import type { EnvironmentId } from "@t3tools/contracts";
import { Link, useBlocker } from "@tanstack/react-router";
import { ChevronDownIcon, PlayIcon, PlusIcon, SaveIcon, WorkflowIcon } from "lucide-react";
import { useEffect, useEffectEvent, useReducer, useRef, useState, type ReactNode } from "react";

import { useMediaQuery } from "~/hooks/useMediaQuery";

import { WorkspacePageHeader } from "~/components/WorkspacePageHeader";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { ScrollArea } from "~/components/ui/scroll-area";
import { SidebarInset } from "~/components/ui/sidebar";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { requestConfirmDialog } from "~/confirmDialog";
import { isElectron } from "~/env";
import { cn } from "~/lib/utils";

import { FactoryApiError } from "../api";
import { FactoryError, FactoryLoading } from "../FactoryNotices";
import { messageOf } from "../format";
import { TouchLink } from "../TouchLink";
import { decodeErrorsOf, pipelineApi } from "./api";
import { Canvas, type CanvasHandle } from "./Canvas";
import { editorReducer, initialEditorState, isDirty, type Selection } from "./editorState";
import { afterRect, freeSlot, nodeRect, NODE_WIDTH } from "./geometry";
import { usePolling, useRequest } from "./hooks";
import { Inspector } from "./Inspector";
import {
  asPipeline,
  happyPort,
  nodeName,
  plural,
  portsOf,
  problemCounts,
  problemsFromDecodeErrors,
  takenOfRun,
  trailOfRun,
  trailOfTrace,
} from "./model";
import { RunDialog } from "./RunDialog";
import { RunsPanel } from "./RunsPanel";
import { SimulationPanel } from "./SimulationPanel";
import type { Catalog, Kind, PipelineRecord, Problem, Trace } from "./types";

const VALIDATE_DEBOUNCE_MS = 300;
const SIMULATE_DEBOUNCE_MS = 300;
/** While a run is going: often enough to follow it node by node. */
const RUNS_POLL_MS = 5_000;
/** While the Runs tab shows and nothing runs here: a run started elsewhere still turns up. */
const RUNS_IDLE_POLL_MS = 15_000;
const HAPPY_PATH_STEPS = 50;
const NO_PROBLEMS: ReadonlyArray<Problem> = [];

/** Keys typed into a field, a menu or a dialog are theirs, not the canvas's. */
const isTyping = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) ||
    target.closest('[role="dialog"],[role="menu"],[role="listbox"],[role="combobox"]') !== null);

/** The editor's chrome: titlebar row, then a body that does not scroll, so the canvas fills it. */
function EditorFrame({ header, children }: { header: ReactNode; children: ReactNode }) {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>{header}</WorkspacePageHeader>
        {children}
      </div>
    </SidebarInset>
  );
}

const backLink = (
  <TouchLink render={<Link to="/factory/pipelines" />} tone="muted">
    Pipelines
  </TouchLink>
);

function StatusChip({
  problems,
  checkError,
  onPick,
}: {
  problems: ReadonlyArray<Problem>;
  checkError: string | null;
  onPick: (problem: Problem) => void;
}) {
  const { errors, warnings } = problemCounts(problems);
  const label =
    checkError !== null
      ? "Not checked"
      : errors > 0
        ? plural(errors, "error")
        : warnings > 0
          ? plural(warnings, "warning")
          : "Valid";
  const dot =
    checkError !== null
      ? "bg-muted-foreground"
      : errors > 0
        ? "bg-destructive"
        : warnings > 0
          ? "bg-warning"
          : "bg-success";
  return (
    <Popover>
      <PopoverTrigger aria-label={`Status: ${label}`} render={<Button size="xs" variant="ghost" />}>
        <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", dot)} />
        {label}
      </PopoverTrigger>
      <PopoverPopup align="end" padding="compact" width="md">
        {checkError !== null ? (
          <p className="text-sm text-muted-foreground">
            Could not check the pipeline: {checkError}
          </p>
        ) : problems.length === 0 ? (
          <p className="text-sm text-muted-foreground">No problems. The pipeline can run.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {problems.map((problem) => (
              <li
                key={`${problem.level} ${problem.node ?? ""} ${problem.edge ?? ""} ${problem.message}`}
              >
                <button
                  className="flex w-full items-start gap-2 rounded-sm px-1 py-0.5 text-left text-sm hover:bg-accent"
                  onClick={() => onPick(problem)}
                  type="button"
                >
                  <span
                    aria-hidden="true"
                    className={
                      problem.level === "error"
                        ? "mt-1.5 size-2 shrink-0 rounded-full bg-destructive"
                        : "mt-1.5 size-2 shrink-0 rounded-full bg-warning"
                    }
                  />
                  <span className="min-w-0 break-words">{problem.message}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </PopoverPopup>
    </Popover>
  );
}

function Editor({
  environmentId,
  record,
  catalog,
}: {
  environmentId: EnvironmentId;
  record: PipelineRecord;
  catalog: Catalog;
}) {
  const { kinds, skills } = catalog;
  const [state, dispatch] = useReducer(editorReducer, record.pipeline, initialEditorState);
  const { pipeline, selection } = state;
  const dirty = isDirty(state);
  const canvas = useRef<CanvasHandle>(null);

  const [problems, setProblems] = useState<ReadonlyArray<Problem>>(record.problems);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [script, setScript] = useState<ReadonlyArray<string> | null>(null);
  const [trace, setTrace] = useState<Trace | null>(null);
  const [simError, setSimError] = useState<string | null>(null);
  const [simBusy, setSimBusy] = useState(false);

  const [panel, setPanel] = useState<"inspect" | "runs">("inspect");
  const [runOpen, setRunOpen] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [runNote, setRunNote] = useState<string | null>(null);
  const runs = useRequest(`${environmentId} ${pipeline.id} runs`, () =>
    pipelineApi.runs(environmentId, pipeline.id),
  );
  const detail = useRequest(runId === null ? null : `${environmentId} run ${runId}`, () =>
    pipelineApi.runDetail(environmentId, runId!),
  );
  const anyRunning = runs.data?.runs.some((run) => run.status === "running") ?? false;
  usePolling(
    () => {
      runs.reload();
      if (detail.data?.run.status === "running") detail.reload();
    },
    anyRunning ? RUNS_POLL_MS : RUNS_IDLE_POLL_MS,
    anyRunning || panel === "runs",
  );

  // Leaving with unsaved edits asks first: in-app links through the router, a reload or a closed
  // tab through the browser's own prompt, which is the only one `beforeunload` may show.
  useBlocker({
    disabled: !dirty,
    enableBeforeUnload: true,
    shouldBlockFn: async () => {
      const message = "Leave without saving?\nYour changes to this pipeline will be lost.";
      const leave =
        (await requestConfirmDialog(message, { variant: "destructive" })) ??
        window.confirm(message);
      return !leave;
    },
  });

  // The latest validation's number: an answer for an older pipeline is dropped.
  const checks = useRef(0);
  useEffect(() => {
    // The record came with its problems; check again only once the person changes something.
    if (pipeline === record.pipeline) return;
    const timer = setTimeout(() => {
      const n = ++checks.current;
      pipelineApi.validate(environmentId, pipeline).then(
        (answer) => {
          if (n !== checks.current) return;
          setProblems(answer.problems);
          setCheckError(null);
        },
        (error: unknown) => {
          if (n !== checks.current) return;
          const decode = decodeErrorsOf(error);
          if (decode !== null) {
            setProblems(problemsFromDecodeErrors(pipeline, decode));
            setCheckError(null);
          } else setCheckError(messageOf(error));
        },
      );
    }, VALIDATE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [environmentId, pipeline, record.pipeline]);

  useEffect(() => {
    if (script === null) return;
    let live = true;
    // Debounced like validation, so typing in the inspector does not post the pipeline per key.
    const timer = setTimeout(() => {
      pipelineApi.simulate(environmentId, pipeline, script).then(
        (answer) => {
          if (!live) return;
          setTrace(answer.trace);
          setSimError(null);
        },
        (error: unknown) => {
          if (!live) return;
          setSimError(
            decodeErrorsOf(error) === null
              ? messageOf(error)
              : "The pipeline has fields the server cannot read. Fix the errors to simulate.",
          );
        },
      );
    }, SIMULATE_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [environmentId, pipeline, script]);

  const save = async () => {
    const sent = pipeline;
    setSaving(true);
    setSaveError(null);
    try {
      const answer = await pipelineApi.save(environmentId, sent);
      dispatch({ type: "saved", pipeline: sent });
      setProblems(answer.problems);
      setCheckError(null);
    } catch (error) {
      const decode = decodeErrorsOf(error);
      if (decode !== null) {
        setProblems(problemsFromDecodeErrors(sent, decode));
        setSaveError(
          `Not saved: the server could not read ${plural(decode.length, "field")}. They are marked on the canvas.`,
        );
      } else setSaveError(`Not saved: ${messageOf(error)}`);
    }
    setSaving(false);
  };

  const select = (next: Selection) => {
    dispatch({ type: "select", selection: next });
    if (next !== null) openInspector();
  };

  const onKey = useEffectEvent((event: KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      if (dirty && !saving) void save();
      return;
    }
    if (isTyping(event.target)) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      dispatch({ type: event.shiftKey ? "redo" : "undo" });
      return;
    }
    if (event.ctrlKey && event.key.toLowerCase() === "y") {
      event.preventDefault();
      dispatch({ type: "redo" });
      return;
    }
    if (event.key === "Escape" && selection !== null) dispatch({ type: "select", selection: null });
    if ((event.key === "Delete" || event.key === "Backspace") && selection !== null) {
      event.preventDefault();
      dispatch({ type: "remove-selection" });
    }
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKey(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  /** The Inspect tab, with no run selected: a run's trail would dim the nodes being edited. */
  const openInspector = () => {
    setPanel("inspect");
    setRunId(null);
  };

  const stacked = useMediaQuery("max-sm");

  const addNode = (kind: Kind) => {
    const rectOf = (node: (typeof pipeline.nodes)[number]) =>
      nodeRect(node, portsOf(kinds, node.kind).length);
    const size = nodeRect({ x: 0, y: 0 }, portsOf(kinds, kind).length);
    const selected =
      selection?.kind === "node"
        ? pipeline.nodes.find((node) => node.id === selection.id)
        : undefined;
    const centre = canvas.current?.centre() ?? { x: 280, y: 200 };
    // After the selected node, the natural "add next"; else where the person is looking.
    const start =
      selected === undefined
        ? { x: centre.x - NODE_WIDTH / 2, y: centre.y - size.height / 2 }
        : afterRect(rectOf(selected));
    const { x, y } = freeSlot(pipeline.nodes.map(rectOf), size, start);
    dispatch({ type: "add-node", kind, x, y });
    openInspector();
  };

  // Each simulation session's number: a happy path still walking when the person turns the
  // simulation off (or on again) must not write its script into the new session.
  const simSession = useRef(0);
  const toggleSimulation = () => {
    simSession.current++;
    setSimBusy(false);
    if (script === null) {
      setScript([]);
      setTrace(null);
      setSimError(null);
    } else setScript(null);
  };

  const happyPath = async () => {
    const session = simSession.current;
    const walk = [...(script ?? [])];
    const kindOf = (id: string) => pipeline.nodes.find((node) => node.id === id)?.kind;
    setSimBusy(true);
    try {
      for (let step = 0; step < HAPPY_PATH_STEPS; step++) {
        const { trace: next } = await pipelineApi.simulate(environmentId, pipeline, walk);
        if (session !== simSession.current) return;
        if (next.end.kind !== "waiting") break;
        const port = happyPort(kindOf(next.end.node), next.end.ports);
        if (port === null) break;
        walk.push(port);
      }
      setScript(walk);
    } catch (error) {
      if (session === simSession.current) setSimError(messageOf(error));
    }
    if (session === simSession.current) setSimBusy(false);
  };

  const stopRun = async (id: string) => {
    setStopping(true);
    try {
      await pipelineApi.stopRun(environmentId, id);
    } catch (error) {
      setRunNote(messageOf(error));
    }
    setStopping(false);
    runs.reload();
    detail.reload();
  };

  const pickProblem = (problem: Problem) => {
    if (problem.node) select({ kind: "node", id: problem.node });
    else if (problem.edge) select({ kind: "edge", id: problem.edge });
  };

  const simulating = script !== null;
  const runDetail = detail.data?.run ?? null;
  const showRun = !simulating && panel === "runs" && runDetail !== null;
  // A run is drawn on the pipeline it started with: its record names that graph's nodes and edges.
  const runPipeline = showRun ? asPipeline(runDetail.pipeline) : null;
  const trail = simulating
    ? trace === null
      ? null
      : trailOfTrace(trace)
    : showRun
      ? trailOfRun(runDetail.events)
      : null;
  const taken = simulating ? (trace?.taken ?? null) : showRun ? takenOfRun(runDetail.events) : null;
  const hasStart = pipeline.nodes.some((node) => node.kind === "start");
  const addable = kinds.filter((info) => info.kind !== "start" || !hasStart);
  const selectedNode =
    selection?.kind === "node"
      ? pipeline.nodes.find((candidate) => candidate.id === selection.id)
      : undefined;
  const selectedName = selectedNode === undefined ? null : nodeName(kinds, selectedNode);

  const actions = (
    <div className="ml-auto flex shrink-0 items-center gap-1.5">
      <Menu>
        <MenuTrigger render={<Button size="xs" variant="outline" />}>
          <PlusIcon />
          Add
          <ChevronDownIcon />
        </MenuTrigger>
        <MenuPopup align="end">
          {addable.map((info) => (
            <MenuItem key={info.kind} onClick={() => addNode(info.kind)}>
              <span className="flex flex-col">
                <span>{info.label}</span>
                <span className="text-xs text-muted-foreground">{info.description}</span>
              </span>
            </MenuItem>
          ))}
        </MenuPopup>
      </Menu>
      <Button
        aria-pressed={simulating}
        onClick={toggleSimulation}
        size="xs"
        variant={simulating ? "secondary" : "outline"}
      >
        <WorkflowIcon />
        Simulate
      </Button>
      <Button onClick={() => setRunOpen(true)} size="xs" variant="outline">
        <PlayIcon />
        Run
      </Button>
      <Button disabled={!dirty || saving} onClick={() => void save()} size="xs">
        <SaveIcon />
        Save
      </Button>
    </div>
  );

  const header = (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      {backLink}
      <Input
        aria-label="Pipeline name"
        className="w-56 min-w-0 max-sm:w-32"
        onChange={(event) =>
          dispatch({
            type: "rename",
            name: event.target.value,
            edit: { key: "name", at: Date.now() },
          })
        }
        size="sm"
        value={pipeline.name}
      />
      <StatusChip checkError={checkError} onPick={pickProblem} problems={problems} />
      {stacked ? null : actions}
    </div>
  );

  return (
    <EditorFrame header={header}>
      {/* The topbar has a fixed height, so on a phone the actions get a row of their own. */}
      {stacked ? <div className="flex items-center border-t px-3 py-2">{actions}</div> : null}
      {saveError ? (
        <div className="border-t px-3 py-2">
          <Alert variant="error">
            <AlertDescription>{saveError}</AlertDescription>
          </Alert>
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col border-t lg:flex-row">
        <div className="relative min-h-72 min-w-0 flex-1">
          <Canvas
            kinds={kinds}
            onConnect={(from, port, to) => {
              dispatch({ type: "connect", from, port, to });
              openInspector();
            }}
            onLayout={(positions) => dispatch({ type: "layout", positions })}
            onMove={(id, x, y) => dispatch({ type: "move-node", id, x, y })}
            onSelect={select}
            pipeline={runPipeline ?? pipeline}
            problems={runPipeline === null ? problems : NO_PROBLEMS}
            readOnly={runPipeline !== null}
            ref={canvas}
            selection={runPipeline === null ? selection : null}
            taken={taken}
            trail={trail}
          />
        </div>
        <aside
          aria-label={selectedName ? `Inspector: ${selectedName}` : "Inspector"}
          className="flex h-96 min-h-0 flex-col border-t lg:h-auto lg:w-80 lg:border-t-0 lg:border-l"
        >
          <div className="flex items-center gap-2 px-3 pt-3">
            <ToggleGroup
              aria-label="Panel"
              onValueChange={(values) => {
                const next = values[0];
                if (next === "inspect") openInspector();
                else if (next === "runs") setPanel(next);
              }}
              value={[panel]}
            >
              <Toggle value="inspect">Inspect</Toggle>
              <Toggle value="runs">Runs{runs.data ? ` (${runs.data.runs.length})` : ""}</Toggle>
            </ToggleGroup>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-4 p-3">
              {simulating ? (
                <SimulationPanel
                  busy={simBusy}
                  error={simError}
                  kinds={kinds}
                  onHappyPath={() => void happyPath()}
                  onPick={(port) => setScript([...script, port])}
                  onReset={() => setScript([])}
                  onUndo={() => setScript(script.slice(0, -1))}
                  pipeline={pipeline}
                  script={script}
                  trace={trace}
                />
              ) : null}
              {panel === "inspect" && (!simulating || selection !== null) ? (
                <Inspector
                  key={selection === null ? "none" : `${selection.kind} ${selection.id}`}
                  kinds={kinds}
                  onDelete={() => dispatch({ type: "remove-selection" })}
                  onEdgeChange={(edge, field) =>
                    dispatch({
                      type: "update-edge",
                      edge,
                      edit: { key: `edge ${edge.id} ${field}`, at: Date.now() },
                    })
                  }
                  onNodeChange={(node, field) =>
                    dispatch({
                      type: "update-node",
                      node,
                      edit: { key: `node ${node.id} ${field}`, at: Date.now() },
                    })
                  }
                  pipeline={pipeline}
                  problems={problems}
                  selection={selection}
                  skills={skills}
                />
              ) : (
                <>
                  {runNote ? (
                    <p className="text-xs text-muted-foreground" role="status">
                      {runNote}
                    </p>
                  ) : null}
                  <RunsPanel
                    detail={runDetail}
                    environmentId={environmentId}
                    error={runs.error ? messageOf(runs.error) : null}
                    kinds={kinds}
                    onSelect={setRunId}
                    onStop={(id) => void stopRun(id)}
                    pipeline={pipeline}
                    runs={runs.data?.runs ?? null}
                    selectedRunId={runId}
                    stopping={stopping}
                  />
                </>
              )}
            </div>
          </ScrollArea>
        </aside>
      </div>
      <RunDialog
        dirty={dirty}
        environmentId={environmentId}
        onOpenChange={setRunOpen}
        onStarted={(run) => {
          setPanel("runs");
          setRunId(run.id);
          setScript(null);
          runs.reload();
        }}
        open={runOpen}
        pipelineId={pipeline.id}
      />
    </EditorFrame>
  );
}

export function PipelineEditorPage({
  environmentId,
  pipelineId,
}: {
  environmentId: EnvironmentId;
  pipelineId: string;
}) {
  const record = useRequest(`${environmentId} ${pipelineId}`, () =>
    pipelineApi.get(environmentId, pipelineId),
  );
  const catalog = useRequest(`${environmentId} catalog`, () => pipelineApi.catalog(environmentId));
  const failed = record.error ?? catalog.error;
  if (record.data !== null && catalog.data !== null) {
    return <Editor catalog={catalog.data} environmentId={environmentId} record={record.data} />;
  }
  const unreadable = record.error === null ? null : decodeErrorsOf(record.error);
  let body: ReactNode;
  if (unreadable !== null) {
    body = (
      <div className="flex flex-col gap-3">
        <FactoryError
          message="The file on the factory machine does not describe a pipeline. Fix or delete it, then reload."
          title={`Pipeline ${pipelineId} is unreadable`}
          onRetry={record.reload}
        />
        <ul className="flex flex-col gap-1 text-sm">
          {unreadable.map((decodeError) => (
            <li key={`${decodeError.path} ${decodeError.message}`}>
              <span className="font-mono">{decodeError.path || "file"}</span> {decodeError.message}
            </li>
          ))}
        </ul>
      </div>
    );
  } else if (failed !== null) {
    body =
      failed instanceof FactoryApiError && failed.status === 404 && record.error !== null ? (
        <FactoryError
          message="It may have been deleted, or the id is wrong."
          title={`No pipeline ${pipelineId}`}
        />
      ) : (
        <FactoryError
          message={messageOf(failed)}
          onRetry={() => {
            record.reload();
            catalog.reload();
          }}
          title="Could not load the pipeline"
        />
      );
  } else body = <FactoryLoading label="Loading pipeline" />;
  return (
    <EditorFrame
      header={
        <div className="flex min-w-0 flex-1 items-center gap-3">
          {backLink}
          <h1 className="min-w-0 truncate font-mono text-sm font-medium">{pipelineId}</h1>
        </div>
      }
    >
      <div className="p-6">{body}</div>
    </EditorFrame>
  );
}
