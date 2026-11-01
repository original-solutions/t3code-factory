import type { EnvironmentId } from "@t3tools/contracts";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { ChevronDownIcon, ChevronRightIcon, ChevronUpIcon } from "lucide-react";
import { useState } from "react";

import { useMediaQuery } from "~/hooks/useMediaQuery";
import { cn } from "~/lib/utils";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";

import { RunAgentCard } from "./RunAgent";
import { FactoryApiError, type FactoryEntry } from "./api";
import { FactoryFrame } from "./FactoryFrame";
import { FactoryKeysButton, FactoryKeysDialog } from "./FactoryKeys";
import { FactoryError, FactoryLoading, FactoryReadFailure } from "./FactoryNotices";
import {
  currentStep,
  issueRef,
  labelForState,
  parseRunId,
  prEndOf,
  prUrlOf,
  runIsFinished,
  runState,
  shownState,
  stateBadgeVariant,
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
import { RunNextStep } from "./RunNextStep";
import { RunReportCard } from "./RunReportCard";
import { RunTimeline } from "./RunTimeline";
import { RunActions, useRunStop } from "./RunActionBar";
import { runActions } from "./runActions";
import { TouchLink } from "./TouchLink";
import { useFactoryEnvironmentLabel, useFactoryRun } from "./useFactoryData";

/** Pairs each item with a key unique within the list, though two rows may read the same. */
function keyed<T>(items: ReadonlyArray<T>, base: (item: T) => string): Array<[string, T]> {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const name = base(item);
    const n = seen.get(name) ?? 0;
    seen.set(name, n + 1);
    return [`${name}#${n}`, item];
  });
}

function Ledger({
  entries,
  truncated,
  skipped,
}: {
  entries: ReadonlyArray<FactoryEntry>;
  truncated: boolean;
  skipped: number;
}) {
  const stacked = useMediaQuery("max-sm");
  return (
    <Collapsible render={<section />} className="flex flex-col gap-2">
      <CollapsibleTrigger
        render={<Button size="sm" variant="ghost-muted" />}
        className="group/ledger self-start"
      >
        <ChevronRightIcon className="transition-transform group-data-panel-open/ledger:rotate-90" />
        Raw ledger ({entries.length} {entries.length === 1 ? "entry" : "entries"})
      </CollapsibleTrigger>
      <CollapsiblePanel animate={false}>
        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">No ledger entries</p>
        ) : stacked ? (
          <ul className="flex flex-col gap-2" data-layout="list">
            {keyed(entries, (entry) => `${entry.ts} ${entry.event}`).map(([key, entry]) => (
              <li
                className="flex flex-col gap-0.5 rounded-lg border bg-card px-3 py-2 text-sm"
                key={key}
              >
                <span className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="min-w-0 break-words font-medium">{entry.event}</span>
                  <span className="font-mono text-xs text-muted-foreground">{entry.ts}</span>
                </span>
                <span className="line-clamp-2 break-all font-mono text-xs">
                  {JSON.stringify(entry.data)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Event</TableHead>
                <TableHead>Data</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {keyed(entries, (entry) => `${entry.ts} ${entry.event}`).map(([key, entry]) => {
                const data = JSON.stringify(entry.data);
                return (
                  <TableRow key={key}>
                    <TableCell className="whitespace-nowrap">
                      <span className="font-mono text-xs">{entry.ts}</span>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{entry.event}</TableCell>
                    <TableCell className="max-w-md">
                      <span className="block line-clamp-2 break-all font-mono text-xs">{data}</span>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CollapsiblePanel>
      {truncated ? (
        <p className="text-xs text-muted-foreground">
          The last line of the ledger was unreadable and was dropped.
        </p>
      ) : null}
      {skipped > 0 ? (
        <p className="text-xs text-muted-foreground">{skipped} unreadable lines skipped.</p>
      ) : null}
    </Collapsible>
  );
}

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
  const [note, setNote] = useState<string | null>(null);
  const stopOf = useRunStop(({ message }) => {
    setNote(message);
    run.refresh();
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
  const [keysOpen, setKeysOpen] = useState(false);
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
  const step = runIsFinished(entries) ? "finished" : currentStep(entries);
  const threadId = threadIdOf(entries);
  const parsed = parseRunId(runId);
  const issue = parsed ? issueRef(`${parsed.owner}/${parsed.repo}`, parsed.issue) : null;
  const next = nextStep(entries);
  // The Next step card is this page's own; every other action shows as it does on the belt and list.
  const actions = runActions({
    id: runId,
    state,
    finished: runIsFinished(entries),
    prUrl: prUrlOf(entries),
    threadId,
  }).filter((action) => action.kind !== "next");

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
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          <Badge variant={stateBadgeVariant(shown)}>{labelForState(shown)}</Badge>
          <span className="min-w-0 break-words text-muted-foreground">Step: {step ?? "-"}</span>
          <span className="ml-auto">
            <RunActions
              actions={actions}
              environmentId={environmentId}
              label={issue?.text ?? runId}
              runId={runId}
              stop={stopOf(environmentId, runId, issue?.text ?? runId)}
              touch
            />
          </span>
        </div>
        {note ? (
          <p className="break-words text-sm text-muted-foreground" role="status">
            {note}
          </p>
        ) : null}
        <RunReportCard entries={entries} />
        {next ? (
          <RunNextStep
            environmentId={environmentId}
            issue={issue}
            prUrl={prUrlOf(entries)}
            step={next}
            threadId={threadId}
          />
        ) : null}
        {threadId !== null && !runIsFinished(entries) ? (
          <RunAgentCard
            environmentId={environmentId}
            stateLabel={labelForState(shown)}
            threadId={threadId}
          />
        ) : null}
        <RunTimeline entries={entries} environmentId={environmentId} />
        <GateOutput entries={entries} />
        <Ledger entries={entries} skipped={run.data.skipped} truncated={run.data.truncated} />
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
          {queued?.title ? (
            <Tooltip>
              <TooltipTrigger render={<h1 className="min-w-0 truncate text-sm font-medium" />}>
                {queued.title}
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
