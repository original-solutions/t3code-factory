import type { EnvironmentId } from "@t3tools/contracts";

import type { FactoryRunRow } from "./api";
import { issueOf, localDay } from "./belt";

/** How a bar is coloured: the post an unfinished run is at, or how a finished one ended. */
export type DayTone = "claimed" | "building" | "pr" | "done" | "closed" | "stuck" | "info";

export interface DayBar {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly id: string;
  readonly issue: string;
  readonly title: string | null;
  readonly tone: DayTone;
  /** Where the run starts and ends (now, while it runs) as fractions of the viewer's day. */
  readonly from: number;
  readonly to: number;
  readonly startedMs: number;
  readonly endMs: number;
  /** It began before today, so its bar starts at midnight. */
  readonly clipped: boolean;
  readonly live: boolean;
  readonly lane: number;
}

export interface DayStrip {
  /** Today's runs, by start. */
  readonly bars: ReadonlyArray<DayBar>;
  /** The lanes the bars stack on: at least one, at most `MAX_LANES`. */
  readonly lanes: number;
  readonly nowAt: number;
  /** Where the hold on claims began, while one holds them (from midnight if it began earlier). */
  readonly heldAt: number | null;
}

/** Past this, a busy day lays extra runs over the lane that frees first rather than growing. */
const MAX_LANES = 4;

const toneOf = (row: FactoryRunRow): DayTone => {
  if (row.finished) {
    if (row.pr_end === "merged") return "done";
    if (row.pr_end === "closed") return "closed";
    if (row.state === "needs-info") return "info";
    return row.state === "stuck" ? "stuck" : "closed";
  }
  if (row.state === "pr-open") return "pr";
  if (row.state === "building") return "building";
  return "claimed";
};

/**
 * Every environment's runs that touched the viewer's today, as bars on a 24-hour strip: a finished
 * run from its start to its end, an unfinished one up to now. Overlapping runs take separate lanes.
 * A hold on claims (by hand, or for an update) since `heldSinceMs` shows as a band up to now.
 */
export function dayStrip(
  environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly recent: ReadonlyArray<FactoryRunRow>;
  }>,
  nowMs: number,
  heldSinceMs: number | null = null,
): DayStrip {
  const [dayStart, dayEnd] = localDay(nowMs);
  const span = dayEnd - dayStart;
  const at = (ms: number) => Math.min(1, Math.max(0, (ms - dayStart) / span));
  const placed: Array<Omit<DayBar, "lane">> = [];
  for (const { environmentId, label, recent } of environments) {
    for (const row of recent) {
      const startedMs = row.started_ts ? Date.parse(row.started_ts) : Number.NaN;
      if (Number.isNaN(startedMs) || row.unreadable) continue;
      const endMs = row.finished ? startedMs + (row.total_ms ?? 0) : Math.max(startedMs, nowMs);
      if (endMs < dayStart || startedMs >= dayEnd) continue;
      placed.push({
        key: `${environmentId} ${row.id}`,
        environmentId,
        label,
        id: row.id,
        issue: issueOf(row.id),
        title: row.title ?? null,
        tone: toneOf(row),
        from: at(startedMs),
        to: at(endMs),
        startedMs,
        endMs,
        clipped: startedMs < dayStart,
        live: !row.finished,
      });
    }
  }
  placed.sort((a, b) => a.startedMs - b.startedMs);

  const laneEnds: Array<number> = [];
  const bars = placed.map((bar): DayBar => {
    let lane = laneEnds.findIndex((end) => end <= bar.startedMs);
    if (lane === -1 && laneEnds.length < MAX_LANES) lane = laneEnds.length;
    if (lane === -1) lane = laneEnds.indexOf(Math.min(...laneEnds));
    laneEnds[lane] = Math.max(laneEnds[lane] ?? bar.endMs, bar.endMs);
    return { ...bar, lane };
  });
  const heldAt =
    heldSinceMs === null || Number.isNaN(heldSinceMs) ? null : Math.min(at(heldSinceMs), at(nowMs));
  return { bars, lanes: Math.max(1, laneEnds.length), nowAt: at(nowMs), heldAt };
}
