import type { EnvironmentId } from "@t3tools/contracts";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { flushSync } from "react-dom";

import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

import { RunAgentLine } from "./RunAgent";
import { FactoryApiError } from "./api";
import { FactoryCard } from "./FactoryCard";
import { FactoryFrame } from "./FactoryFrame";
import { FactoryKeysButton, FactoryKeysDialog } from "./FactoryKeys";
import { FactoryError, FactoryLoading, FactoryReadFailure } from "./FactoryNotices";
import {
  currentStep,
  issueRef,
  issueTitleOf,
  lastGateOutput,
  parseRunId,
  prEndOf,
  prUrlOf,
  runIsFinished,
  prRef,
  runState,
  shownState,
  threadIdOf,
} from "./format";
import {
  runLinkKey,
  stepInQueue,
  useFactoryKeys,
  type QueuedRun,
  type QueueStep,
} from "./runQueue";
import { nextStep } from "./nextStep";
import { GateOutput } from "./GateOutput";
import { RunDetails, TabCount, TabDot } from "./RunDetails";
import { runDetails, type RunDetailTab } from "./runDetailTabs";
import { RunLedger } from "./RunLedgerTable";
import { GATE_OUTPUT_ID, RunNextStep } from "./RunNextStep";
import { RunGitHub } from "./RunGitHub";
import { RunReportCard } from "./RunReportCard";
import { RunTimeline } from "./RunTimeline";
import { RunTrackLine } from "./RunTrackLine";
import { runTrack, stateMark } from "./runTrack";
import { StateChip } from "./StateChip";
import { RunActions, useRunStop } from "./RunActionBar";
import { runActions } from "./runActions";
import { TouchLink } from "./TouchLink";
import { readFactoryRunAhead, useFactoryEnvironmentLabel, useFactoryRun } from "./useFactoryData";

/** Up and down the list the run was opened from, with where this run sits in it. */
function QueueStepper({ step, onGo }: { step: QueueStep; onGo: (run: QueuedRun) => void }) {
  return (
    <div className="ml-auto flex shrink-0 items-center gap-1" role="group" aria-label="Runs list">
      <Button
        aria-keyshortcuts="k"
        aria-label="Previous run"
        disabled={step.previous === null}
        onClick={() => step.previous && onGo(step.previous)}
        size="icon-sm"
        title="Previous run (k)"
        variant="ghost"
      >
        <ChevronUpIcon />
      </Button>
      <span className="font-mono text-xs text-muted-foreground tabular-nums">
        {step.position}
        <span className="max-sm:hidden"> of </span>
        <span className="sm:hidden">/</span>
        {step.total}
      </span>
      <Button
        aria-keyshortcuts="j"
        aria-label="Next run"
        disabled={step.next === null}
        onClick={() => step.next && onGo(step.next)}
        size="icon-sm"
        title="Next run (j)"
        variant="ghost"
      >
        <ChevronDownIcon />
      </Button>
    </div>
  );
}

export function FactoryRunPage({
  environmentId,
  runId,
}: {
  environmentId: EnvironmentId;
  runId: string;
}) {
  const run = useFactoryRun(environmentId, runId);
  const label = useFactoryEnvironmentLabel(environmentId);
  const stopOf = useRunStop((answered) => {
    if (answered === environmentId) run.refresh();
  });
  const navigate = useNavigate();
  // The list this run was opened from, if any: the header steps through it and goes back to it.
  const queue = useRouterState({ select: ({ location }) => location.state.factoryRunQueue });
  const queued = stepInQueue(queue, environmentId, runId);
  const backSearch = queue?.search ?? {};
  const backState = queue
    ? { factoryReturn: { query: queue.query, focus: runLinkKey(environmentId, runId) } }
    : {};
  // Replacing, so the browser's Back still leaves the run pages for the list in one step.
  const go = (next: QueuedRun) =>
    void navigate({
      to: "/factory/$environmentId/$runId",
      params: { environmentId: next.environmentId, runId: next.runId },
      state: queue ? { factoryRunQueue: queue } : {},
      replace: true,
    });
  const nextRun = queued?.next ?? null;
  const previousRun = queued?.previous ?? null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the neighbours into the run cache, so j and k open at once
  useEffect(() => {
    for (const run of [nextRun, previousRun]) {
      if (run !== null) readFactoryRunAhead(run.environmentId as EnvironmentId, run.runId);
    }
  }, [nextRun, previousRun]);
  const [keysOpen, setKeysOpen] = useState(false);
  // The part a person picked stays picked while the page refreshes; another run opens on its own lead.
  const [picked, setPicked] = useState<{ run: string; tab: RunDetailTab } | null>(null);
  useFactoryKeys((key) => {
    if (key === "help") {
      setKeysOpen(true);
      return true;
    }
    if (key === "back") {
      void navigate({ to: "/factory", search: backSearch, state: backState });
      return true;
    }
    const target = key === "next" ? queued?.next : key === "previous" ? queued?.previous : null;
    if (!target) return false;
    go(target);
    return true;
  });

  const entries = run.data?.entries ?? [];
  const state = runState(entries);
  const shown = shownState(state, prEndOf(entries));
  // A finished run's last step is over; the runs list says finished too.
  const finished = runIsFinished(entries);
  // A finished run's track says where it ended; only a live run has a step to name.
  const step = finished ? null : currentStep(entries);
  const lastEvent = finished ? null : (entries.at(-1)?.event ?? null);
  const threadId = threadIdOf(entries);
  const parsed = parseRunId(runId);
  const issue = parsed ? issueRef(`${parsed.owner}/${parsed.repo}`, parsed.issue) : null;
  const next = nextStep(entries);
  const title = queued?.title ?? issueTitleOf(entries);
  const track = runTrack(entries);
  const { station } = stateMark(shown, lastEvent);
  // The Next step card is this page's own; every other action shows as it does on the belt and list.
  const actions = runActions({
    id: runId,
    state,
    finished,
    prUrl: prUrlOf(entries),
    threadId,
  }).filter((action) => action.kind !== "next");
  const pr = prRef(prUrlOf(entries));
  const runKey = `${environmentId}/${runId}`;
  const details = runDetails(entries, { gitHub: issue !== null || pr !== null });
  const tab =
    picked?.run === runKey && details.tabs.includes(picked.tab) ? picked.tab : details.lead;
  const pickTab = (next: RunDetailTab) => setPicked({ run: runKey, tab: next });
  const showGate = () => {
    flushSync(() => pickTab("gate"));
    document.getElementById(GATE_OUTPUT_ID)?.scrollIntoView({ block: "start" });
  };
  const gate = lastGateOutput(entries);

  let body;
  if (run.status === "error" && run.data === null) {
    body =
      run.error instanceof FactoryApiError && run.error.status === 404 ? (
        <FactoryError
          message="It may be finished and cleaned up, or the id is wrong."
          title={`No run ${runId}`}
        />
      ) : (
        <FactoryReadFailure
          dataAt={run.dataAt}
          error={run.error}
          label={label}
          onRetry={run.refresh}
          verb="read"
        />
      );
  } else if (run.data === null) {
    body = <FactoryLoading label="Loading run" />;
  } else {
    body = (
      <>
        {run.status === "error" ? (
          <FactoryReadFailure
            dataAt={run.dataAt}
            error={run.error}
            label={label}
            onRetry={run.refresh}
            verb="refresh"
          />
        ) : null}
        <FactoryCard
          aria-label="Run"
          className="gap-4 py-3.5"
          data-station={station ?? undefined}
          rail={station !== null}
        >
          <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
            <div className="flex min-w-0 flex-1 basis-72 flex-col gap-1.5">
              {parsed ? (
                <p className="min-w-0 truncate text-xs text-muted-foreground">
                  {parsed.owner}/{parsed.repo}
                  <span className="ml-1.5 font-mono font-medium text-foreground">
                    #{parsed.issue}
                  </span>
                  {parsed.attempt > 1 ? ` · attempt ${parsed.attempt}` : null}
                </p>
              ) : null}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <StateChip lastEvent={lastEvent} state={shown} />
                {step ? (
                  <span className="min-w-0 break-words text-muted-foreground">Step: {step}</span>
                ) : null}
              </div>
            </div>
            <RunActions
              actions={actions}
              environmentId={environmentId}
              label={issue?.text ?? runId}
              runId={runId}
              stop={stopOf(environmentId, runId)}
              touch
            />
          </div>
          <RunTrackLine track={track} />
          {threadId !== null && !finished ? (
            <RunAgentLine environmentId={environmentId} threadId={threadId} />
          ) : null}
        </FactoryCard>
        <RunReportCard entries={entries} />
        {next ? (
          <RunNextStep
            environmentId={environmentId}
            issue={issue}
            onShowGate={showGate}
            prUrl={prUrlOf(entries)}
            runKey={runKey}
            step={next}
            threadId={threadId}
          />
        ) : null}
        <RunDetails
          onTab={pickTab}
          parts={{
            timeline: {
              label: "Timeline",
              panel: <RunTimeline entries={entries} environmentId={environmentId} />,
            },
            gate: {
              label: "Gate",
              aside:
                gate.commands.length > 0 ? (
                  <TabDot ok={gate.commands.every((command) => command.exit_code === 0)} />
                ) : undefined,
              panel: <GateOutput entries={entries} />,
            },
            github: {
              label: issue && pr ? "Issue & PR" : pr ? "PR" : "Issue",
              panel: (
                <RunGitHub
                  environmentId={environmentId}
                  issue={issue}
                  label={label}
                  pr={pr}
                  runId={runId}
                />
              ),
            },
            ledger: {
              label: "Ledger",
              aside: <TabCount n={entries.length} />,
              panel: (
                <RunLedger
                  entries={entries}
                  skipped={run.data.skipped}
                  truncated={run.data.truncated}
                />
              ),
            },
          }}
          tab={tab}
          tabs={details.tabs}
        />
      </>
    );
  }

  return (
    <FactoryFrame
      header={
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <TouchLink
            aria-keyshortcuts="Escape"
            render={<Link search={backSearch} state={backState} to="/factory" />}
            tone="muted"
          >
            Back
          </TouchLink>
          {title ? (
            <Tooltip>
              <TooltipTrigger render={<h1 className="min-w-0 truncate text-sm font-medium" />}>
                {title}
              </TooltipTrigger>
              <TooltipPopup side="bottom">
                <span className="font-mono">{runId}</span>
              </TooltipPopup>
            </Tooltip>
          ) : (
            <h1 className="min-w-0 truncate font-mono text-sm font-medium">{runId}</h1>
          )}
          {/* On a phone the stepper takes the label's room; the run's own row still says where. */}
          <span
            className={cn(
              "min-w-0 shrink-0 truncate text-sm text-muted-foreground",
              queued && "max-sm:hidden",
            )}
          >
            {label}
          </span>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {queued ? <QueueStepper onGo={go} step={queued} /> : null}
            <FactoryKeysButton onOpen={() => setKeysOpen(true)} />
          </div>
        </div>
      }
    >
      {body}
      <FactoryKeysDialog onOpenChange={setKeysOpen} open={keysOpen} />
    </FactoryFrame>
  );
}
