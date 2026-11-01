import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { FactoryStatus } from "./api";
import { factoryPulse } from "./pulse";

const ENV_A = "env-a" as EnvironmentId;
const ENV_B = "env-b" as EnvironmentId;

type StatusRun = FactoryStatus["runs"][number];

const run = (issue: number, overrides: Partial<StatusRun> = {}): StatusRun => ({
  id: `acme__widgets__${issue}__1`,
  state: "building",
  last_event: "step_changed",
  title: `Issue ${issue}`,
  user: "acme",
  for_ms: 60_000,
  pr_url: null,
  thread_id: null,
  unreadable: false,
  ...overrides,
});

const status = (overrides: Partial<FactoryStatus> = {}): FactoryStatus => ({
  state: "running",
  reason: null,
  paused_by_hand: null,
  deploy_pending: null,
  runs: [],
  attention: [],
  slots: { used: 0, max: 2 },
  passes: { at: null, poll_seconds: 600, running: false, stale: false },
  problems: [],
  ...overrides,
});

const attention = (id: string) => ({
  id,
  kind: "stuck",
  repo: "acme/widgets",
  issue: 1,
  run: null,
  message: "stuck",
  first_seen: "2026-11-01T00:00:00Z",
});

describe("factoryPulse", () => {
  it("lists runs nearest to done first, then longest at their post, and skips unreadable ones", () => {
    const pulse = factoryPulse([
      {
        environmentId: ENV_A,
        label: "mac",
        status: status({
          runs: [
            run(1, { state: "triage", for_ms: 5_000 }),
            run(2, { for_ms: 1_000 }),
            run(3, { state: "pr-open" }),
            run(4, { for_ms: 9_000 }),
            run(5, { pr_reported: true }),
            run(6, { unreadable: true }),
            run(7, { state: "stuck" }),
          ],
        }),
      },
    ]);
    expect(pulse.environments[0]!.runs.map((r) => [r.issue, r.station])).toEqual([
      ["#3", "pr"],
      ["#5", "gate"],
      ["#4", "building"],
      ["#2", "building"],
      ["#1", "claimed"],
    ]);
    expect(pulse.environments[0]!.runs[0]).toMatchObject({ repo: "widgets", title: "Issue 3" });
    expect(pulse).toMatchObject({ tone: "working", inFlight: 5, summary: "5 runs in flight" });
  });

  it.each([
    [{ paused_by_hand: { since: "2026-11-01T00:00:00Z", for_ms: 1 } }, "claims paused"],
    [
      {
        deploy_pending: {
          commit: null,
          since: "2026-11-01T00:00:00Z",
          waited_ms: 1,
          deploy_by: null,
          snoozed_until: null,
        },
      },
      "held for update",
    ],
    [{ passes: { at: null, poll_seconds: 600, running: false, stale: true } }, "pass overdue"],
  ] as const)("names the hold %#, and a hold outranks runs in flight", (overrides, hold) => {
    const pulse = factoryPulse([
      { environmentId: ENV_A, label: "mac", status: status({ ...overrides, runs: [run(1)] }) },
    ]);
    expect(pulse.environments[0]!.hold).toBe(hold);
    expect(pulse.tone).toBe("held");
    expect(pulse.summary).toBe(`1 run in flight · ${hold}`);
  });

  it("does not count a snoozed update as a hold", () => {
    const pulse = factoryPulse([
      {
        environmentId: ENV_A,
        label: "mac",
        status: status({
          deploy_pending: {
            commit: null,
            since: "2026-11-01T00:00:00Z",
            waited_ms: 1,
            deploy_by: null,
            snoozed_until: "2026-11-01T02:00:00Z",
          },
        }),
      },
    ]);
    expect(pulse).toMatchObject({ tone: "idle", summary: "nothing in flight" });
  });

  it("adds up environments, names a shared hold once, and leaves out those not read", () => {
    const paused = { paused_by_hand: { since: "2026-11-01T00:00:00Z", for_ms: 1 } };
    const pulse = factoryPulse([
      {
        environmentId: ENV_A,
        label: "mac",
        status: status({ ...paused, attention: [attention("a")], runs: [run(1)] }),
      },
      {
        environmentId: ENV_B,
        label: "vps",
        status: status({ ...paused, attention: [attention("b"), attention("c")] }),
      },
      { environmentId: "env-c" as EnvironmentId, label: "laptop", status: null },
    ]);
    expect(pulse.environments.map((env) => env.label)).toEqual(["mac", "vps"]);
    expect(pulse.summary).toBe("1 run in flight · claims paused · 3 need you");
    expect(factoryPulse([]).summary).toBe("not read yet");
  });

  it("lists at most maxRuns runs across environments, in their order, and counts the rest", () => {
    const pulse = factoryPulse(
      [
        { environmentId: ENV_A, label: "mac", status: status({ runs: [run(1), run(2)] }) },
        { environmentId: ENV_B, label: "vps", status: status({ runs: [run(3), run(4)] }) },
      ],
      3,
    );
    expect(pulse.environments.map((env) => env.runs.length)).toEqual([2, 1]);
    expect(pulse).toMatchObject({ inFlight: 4, hidden: 1, summary: "4 runs in flight" });
  });
});
