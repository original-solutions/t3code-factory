import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { FactoryRunRow } from "./api";
import { dayStrip } from "./dayStrip";

const ENV_A = "env-a" as EnvironmentId;
const ENV_B = "env-b" as EnvironmentId;

const at = (hour: number, minute = 0, dayOffset = 0) =>
  new Date(2026, 9, 27 + dayOffset, hour, minute).getTime();
const iso = (ms: number) => new Date(ms).toISOString();
const NOW = at(12);
const HOUR = 3_600_000;

const id = (issue: number, attempt = 1) => `acme__widgets__${issue}__${attempt}`;

const row = (
  issue: number,
  startedMs: number,
  overrides: Partial<FactoryRunRow> = {},
): FactoryRunRow => ({
  id: id(issue),
  started_ts: iso(startedMs),
  state: "building",
  last_event: "step_changed",
  step: null,
  status: "running",
  pr_url: null,
  finished: false,
  total_ms: null,
  unreadable: false,
  ...overrides,
});

const done = (issue: number, startedMs: number, totalMs: number, more: Partial<FactoryRunRow>) =>
  row(issue, startedMs, { finished: true, status: "finished", total_ms: totalMs, ...more });

const strip = (recent: FactoryRunRow[], nowMs = NOW, more: FactoryRunRow[] = []) =>
  dayStrip(
    [
      { environmentId: ENV_A, label: "Desktop", recent },
      { environmentId: ENV_B, label: "Studio", recent: more },
    ],
    nowMs,
  );

describe("dayStrip", () => {
  it("places today's runs as spans of the day, toned by how they ended", () => {
    const { bars, nowAt } = strip([
      done(1, at(6), 3 * HOUR, { state: "pr-open", pr_end: "merged" }),
      done(2, at(7), HOUR, { state: "stuck" }),
      done(3, at(8), HOUR, { state: "needs-info" }),
      done(4, at(9), HOUR, { state: "pr-open", pr_end: "closed" }),
    ]);
    expect(nowAt).toBe(0.5);
    expect(bars.map(({ issue, tone, from, to }) => [issue, tone, from, to])).toEqual([
      ["#1", "done", 0.25, 0.375],
      ["#2", "stuck", 7 / 24, 8 / 24],
      ["#3", "info", 8 / 24, 9 / 24],
      ["#4", "closed", 9 / 24, 10 / 24],
    ]);
  });

  it("runs an unfinished run up to now, toned by its post", () => {
    const { bars } = strip([
      row(1, at(10), { state: "triage" }),
      row(2, at(10), { state: "building" }),
      row(3, at(10), { state: "pr-open" }),
    ]);
    expect(bars.map(({ tone, to, live }) => [tone, to, live])).toEqual([
      ["claimed", 0.5, true],
      ["building", 0.5, true],
      ["pr", 0.5, true],
    ]);
  });

  it("clips a run from yesterday at midnight and leaves out one that ended before it", () => {
    const { bars } = strip([
      done(1, at(22, 0, -1), 4 * HOUR, { state: "pr-open", pr_end: "merged" }),
      done(2, at(20, 0, -1), HOUR, { state: "pr-open", pr_end: "merged" }),
      row(3, at(9), { started_ts: null }),
    ]);
    expect(bars.map(({ issue, from, to, clipped }) => [issue, from, to, clipped])).toEqual([
      ["#1", 0, 2 / 24, true],
    ]);
  });

  it("stacks overlapping runs on separate lanes and reuses a lane once it is free", () => {
    const { bars, lanes } = strip(
      [
        done(1, at(8), 2 * HOUR, { state: "pr-open", pr_end: "merged" }),
        done(2, at(9), 2 * HOUR, { state: "pr-open", pr_end: "merged" }),
      ],
      NOW,
      [done(3, at(10, 30), HOUR, { state: "pr-open", pr_end: "merged" })],
    );
    expect(bars.map(({ issue, lane, label }) => [issue, lane, label])).toEqual([
      ["#1", 0, "Desktop"],
      ["#2", 1, "Desktop"],
      ["#3", 0, "Studio"],
    ]);
    expect(lanes).toBe(2);
  });

  it("caps the lanes, laying a busy day's extra runs over the lane that frees first", () => {
    const recent = Array.from({ length: 6 }, (_, i) =>
      done(i + 1, at(8, i), 3 * HOUR - i * 180_000, { state: "pr-open", pr_end: "merged" }),
    );
    const { bars, lanes } = strip(recent);
    expect(lanes).toBe(4);
    expect(bars.map(({ lane }) => lane)).toEqual([0, 1, 2, 3, 3, 3]);
  });

  it("is empty with no run today", () => {
    expect(strip([])).toEqual({ bars: [], lanes: 1, nowAt: 0.5, heldAt: null });
  });

  it("marks where today's hold on claims began, from midnight for an older one", () => {
    const env = [{ environmentId: ENV_A, label: "Desktop", recent: [] }];
    expect(dayStrip(env, NOW, at(9)).heldAt).toBe(9 / 24);
    expect(dayStrip(env, NOW, at(9, 0, -2)).heldAt).toBe(0);
    expect(dayStrip(env, NOW, Number.NaN).heldAt).toBeNull();
  });
});
