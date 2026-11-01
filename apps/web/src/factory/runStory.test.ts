import { describe, expect, it } from "vite-plus/test";

import type { FactoryEntry } from "./api";
import { formatSpan, runStory } from "./runStory";

const entry = (ms: number, event: string, data: unknown = {}): FactoryEntry => ({
  ts: new Date(ms).toISOString(),
  ms,
  event,
  data,
  cause: null,
});

const MIN = 60_000;

describe("formatSpan", () => {
  it.each([
    [0, "0s"],
    [412, "0.4s"],
    [26_311, "26s"],
    [554_442, "9m 14s"],
    [10_096_159, "2h 48m"],
    [3 * 86_400_000 + 5 * 3_600_000, "3d 5h"],
  ])("%i ms reads %s", (ms, text) => {
    expect(formatSpan(ms)).toBe(text);
  });
});

describe("runStory", () => {
  it("drops bookkeeping and tells the rest in plain words, timed from the first entry", () => {
    const story = runStory([
      entry(0, "step_changed", { step: "approved" }),
      entry(10, "claimed", { machine: "personal-mac", github_user: "rawphp" }),
      entry(20, "state_changed", { from: "ready", to: "triage" }),
      entry(30, "session_launched", { thread_id: "t-1", model: "claude-opus-5-5" }),
      entry(48 * MIN, "pr_opened", { pr: 65, url: "https://github.com/o/r/pull/65" }),
      entry(49 * MIN, "gate_checkout", { attempt: 1 }),
      entry(49 * MIN, "worktree_removed", { path: "/w" }),
    ]);
    expect(story.steps.map((step) => [step.title, step.detail, step.tone, step.at])).toEqual([
      ["Claimed", "by rawphp on personal-mac", "info", "+0s"],
      ["Agent session started", "claude-opus-5-5", "info", "+0s"],
      ["Opened pull request", null, "success", "+48m 0s"],
    ]);
    expect(story.steps[1]!.threadId).toBe("t-1");
    expect(story.steps[2]!.link).toEqual({ text: "#65", href: "https://github.com/o/r/pull/65" });
  });

  it("folds each gate run's commands into one step, passed or failed", () => {
    const story = runStory([
      entry(0, "claimed"),
      entry(MIN, "gate_command", { attempt: 1, command: "lint", exit_code: 0, duration_ms: 412 }),
      entry(MIN, "gate_command", {
        attempt: 1,
        command: "test",
        exit_code: 2,
        duration_ms: 26_311,
      }),
      entry(2 * MIN, "gate_sent_back", { attempt: 1 }),
      entry(3 * MIN, "gate_regate", {}),
      entry(4 * MIN, "gate_command", {
        attempt: 2,
        command: "lint",
        exit_code: 0,
        duration_ms: 500,
      }),
      entry(4 * MIN, "gate_command", {
        attempt: 2,
        command: "test",
        exit_code: 0,
        duration_ms: 9000,
      }),
      // A re-gate of the same attempt is a second run of it.
      entry(5 * MIN, "gate_regate", {}),
      entry(5 * MIN, "gate_command", {
        attempt: 2,
        command: "lint",
        exit_code: 0,
        duration_ms: 300,
      }),
    ]);
    expect(story.steps.map((step) => [step.title, step.detail, step.tone])).toEqual([
      ["Claimed", null, "info"],
      ["Gate failed", "attempt 1 · 26s", "error"],
      ["Sent the failure back to the agent", null, "warning"],
      ["Base branch moved; gating again", null, "muted"],
      ["Gate passed", "attempt 2 · 9.5s", "success"],
      ["Base branch moved; gating again", null, "muted"],
      ["Gate passed", "attempt 2 · 0.3s", "success"],
    ]);
    expect(story.steps[1]!.commands).toEqual([
      { command: "lint", exit_code: 0, duration_ms: 412 },
      { command: "test", exit_code: 2, duration_ms: 26_311 },
    ]);
    expect(story.gateRuns).toEqual({ total: 3, failed: 1 });
  });

  it("calls a second session a relaunch and counts sessions", () => {
    const story = runStory([
      entry(0, "session_launched", { thread_id: "a" }),
      entry(1, "session_launched", { thread_id: "b" }),
    ]);
    expect(story.steps.map((step) => step.title)).toEqual([
      "Agent session started",
      "Agent session relaunched",
    ]);
    expect(story.sessions).toBe(2);
  });

  it("ends on how the pull request ended, with the run's total time", () => {
    const merged = runStory([
      entry(0, "claimed"),
      entry(MIN, "finished", { outcome: "pr-open", total_ms: 10_096_159, pr_end: "merged" }),
    ]);
    expect(merged.steps.at(-1)).toMatchObject({
      title: "Pull request merged",
      detail: "after 2h 48m",
      tone: "success",
    });
    expect(merged.tookMs).toBe(10_096_159);

    const stopped = runStory([entry(0, "finished", { outcome: "stopped" })]);
    expect(stopped.steps[0]).toMatchObject({ title: "Finished: stopped", tone: "muted" });
  });

  it("names why a run stopped for a person, and errors with their text", () => {
    const story = runStory([
      entry(0, "questions_posted", { questions: "Which table?\nAnd why?" }),
      entry(1, "stuck", { reason: "the session run ended as failed\n\nAPI Error: 429" }),
      entry(2, "error", { step: "forward", kind: "tracker", message: "HTTP 504" }),
      entry(3, "stop_requested", { by: "operator" }),
      entry(4, "pr_ready_outside", { pr: 147, by: "tomkaczocha" }),
    ]);
    expect(story.steps.map((step) => [step.title, step.detail, step.tone])).toEqual([
      ["Posted questions on the issue", "Which table?", "warning"],
      ["Stuck", "the session run ended as failed", "error"],
      ["Tracker error while forwarding", "HTTP 504", "error"],
      ["Stop requested by operator", null, "warning"],
      ["Pull request #147 marked ready by tomkaczocha", null, "info"],
    ]);
  });

  it("still shows an event it has no words for, so nothing is hidden", () => {
    const story = runStory([entry(0, "brand_new_thing", { x: 1 })]);
    expect(story.steps).toMatchObject([{ title: "brand new thing", tone: "muted" }]);
  });

  it("is empty for an empty ledger", () => {
    expect(runStory([])).toEqual({
      steps: [],
      gateRuns: { total: 0, failed: 0 },
      sessions: 0,
      tookMs: null,
    });
  });
});
