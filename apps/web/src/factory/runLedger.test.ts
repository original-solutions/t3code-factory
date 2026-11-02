import { describe, expect, it } from "vite-plus/test";

import type { FactoryRunRow } from "./api";
import {
  bucketOf,
  countBuckets,
  dayLabel,
  firstOfDays,
  groupByDay,
  matchesQuery,
} from "./runLedger";

const row = (over: Partial<FactoryRunRow> = {}): FactoryRunRow => ({
  id: "original-solutions__t3code-factory__20__1",
  started_ts: "2026-10-17T10:00:00.000Z",
  state: "building",
  last_event: null,
  step: null,
  status: "running",
  pr_url: null,
  finished: false,
  total_ms: null,
  unreadable: false,
  ...over,
});

describe("bucketOf", () => {
  it.each([
    [{}, "active"],
    [{ state: "stuck", finished: true }, "attention"],
    [{ state: "needs-info", finished: true }, "attention"],
    [{ state: "pr-open", finished: true, pr_end: "merged" as const }, "merged"],
    [{ state: "pr-open", finished: true, pr_end: "closed" as const }, "closed"],
    [{ state: "pr-open", finished: true }, "other"],
    [{ unreadable: true }, "other"],
  ])("puts %j in %s", (over, bucket) => {
    expect(bucketOf(row(over))).toBe(bucket);
  });

  it("counts every bucket and the total", () => {
    const counts = countBuckets([row(), row({ state: "stuck", finished: true }), row()]);
    expect(counts).toEqual({ all: 3, active: 2, attention: 1, merged: 0, closed: 0 });
  });
});

describe("matchesQuery", () => {
  const run = row({ title: "Fix the Claim guard", pr_url: "https://github.com/o/r/pull/42" });

  it("matches every word against the title, repo, issue, run id and environment", () => {
    expect(matchesQuery(run, "Laptop", "")).toBe(true);
    expect(matchesQuery(run, "Laptop", "claim GUARD")).toBe(true);
    expect(matchesQuery(run, "Laptop", "t3code-factory #20")).toBe(true);
    expect(matchesQuery(run, "Laptop", "laptop")).toBe(true);
    expect(matchesQuery(run, "Laptop", "#42")).toBe(true);
    expect(matchesQuery(run, "Laptop", "claim people-hub")).toBe(false);
  });

  it("does not match #2 to issue #20", () => {
    expect(matchesQuery(run, "Laptop", "#2")).toBe(false);
  });
});

describe("dayLabel and groupByDay", () => {
  const now = new Date(2026, 9, 17, 15, 0).getTime();

  it("names today, yesterday and older days", () => {
    expect(dayLabel(new Date(2026, 9, 17, 0, 5).getTime(), now)).toBe("Today");
    expect(dayLabel(new Date(2026, 9, 16, 23, 55).getTime(), now)).toBe("Yesterday");
    expect(dayLabel(new Date(2026, 9, 14, 9, 0).getTime(), now)).toMatch(/14/);
    expect(dayLabel(Number.NaN, now)).toBe("No start time");
  });

  it("keeps the order it is given and starts a group at each new day", () => {
    const at = (d: number, h: number) => ({ ms: new Date(2026, 9, d, h).getTime() });
    const groups = groupByDay([at(17, 9), at(17, 8), at(16, 20), at(14, 1)], (x) => x.ms, now);
    expect(groups.map(({ label, items }) => [label, items.length])).toEqual([
      ["Today", 2],
      ["Yesterday", 1],
      [dayLabel(at(14, 1).ms, now), 1],
    ]);
  });

  it("keeps the first runs across days, each shown day keeping its full count", () => {
    const days = [
      { label: "Today", items: [1, 2] },
      { label: "Yesterday", items: [3, 4, 5] },
      { label: "Mon", items: [6] },
    ];
    expect(firstOfDays(days, 3)).toEqual({
      days: [
        { label: "Today", items: [1, 2], total: 2 },
        { label: "Yesterday", items: [3], total: 3 },
      ],
      hidden: 3,
    });
    expect(firstOfDays(days, 10).hidden).toBe(0);
    expect(firstOfDays(days, 10).days.map((day) => day.items.length)).toEqual([2, 3, 1]);
  });
});
