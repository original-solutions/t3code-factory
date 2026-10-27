import type { EnvironmentId } from "@t3tools/contracts";

import type { FactoryRunRow, FactoryStatus } from "./api";
import { parseRunId, shownState } from "./format";

/** The posts of the belt, left to right. Done is the bin at the rail's end. */
export const STATIONS = ["claimed", "building", "gate", "pr", "done"] as const;
export type Station = (typeof STATIONS)[number];

/** What a post is called, and the label (or `pr_end` rule) that puts a run there. */
export const STATION_META: Readonly<
  Record<Station, { readonly name: string; readonly tag: string }>
> = {
  claimed: { name: "Claimed", tag: "factory:triage" },
  building: { name: "Building", tag: "factory:building" },
  gate: { name: "Gate", tag: "gate-sending" },
  pr: { name: "PR open", tag: "factory:pr-open" },
  done: { name: "Done", tag: "pr_end: merged · closed" },
};

type StatusRun = FactoryStatus["runs"][number];

/**
 * The station an unfinished run is at, from its state and the event of its last ledger line; null
 * for a state that is on no post (stuck and needs-info runs are in the bins, once finished).
 */
export function stationOf(
  run: Pick<StatusRun, "state" | "last_event">,
): Exclude<Station, "done"> | null {
  switch (run.state) {
    case null:
    case "triage":
      return "claimed";
    case "building":
      return run.last_event === "gate_checkout" || run.last_event === "gate_command"
        ? "gate"
        : "building";
    case "pr-open":
      return "pr";
    default:
      return null;
  }
}

/** The newest attempt of each issue, by repo (without regard to case), issue and attempt number. */
export function newestAttempts<T extends { readonly id: string }>(
  runs: ReadonlyArray<T>,
): Array<T> {
  const newest = new Map<string, { run: T; attempt: number }>();
  for (const run of runs) {
    const parsed = parseRunId(run.id);
    // An id that does not parse is its own issue.
    const key = parsed ? `${parsed.owner}/${parsed.repo}#${parsed.issue}`.toLowerCase() : run.id;
    const attempt = parsed?.attempt ?? 0;
    const known = newest.get(key);
    if (known === undefined || attempt > known.attempt) newest.set(key, { run, attempt });
  }
  return Array.from(newest.values(), ({ run }) => run);
}

/** One environment's part of the belt: its unfinished runs and its recent runs list. */
export interface BeltEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** The status report's `runs`: the runs that are not finished. */
  readonly active: ReadonlyArray<StatusRun>;
  /** The recent runs list: the unfinished runs and the week's finished ones. */
  readonly recent: ReadonlyArray<FactoryRunRow>;
}

/** A run as the rail, the readout and the bins show it. */
export interface BeltRun {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly id: string;
  /** `#20` for a numbered issue, else the run id. */
  readonly issue: string;
  readonly title: string | null;
  readonly state: string | null;
  /** The recent list's `step`, else the state; for a done run, how its pull request ended. */
  readonly step: string | null;
  /** When the run began (Unix epoch ms); NaN when the recent list does not have it. */
  readonly startedMs: number;
  /** How long it has run; for a done run, how long it took. */
  readonly forMs: number | null;
  readonly prUrl: string | null;
  /** For the bins: why a run is stuck, or the questions it posted. */
  readonly reason: string | null;
  /** Whether the run page would enable its Stop: a building run that is not finished. */
  readonly stoppable: boolean;
}

export interface Belt {
  /** The runs at each post, newest start first; Done holds today's, newest finish first. */
  readonly runs: Readonly<Record<Station, ReadonlyArray<BeltRun>>>;
  readonly done: {
    readonly merged: number;
    readonly closed: number;
    /** The issues of the latest three done runs. */
    readonly latest: ReadonlyArray<string>;
  };
  readonly stuck: ReadonlyArray<BeltRun>;
  readonly info: ReadonlyArray<BeltRun>;
  readonly counters: {
    readonly runsToday: number;
    readonly mergedToday: number;
    readonly stuck: number;
  };
  /** The post of the run that began last, among the rail and today's done runs. */
  readonly newest: Station;
}

const startedOf = (row: FactoryRunRow | undefined): number =>
  row?.started_ts ? Date.parse(row.started_ts) : Number.NaN;

const issueOf = (id: string): string => {
  const issue = parseRunId(id)?.issue;
  if (issue === undefined) return id;
  return /^[0-9]+$/.test(issue) ? `#${issue}` : issue;
};

/** Newest first; NaN (unknown) last. */
const newestFirst = (a: number, b: number): number => {
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.isNaN(a) ? (Number.isNaN(b) ? 0 : 1) : -1;
  return b - a;
};

/** The viewer's today as `[start, next start)` in epoch ms, around `nowMs`. */
const localDay = (nowMs: number): readonly [number, number] => {
  const start = new Date(nowMs);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return [start.getTime(), end.getTime()];
};

/**
 * What the belt shows, from every environment's unfinished runs and recent runs list: the runs at
 * each post, today's done bin, the Stuck and Needs info bins, and the counters. Only the newest
 * attempt of an issue counts for the bins and Done, and "today" is the viewer's local day.
 */
export function deriveBelt(environments: ReadonlyArray<BeltEnvironment>, nowMs: number): Belt {
  const [dayStart, dayEnd] = localDay(nowMs);
  const today = (ms: number) => ms >= dayStart && ms < dayEnd;
  const lanes: Record<Exclude<Station, "done">, Array<BeltRun>> = {
    claimed: [],
    building: [],
    gate: [],
    pr: [],
  };
  const done: Array<{ run: BeltRun; finishedMs: number; merged: boolean }> = [];
  const stuck: Array<BeltRun> = [];
  const info: Array<BeltRun> = [];
  // In the order seen, so that of two runs with the same (or no) start the later one is newest.
  const ranked: Array<{ station: Station; startedMs: number }> = [];
  let runsToday = 0;

  for (const { environmentId, label, active, recent } of environments) {
    const rowById = new Map(recent.map((row) => [row.id, row]));
    const beltRun = (
      id: string,
      row: FactoryRunRow | undefined,
      rest: Partial<BeltRun>,
    ): BeltRun => ({
      key: `${environmentId} ${id}`,
      environmentId,
      label,
      id,
      issue: issueOf(id),
      title: row?.title ?? null,
      state: row?.state ?? null,
      step: row?.step ?? row?.state ?? null,
      startedMs: startedOf(row),
      forMs: null,
      prUrl: row?.pr_url ?? null,
      reason: null,
      stoppable: false,
      ...rest,
    });

    for (const run of active) {
      // The runs list badges it; a null state here is a damaged file, not a launching session.
      if (run.unreadable) continue;
      const station = stationOf(run);
      if (station === null) continue;
      const row = rowById.get(run.id);
      const made = beltRun(run.id, row, {
        title: run.title ?? row?.title ?? null,
        state: run.state,
        step: row?.step ?? run.state,
        forMs: run.for_ms,
        prUrl: run.pr_url ?? row?.pr_url ?? null,
        stoppable: run.state === "building",
      });
      lanes[station].push(made);
      ranked.push({ station, startedMs: made.startedMs });
    }

    for (const row of recent) {
      if (today(startedOf(row))) runsToday++;
    }
    for (const row of newestAttempts(recent)) {
      if (row.finished && (row.pr_end === "merged" || row.pr_end === "closed")) {
        const finishedMs = startedOf(row) + (row.total_ms ?? Number.NaN);
        if (!today(finishedMs)) continue;
        done.push({
          run: beltRun(row.id, row, {
            step: shownState(row.state, row.pr_end),
            forMs: row.total_ms,
          }),
          finishedMs,
          merged: row.pr_end === "merged",
        });
      } else if (row.state === "stuck") {
        stuck.push(beltRun(row.id, row, { reason: row.reason ?? null }));
      } else if (row.state === "needs-info") {
        info.push(beltRun(row.id, row, { reason: row.reason ?? null }));
      }
    }
  }

  done.sort((a, b) => b.finishedMs - a.finishedMs);
  for (const { run } of done) ranked.push({ station: "done", startedMs: run.startedMs });
  let newest: Station = "claimed";
  let newestStart = Number.NEGATIVE_INFINITY;
  for (const { station, startedMs } of ranked) {
    const start = Number.isNaN(startedMs) ? Number.NEGATIVE_INFINITY : startedMs;
    if (start >= newestStart) {
      newest = station;
      newestStart = start;
    }
  }

  const byStart = (a: BeltRun, b: BeltRun) => newestFirst(a.startedMs, b.startedMs);
  const doneRuns = done.map(({ run }) => run);
  const merged = done.filter((entry) => entry.merged).length;
  const sortedStuck = stuck.toSorted(byStart);
  return {
    runs: {
      claimed: lanes.claimed.toSorted(byStart),
      building: lanes.building.toSorted(byStart),
      gate: lanes.gate.toSorted(byStart),
      pr: lanes.pr.toSorted(byStart),
      done: doneRuns,
    },
    done: {
      merged,
      closed: done.length - merged,
      latest: doneRuns.slice(0, 3).map((run) => run.issue),
    },
    stuck: sortedStuck,
    info: info.toSorted(byStart),
    counters: { runsToday, mergedToday: merged, stuck: sortedStuck.length },
    newest,
  };
}

/**
 * How many tiles a lane shows of `count` runs given `slots` places. When every run has a place,
 * all show; otherwise the last place is the `+N` tile for the `hidden` rest.
 */
export function fitLane(count: number, slots: number): { shown: number; hidden: number } {
  if (count <= slots) return { shown: count, hidden: 0 };
  const shown = Math.max(0, slots - 1);
  return { shown, hidden: count - shown };
}

/**
 * The control bar's pass line: "pass running" while one runs, "pass overdue" once the server calls
 * the last pass stale, else the seconds left until the last pass plus the poll; null when the
 * factory has not said (no pass yet, or no poll).
 */
export function nextPassText(
  passes: Partial<FactoryStatus["passes"]> | undefined,
  nowMs: number,
): string | null {
  if (passes === undefined) return null;
  if (passes.running === true) return "pass running";
  if (passes.stale === true) return "pass overdue";
  if (typeof passes.at !== "string" || typeof passes.poll_seconds !== "number") return null;
  const at = Date.parse(passes.at);
  if (Number.isNaN(at)) return null;
  const seconds = Math.max(0, Math.ceil((at + passes.poll_seconds * 1000 - nowMs) / 1000));
  return `next pass in ${seconds}s`;
}

/** `HH:MM` in the viewer's time. */
export function formatClock(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
