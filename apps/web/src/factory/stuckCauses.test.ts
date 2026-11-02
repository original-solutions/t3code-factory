import { describe, expect, it } from "vite-plus/test";

import { splitStuckReason, stuckCauses } from "./stuckCauses";

describe("splitStuckReason", () => {
  it.each([
    [null, "No reason recorded", null],
    ["  ", "No reason recorded", null],
    ["stopped by hand", "Stopped by hand", null],
    [
      "the session stopped and said it was stuck\n\nI need a product call on the demotion rule.",
      "The session stopped and said it was stuck",
      "I need a product call on the demotion rule.",
    ],
    [
      "the run passed its time limit (95 min worked; last session activity 40 min before the stop: the session looked idle)",
      "The run passed its time limit",
      "95 min worked; last session activity 40 min before the stop: the session looked idle",
    ],
    [
      "the session reported PR #223 but its branch sync/v0.1.3 is not this session's branch\n\nNothing further is needed.",
      "The session reported a pull request from another branch",
      "PR #223, branch sync/v0.1.3. Nothing further is needed.",
    ],
  ])("splits %j into its cause and the rest", (reason, cause, detail) => {
    expect(splitStuckReason(reason)).toEqual({ cause, detail });
  });
});

describe("stuckCauses", () => {
  const run = (key: string, reason: string | null) => ({ key, reason });

  it("groups runs by cause, the biggest first and ties in the order first seen, keeping run order", () => {
    const groups = stuckCauses([
      run("a", "stopped by hand"),
      run("b", "the run passed its time limit"),
      run("c", "the session stopped and said it was stuck\n\nneeds a call"),
      run(
        "d",
        "the run passed its time limit (10 min worked; last session activity 1 min before the stop)",
      ),
      run("e", "the session stopped and said it was stuck"),
      run("f", null),
    ]);
    expect(
      groups.map(({ cause, entries }) => [cause, entries.map((entry) => entry.run.key)]),
    ).toEqual([
      ["The run passed its time limit", ["b", "d"]],
      ["The session stopped and said it was stuck", ["c", "e"]],
      ["Stopped by hand", ["a"]],
      ["No reason recorded", ["f"]],
    ]);
    expect(groups[1]!.entries.map((entry) => entry.detail)).toEqual(["needs a call", null]);
  });

  it("has no groups for no runs", () => {
    expect(stuckCauses([])).toEqual([]);
  });
});
