import { Badge } from "~/components/ui/badge";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import { cn } from "~/lib/utils";

import type { FactoryEntry } from "./api";
import { prRef, prUrlOf } from "./format";
import { Ref } from "./Ref";
import { runReport, type ReportMarkKind, type ReportStage } from "./runReport";
import { formatSpan } from "./runStory";

const STAGES: ReadonlyArray<{ stage: ReportStage; word: string; color: string }> = [
  { stage: "agent", word: "Agent building", color: "var(--factory-building)" },
  { stage: "gate", word: "Gate", color: "var(--factory-gate)" },
  { stage: "review", word: "Waiting on review", color: "var(--factory-pr)" },
];
const COLOR = Object.fromEntries(STAGES.map(({ stage, color }) => [stage, color]));

const MARK: Record<ReportMarkKind, string> = {
  "gate-failed": "bg-destructive",
  feedback: "bg-warning",
  "base-moved": "bg-muted-foreground/60",
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const percent = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : 0);

/**
 * The top of a finished run's page: how its pull request ended, where the time from claim to end
 * went, and how often it went back to the agent.
 */
export function RunReportCard({ entries }: { entries: ReadonlyArray<FactoryEntry> }) {
  const report = runReport(entries);
  if (report === null) return null;
  const merged = report.end === "merged";
  const pr = prRef(prUrlOf(entries));
  const startMs = report.segments[0]?.startMs ?? 0;
  const rounds: ReadonlyArray<[ReportMarkKind, number, string]> = [
    [
      "gate-failed",
      report.gateSendBacks,
      plural(report.gateSendBacks, "gate failure fixed", "gate failures fixed"),
    ],
    ["feedback", report.feedbackRounds, plural(report.feedbackRounds, "review round")],
    ["base-moved", report.baseMoves, `base branch moved ${plural(report.baseMoves, "time")}`],
  ];
  const split = STAGES.map(({ stage, word }) => `${word} ${formatSpan(report.totals[stage])}`).join(
    ", ",
  );
  return (
    <section
      aria-label="Run report"
      className={cn(
        "flex flex-col gap-3 rounded-xl border border-l-4 bg-card px-4 py-3",
        merged ? "border-l-success" : "border-l-border",
      )}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          {merged ? (
            <PullRequestGlyph.merged aria-hidden className="size-4 text-success-foreground" />
          ) : (
            <PullRequestGlyph.closed aria-hidden className="size-4 text-muted-foreground" />
          )}
          {merged ? "Merged" : "Closed without merging"}
          {pr ? <Ref {...pr} /> : null}
        </h2>
        <span className="text-sm text-muted-foreground">
          {formatSpan(report.totalMs)} from claim to {merged ? "merge" : "close"}
        </span>
        {report.firstTry ? (
          <Badge className="sm:ml-auto" variant="success">
            First try
          </Badge>
        ) : null}
      </div>
      <div className="flex flex-col gap-1">
        <div
          aria-label={`Where the time went: ${split}`}
          className="flex h-2.5 w-full gap-px overflow-hidden rounded-full bg-muted"
          role="img"
        >
          {report.segments.map((segment) => (
            <span
              className="h-full min-w-0.5"
              key={segment.startMs}
              style={{
                width: `${percent(segment.endMs - segment.startMs, report.totalMs)}%`,
                background: COLOR[segment.stage],
              }}
            />
          ))}
        </div>
        {report.marks.length > 0 ? (
          <div aria-hidden className="relative h-1.5">
            {/* Two marks of one kind at one instant draw as one dot. */}
            {[...new Map(report.marks.map((mark) => [`${mark.kind}@${mark.atMs}`, mark]))].map(
              ([key, mark]) => (
                <span
                  className={cn(
                    "absolute top-0 size-1.5 -translate-x-1/2 rounded-full",
                    MARK[mark.kind],
                  )}
                  key={key}
                  style={{ left: `${percent(mark.atMs - startMs, report.totalMs)}%` }}
                />
              ),
            )}
          </div>
        ) : null}
      </div>
      <ul className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
        {STAGES.map(({ stage, word, color }) => (
          <li className="flex items-center gap-1.5" key={stage}>
            <span aria-hidden className="size-2 rounded-full" style={{ background: color }} />
            <span className="text-muted-foreground">{word}</span>
            <span className="font-mono tabular-nums">{formatSpan(report.totals[stage])}</span>
            <span className="text-muted-foreground tabular-nums">
              {Math.round(percent(report.totals[stage], report.totalMs))}%
            </span>
          </li>
        ))}
      </ul>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <li>{plural(report.sessions, "agent session")}</li>
        {rounds
          .filter(([, n]) => n > 0)
          .map(([kind, , text]) => (
            <li className="flex items-center gap-1.5" key={kind}>
              <span aria-hidden className={cn("size-1.5 rounded-full", MARK[kind])} />
              {text}
            </li>
          ))}
      </ul>
    </section>
  );
}
