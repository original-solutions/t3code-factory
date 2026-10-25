import type { EnvironmentId } from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "~/components/ui/empty";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Radio, RadioGroup } from "~/components/ui/radio-group";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";

import { requestConfirmDialog } from "~/confirmDialog";

import { FactoryFrame } from "../FactoryFrame";
import { FactoryError, FactoryLoading, FactoryReadFailure } from "../FactoryNotices";
import { messageOf } from "../format";
import { TouchLink } from "../TouchLink";
import { useFactoryEnvironments, useFactorySupported } from "../useFactoryData";
import { pipelineApi } from "./api";
import { useRequest } from "./hooks";
import { plural, slugOf, templatePipeline } from "./model";
import type { PipelineListItem } from "./types";

const updated = (iso: string | null) => {
  if (iso === null) return "-";
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
};

function PipelineRow({
  environmentId,
  pipeline,
  onDeleted,
}: {
  environmentId: EnvironmentId;
  pipeline: PipelineListItem;
  onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = async () => {
    const message = `Delete the pipeline "${pipeline.name}"?\nIts runs' records stay; the pipeline itself cannot be restored.`;
    const confirmed =
      (await requestConfirmDialog(message, { variant: "destructive" })) ?? window.confirm(message);
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    try {
      await pipelineApi.remove(environmentId, pipeline.id);
      onDeleted();
    } catch (cause) {
      setError(messageOf(cause));
    }
    setBusy(false);
  };
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border bg-card px-3 py-2 text-sm">
      <TouchLink
        render={
          <Link
            params={{ environmentId, pipelineId: pipeline.id }}
            to="/factory/pipelines/$environmentId/$pipelineId"
          />
        }
      >
        {pipeline.name}
      </TouchLink>
      {pipeline.name === pipeline.id ? null : (
        <span className="font-mono text-xs text-muted-foreground">{pipeline.id}</span>
      )}
      {pipeline.unreadable ? null : (
        <span className="text-xs text-muted-foreground">
          {plural(pipeline.nodes, "node")} · {plural(pipeline.edges, "transition")}
        </span>
      )}
      {pipeline.unreadable ? (
        <Badge variant="error">Unreadable</Badge>
      ) : pipeline.errors > 0 ? (
        <Badge variant="error">{plural(pipeline.errors, "error")}</Badge>
      ) : pipeline.warnings > 0 ? (
        <Badge variant="warning">{plural(pipeline.warnings, "warning")}</Badge>
      ) : (
        <Badge variant="success">Valid</Badge>
      )}
      {pipeline.errors > 0 && pipeline.warnings > 0 ? (
        <Badge variant="warning">{plural(pipeline.warnings, "warning")}</Badge>
      ) : null}
      <span className="ml-auto text-xs text-muted-foreground">
        Updated {updated(pipeline.updatedAt)}
      </span>
      <Button
        aria-label={`Delete ${pipeline.name}`}
        disabled={busy}
        onClick={() => void remove()}
        size="icon-xs"
        variant="ghost-destructive"
      >
        <Trash2Icon />
      </Button>
      {pipeline.unreadable && pipeline.decodeErrors && pipeline.decodeErrors.length > 0 ? (
        <ul className="w-full text-xs text-muted-foreground">
          {pipeline.decodeErrors.map((decodeError) => (
            <li key={`${decodeError.path} ${decodeError.message}`}>
              <span className="font-mono">{decodeError.path || "file"}</span> {decodeError.message}
            </li>
          ))}
        </ul>
      ) : null}
      {error ? (
        <p className="w-full text-xs text-destructive-foreground" role="alert">
          Could not delete: {error}
        </p>
      ) : null}
    </li>
  );
}

type Listed = {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly pipelines: ReadonlyArray<PipelineListItem> | null;
  readonly error: Error | null;
  readonly reload: () => void;
};

/** One environment's list; it reports what it read so the page can name taken ids. */
function EnvironmentPipelines({
  environmentId,
  label,
  showLabel,
  onCreate,
}: {
  environmentId: EnvironmentId;
  label: string;
  showLabel: boolean;
  onCreate: (listed: Listed) => void;
}) {
  const list = useRequest(`${environmentId} pipelines`, () => pipelineApi.list(environmentId));
  const listed: Listed = {
    environmentId,
    label,
    pipelines: list.data?.pipelines ?? null,
    error: list.error,
    reload: list.reload,
  };
  let body;
  if (listed.pipelines === null && listed.error !== null) {
    body = (
      <FactoryReadFailure
        label={label}
        message={messageOf(listed.error)}
        onRetry={listed.reload}
        verb="read"
      />
    );
  } else if (listed.pipelines === null) {
    body = <FactoryLoading label={`Loading ${label}'s pipelines`} />;
  } else if (listed.pipelines.length === 0) {
    body = (
      <Empty size="compact">
        <EmptyHeader>
          <EmptyTitle>No pipelines yet</EmptyTitle>
          <EmptyDescription>
            A pipeline is the graph a factory run follows: agents, checks, loops and a learning
            step, drawn on a canvas.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button onClick={() => onCreate(listed)} size="sm">
            <PlusIcon />
            New pipeline
          </Button>
        </EmptyContent>
      </Empty>
    );
  } else {
    body = (
      <ul className="flex flex-col gap-2">
        {listed.pipelines.map((pipeline) => (
          <PipelineRow
            environmentId={environmentId}
            key={pipeline.id}
            onDeleted={listed.reload}
            pipeline={pipeline}
          />
        ))}
      </ul>
    );
  }
  return (
    <section aria-label={label} className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        {showLabel ? <h2 className="text-sm font-medium">{label}</h2> : null}
        {listed.pipelines !== null && listed.pipelines.length > 0 ? (
          <Button className="ml-auto" onClick={() => onCreate(listed)} size="xs" variant="outline">
            <PlusIcon />
            New pipeline
          </Button>
        ) : null}
      </div>
      {body}
    </section>
  );
}

/** The "Start from" value for an empty canvas; template ids are pipeline ids, which cannot clash. */
const BLANK = "";

function NewPipelineDialog({ target, onClose }: { target: Listed | null; onClose: () => void }) {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [from, setFrom] = useState(BLANK);
  // A local, not `target.environmentId` in the closure: the compiler reads a closure's property
  // paths as its dependencies, during render, while `target` may still be null.
  const environmentId = target?.environmentId ?? null;
  const catalog = useRequest(environmentId === null ? null : `${environmentId} catalog`, () =>
    environmentId === null
      ? Promise.reject(new Error("No environment"))
      : pipelineApi.catalog(environmentId),
  );
  const templates = catalog.data?.templates ?? [];
  const template = templates.find((candidate) => candidate.id === from);
  const taken = new Set((target?.pipelines ?? []).map((pipeline) => pipeline.id));
  const id = slugOf(name, taken);

  const close = () => {
    setName("");
    setError(null);
    setFrom(BLANK);
    onClose();
  };

  const create = async () => {
    if (target === null || name.trim() === "") return;
    setBusy(true);
    setError(null);
    // A template keeps its nodes, edges and positions; only the id and name are the person's.
    const body =
      template === undefined
        ? templatePipeline(id, name.trim())
        : { ...template.pipeline, id, name: name.trim() };
    try {
      await pipelineApi.save(target.environmentId, body);
      close();
      void navigate({
        to: "/factory/pipelines/$environmentId/$pipelineId",
        params: { environmentId: target.environmentId, pipelineId: id },
      });
    } catch (cause) {
      setError(messageOf(cause));
    }
    setBusy(false);
  };

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) close();
      }}
      open={target !== null}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>New pipeline</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <form
            className="flex flex-col gap-2"
            id="new-pipeline"
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            <Label htmlFor="new-pipeline-name">Name</Label>
            <Input
              autoFocus
              id="new-pipeline-name"
              onChange={(event) => setName(event.target.value)}
              placeholder="Build and learn"
              value={name}
            />
            <p className="text-xs text-muted-foreground">
              Saved as <span className="font-mono">{id}</span>
              {target !== null ? ` on ${target.label}` : ""}.
            </p>
            <Label id="new-pipeline-from">Start from</Label>
            <RadioGroup aria-labelledby="new-pipeline-from" onValueChange={setFrom} value={from}>
              {[
                { id: BLANK, name: "Blank", description: "A start and two ends, done and stuck." },
                ...templates,
              ].map((choice) => (
                <label
                  className="flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2 text-sm"
                  key={choice.id}
                >
                  <Radio value={choice.id} />
                  <span className="flex min-w-0 flex-col">
                    <span className="font-medium">{choice.name}</span>
                    <span className="text-xs text-muted-foreground">{choice.description}</span>
                  </span>
                </label>
              ))}
            </RadioGroup>
            {error ? (
              <p className="text-sm text-destructive-foreground" role="alert">
                {error}
              </p>
            ) : null}
          </form>
        </DialogPanel>
        <DialogFooter>
          <Button onClick={close} variant="outline">
            Cancel
          </Button>
          <Button disabled={busy || name.trim() === ""} form="new-pipeline" type="submit">
            Create
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function PipelinesPage() {
  const environments = useFactoryEnvironments();
  const supported = useFactorySupported();
  const [target, setTarget] = useState<Listed | null>(null);
  const [filter, setFilter] = useState<EnvironmentId | null>(null);
  const shown = environments.filter(
    ({ environmentId }) => filter === null || environmentId === filter,
  );

  let body;
  if (environments.length === 0) {
    body = supported ? (
      <FactoryLoading label="Loading factory" />
    ) : (
      <FactoryError
        message="None of the connected environments runs a factory."
        title="No factory"
      />
    );
  } else {
    body = shown.map(({ environmentId, label }) => (
      <EnvironmentPipelines
        environmentId={environmentId}
        key={environmentId}
        label={label}
        onCreate={setTarget}
        showLabel={environments.length > 1}
      />
    ));
  }

  const items = [
    { value: null, label: "All environments" },
    ...environments.map(({ environmentId, label }) => ({ value: environmentId, label })),
  ];

  return (
    <FactoryFrame
      header={
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <TouchLink render={<Link to="/factory" />} tone="muted">
            Factory
          </TouchLink>
          <h1 className="min-w-0 truncate text-sm font-medium">Pipelines</h1>
          {environments.length > 1 ? (
            <div className="ml-auto w-44 min-w-0">
              <Select items={items} onValueChange={setFilter} value={filter}>
                <SelectTrigger aria-label="Environment" size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {items.map((item) => (
                    <SelectItem key={item.value ?? ""} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          ) : null}
        </div>
      }
    >
      <div className="flex flex-col gap-6">{body}</div>
      <NewPipelineDialog onClose={() => setTarget(null)} target={target} />
    </FactoryFrame>
  );
}
