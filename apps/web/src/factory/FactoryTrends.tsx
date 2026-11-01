import type { EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import { Button, InlineButton } from "~/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { cn } from "~/lib/utils";

import type { FactoryRunRow } from "./api";
import "./belt.css";
import { FactoryCard, FactoryCardHeader } from "./FactoryCard";
import { parseRunId } from "./format";
import { runLinkKey, runQueue, type QueueOrigin } from "./runQueue";
import { formatSpanMinutes } from "./runStory";
import {
  causesInWeek,
  factoryTrends,
  type TrendCause,
  type TrendFigures,
  type TrendOutcome,
  type TrendWeek,
} from "./trends";

/** A run as Trends gets it: which environment it came from, to link to its page. */
export interface TrendRun {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly run: FactoryRunRow;
}

/** The week a click picked, an index into the weeks; null for all of them. */
interface WeekPick {
  readonly week: number | null;
  readonly onWeek: (week: number | null) => void;
}

/** Bottom to top: what ended well, then what stopped, then what is still going. */
const STACK: ReadonlyArray<{ outcome: TrendOutcome; color: string; word: string }> = [
  { outcome: "merged", color: "var(--factory-done)", word: "merged" },
  {
    outcome: "closed",
    color: "color-mix(in srgb, var(--muted-foreground) 45%, transparent)",
    word: "closed",
  },
  { outcome: "stuck", color: "var(--factory-stuck)", word: "stuck" },
  { outcome: "info", color: "var(--factory-info)", word: "needs info" },
  { outcome: "active", color: "var(--factory-pr)", word: "in flight" },
];

const percent = (rate: number | null) => (rate === null ? "-" : `${Math.round(rate * 100)}%`);
const span = (ms: number | null) => (ms === null ? "-" : formatSpanMinutes(ms));

const weekLabel = (week: TrendWeek, last: boolean) =>
  last
    ? "This week"
    : new Date(week.startMs).toLocaleDateString(undefined, { day: "numeric", month: "short" });

const weekSummary = (week: TrendWeek) =>
  STACK.filter(({ outcome }) => week.counts[outcome] > 0)
    .map(({ outcome, word }) => `${week.counts[outcome]} ${word}`)
    .join(", ") || "no runs";

/**
 * How `now` stands against `before`, and whether that is good news: `lower` says a fall is better.
 * Within `same` of each other they read as the same.
 */
function change(
  now: number | null,
  before: number | null,
  lower: boolean,
  same: number,
  show: (value: number) => string,
): { text: string; tone: "good" | "bad" | "same" } | null {
  if (now === null || before === null) return null;
  if (Math.abs(now - before) <= same)
    return { text: `about the same as ${show(before)}`, tone: "same" };
  const up = now > before;
  return {
    text: `${up ? "up" : "down"} from ${show(before)}`,
    tone: up === lower ? "bad" : "good",
  };
}

const TONE_CLASS = {
  good: "text-success-foreground",
  bad: "text-destructive-foreground",
  same: "text-muted-foreground",
} as const;

function Figure({
  label,
  value,
  note,
  delta,
}: {
  label: string;
  value: string;
  note: string;
  delta: ReturnType<typeof change>;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-lg bg-muted/40 px-3 py-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <b className="font-mono text-xl font-semibold leading-tight">{value}</b>
      <span className={`text-xs ${delta ? TONE_CLASS[delta.tone] : "text-muted-foreground"}`}>
        {delta?.text ?? note}
      </span>
    </div>
  );
}

function Figures({ now, before }: { now: TrendFigures; before: TrendFigures | null }) {
  const first = "no earlier week to compare";
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <Figure
        delta={null}
        label="Merged this week"
        note={before === null ? first : `so far; ${Number(before.merged.toFixed(1))} a week before`}
        value={String(now.merged)}
      />
      <Figure
        delta={change(now.stuckRate, before?.stuckRate ?? null, true, 0.02, percent)}
        label="Stuck"
        note={before === null ? first : "nothing ended yet"}
        value={percent(now.stuckRate)}
      />
      <Figure
        delta={change(now.infoRate, before?.infoRate ?? null, true, 0.02, percent)}
        label="Needs info"
        note={before === null ? first : "nothing ended yet"}
        value={percent(now.infoRate)}
      />
      <Figure
        delta={change(
          now.mergeMs,
          before?.mergeMs ?? null,
          true,
          0.1 * (before?.mergeMs ?? 0),
          formatSpanMinutes,
        )}
        label="Claim to merge"
        note={before === null ? first : "nothing merged yet"}
        value={span(now.mergeMs)}
      />
    </div>
  );
}

/** A second click on the picked week lets it go. */
const toggle = (pick: WeekPick, i: number) => pick.onWeek(pick.week === i ? null : i);

function WeekChart({ weeks, pick }: { weeks: ReadonlyArray<TrendWeek>; pick: WeekPick }) {
  const scale = Math.max(1, ...weeks.map((week) => week.total));
  return (
    <div className="flex flex-col gap-2">
      <ol aria-label="Runs per week" className="flex h-44 min-w-0 items-end gap-1.5 sm:gap-3">
        {weeks.map((week, i) => {
          const label = weekLabel(week, i === weeks.length - 1);
          const picked = pick.week === i;
          return (
            <li className="flex h-full min-w-0 flex-1" key={week.startMs}>
              <button
                aria-label={`${label}: ${weekSummary(week)}`}
                aria-pressed={picked}
                className={cn(
                  "group/week flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                  pick.week !== null && !picked && "opacity-40 hover:opacity-70",
                )}
                onClick={() => toggle(pick, i)}
                type="button"
              >
                <span
                  className={cn(
                    "font-mono text-xs",
                    picked ? "font-semibold text-foreground" : "text-muted-foreground",
                  )}
                >
                  {week.total}
                </span>
                <span
                  className={cn(
                    "flex w-full max-w-12 flex-col-reverse overflow-hidden rounded-sm",
                    picked
                      ? "ring-2 ring-foreground ring-offset-2 ring-offset-card"
                      : "group-hover/week:brightness-110",
                  )}
                  style={{ height: `${(week.total / scale) * 100}%` }}
                >
                  {STACK.map(({ outcome, color }) =>
                    week.counts[outcome] > 0 ? (
                      <span
                        className="block w-full"
                        key={outcome}
                        style={{ background: color, flexGrow: week.counts[outcome] }}
                      />
                    ) : null,
                  )}
                </span>
                <span
                  className={cn(
                    "w-full truncate text-center text-2xs",
                    picked ? "font-medium text-foreground" : "text-muted-foreground",
                  )}
                >
                  {label}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      <p aria-hidden className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {STACK.map(({ outcome, color, word }) => (
          <span className="inline-flex items-center gap-1.5" key={outcome}>
            <span className="inline-block size-2 rounded-full" style={{ background: color }} />
            {word}
          </span>
        ))}
      </p>
    </div>
  );
}

function WeekTable({ weeks, pick }: { weeks: ReadonlyArray<TrendWeek>; pick: WeekPick }) {
  const rows = weeks.map((week, i) => ({
    week,
    i,
    label: weekLabel(week, i === weeks.length - 1),
  }));
  const wide = "hidden sm:table-cell";
  return (
    <div className="self-start tabular-nums">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Week of</TableHead>
            <TableHead className={cn(wide, "text-right")}>Runs</TableHead>
            <TableHead className="text-right">Merged</TableHead>
            <TableHead className="text-right">Stuck</TableHead>
            <TableHead className="text-right">Needs info</TableHead>
            <TableHead className="text-right">To merge</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.toReversed().map(({ week, i, label }) => (
            <TableRow data-state={pick.week === i ? "selected" : undefined} key={week.startMs}>
              <TableCell>
                <button
                  aria-pressed={pick.week === i}
                  className="-mx-1 min-h-8 rounded-sm px-1 text-left underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-pressed:font-semibold pointer-coarse:min-h-11"
                  onClick={() => toggle(pick, i)}
                  type="button"
                >
                  {label}
                </button>
              </TableCell>
              <TableCell className={cn(wide, "text-right")}>{week.total}</TableCell>
              <TableCell className="text-right">{week.counts.merged}</TableCell>
              <TableCell className="text-right">{percent(week.stuckRate)}</TableCell>
              <TableCell className="text-right">{percent(week.infoRate)}</TableCell>
              <TableCell className="text-right">{span(week.mergeMs)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

const dayOf = (iso: string | null) =>
  iso === null
    ? null
    : new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });

/** How many of a cause's runs show before "Show N more"; a cause can hold a hundred. */
const CAUSE_PAGE = 10;

/**
 * Stuck runs by cause, for every week or the one picked: each cause a fold with its weekly bars
 * and count that opens on its runs, newest first, each a link to its page. The links carry the
 * cause's runs as a queue, so j and k step through every run one cause stopped.
 */
function StuckCauses({
  causes: allCauses,
  weeks,
  pick,
  runs,
  origin,
}: {
  causes: ReadonlyArray<TrendCause>;
  weeks: ReadonlyArray<TrendWeek>;
  pick: WeekPick;
  runs: ReadonlyArray<TrendRun>;
  origin: QueueOrigin;
}) {
  if (allCauses.length === 0) return null;
  const causes = causesInWeek(allCauses, pick.week);
  const picked = pick.week === null ? null : weeks[pick.week]!;
  const pickedLabel =
    picked === null
      ? null
      : pick.week === weeks.length - 1
        ? "this week"
        : `the week of ${weekLabel(picked, false)}`;
  const scale = Math.max(1, ...allCauses.flatMap(({ perWeek }) => perWeek));
  const placeOf = new Map(runs.map((entry) => [entry.run, entry]));
  const severalEnvironments = new Set(runs.map(({ environmentId }) => environmentId)).size > 1;
  return (
    <FactoryCard aria-label="Why runs got stuck">
      <FactoryCardHeader
        aside={
          picked === null ? null : (
            <Button onClick={() => pick.onWeek(null)} size="xs" variant="outline">
              All weeks
            </Button>
          )
        }
        eyebrow={
          pickedLabel === null ? "Stuck runs by cause" : `Stuck runs by cause · ${pickedLabel}`
        }
        title={pickedLabel === null ? "Why runs got stuck" : `Why runs got stuck ${pickedLabel}`}
      />
      {causes.length === 0 ? (
        <p className="text-sm text-muted-foreground">No run claimed {pickedLabel} got stuck.</p>
      ) : (
        <div className="flex flex-col divide-y">
          {causes.map(({ cause, total, perWeek, runs: causeRuns }) => (
            <CauseFold
              cause={cause}
              entries={causeRuns.flatMap(({ run, detail }) => {
                const place = placeOf.get(run);
                return place ? [{ ...place, detail }] : [];
              })}
              key={`${pick.week ?? "all"} ${cause}`}
              origin={origin}
              perWeek={perWeek}
              pickedWeek={pick.week}
              scale={scale}
              severalEnvironments={severalEnvironments}
              total={total}
              weeks={weeks}
            />
          ))}
        </div>
      )}
    </FactoryCard>
  );
}

function CauseFold({
  cause,
  total,
  perWeek,
  entries,
  weeks,
  pickedWeek,
  scale,
  origin,
  severalEnvironments,
}: {
  cause: string;
  total: number;
  perWeek: ReadonlyArray<number>;
  entries: ReadonlyArray<TrendRun & { readonly detail: string | null }>;
  weeks: ReadonlyArray<TrendWeek>;
  pickedWeek: number | null;
  scale: number;
  origin: QueueOrigin;
  severalEnvironments: boolean;
}) {
  const [limit, setLimit] = useState(CAUSE_PAGE);
  const queue = runQueue(
    origin,
    entries.map(({ environmentId, run }) => ({
      environmentId,
      runId: run.id,
      title: run.title ?? null,
    })),
  );
  return (
    <Collapsible data-cause={cause}>
      <CollapsibleTrigger className="group/cause flex min-h-9 w-full min-w-0 items-center gap-3 rounded-sm py-2 text-left outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring pointer-coarse:min-h-11">
        <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-panel-open/cause:rotate-90" />
        <span className="min-w-0 flex-1 text-sm break-words">{cause}</span>
        <span
          aria-label={`Per week: ${perWeek.join(", ")}`}
          className="flex h-5 shrink-0 items-end gap-0.5"
          role="img"
        >
          {perWeek.map((count, i) => (
            <span
              className={cn(
                "w-2 rounded-xs bg-muted",
                pickedWeek !== null && pickedWeek !== i && "opacity-40",
              )}
              key={weeks[i]!.startMs}
              style={
                count > 0
                  ? {
                      height: `${Math.max(15, (count / scale) * 100)}%`,
                      background: "var(--factory-stuck)",
                    }
                  : { height: "15%" }
              }
            />
          ))}
        </span>
        <b className="w-8 shrink-0 text-right font-mono text-sm font-semibold">{total}</b>
      </CollapsibleTrigger>
      <CollapsiblePanel animate={false}>
        <ul
          className="mb-2 ml-1.5 flex flex-col divide-y border-l border-(--factory-station)/40 pl-3"
          data-station="stuck"
        >
          {entries.slice(0, limit).map(({ environmentId, label, run, detail }) => {
            const parsed = parseRunId(run.id);
            return (
              <li
                className="flex flex-col gap-0.5 py-1.5 text-sm"
                key={runLinkKey(environmentId, run.id)}
              >
                <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                  <InlineButton
                    className="font-mono font-semibold pointer-coarse:min-h-11"
                    render={
                      <Link
                        data-run-link={runLinkKey(environmentId, run.id)}
                        params={{ environmentId, runId: run.id }}
                        state={{ factoryRunQueue: queue }}
                        to="/factory/$environmentId/$runId"
                      />
                    }
                  >
                    {parsed ? `#${parsed.issue}` : run.id}
                  </InlineButton>
                  {run.title ? <span className="min-w-0 break-words">{run.title}</span> : null}
                  {parsed ? (
                    <span className="min-w-0 break-all font-mono text-xs text-muted-foreground">
                      {parsed.owner}/{parsed.repo}
                    </span>
                  ) : null}
                  {severalEnvironments ? (
                    <span className="text-xs text-muted-foreground">{label}</span>
                  ) : null}
                  <span className="ml-auto text-xs text-muted-foreground">
                    {dayOf(run.started_ts)}
                  </span>
                </div>
                {detail ? (
                  <p className="line-clamp-2 break-words text-xs text-muted-foreground">{detail}</p>
                ) : null}
              </li>
            );
          })}
        </ul>
        {entries.length > limit ? (
          <Button
            className="mb-2 ml-4"
            onClick={() => setLimit((n) => n + CAUSE_PAGE * 5)}
            size="xs"
            variant="ghost"
          >
            Show {Math.min(entries.length - limit, CAUSE_PAGE * 5)} more of {entries.length}
          </Button>
        ) : null}
      </CollapsiblePanel>
    </Collapsible>
  );
}

/**
 * How the factory has done over the last weeks, from the full runs list the page already reads:
 * each week's runs by how they came out, this week against the weeks before, and the causes that
 * stopped runs, so a change to how issues are written or to the config shows in the weeks after.
 */
export function FactoryTrends({
  runs,
  nowMs,
  origin,
}: {
  runs: ReadonlyArray<TrendRun>;
  nowMs: number;
  /** The page's filters, for a run page's Back and stepping. */
  origin: QueueOrigin;
}) {
  const [pickedWeek, setPickedWeek] = useState<number | null>(null);
  const trends = factoryTrends(
    runs.map(({ run }) => run),
    nowMs,
  );
  if (trends === null) {
    return <p className="text-sm text-muted-foreground">No runs to chart yet.</p>;
  }
  const { weeks, now, before, causes } = trends;
  // A filter that shortens the weeks may leave the pick past the end.
  const pick: WeekPick = {
    week: pickedWeek !== null && pickedWeek < weeks.length ? pickedWeek : null,
    onWeek: setPickedWeek,
  };
  const total = weeks.reduce((sum, week) => sum + week.total, 0);
  return (
    <section aria-label="Trends" className="flex min-w-0 flex-col gap-4">
      <FactoryCard>
        <FactoryCardHeader
          eyebrow="Runs per week"
          title={`The last ${weeks.length} ${weeks.length === 1 ? "week" : "weeks"}`}
        />
        <p className="-mt-2 text-xs text-muted-foreground">
          {total} runs, each in the week it was claimed. Rates are of the runs that ended.
          {causes.length > 0 ? " Pick a week to see why its runs got stuck." : ""}
        </p>
        <Figures before={before} now={now} />
        <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <WeekChart pick={pick} weeks={weeks} />
          <WeekTable pick={pick} weeks={weeks} />
        </div>
      </FactoryCard>
      <StuckCauses causes={causes} origin={origin} pick={pick} runs={runs} weeks={weeks} />
    </section>
  );
}
