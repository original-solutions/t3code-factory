import type { FactoryRunRow, FactoryStatus } from "./api";
import { newestAttempts, stationOf } from "./belt";
import { parseRunId } from "./format";

/** `owner/name` of a run, from its id; null for an id that does not parse. */
export const repoOfRun = (id: string): string | null => {
  const parsed = parseRunId(id);
  return parsed ? `${parsed.owner}/${parsed.repo}` : null;
};

/**
 * What a repo needs, worst first: a run stuck, a run waiting on an answer, a run in flight, a merge
 * in the last seven days, or none of those.
 */
export type RepoVerdict = "stuck" | "info" | "moving" | "flowing" | "quiet";

const ORDER: ReadonlyArray<RepoVerdict> = ["stuck", "info", "moving", "flowing", "quiet"];

export interface RepoDay {
  /** Local midnight that starts the day (epoch ms). */
  readonly startMs: number;
  /** Newest attempts that ended this day merged. */
  readonly merged: number;
  /** Newest attempts that ended this day stuck or needing info. */
  readonly stopped: number;
}

export interface RepoHealth {
  readonly repo: string;
  readonly verdict: RepoVerdict;
  readonly stuck: number;
  readonly info: number;
  /** Unfinished runs on a post of the belt. */
  readonly inFlight: number;
  /** Merged in the last seven days. */
  readonly merged: number;
  /** The latest merge the recent window knows, which may be older than the seven days. */
  readonly lastMergeMs: number | null;
  /** The last seven local days, oldest first. */
  readonly days: ReadonlyArray<RepoDay>;
}

const STRIP_DAYS = 7;

const endOf = (row: FactoryRunRow) =>
  (row.started_ts ? Date.parse(row.started_ts) : Number.NaN) + (row.total_ms ?? Number.NaN);

const verdictOf = (repo: Omit<RepoHealth, "verdict" | "repo" | "days">): RepoVerdict =>
  repo.stuck > 0
    ? "stuck"
    : repo.info > 0
      ? "info"
      : repo.inFlight > 0
        ? "moving"
        : repo.merged > 0
          ? "flowing"
          : "quiet";

/** Within a verdict: the most to act on first, the freshest merge for flowing repos, then by name. */
const rank = (a: RepoHealth, b: RepoHealth): number =>
  ORDER.indexOf(a.verdict) - ORDER.indexOf(b.verdict) ||
  b.stuck - a.stuck ||
  b.info - a.info ||
  b.inFlight - a.inFlight ||
  (b.lastMergeMs ?? 0) - (a.lastMergeMs ?? 0) ||
  a.repo.toLowerCase().localeCompare(b.repo.toLowerCase());

/**
 * One line per repo across the given environments: what it needs (its verdict) and how its week
 * went, from the status report's unfinished runs and the recent runs list the page already reads.
 * Only the newest attempt of an issue counts, so a retried stuck run stops marking its repo; a repo
 * is joined across environments without regard to case.
 */
export function repoBoard(
  environments: ReadonlyArray<{
    readonly active: ReadonlyArray<FactoryStatus["runs"][number]>;
    readonly recent: ReadonlyArray<FactoryRunRow>;
  }>,
  nowMs: number,
): Array<RepoHealth> {
  const today = new Date(nowMs);
  today.setHours(0, 0, 0, 0);
  const dayStarts = Array.from({ length: STRIP_DAYS + 1 }, (_, i) => {
    const day = new Date(today);
    day.setDate(day.getDate() - (STRIP_DAYS - 1) + i);
    return day.getTime();
  });

  interface Tally {
    repo: string;
    stuck: number;
    info: number;
    inFlight: number;
    merged: number;
    lastMergeMs: number | null;
    days: Array<{ startMs: number; merged: number; stopped: number }>;
  }
  const tallies = new Map<string, Tally>();
  const tallyOf = (id: string): Tally | null => {
    const repo = repoOfRun(id);
    if (repo === null) return null;
    const key = repo.toLowerCase();
    let tally = tallies.get(key);
    if (tally === undefined) {
      tally = {
        repo,
        stuck: 0,
        info: 0,
        inFlight: 0,
        merged: 0,
        lastMergeMs: null,
        days: dayStarts.slice(0, STRIP_DAYS).map((startMs) => ({ startMs, merged: 0, stopped: 0 })),
      };
      tallies.set(key, tally);
    }
    return tally;
  };
  const dayOf = (tally: Tally, ms: number) => {
    const index = dayStarts.findIndex(
      (start, i) => i < STRIP_DAYS && ms >= start && ms < dayStarts[i + 1]!,
    );
    return index === -1 ? null : tally.days[index]!;
  };

  for (const { active, recent } of environments) {
    for (const run of active) {
      if (run.unreadable || stationOf(run) === null) continue;
      const tally = tallyOf(run.id);
      if (tally) tally.inFlight++;
    }
    for (const row of newestAttempts(recent)) {
      const tally = tallyOf(row.id);
      if (tally === null || !row.finished) continue;
      const endMs = endOf(row);
      if (row.pr_end === "merged") {
        if (Number.isNaN(endMs)) continue;
        tally.lastMergeMs = Math.max(tally.lastMergeMs ?? endMs, endMs);
        const day = dayOf(tally, endMs);
        if (day) {
          day.merged++;
          tally.merged++;
        }
      } else if (row.pr_end === "closed") {
        continue;
      } else if (row.state === "stuck" || row.state === "needs-info") {
        if (row.state === "stuck") tally.stuck++;
        else tally.info++;
        const day = Number.isNaN(endMs) ? null : dayOf(tally, endMs);
        if (day) day.stopped++;
      }
    }
  }

  return Array.from(tallies.values(), (tally) => ({ ...tally, verdict: verdictOf(tally) })).sort(
    rank,
  );
}
