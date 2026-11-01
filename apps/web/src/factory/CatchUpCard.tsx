import type { EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import type { ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { cn } from "~/lib/utils";

import type { FactoryRunRow } from "./api";
import { formatClock } from "./belt";
import { catchUp, catchUpSince, type CatchUpRun } from "./catchUp";
import { DIAL_CELL, DialButton, DialDetail, useControlFold } from "./ControlFold";
import { formatAge } from "./format";
import { dayLabel } from "./runLedger";
import { runLinkKey, runQueue, type QueueOrigin } from "./runQueue";
import { splitStuckReason } from "./stuckCauses";
import { TouchLink } from "./TouchLink";

/** This browser's "caught up" mark: one per browser, across every environment it reads. */
const CAUGHT_UP_KEY = "t3code:factory:caught-up-at";
const MarkSchema = Schema.NullOr(Schema.Number);

const TONE: Record<CatchUpRun["outcome"], { color: string; word: string }> = {
  merged: { color: "var(--factory-done)", word: "merged" },
  closed: { color: "var(--muted-foreground)", word: "closed" },
  stuck: { color: "var(--factory-stuck)", word: "stuck" },
  info: { color: "var(--factory-info)", word: "needs info" },
};

const sinceText = (markMs: number | null, sinceMs: number, nowMs: number) => {
  if (markMs === null || markMs !== sinceMs) {
    return markMs === null ? "In the last day" : "In the last week";
  }
  const day = dayLabel(sinceMs, nowMs);
  const when = day === "Today" ? "" : `${day === "Yesterday" ? "yesterday" : day} `;
  return `Since you caught up ${when}at ${formatClock(sinceMs)}`;
};

function RunLink({
  run,
  queue,
  children,
}: {
  run: CatchUpRun;
  queue: ReturnType<typeof runQueue> | undefined;
  children: ReactNode;
}) {
  return (
    <TouchLink
      className="font-mono font-semibold"
      render={
        <Link
          data-run-link={runLinkKey(run.environmentId, run.id)}
          params={{ environmentId: run.environmentId, runId: run.id }}
          state={queue ? { factoryRunQueue: queue } : {}}
          title={run.title ?? undefined}
          to="/factory/$environmentId/$runId"
        />
      }
    >
      {children}
    </TouchLink>
  );
}

const queueOf = (origin: QueueOrigin | undefined, runs: ReadonlyArray<CatchUpRun>) =>
  origin === undefined
    ? undefined
    : runQueue(
        origin,
        runs.map((run) => ({ environmentId: run.environmentId, runId: run.id, title: run.title })),
      );

/** One count in the summary line: a tone dot, the number, and what it counts. */
function Count({
  color,
  value,
  word,
  strong = false,
}: {
  color: string;
  value: number;
  word: string;
  /** Wants a person: the word in its tone. */
  strong?: boolean;
}) {
  return (
    <span className="inline-flex items-baseline gap-1">
      <span
        aria-hidden
        className="inline-block size-2 rounded-full"
        style={{ background: color }}
      />
      <b className="font-mono text-sm font-semibold leading-none">{value}</b>
      <span
        className={cn(
          "whitespace-nowrap text-xs",
          strong ? "font-medium" : "text-muted-foreground",
        )}
        style={strong ? { color } : undefined}
      >
        {word}
      </span>
    </span>
  );
}

/** Issues as a line of links: one outcome's runs, newest first. */
function IssueLine({
  label,
  runs,
  origin,
}: {
  label: string;
  runs: ReadonlyArray<CatchUpRun>;
  origin: QueueOrigin | undefined;
}) {
  if (runs.length === 0) return null;
  const queue = queueOf(origin, runs);
  return (
    <p className="flex flex-wrap items-center gap-x-2 text-sm">
      <span className="text-xs text-muted-foreground">{label}</span>
      {runs.map((run) => (
        <RunLink key={run.key} queue={queue} run={run}>
          {run.issue}
        </RunLink>
      ))}
    </p>
  );
}

/**
 * What the factory did since this browser last caught up: what merged and closed, and the runs
 * that stopped for a person, each linking to its run. "Mark caught up" moves the mark to the last
 * read. Static between reads; a pure fold of the recent lists the page already reads. A dial of the
 * belt's control bar, its counts on top and the runs one tap below.
 */
export function CatchUpCard({
  environments,
  nowMs,
  origin,
  showEnvironment,
}: {
  environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly recent: ReadonlyArray<FactoryRunRow>;
  }>;
  nowMs: number;
  origin: QueueOrigin | undefined;
  showEnvironment: boolean;
}) {
  const [markMs, setMarkMs] = useLocalStorage(CAUGHT_UP_KEY, null, MarkSchema);
  const fold = useControlFold("catch-up");
  if (environments.length === 0 || nowMs === 0) return null;
  const sinceMs = catchUpSince(markMs, nowMs);
  const { merged, closed, stopped, claimed } = catchUp(environments, sinceMs);
  const heading = sinceText(markMs, sinceMs, nowMs);
  const quiet = merged.length + closed.length + stopped.length + claimed === 0;
  const stoppedQueue = queueOf(origin, stopped);

  if (quiet) {
    return (
      <section
        aria-label="Since you caught up"
        className={cn(DIAL_CELL, "flex-col justify-center gap-1 px-5 py-2.5")}
      >
        <h2 className="text-xs text-muted-foreground">{heading}</h2>
        <span className="text-sm">Nothing new: no runs claimed or finished.</span>
      </section>
    );
  }

  return (
    <>
      <div className={cn(DIAL_CELL, "flex-wrap items-center")}>
        <DialButton
          controls={fold.id}
          label={`${heading}: ${merged.length} merged, ${stopped.length} need you, ${closed.length} closed, ${claimed} claimed`}
          onToggle={fold.toggle}
          open={fold.open}
        >
          <h2 className="min-w-0 truncate text-xs text-muted-foreground">{heading}</h2>
          <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <Count color={TONE.merged.color} value={merged.length} word="merged" />
            <Count
              color={TONE.stuck.color}
              strong={stopped.length > 0}
              value={stopped.length}
              word="need you"
            />
            <Count color={TONE.closed.color} value={closed.length} word="closed" />
            <Count color="var(--factory-claimed)" value={claimed} word="claimed" />
          </span>
        </DialButton>
        <div className="shrink-0 basis-full px-5 pb-2.5 @md:basis-auto @md:pr-3 @md:pb-0 @md:pl-0">
          <Button onClick={() => setMarkMs(nowMs)} size="xs" variant="outline">
            Mark caught up
          </Button>
        </div>
      </div>

      {fold.open ? (
        <DialDetail id={fold.id} label="What happened since you caught up">
          <div className="flex flex-col gap-3 px-5 py-3">
            <span className="text-xs text-muted-foreground">
              {markMs === sinceMs
                ? `${heading} · ${formatAge(sinceMs, nowMs)} ago`
                : "Mark caught up and your next visit starts from here."}
            </span>
            {stopped.length === 0 ? null : (
              <ul aria-label="Stopped for you" className="flex flex-col divide-y border-t">
                {stopped.map((run) => {
                  const tone = TONE[run.outcome];
                  const text =
                    run.outcome === "stuck"
                      ? splitStuckReason(run.reason).cause
                      : run.reason?.trim();
                  return (
                    <li
                      className="flex min-w-0 gap-3 py-2 text-sm last:pb-0"
                      data-outcome={run.outcome}
                      key={run.key}
                    >
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <div className="flex flex-wrap items-center gap-x-2">
                          <span
                            aria-hidden
                            className="size-2 shrink-0 rounded-full"
                            style={{ background: tone.color }}
                          />
                          <RunLink queue={stoppedQueue} run={run}>
                            {run.issue}
                          </RunLink>
                          {run.title === null ? null : (
                            <span className="min-w-0 break-words">{run.title}</span>
                          )}
                        </div>
                        <span className="flex min-w-0 flex-wrap gap-x-1.5 text-xs text-muted-foreground">
                          <span className="font-medium" style={{ color: tone.color }}>
                            {tone.word}
                          </span>
                          <span>· {formatAge(run.endMs, nowMs)} ago</span>
                          {run.repo === null ? null : (
                            <span className="min-w-0 break-all font-mono">· {run.repo}</span>
                          )}
                          {showEnvironment ? <span>· {run.label}</span> : null}
                        </span>
                        {text ? (
                          <p className="line-clamp-2 break-words text-xs text-muted-foreground">
                            {text}
                          </p>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            {merged.length + closed.length === 0 ? null : (
              <div className="flex flex-col gap-1 border-t pt-2">
                <IssueLine label="Merged" origin={origin} runs={merged} />
                <IssueLine label="Closed" origin={origin} runs={closed} />
              </div>
            )}
          </div>
        </DialDetail>
      ) : null}
    </>
  );
}
