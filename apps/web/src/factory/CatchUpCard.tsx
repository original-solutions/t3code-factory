import type { EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import type { ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { useLocalStorage } from "~/hooks/useLocalStorage";

import type { FactoryRunRow } from "./api";
import { formatClock } from "./belt";
import { catchUp, catchUpSince, type CatchUpRun } from "./catchUp";
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
function Count({ color, value, word }: { color: string; value: number; word: string }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span
        aria-hidden
        className="inline-block size-2 rounded-full"
        style={{ background: color }}
      />
      <b className="font-mono text-lg font-semibold leading-none">{value}</b>
      <span className="text-sm text-muted-foreground">{word}</span>
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
 * read. Static between reads; a pure fold of the recent lists the page already reads.
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
        className="flex flex-wrap items-baseline gap-x-2 rounded-lg border bg-card px-5 py-2.5 text-sm"
      >
        <h2 className="font-medium">{heading}</h2>
        <span className="text-muted-foreground">nothing new: no runs claimed or finished.</span>
      </section>
    );
  }

  return (
    <section
      aria-label="Since you caught up"
      className="flex flex-col gap-3 rounded-lg border bg-card px-5 py-3.5"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-col">
          <h2 className="text-sm font-medium">{heading}</h2>
          <span className="text-xs text-muted-foreground">
            {markMs === sinceMs
              ? `${formatAge(sinceMs, nowMs)} ago`
              : "Mark caught up and your next visit starts from here."}
          </span>
        </div>
        <div className="ml-auto">
          <Button onClick={() => setMarkMs(nowMs)} size="sm" variant="outline">
            Mark caught up
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-2">
        <Count color={TONE.merged.color} value={merged.length} word="merged" />
        <Count color={TONE.stuck.color} value={stopped.length} word="need you" />
        <Count color={TONE.closed.color} value={closed.length} word="closed" />
        <Count color="var(--factory-claimed)" value={claimed} word="claimed" />
      </div>

      {stopped.length === 0 ? null : (
        <ul aria-label="Stopped for you" className="flex flex-col divide-y border-t">
          {stopped.map((run) => {
            const tone = TONE[run.outcome];
            const text =
              run.outcome === "stuck" ? splitStuckReason(run.reason).cause : run.reason?.trim();
            return (
              <li
                className="flex min-w-0 gap-3 py-2 text-sm last:pb-0"
                data-outcome={run.outcome}
                key={run.key}
              >
                <span
                  aria-hidden
                  className="w-0.5 shrink-0 self-stretch rounded-full"
                  style={{ background: tone.color }}
                />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="flex flex-wrap items-baseline gap-x-2">
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
                    <p className="line-clamp-2 break-words text-xs text-muted-foreground">{text}</p>
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
    </section>
  );
}
