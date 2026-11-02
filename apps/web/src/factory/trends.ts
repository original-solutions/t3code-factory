import type { FactoryRunRow } from "./api";
import { shownState } from "./format";
import { splitStuckReason } from "./stuckCauses";

/** How a run claimed in a week came out; `other` is unreadable or ended some other way. */
export type TrendOutcome = "merged" | "closed" | "stuck" | "info" | "active" | "other";

export interface TrendWeek {
  /** Local Monday, midnight. */
  readonly startMs: number;
  readonly counts: Readonly<Record<TrendOutcome, number>>;
  /** Runs claimed this week, `other` aside. */
  readonly total: number;
  /** Of the runs that ended; null when none did. */
  readonly stuckRate: number | null;
  readonly infoRate: number | null;
  /** Median claim-to-merge of the runs that merged; null without one. */
  readonly mergeMs: number | null;
}

export interface TrendFigures {
  readonly merged: number;
  readonly stuckRate: number | null;
  readonly infoRate: number | null;
  readonly mergeMs: number | null;
}

export interface Trends {
  readonly weeks: ReadonlyArray<TrendWeek>;
  /** This week so far. */
  readonly now: TrendFigures;
  /** The weeks before this one that ended anything, up to `BASELINE_WEEKS`; null without one. */
  readonly before: TrendFigures | null;
  /** Stuck runs by cause, most first, with a count for each of `weeks`. */
  readonly causes: ReadonlyArray<TrendCause>;
}

export interface TrendCause {
  readonly cause: string;
  readonly total: number;
  readonly perWeek: ReadonlyArray<number>;
  /** Newest claim first; `week` indexes `weeks`, `detail` is the reason past its cause. */
  readonly runs: ReadonlyArray<{
    readonly run: FactoryRunRow;
    readonly week: number;
    readonly detail: string | null;
  }>;
}

const BASELINE_WEEKS = 4;

export function weekStart(ms: number): number {
  const date = new Date(ms);
  const back = (date.getDay() + 6) % 7;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - back).getTime();
}

const addWeeks = (startMs: number, weeks: number) => {
  const date = new Date(startMs);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 7 * weeks).getTime();
};

function outcomeOf(run: FactoryRunRow): TrendOutcome {
  if (run.unreadable) return "other";
  const state = shownState(run.state, run.pr_end);
  if (state === "merged" || state === "closed" || state === "stuck") return state;
  if (state === "needs-info") return "info";
  return run.finished ? "other" : "active";
}

const median = (values: ReadonlyArray<number>): number | null => {
  if (values.length === 0) return null;
  const sorted = values.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

interface Bucket {
  readonly counts: Record<TrendOutcome, number>;
  readonly mergeTimes: Array<number>;
}

const emptyCounts = (): Record<TrendOutcome, number> => ({
  merged: 0,
  closed: 0,
  stuck: 0,
  info: 0,
  active: 0,
  other: 0,
});

/** The rates and merge time of runs pooled from `buckets`. */
const figures = (buckets: ReadonlyArray<Bucket>, merged: number): TrendFigures => {
  let stuck = 0;
  let info = 0;
  let ended = 0;
  for (const { counts } of buckets) {
    stuck += counts.stuck;
    info += counts.info;
    ended += counts.merged + counts.closed + counts.stuck + counts.info;
  }
  return {
    merged,
    stuckRate: ended === 0 ? null : stuck / ended,
    infoRate: ended === 0 ? null : info / ended,
    mergeMs: median(buckets.flatMap(({ mergeTimes }) => mergeTimes)),
  };
};

const endedAny = ({ counts }: Bucket) =>
  counts.merged + counts.closed + counts.stuck + counts.info > 0;

/**
 * The runs by the week they were claimed, from the first week with a run (at most `maxWeeks` back)
 * to this one, so a change to how issues are written or to the config shows in the weeks after it.
 * Null when no run has a start time.
 */
export function factoryTrends(
  runs: ReadonlyArray<FactoryRunRow>,
  nowMs: number,
  maxWeeks = 8,
): Trends | null {
  const dated = runs.flatMap((run) => {
    const ms = run.started_ts === null ? Number.NaN : Date.parse(run.started_ts);
    return Number.isFinite(ms) ? [{ run, ms }] : [];
  });
  if (dated.length === 0) return null;
  const thisWeek = weekStart(nowMs);
  const earliest = addWeeks(thisWeek, -(maxWeeks - 1));
  const first = Math.max(earliest, weekStart(Math.min(...dated.map(({ ms }) => ms))));
  const starts: Array<number> = [];
  for (let start = first; start <= thisWeek; start = addWeeks(start, 1)) starts.push(start);
  const buckets: Array<Bucket> = starts.map(() => ({ counts: emptyCounts(), mergeTimes: [] }));
  const causes = new Map<
    string,
    { perWeek: Array<number>; runs: Array<TrendCause["runs"][number] & { ms: number }> }
  >();
  for (const { run, ms } of dated) {
    const index = starts.findLastIndex((start) => start <= ms);
    if (index === -1 || ms >= addWeeks(thisWeek, 1)) continue;
    const bucket = buckets[index]!;
    const outcome = outcomeOf(run);
    bucket.counts[outcome]++;
    if (outcome === "merged" && run.total_ms !== null) bucket.mergeTimes.push(run.total_ms);
    if (outcome === "stuck") {
      const { cause, detail } = splitStuckReason(run.reason ?? null);
      const group = causes.get(cause) ?? { perWeek: starts.map(() => 0), runs: [] };
      group.perWeek[index]!++;
      group.runs.push({ run, week: index, detail, ms });
      causes.set(cause, group);
    }
  }
  const weeks = buckets.map((bucket, i): TrendWeek => {
    const { counts } = bucket;
    const { stuckRate, infoRate, mergeMs } = figures([bucket], counts.merged);
    return {
      startMs: starts[i]!,
      counts,
      total: counts.merged + counts.closed + counts.stuck + counts.info + counts.active,
      stuckRate,
      infoRate,
      mergeMs,
    };
  });
  const current = buckets.at(-1)!;
  const baseline = buckets.slice(0, -1).slice(-BASELINE_WEEKS).filter(endedAny);
  return {
    weeks,
    now: figures([current], current.counts.merged),
    before:
      baseline.length === 0
        ? null
        : figures(
            baseline,
            baseline.reduce((sum, { counts }) => sum + counts.merged, 0) / baseline.length,
          ),
    causes: Array.from(causes, ([cause, { perWeek, runs: group }]) => ({
      cause,
      total: perWeek.reduce((sum, n) => sum + n, 0),
      perWeek,
      runs: group
        .toSorted((a, b) => b.ms - a.ms)
        .map(({ run, week, detail }) => ({ run, week, detail })),
    })).toSorted((a, b) => b.total - a.total),
  };
}

/** The causes of one week (an index into `weeks`), most first, with that week's count and runs; all of them for null. */
export function causesInWeek(
  causes: ReadonlyArray<TrendCause>,
  week: number | null,
): ReadonlyArray<TrendCause> {
  if (week === null) return causes;
  return causes
    .map((cause) => ({
      ...cause,
      total: cause.perWeek[week] ?? 0,
      runs: cause.runs.filter((entry) => entry.week === week),
    }))
    .filter(({ total }) => total > 0)
    .toSorted((a, b) => b.total - a.total);
}
