import { describe, expect, it } from "vite-plus/test";

import { feedbackBudget, pendingChanges, readingOf, spanOf, type TuningForm } from "./tuning";

const form = (overrides: Partial<TuningForm> = {}): TuningForm => ({
  gh_config_dir: "/home/t3/gh",
  poll_seconds: "60",
  max_concurrent_runs: "1",
  max_concurrent_gates: "2",
  feedback_seconds: "600",
  ...overrides,
});

describe("spanOf", () => {
  it.each([
    [1, "1 s"],
    [45, "45 s"],
    [60, "1 min"],
    [90, "1 min 30 s"],
    [600, "10 min"],
    [3600, "1 h"],
    [5400, "1 h 30 min"],
  ])("%i seconds reads %s", (seconds, text) => {
    expect(spanOf(seconds)).toBe(text);
  });
});

describe("readingOf", () => {
  it("says what each number does in plain words", () => {
    expect(readingOf("poll_seconds", "600")).toBe("Looks at GitHub at least every 10 min.");
    expect(readingOf("max_concurrent_runs", "1")).toBe("1 run builds at a time.");
    expect(readingOf("max_concurrent_runs", "3")).toBe("3 runs build at a time.");
    expect(readingOf("max_concurrent_gates", "2")).toBe("2 gates run at a time.");
    expect(readingOf("feedback_seconds", "0")).toBe("Reads feedback on every pass.");
    expect(readingOf("feedback_seconds", "300")).toBe("Reads feedback at most every 5 min.");
  });

  it("says nothing for a value the server would refuse, leaving that to its error", () => {
    expect(readingOf("poll_seconds", "")).toBeNull();
    expect(readingOf("poll_seconds", "5")).toBeNull();
    expect(readingOf("poll_seconds", "1.5")).toBeNull();
    expect(readingOf("max_concurrent_runs", "0")).toBeNull();
    expect(readingOf("feedback_seconds", "-1")).toBeNull();
    expect(readingOf("gh_config_dir", "/x")).toBeNull();
  });
});

describe("feedbackBudget", () => {
  // The guide's figures: 40 waiting pull requests at a 60 s poll spend 7,200 points at 0, 720 at 600.
  it("spends 3 points per waiting pull request per read, a read at most once a pass", () => {
    expect(feedbackBudget(form({ poll_seconds: "60", feedback_seconds: "0" }))).toEqual({
      pointsPerPullRequest: 180,
      pullRequestsToSpendAll: 27,
      tight: true,
    });
    expect(feedbackBudget(form({ poll_seconds: "60", feedback_seconds: "600" }))).toEqual({
      pointsPerPullRequest: 18,
      pullRequestsToSpendAll: 277,
      tight: false,
    });
  });

  it("reads no oftener than the pass, whatever feedback_seconds asks", () => {
    expect(
      feedbackBudget(form({ poll_seconds: "600", feedback_seconds: "0" }))?.pointsPerPullRequest,
    ).toBe(18);
  });

  it("has no estimate while either number is not one the server takes", () => {
    expect(feedbackBudget(form({ poll_seconds: "" }))).toBeNull();
    expect(feedbackBudget(form({ feedback_seconds: "x" }))).toBeNull();
  });
});

describe("pendingChanges", () => {
  it("lists each field that differs from the file, in form order, with both readings", () => {
    const saved = form();
    const edited = form({ feedback_seconds: "0", poll_seconds: "300" });
    expect(pendingChanges(saved, edited)).toEqual([
      { key: "poll_seconds", label: "Poll seconds", from: "60", to: "300" },
      { key: "feedback_seconds", label: "Feedback seconds", from: "600", to: "0" },
    ]);
  });

  it("ignores spaces around a value, so a stray space is not a change", () => {
    expect(pendingChanges(form(), form({ poll_seconds: " 60 " }))).toEqual([]);
  });

  it("shows an emptied field as empty, not as a missing change", () => {
    expect(pendingChanges(form(), form({ max_concurrent_gates: "" }))).toEqual([
      { key: "max_concurrent_gates", label: "Max concurrent gates", from: "2", to: "" },
    ]);
  });
});
