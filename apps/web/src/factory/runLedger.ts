import type { FactoryRunRow } from "./api";
import { parseRunId, prRef, shownState } from "./format";

/** The ledger's state chips; `other` is a run none of them names, listed only under All. */
export type RunBucket = "active" | "attention" | "merged" | "closed" | "other";
export type RunBucketFilter = Exclude<RunBucket, "other">;

export const RUN_BUCKETS: ReadonlyArray<{
  readonly value: RunBucketFilter;
  readonly label: string;
}> = [
  { value: "active", label: "Active" },
  { value: "attention", label: "Needs a person" },
  { value: "merged", label: "Merged" },
  { value: "closed", label: "Closed" },
];

export const isRunBucket = (value: unknown): value is RunBucketFilter =>
  RUN_BUCKETS.some((bucket) => bucket.value === value);

export function bucketOf(run: FactoryRunRow): RunBucket {
  if (run.unreadable) return "other";
  const state = shownState(run.state, run.pr_end);
  if (state === "merged" || state === "closed") return state;
  if (state === "stuck" || state === "needs-info") return "attention";
  return run.finished ? "other" : "active";
}

export type BucketCounts = Record<RunBucketFilter | "all", number>;

export function countBuckets(runs: Iterable<FactoryRunRow>): BucketCounts {
  const counts: BucketCounts = { all: 0, active: 0, attention: 0, merged: 0, closed: 0 };
  for (const run of runs) {
    counts.all++;
    const bucket = bucketOf(run);
    if (bucket !== "other") counts[bucket]++;
  }
  return counts;
}

/**
 * Every word of `query` is found in the run's title, repo, run id or environment, case aside. A
 * word starting with `#` names an issue or pull request exactly, so `#2` does not find `#20`.
 */
export function matchesQuery(run: FactoryRunRow, environment: string, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const parsed = parseRunId(run.id);
  const refs = [parsed ? `#${parsed.issue}` : null, prRef(run.pr_url)?.text ?? null]
    .filter((ref): ref is string => ref !== null)
    .map((ref) => ref.toLowerCase());
  const text = [
    run.title ?? "",
    parsed ? `${parsed.owner}/${parsed.repo}` : "",
    run.id,
    environment,
  ]
    .join(" ")
    .toLowerCase();
  return words.every((word) => (word.startsWith("#") ? refs.includes(word) : text.includes(word)));
}

const startOfDay = (ms: number) => {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
};

/** Today, Yesterday, or the local date, for a day heading. */
export function dayLabel(ms: number, nowMs: number): string {
  if (!Number.isFinite(ms)) return "No start time";
  const today = startOfDay(nowMs);
  const day = startOfDay(ms);
  if (day === today) return "Today";
  if (day === startOfDay(today - 1)) return "Yesterday";
  return new Date(ms).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(new Date(ms).getFullYear() === new Date(nowMs).getFullYear() ? {} : { year: "numeric" }),
  });
}

/** Already-sorted items cut into runs of the same local day, in the order given. */
export function groupByDay<T>(
  items: ReadonlyArray<T>,
  msOf: (item: T) => number,
  nowMs: number,
): Array<{ readonly label: string; readonly items: Array<T> }> {
  const groups: Array<{ label: string; items: Array<T> }> = [];
  for (const item of items) {
    const label = dayLabel(msOf(item), nowMs);
    const last = groups.at(-1);
    if (last?.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}

/** How many runs the ledger renders before it asks to show more. */
export const LEDGER_PAGE = 50;

/** The first `shown` items across `days`; a cut day keeps its full count in `total`. */
export function firstOfDays<T>(
  days: ReadonlyArray<{ readonly label: string; readonly items: ReadonlyArray<T> }>,
  shown: number,
): {
  readonly days: Array<{
    readonly label: string;
    readonly items: Array<T>;
    readonly total: number;
  }>;
  readonly hidden: number;
} {
  const out: Array<{ label: string; items: Array<T>; total: number }> = [];
  let left = shown;
  let hidden = 0;
  for (const { label, items } of days) {
    if (left > 0) out.push({ label, items: items.slice(0, left), total: items.length });
    hidden += Math.max(0, items.length - left);
    left = Math.max(0, left - items.length);
  }
  return { days: out, hidden };
}
