import { describe, expect, it } from "vite-plus/test";

import type { FactoryStatus } from "./api";
import { formatClock } from "./belt";
import { machineLine } from "./machines";

const SINCE = "2026-10-17T11:00:00.000Z";

const status = (extra: Partial<FactoryStatus> = {}): FactoryStatus => ({
  state: "running",
  reason: null,
  paused_by_hand: null,
  deploy_pending: null,
  runs: [],
  attention: [],
  slots: { used: 0, max: 1 },
  passes: { at: null, poll_seconds: null, running: false },
  problems: [],
  ...extra,
});

const pending = (snoozed: boolean): NonNullable<FactoryStatus["deploy_pending"]> => ({
  commit: "abc",
  since: SINCE,
  waited_ms: 0,
  deploy_by: null,
  snoozed_until: snoozed ? "2026-10-17T13:00:00.000Z" : null,
});

const health = ({ low = false, high = false }): NonNullable<FactoryStatus["health"]> => ({
  disk: {
    path: "/w",
    free_bytes: 7.8 * 1024 ** 3,
    total_bytes: 400 * 1024 ** 3,
    floor_bytes: 10 * 1024 ** 3,
    low,
  },
  load: { one_minute: 30, cores: 12, limit: 24, high },
  gates: { running: 0, max: 1, oldest_ms: null },
});

const read = (data: FactoryStatus | null, failed = false) => ({
  data,
  status: failed ? ("error" as const) : data === null ? ("loading" as const) : ("ready" as const),
});

describe("machineLine", () => {
  it.each([
    ["a read in flight", read(null), { tone: "loading", word: "Loading", detail: null }],
    [
      "a first read that failed",
      read(null, true),
      { tone: "down", word: "No answer", detail: null },
    ],
    ["a factory that claims", read(status()), { tone: "running", word: "Running", detail: null }],
    [
      "a hand pause, before an update or an idle",
      read(
        status({
          state: "idle",
          deploy_pending: pending(false),
          paused_by_hand: { since: SINCE, for_ms: 1 },
        }),
      ),
      { tone: "paused", word: "Paused", detail: `since ${formatClock(Date.parse(SINCE))}` },
    ],
    [
      "an idle factory, with its reason",
      read(status({ state: "idle", reason: "no repos", deploy_pending: pending(false) })),
      { tone: "idle", word: "Idle", detail: "no repos" },
    ],
    [
      "an update that holds claims",
      read(status({ deploy_pending: pending(false) })),
      { tone: "held", word: "Held for update", detail: `since ${formatClock(Date.parse(SINCE))}` },
    ],
    [
      "a low disk that holds claims",
      read(status({ health: health({ low: true }) })),
      { tone: "held", word: "Held: low disk", detail: "7.8 GiB free, needs 10 GiB" },
    ],
    [
      "a high load that holds claims",
      read(status({ health: health({ high: true }) })),
      { tone: "held", word: "Held: high load", detail: "1-minute load 30.0, above 24" },
    ],
    [
      "a signed-out gh, which holds claims with or without health",
      read(
        status({
          attention: ["acme/web", "acme/api"].map((repo) => ({
            id: `config-not-loaded:${repo}`,
            kind: "attention",
            repo,
            issue: null,
            run: null,
            message: `${repo}: project config not loaded; last error: please run: gh auth login`,
            first_seen: SINCE,
          })),
        }),
      ),
      { tone: "held", word: "Held: gh signed out", detail: "cannot read 2 repos" },
    ],
    [
      "a snoozed update, which holds nothing",
      read(status({ deploy_pending: pending(true) })),
      { tone: "running", word: "Running", detail: null },
    ],
  ])("says %s", (_, input, expected) => {
    expect(machineLine(input)).toMatchObject(expected);
  });

  it("flags a waiting update whether or not it holds claims", () => {
    expect(machineLine(read(status({ deploy_pending: pending(true) }))).update).toBe(true);
    expect(machineLine(read(status({ deploy_pending: pending(false) }))).update).toBe(true);
    expect(machineLine(read(status())).update).toBe(false);
    expect(machineLine(read(null)).update).toBe(false);
  });
});
