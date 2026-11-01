import { describe, expect, it } from "vite-plus/test";

import type { FactoryEntry } from "./api";
import { nextStep } from "./nextStep";

let ms = 0;
const entry = (event: string, data: unknown = {}): FactoryEntry => {
  ms += 1000;
  return { ts: new Date(ms).toISOString(), ms, event, data, cause: null };
};
const to = (state: string) => entry("state_changed", { to: state });
const stuck = (reason: string, branch?: string) => [
  entry("stuck", branch === undefined ? { reason } : { reason, branch }),
  to("stuck"),
];
const gate = (attempt: number, exits: ReadonlyArray<number>) =>
  exits.map((exit_code, i) =>
    entry("gate_command", { attempt, command: `cmd${i}`, exit_code, duration_ms: 10 }),
  );
const prOpened = entry("pr_opened", { url: "https://github.com/o/r/pull/187" });

describe("nextStep", () => {
  it("is null for a run that did not stop for a person", () => {
    expect(nextStep([to("building")])).toBeNull();
    expect(nextStep([to("pr-open")])).toBeNull();
  });

  it.each([
    ["the gate failed after 3 attempts", "gate"],
    ["the required checks failed after 1 attempt", "checks"],
    ["the session stopped and said it was stuck\n\nI need a product call.", "thread"],
    ["the session ended without a FACTORY-DONE or FACTORY-STOP line", "thread"],
    [
      "the run passed its time limit (92 min worked; last session activity 40 min before the stop: the session looked idle)",
      "thread",
    ],
    [
      "the run passed its time limit (92 min worked; last session activity 2 min before the stop)",
      "issue",
    ],
    [
      "the session run ended as failed\n\nAPI Error: Request rejected (429) · cooling down",
      "issue",
    ],
    ["the session run ended as failed\n\nTypeError: x is undefined", "thread"],
    ["the issue text was changed during the build by someone who is not an instructor", "issue"],
    ["stopped by hand", "issue"],
    ["something the factory says one day", "thread"],
  ])("sends %j to the %s", (reason, focus) => {
    expect(nextStep(stuck(reason))?.focus).toBe(focus);
  });

  it("names the latest stuck cause in sentence case and keeps the rest as detail", () => {
    const step = nextStep([
      entry("stuck", { reason: "an earlier reason" }),
      entry("state_changed", { to: "building" }),
      ...stuck("the session stopped and said it was stuck\n\nDisk is full."),
    ]);
    expect(step).toMatchObject({
      kind: "stuck",
      cause: "The session stopped and said it was stuck",
      detail: "Disk is full.",
    });
  });

  it("lists only the failing commands of the last gate run", () => {
    const step = nextStep([...gate(1, [1]), ...gate(2, [0, 2]), ...stuck("the gate failed")]);
    expect(step?.failedGate.map((command) => command.command)).toEqual(["cmd1"]);
    expect(nextStep([...gate(1, [0]), ...stuck("stopped by hand")])?.failedGate).toEqual([]);
  });

  it("says what a new run starts from", () => {
    const limit = "the run passed its time limit";
    expect(nextStep([prOpened, ...stuck(limit, "t3/x")])?.nextRun).toBe(
      "A new run continues PR #187 on its branch. Close the PR first to start over.",
    );
    expect(nextStep(stuck(limit, "t3/x"))?.nextRun).toBe(
      "A new run continues from t3/x, unless the issue text changes first.",
    );
    expect(nextStep(stuck("the gate failed", "t3/x"))?.nextRun).toBe(
      "A new run starts from the base branch; this run's work stays on t3/x.",
    );
    expect(nextStep(stuck("stopped by hand"))?.nextRun).toBe(
      "A new run starts from the base branch.",
    );
    const closed = entry("finished", {
      pr_url: "https://github.com/o/r/pull/187",
      pr_end: "closed",
    });
    expect(nextStep([prOpened, ...stuck(limit, "t3/x"), closed])?.nextRun).toMatch(
      /continues from t3\/x/,
    );
  });

  it("asks a needs-info run's person to answer the questions", () => {
    const step = nextStep([
      entry("questions_posted", { questions: "1. Which one?" }),
      to("needs-info"),
    ]);
    expect(step).toMatchObject({ kind: "needs-info", detail: "1. Which one?", focus: "issue" });
  });
});
