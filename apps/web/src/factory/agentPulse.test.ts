import { describe, expect, it } from "vite-plus/test";

import { agentCensus, agentChanged, agentPulse, type AgentThread } from "./agentPulse";

type Runtime = NonNullable<AgentThread["runtime"]>;

const thread = (
  over: Partial<Omit<AgentThread, "runtime">> & { runtime?: Partial<Runtime> | null } = {},
): AgentThread => {
  const { runtime, ...rest } = over;
  return {
    runtime:
      runtime === null
        ? null
        : ({
            status: "running",
            activeRunId: null,
            activityStartedAt: "2026-11-01T08:00:00.000Z",
            providerInstanceId: "claudeAgent",
            providerName: null,
            lastError: null,
            updatedAt: "2026-11-01T08:05:00.000Z",
            ...runtime,
          } as Runtime),
    latestRun: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    updatedAt: "2026-11-01T08:05:00.000Z",
    itemCount: 12,
    ...rest,
  } as AgentThread;
};

describe("agentPulse", () => {
  it("is null for a thread this client does not hold", () => {
    expect(agentPulse(null)).toBeNull();
  });

  it.each([
    [{ runtime: { status: "running" as const } }, "working", "working"],
    [{ runtime: { status: "starting" as const } }, "working", "working"],
    [{ runtime: { status: "queued" as const } }, "working", "working"],
    [{ runtime: { status: "waiting" as const } }, "waiting", "waiting"],
    [{ hasPendingApprovals: true }, "waiting", "needs approval"],
    [
      { hasPendingUserInput: true, runtime: { status: "waiting" as const } },
      "waiting",
      "needs answer",
    ],
    [{ runtime: { status: "failed" as const, lastError: "boom" } }, "failed", "failed"],
    [{ runtime: { status: "interrupted" as const } }, "failed", "interrupted"],
    [{ runtime: { status: "completed" as const } }, "ended", "turn ended"],
    [{ runtime: { status: "idle" as const } }, "ended", "turn ended"],
    [{ runtime: null }, "ended", "turn ended"],
  ])("reads %j as %s (%s)", (over, tone, word) => {
    const pulse = agentPulse(thread(over));
    expect(pulse?.tone).toBe(tone);
    expect(pulse?.word).toBe(word);
  });

  it("puts a request for a person ahead of the run being active", () => {
    expect(agentPulse(thread({ hasPendingApprovals: true }))?.word).toBe("needs approval");
  });

  it("says a usage limit only while nothing is running, with when it resets", () => {
    const limited = agentPulse(
      thread({ runtime: { status: "idle", usageLimitResetAt: "2026-11-01T09:30:00.000Z" } }),
    );
    expect(limited?.word).toBe("usage limit");
    expect(limited?.hint).toMatch(/^The provider resets it at \d\d:\d\d\.$/);
    expect(
      agentPulse(
        thread({ runtime: { status: "running", usageLimitResetAt: "2026-11-01T09:30:00.000Z" } }),
      )?.word,
    ).toBe("working");
  });

  it("dates work from the activity's start and an end from the run's completion", () => {
    expect(agentPulse(thread())?.since).toBe("2026-11-01T08:00:00.000Z");
    const ended = agentPulse(
      thread({
        runtime: { status: "completed" },
        latestRun: { completedAt: "2026-11-01T08:07:00.000Z" } as AgentThread["latestRun"],
      }),
    );
    expect(ended?.since).toBe("2026-11-01T08:07:00.000Z");
    expect(agentPulse(thread({ runtime: { status: "completed" } }))?.since).toBe(
      "2026-11-01T08:05:00.000Z",
    );
  });

  it("carries a failed session's error", () => {
    expect(agentPulse(thread({ runtime: { status: "failed", lastError: "boom" } }))?.error).toBe(
      "boom",
    );
  });

  it("carries how far the thread has got and when it last changed", () => {
    expect(agentPulse(thread())).toMatchObject({
      items: 12,
      lastActivity: "2026-11-01T08:05:00.000Z",
    });
  });
});

describe("agentCensus", () => {
  const pulse = (over: Parameters<typeof thread>[0]) => agentPulse(thread(over));

  it("is null when no run's agent is in this client", () => {
    expect(agentCensus([])).toBeNull();
    expect(agentCensus([null, null])).toBeNull();
  });

  it("counts the agents a person must answer first, then failed, working, waiting and idle", () => {
    expect(
      agentCensus([
        pulse({ runtime: { status: "completed" } }),
        pulse({ runtime: { status: "running" } }),
        pulse({ hasPendingApprovals: true }),
        pulse({ runtime: { status: "running" } }),
        pulse({ hasPendingUserInput: true }),
        pulse({ runtime: { status: "failed" } }),
        pulse({ runtime: { status: "waiting" } }),
        null,
      ]),
    ).toBe("2 need you · 1 failed · 2 working · 1 waiting · 1 idle");
  });

  it("says needs for one agent that waits on a person", () => {
    expect(agentCensus([pulse({ hasPendingApprovals: true })])).toBe("1 needs you");
  });
});

describe("agentChanged", () => {
  const working = (itemCount: number) => agentPulse(thread({ itemCount }));

  it("stays still while the agent keeps adding to its thread in the same state", () => {
    expect(agentChanged(working(12), working(13))).toBe(false);
    expect(agentChanged(working(13), working(40))).toBe(false);
  });

  it("flashes when the agent changes state", () => {
    expect(agentChanged(agentPulse(thread({ runtime: { status: "idle" } })), working(12))).toBe(
      true,
    );
    expect(agentChanged(working(12), agentPulse(thread({ hasPendingApprovals: true })))).toBe(true);
    expect(agentChanged(working(12), agentPulse(thread({ runtime: { status: "failed" } })))).toBe(
      true,
    );
  });

  it("stays still when the thread first appears or leaves this client", () => {
    expect(agentChanged(null, working(12))).toBe(false);
    expect(agentChanged(working(12), null)).toBe(false);
  });
});
