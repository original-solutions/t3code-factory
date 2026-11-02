import { describe, expect, it } from "vite-plus/test";

import type { FactoryStatus } from "./api";
import { updateWait } from "./updateWait";

const MIN = 60_000;
const SINCE = Date.UTC(2026, 10, 1, 4, 0);
const iso = (ms: number) => new Date(ms).toISOString();

const run = (
  issue: number,
  over: Partial<FactoryStatus["runs"][number]> = {},
): FactoryStatus["runs"][number] => ({
  id: `acme__shop__${issue}__1`,
  state: "building",
  last_event: null,
  title: null,
  user: null,
  for_ms: null,
  pr_url: null,
  thread_id: null,
  unreadable: false,
  ...over,
});

const status = (over: Partial<FactoryStatus> = {}): FactoryStatus => ({
  state: "running",
  reason: null,
  paused_by_hand: null,
  deploy_pending: {
    commit: "0123456789abcdef",
    since: iso(SINCE),
    waited_ms: 0,
    deploy_by: iso(SINCE + 120 * MIN),
    snoozed_until: null,
  },
  runs: [],
  attention: [],
  slots: { used: 0, max: null },
  threads: { running: 0 },
  passes: { at: null, poll_seconds: 60, running: false, stale: false },
  problems: [],
  ...over,
});

describe("updateWait", () => {
  it("puts now on the track from the first wait to the latest install", () => {
    const wait = updateWait(status(), SINCE + 30 * MIN);
    expect(wait.track).toEqual({ since: SINCE, deployBy: SINCE + 120 * MIN, done: 0.25 });
    expect(updateWait(status(), SINCE + 500 * MIN).track?.done).toBe(1);
    expect(updateWait(status(), SINCE - MIN).track?.done).toBe(0);
  });

  it("draws no track without a latest install time, or one that is not after the wait began", () => {
    const pending = status().deploy_pending!;
    expect(
      updateWait(status({ deploy_pending: { ...pending, deploy_by: null } }), SINCE).track,
    ).toBe(null);
    expect(
      updateWait(status({ deploy_pending: { ...pending, deploy_by: iso(SINCE) } }), SINCE).track,
    ).toBe(null);
  });

  it("lists what the install waits for: runs in progress at their post, the threads, and not a running pass", () => {
    const wait = updateWait(
      status({
        runs: [
          run(2, { title: "Make the belt faster" }),
          run(3, { state: "triage" }),
          run(4, { state: "pr-open" }),
          run(5, { state: "stuck" }),
          run(6, { state: "pr-open", unreadable: true }),
          run(7, { last_event: "gate_command" }),
        ],
        threads: { running: 2 },
        passes: { at: null, poll_seconds: 60, running: true, stale: false },
      }),
      SINCE,
    );
    expect(wait.blockers).toEqual([
      {
        kind: "run",
        id: "acme__shop__2__1",
        text: "Make the belt faster",
        issue: "#2",
        station: "building",
      },
      { kind: "run", id: "acme__shop__3__1", text: "acme/shop", issue: "#3", station: "claimed" },
      { kind: "run", id: "acme__shop__6__1", text: "acme/shop", issue: "#6", station: null },
      { kind: "run", id: "acme__shop__7__1", text: "acme/shop", issue: "#7", station: "gate" },
      { kind: "threads", running: 2 },
    ]);
  });

  it("counts a thread count T3 could not read as in the way, and an older server's none as none", () => {
    expect(updateWait(status({ threads: { running: null } }), SINCE).blockers).toEqual([
      { kind: "threads", running: null },
    ]);
    const { threads: _threads, ...older } = status();
    expect(updateWait(older, SINCE).blockers).toEqual([]);
  });
});
