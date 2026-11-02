import { describe, expect, it } from "vite-plus/test";

import {
  feedbackBudget,
  limitNow,
  pendingChanges,
  readingOf,
  spanOf,
  type MachineNow,
  type TuningForm,
} from "./tuning";

const form = (overrides: Partial<TuningForm> = {}): TuningForm => ({
  gh_config_dir: "/home/t3/gh",
  poll_seconds: "60",
  max_concurrent_runs: "1",
  max_concurrent_gates: "2",
  feedback_seconds: "600",
  min_free_gib: "10",
  max_load_per_core: "1",
  ...overrides,
});

const GIB = 1024 ** 3;

const now = (overrides: { freeGib?: number; load?: number; used?: number; gates?: number } = {}) =>
  ({
    slots: { used: overrides.used ?? 1 },
    health: {
      disk: {
        path: "/w",
        free_bytes: (overrides.freeGib ?? 26) * GIB,
        total_bytes: 460 * GIB,
        floor_bytes: 10 * GIB,
        low: false,
      },
      load: { one_minute: overrides.load ?? 4.2, cores: 12, limit: 12, high: false },
      gates: { running: overrides.gates ?? 0, max: 2, oldest_ms: null },
    },
  }) satisfies MachineNow;

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
    expect(readingOf("min_free_gib", "10")).toBe(
      "Claims and gates wait while less than 10 GiB is free.",
    );
    expect(readingOf("min_free_gib", "0")).toBe("Never waits for disk.");
    expect(readingOf("max_load_per_core", "2")).toBe(
      "Claims wait while the 1-minute load is above 2 per core.",
    );
    expect(readingOf("max_load_per_core", "0")).toBe("Never waits for load.");
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

describe("limitNow", () => {
  it("sets the typed disk floor against the free space now, and says when it would hold", () => {
    const saved = form();
    expect(limitNow("min_free_gib", saved, saved, now())).toEqual({
      tone: "ok",
      text: "26 GiB free now, 16 GiB above the floor.",
      fill: 0,
      mark: 0.5,
    });
    expect(limitNow("min_free_gib", form({ min_free_gib: "30" }), saved, now())).toMatchObject({
      tone: "bad",
      text: "26 GiB free now, under 30 GiB: claims would be held.",
    });
    expect(limitNow("min_free_gib", saved, saved, now({ freeGib: 4 }))).toMatchObject({
      tone: "bad",
      text: "4.0 GiB free now, under 10 GiB: claims are held.",
    });
    expect(limitNow("min_free_gib", saved, saved, now({ freeGib: 12 }))?.tone).toBe("warn");
    expect(limitNow("min_free_gib", form({ min_free_gib: "0" }), saved, now())).toMatchObject({
      tone: "ok",
      text: "Off. 26 GiB free now.",
      mark: null,
    });
  });

  it("sets the typed load limit against the load now, times the cores", () => {
    const saved = form();
    expect(limitNow("max_load_per_core", saved, saved, now())).toMatchObject({
      tone: "ok",
      text: "Load 4.2 now; holds above 12 on 12 cores.",
      mark: 0.5,
    });
    expect(limitNow("max_load_per_core", saved, saved, now({ load: 11 }))?.tone).toBe("warn");
    expect(limitNow("max_load_per_core", saved, saved, now({ load: 13.5 }))).toMatchObject({
      tone: "bad",
      text: "Load 13.5 now, above 12 on 12 cores: claims are held.",
    });
    expect(
      limitNow("max_load_per_core", form({ max_load_per_core: "2" }), saved, now({ load: 13.5 })),
    ).toMatchObject({ tone: "ok", text: "Load 13.5 now; holds above 24 on 12 cores." });
  });

  it("counts the runs and gates in use now against the typed limit", () => {
    const saved = form();
    expect(limitNow("max_concurrent_runs", saved, saved, now({ used: 1 }))).toMatchObject({
      tone: "warn",
      text: "1 of 1 in use now: the next ready issue waits for one to end.",
      fill: 1,
    });
    expect(
      limitNow("max_concurrent_runs", form({ max_concurrent_runs: "3" }), saved, now()),
    ).toMatchObject({ tone: "ok", text: "1 of 3 in use now." });
    expect(limitNow("max_concurrent_runs", saved, saved, now({ used: 3 }))).toMatchObject({
      tone: "bad",
      text: "3 hold an issue now: nothing new is claimed until 3 end.",
    });
    expect(limitNow("max_concurrent_gates", saved, saved, now({ gates: 1 }))).toMatchObject({
      tone: "ok",
      text: "1 of 2 running now.",
    });
  });

  it("has nothing to set a limit against without a status, a reading or a value the server takes", () => {
    const saved = form();
    expect(limitNow("min_free_gib", saved, saved, null)).toBeNull();
    expect(limitNow("poll_seconds", saved, saved, now())).toBeNull();
    expect(limitNow("min_free_gib", form({ min_free_gib: "x" }), saved, now())).toBeNull();
    expect(
      limitNow("min_free_gib", saved, saved, {
        slots: { used: 0 },
        health: { ...now().health, disk: { error: "EACCES" } },
      }),
    ).toBeNull();
    expect(
      limitNow("max_concurrent_gates", saved, saved, { slots: { used: 0 }, health: null }),
    ).toBeNull();
  });
});
