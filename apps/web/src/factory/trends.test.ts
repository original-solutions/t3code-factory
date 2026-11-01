import { describe, expect, it } from "vite-plus/test";

import type { FactoryRunRow } from "./api";
import { factoryTrends, weekStart } from "./trends";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Sunday 1 November 2026, 10:00 local: this week began Monday 26 October.
const NOW = new Date(2026, 10, 1, 10, 0).getTime();
const THIS_WEEK = new Date(2026, 9, 26).getTime();
const iso = (ms: number) => new Date(ms).toISOString();

let issue = 0;
const run = (startedMs: number, overrides: Partial<FactoryRunRow> = {}): FactoryRunRow => ({
  id: `acme__widgets__${++issue}__1`,
  started_ts: iso(startedMs),
  state: "pr-open",
  last_event: "finished",
  step: null,
  status: "finished",
  pr_url: null,
  finished: true,
  total_ms: HOUR,
  unreadable: false,
  ...overrides,
});
const merged = (startedMs: number, totalMs = HOUR) =>
  run(startedMs, { pr_end: "merged", total_ms: totalMs });
const stuck = (startedMs: number, reason: string) => run(startedMs, { state: "stuck", reason });

describe("weekStart", () => {
  it("is the local Monday at midnight, a Monday itself included", () => {
    expect(weekStart(NOW)).toBe(THIS_WEEK);
    expect(weekStart(THIS_WEEK)).toBe(THIS_WEEK);
    expect(weekStart(THIS_WEEK - 1)).toBe(new Date(2026, 9, 19).getTime());
  });
});

describe("factoryTrends", () => {
  it("is null with no run that has a start time", () => {
    expect(factoryTrends([], NOW)).toBeNull();
    expect(factoryTrends([run(NOW, { started_ts: null })], NOW)).toBeNull();
  });

  it("counts each run's outcome in the week it was claimed, from its first week to this one", () => {
    const trends = factoryTrends(
      [
        merged(THIS_WEEK - 6 * DAY),
        stuck(THIS_WEEK - 6 * DAY, "the session hit its time limit (60m)"),
        run(THIS_WEEK + DAY, { state: "needs-info" }),
        run(THIS_WEEK + DAY, { pr_end: "closed" }),
        run(THIS_WEEK + 2 * DAY, { state: "building", finished: false, total_ms: null }),
        run(THIS_WEEK + 2 * DAY, { unreadable: true }),
      ],
      NOW,
    )!;
    expect(trends.weeks.map((week) => week.startMs)).toEqual([THIS_WEEK - 7 * DAY, THIS_WEEK]);
    expect(trends.weeks[0]!.counts).toEqual({
      merged: 1,
      closed: 0,
      stuck: 1,
      info: 0,
      active: 0,
      other: 0,
    });
    expect(trends.weeks[1]!.counts).toEqual({
      merged: 0,
      closed: 1,
      stuck: 0,
      info: 1,
      active: 1,
      other: 1,
    });
    expect(trends.weeks[1]!.total).toBe(3);
  });

  it("keeps empty weeks between runs and no more than the weeks asked for", () => {
    const trends = factoryTrends(
      [merged(THIS_WEEK - 20 * 7 * DAY), merged(THIS_WEEK - 2 * 7 * DAY), merged(THIS_WEEK)],
      NOW,
      4,
    )!;
    expect(trends.weeks.map((week) => week.total)).toEqual([0, 1, 0, 1]);
    expect(trends.weeks[0]!.startMs).toBe(THIS_WEEK - 3 * 7 * DAY);
  });

  it("rates stuck and needs-info against the runs that ended, and takes the median time to merge", () => {
    const week = factoryTrends(
      [
        merged(THIS_WEEK, HOUR),
        merged(THIS_WEEK, 3 * HOUR),
        merged(THIS_WEEK, 10 * HOUR),
        stuck(THIS_WEEK, "no reason"),
        run(THIS_WEEK, { state: "building", finished: false, total_ms: null }),
      ],
      NOW,
    )!.weeks[0]!;
    expect(week.stuckRate).toBe(0.25);
    expect(week.infoRate).toBe(0);
    expect(week.mergeMs).toBe(3 * HOUR);
  });

  it("has no rate for a week with nothing ended and no merge time without a merge", () => {
    const week = factoryTrends(
      [run(THIS_WEEK, { state: "building", finished: false, total_ms: null })],
      NOW,
    )!.weeks[0]!;
    expect(week.stuckRate).toBeNull();
    expect(week.mergeMs).toBeNull();
  });

  it("compares this week with the average of up to four weeks before it that ended anything", () => {
    const trends = factoryTrends(
      [
        // Five weeks back: outside the four the baseline averages.
        stuck(THIS_WEEK - 5 * 7 * DAY, "x"),
        merged(THIS_WEEK - 2 * 7 * DAY, 2 * HOUR),
        merged(THIS_WEEK - 2 * 7 * DAY, 2 * HOUR),
        merged(THIS_WEEK - 7 * DAY, 4 * HOUR),
        stuck(THIS_WEEK - 7 * DAY, "x"),
        merged(THIS_WEEK, HOUR),
      ],
      NOW,
    )!;
    expect(trends.now).toEqual({ merged: 1, stuckRate: 0, infoRate: 0, mergeMs: HOUR });
    // Merged averages the weeks that ended anything (2 and 1); rates pool those weeks' runs.
    expect(trends.before).toEqual({
      merged: 1.5,
      stuckRate: 0.25,
      infoRate: 0,
      mergeMs: 2 * HOUR,
    });
  });

  it("has no baseline when this week is the first", () => {
    expect(factoryTrends([merged(THIS_WEEK)], NOW)!.before).toBeNull();
  });

  it("groups stuck runs by cause, most first, with each cause's count per week", () => {
    const trends = factoryTrends(
      [
        stuck(THIS_WEEK - 7 * DAY, "the session hit its time limit (60m)"),
        stuck(THIS_WEEK - 7 * DAY, "the session hit its time limit (45m)"),
        stuck(THIS_WEEK, "the gate failed 3 times"),
        stuck(THIS_WEEK, "the session hit its time limit (60m)"),
      ],
      NOW,
    )!;
    expect(trends.causes).toEqual([
      { cause: "The session hit its time limit", total: 3, perWeek: [2, 1] },
      { cause: "The gate failed 3 times", total: 1, perWeek: [0, 1] },
    ]);
  });
});
