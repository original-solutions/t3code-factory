import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { FactoryRunRow } from "./api";
import { catchUp, catchUpSince } from "./catchUp";

const ENV_A = "env-a" as EnvironmentId;
const ENV_B = "env-b" as EnvironmentId;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = new Date(2026, 9, 28, 8, 0).getTime();
const iso = (ms: number) => new Date(ms).toISOString();

const row = (
  issue: number,
  startedMs: number,
  overrides: Partial<FactoryRunRow> = {},
  attempt = 1,
): FactoryRunRow => ({
  id: `acme__widgets__${issue}__${attempt}`,
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

const ended = (
  issue: number,
  endMs: number,
  more: Partial<FactoryRunRow>,
  attempt = 1,
): FactoryRunRow =>
  row(
    issue,
    endMs - HOUR,
    { finished: true, status: "finished", total_ms: HOUR, ...more },
    attempt,
  );

describe("catchUpSince", () => {
  it("is the mark, a day back without one, and never older than the week the list covers", () => {
    expect(catchUpSince(NOW - 3 * HOUR, NOW)).toBe(NOW - 3 * HOUR);
    expect(catchUpSince(null, NOW)).toBe(NOW - DAY);
    expect(catchUpSince(NOW - 30 * DAY, NOW)).toBe(NOW - 7 * DAY);
  });
});

describe("catchUp", () => {
  const SINCE = NOW - 12 * HOUR;

  it("sorts what ended since the mark by how, newest first, and leaves out what ended before", () => {
    const result = catchUp(
      [
        {
          environmentId: ENV_A,
          label: "Desktop",
          recent: [
            ended(1, NOW - 2 * HOUR, { state: "pr-open", pr_end: "merged" }),
            ended(2, NOW - 1 * HOUR, { state: "pr-open", pr_end: "merged" }),
            ended(3, NOW - 13 * HOUR, { state: "pr-open", pr_end: "merged" }),
            ended(4, NOW - 4 * HOUR, { state: "pr-open", pr_end: "closed" }),
            ended(5, NOW - 5 * HOUR, { state: "stuck", reason: "the run passed its time limit" }),
            row(6, NOW - 1 * HOUR),
          ],
        },
        {
          environmentId: ENV_B,
          label: "Studio",
          recent: [ended(7, NOW - 3 * HOUR, { state: "needs-info", reason: "Which API?" })],
        },
      ],
      SINCE,
    );
    expect(result.merged.map(({ issue }) => issue)).toEqual(["#2", "#1"]);
    expect(result.closed.map(({ issue }) => issue)).toEqual(["#4"]);
    expect(result.stopped.map(({ issue, outcome, label }) => [issue, outcome, label])).toEqual([
      ["#7", "info", "Studio"],
      ["#5", "stuck", "Desktop"],
    ]);
    expect(result.stopped[1]!.reason).toBe("the run passed its time limit");
    expect(result.claimed).toBe(6);
  });

  it("drops a stop a later attempt of the same issue has taken over", () => {
    const result = catchUp(
      [
        {
          environmentId: ENV_A,
          label: "Desktop",
          recent: [
            ended(8, NOW - 6 * HOUR, { state: "stuck" }, 1),
            row(8, NOW - 5 * HOUR, {}, 2),
            ended(9, NOW - 6 * HOUR, { state: "stuck" }, 1),
            ended(9, NOW - 2 * HOUR, { state: "pr-open", pr_end: "merged" }, 2),
          ],
        },
      ],
      SINCE,
    );
    expect(result.stopped).toEqual([]);
    expect(result.merged.map(({ id }) => id)).toEqual(["acme__widgets__9__2"]);
  });

  it("skips unreadable runs and runs with no start", () => {
    const result = catchUp(
      [
        {
          environmentId: ENV_A,
          label: "Desktop",
          recent: [
            ended(10, NOW - HOUR, { state: "stuck", unreadable: true }),
            ended(11, NOW - HOUR, { state: "stuck", started_ts: null }),
          ],
        },
      ],
      SINCE,
    );
    expect(result).toMatchObject({ merged: [], closed: [], stopped: [], claimed: 0 });
  });
});
