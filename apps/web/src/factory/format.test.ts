import { describe, expect, it } from "vite-plus/test";

import type { FactoryEntry } from "./api";
import {
  currentStep,
  formatAge,
  issueRef,
  labelForState,
  lastGateOutput,
  parseRunId,
  prEndOf,
  prRef,
  prUrlOf,
  runIsFinished,
  runState,
  shownState,
  stateBadgeVariant,
  threadIdOf,
  whyStopped,
} from "./format";

let tick = 0;
const entry = (event: string, data: unknown): FactoryEntry => ({
  ts: `2026-10-04T10:00:${String(tick++).padStart(2, "0")}.000Z`,
  ms: tick,
  event,
  data,
  cause: { step: "gate", reason: "x" },
});

describe("parseRunId", () => {
  it("splits owner, repo, issue and attempt", () => {
    expect(parseRunId("original-solutions__t3code-factory__20__1")).toEqual({
      owner: "original-solutions",
      repo: "t3code-factory",
      issue: "20",
      attempt: 1,
    });
  });

  it("keeps a double underscore inside the repo name", () => {
    expect(parseRunId("acme__my__repo__7__12")).toEqual({
      owner: "acme",
      repo: "my__repo",
      issue: "7",
      attempt: 12,
    });
  });

  it("reads a repo that ends in an underscore the way the server does", () => {
    expect(parseRunId("o__a___12__1")).toEqual({
      owner: "o",
      repo: "a_",
      issue: "12",
      attempt: 1,
    });
  });

  it("takes a Linear identifier as the issue", () => {
    expect(parseRunId("acme__app__ENG-42__2")?.issue).toBe("ENG-42");
  });

  it("is null for text that is not a run id", () => {
    expect(parseRunId("nope")).toBeNull();
    expect(parseRunId("a__b__c")).toBeNull();
    expect(parseRunId("a__b__1__x")).toBeNull();
    expect(parseRunId("")).toBeNull();
  });
});

describe("currentStep", () => {
  it("is the step of the last step_changed entry", () => {
    expect(
      currentStep([
        entry("step_changed", { step: "launch-sending" }),
        entry("claimed", {}),
        entry("step_changed", { step: "gate-passed abc 2" }),
        entry("state_changed", { from: "building", to: "pr-open" }),
      ]),
    ).toBe("gate-passed abc 2");
  });

  it("is null before any step_changed, and skips one without a text step", () => {
    expect(currentStep([entry("claimed", {})])).toBeNull();
    expect(
      currentStep([entry("step_changed", { step: "a" }), entry("step_changed", { step: 3 })]),
    ).toBe("a");
    expect(currentStep([])).toBeNull();
  });
});

describe("threadIdOf", () => {
  it("is the thread_id of the last session_launched entry", () => {
    expect(
      threadIdOf([
        entry("session_launched", { thread_id: "t-1" }),
        entry("session_launched", { thread_id: "t-2" }),
        entry("claimed", {}),
      ]),
    ).toBe("t-2");
  });

  it("is null when no session was launched", () => {
    expect(threadIdOf([entry("claimed", {})])).toBeNull();
    expect(threadIdOf([entry("session_launched", {})])).toBeNull();
  });
});

describe("lastGateOutput", () => {
  it("has nothing for a ledger without a gate", () => {
    expect(lastGateOutput([entry("claimed", {})])).toEqual({
      attempt: null,
      commands: [],
      message: null,
    });
  });

  it("lists the commands of the highest attempt only, in order", () => {
    const out = lastGateOutput([
      entry("gate_command", { attempt: 1, command: "pnpm lint", exit_code: 1, duration_ms: 40 }),
      entry("gate_command", { attempt: 2, command: "pnpm lint", exit_code: 0, duration_ms: 41 }),
      entry("gate_command", { attempt: 2, command: "pnpm test", exit_code: 2, duration_ms: 9000 }),
    ]);
    expect(out.attempt).toBe(2);
    expect(out.commands).toEqual([
      { command: "pnpm lint", exit_code: 0, duration_ms: 41 },
      { command: "pnpm test", exit_code: 2, duration_ms: 9000 },
    ]);
  });

  it("reads the message of the last relaunch or forward entry", () => {
    const out = lastGateOutput([
      entry("regate_relaunching", { attempt: 1, branch: "b", message: "first" }),
      entry("feedback_forwarding", { n: 1, run_ordinal: 1, items: [], message: "second" }),
      entry("feedback_relaunching", { n: 2, branch: "b", items: [], message: "third" }),
    ]);
    expect(out.message).toBe("third");
  });

  it("shows the message sent after the last attempt failed", () => {
    const out = lastGateOutput([
      entry("gate_command", { attempt: 1, command: "pnpm lint", exit_code: 1, duration_ms: 40 }),
      entry("regate_relaunching", { attempt: 1, branch: "b", message: "lint failed" }),
    ]);
    expect(out.message).toBe("lint failed");
  });

  it("drops a message about an earlier attempt once a later attempt has run", () => {
    const out = lastGateOutput([
      entry("gate_command", { attempt: 1, command: "pnpm lint", exit_code: 1, duration_ms: 40 }),
      entry("regate_relaunching", { attempt: 1, branch: "b", message: "lint failed" }),
      entry("gate_command", { attempt: 2, command: "pnpm lint", exit_code: 0, duration_ms: 41 }),
    ]);
    expect(out.attempt).toBe(2);
    expect(out.message).toBeNull();
  });
});

describe("formatAge", () => {
  const now = Date.parse("2026-10-17T12:00:00.000Z");
  it("formats the time since a moment", () => {
    expect(formatAge(now - 30_000, now)).toBe("30s");
    expect(formatAge(now - 5 * 60_000, now)).toBe("5m");
    expect(formatAge(now - 3 * 3_600_000, now)).toBe("3h");
    expect(formatAge(now - 2 * 86_400_000, now)).toBe("2d");
  });

  it("is a dash for a moment that is not a time", () => {
    expect(formatAge(Number.NaN, now)).toBe("-");
  });
});

describe("labelForState and stateBadgeVariant", () => {
  it("labels known states and falls back for others", () => {
    expect(labelForState("pr-open")).toBe("pr-open");
    expect(labelForState(null)).toBe("unknown");
  });

  it("picks a badge variant per state", () => {
    expect(stateBadgeVariant("building")).toBe("info");
    expect(stateBadgeVariant("pr-open")).toBe("success");
    expect(stateBadgeVariant("stuck")).toBe("error");
    expect(stateBadgeVariant("needs-info")).toBe("warning");
    expect(stateBadgeVariant("triage")).toBe("secondary");
    expect(stateBadgeVariant(null)).toBe("secondary");
  });
});

describe("runState and runIsFinished", () => {
  it("reads the state from the last state_changed entry", () => {
    const entries = [
      entry("state_changed", { from: "ready", to: "triage" }),
      entry("state_changed", { from: "triage", to: "building" }),
    ];
    expect(runState(entries)).toBe("building");
    expect(runState([entry("claimed", {})])).toBeNull();
  });

  it("is finished once a finished entry is written", () => {
    expect(runIsFinished([entry("claimed", {})])).toBe(false);
    expect(runIsFinished([entry("claimed", {}), entry("finished", { outcome: "stuck" })])).toBe(
      true,
    );
  });
});

describe("shownState and prEndOf", () => {
  it("shows how a finished run's pull request ended over the label it last set", () => {
    expect(shownState("pr-open", "merged")).toBe("merged");
    expect(shownState("building", "closed")).toBe("closed");
    expect(shownState("pr-open", null)).toBe("pr-open");
    expect(shownState("stuck", undefined)).toBe("stuck");
    expect(stateBadgeVariant(shownState("pr-open", "merged"))).toBe("secondary");
  });

  it("reads the pull request's end from the finished entry", () => {
    const finished = (pr_end: unknown) => [
      entry("state_changed", { from: "pr-open", to: "building" }),
      entry("finished", { outcome: "pr-open", pr_end }),
    ];
    expect(prEndOf(finished("merged"))).toBe("merged");
    expect(prEndOf(finished("closed"))).toBe("closed");
    expect(prEndOf(finished(null))).toBeNull();
    expect(prEndOf(finished("reopened"))).toBeNull();
    expect(prEndOf([entry("state_changed", { from: "building", to: "pr-open" })])).toBeNull();
  });
});

describe("whyStopped", () => {
  it("gives a stuck run's whole reason, whatever it names", () => {
    const reason = "the session stopped and said it was stuck\n\nThe machine is out of disk.";
    expect(
      whyStopped([
        entry("stuck", { reason: "an earlier reason" }),
        entry("stuck", { reason }),
        entry("state_changed", { from: "building", to: "stuck" }),
        entry("finished", { outcome: "stuck" }),
      ]),
    ).toEqual({ title: "Why it is stuck", text: reason });
  });

  it("gives the questions a needs-info run posted", () => {
    expect(
      whyStopped([
        entry("questions_posted", { questions: "Which page?" }),
        entry("state_changed", { from: "building", to: "needs-info" }),
      ]),
    ).toEqual({ title: "Questions on the issue", text: "Which page?" });
  });

  it("has nothing for a run in any other state, or with no reason recorded", () => {
    expect(
      whyStopped([
        entry("stuck", { reason: "old" }),
        entry("state_changed", { from: "stuck", to: "building" }),
      ]),
    ).toBeNull();
    expect(whyStopped([entry("state_changed", { from: "building", to: "stuck" })])).toBeNull();
  });
});

describe("issueRef, prRef and prUrlOf", () => {
  it("links a numeric issue on GitHub, and leaves any other as text", () => {
    expect(issueRef("acme/app", "20")).toEqual({
      text: "#20",
      href: "https://github.com/acme/app/issues/20",
    });
    expect(issueRef("acme/app", "PROJ-4")).toEqual({ text: "PROJ-4", href: null });
  });

  it("links only a github.com pull request", () => {
    expect(prRef("https://github.com/acme/app/pull/30")).toEqual({
      text: "#30",
      href: "https://github.com/acme/app/pull/30",
    });
    expect(prRef("javascript:alert(1)")).toEqual({ text: "javascript:alert(1)", href: null });
    expect(prRef(null)).toBeNull();
  });

  it("reads the finished line's pull request, else the last one opened", () => {
    const opened = (pr: number) => entry("pr_opened", { pr, url: `https://x.test/pull/${pr}` });
    expect(prUrlOf([opened(1), opened(2)])).toBe("https://x.test/pull/2");
    expect(prUrlOf([opened(1), entry("finished", { pr_url: "https://x.test/pull/9" })])).toBe(
      "https://x.test/pull/9",
    );
    expect(prUrlOf([opened(1), entry("finished", { pr_url: null })])).toBe("https://x.test/pull/1");
    expect(prUrlOf([entry("claimed", {})])).toBeNull();
  });
});
