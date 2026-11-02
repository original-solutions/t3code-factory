import { describe, expect, it } from "vite-plus/test";

import type { FactoryEntry } from "./api";
import { runReport } from "./runReport";

const MIN = 60_000;

const entry = (min: number, event: string, data: unknown = {}): FactoryEntry => ({
  ts: new Date(min * MIN).toISOString(),
  ms: min * MIN,
  event,
  data,
  cause: null,
});

const to = (min: number, from: string, next: string) =>
  entry(min, "state_changed", { from, to: next });

const gate = (min: number, attempt: number, exit = 0) => [
  entry(min, "gate_checkout", { attempt }),
  entry(min + 2, "gate_command", {
    attempt,
    command: "make check",
    exit_code: exit,
    duration_ms: 2 * MIN,
  }),
];

const claim = [entry(0, "claimed"), to(0, "ready", "triage"), entry(0, "session_launched")];

describe("runReport", () => {
  it("is null until the run's pull request ends", () => {
    expect(runReport([...claim, to(1, "triage", "building")])).toBeNull();
    expect(
      runReport([
        ...claim,
        to(1, "building", "stuck"),
        entry(1, "finished", { outcome: "stuck", pr_end: null }),
      ]),
    ).toBeNull();
  });

  it("splits a merged run's time into agent, gate and review, in order", () => {
    const report = runReport([
      ...claim,
      to(1, "triage", "building"),
      entry(30, "pr_opened", { pr: 9, url: "https://github.com/o/r/pull/9" }),
      ...gate(31, 1),
      entry(33, "step_changed", { step: "gate-passed" }),
      to(34, "building", "pr-open"),
      entry(100, "finished", { outcome: "pr-open", total_ms: 100 * MIN, pr_end: "merged" }),
    ]);
    expect(report).toMatchObject({
      end: "merged",
      totalMs: 100 * MIN,
      totals: { agent: 32 * MIN, gate: 2 * MIN, review: 66 * MIN },
      feedbackRounds: 0,
      gateSendBacks: 0,
      baseMoves: 0,
      sessions: 1,
      firstTry: true,
    });
    expect(report!.segments.map((s) => [s.stage, s.startMs / MIN, s.endMs / MIN])).toEqual([
      ["agent", 0, 31],
      ["gate", 31, 33],
      ["agent", 33, 34],
      ["review", 34, 100],
    ]);
  });

  it("counts the rounds that sent it back: gate failures, review feedback and base moves", () => {
    const report = runReport([
      ...claim,
      to(1, "triage", "building"),
      ...gate(10, 1, 1),
      entry(12, "gate_sent_back", { attempt: 1 }),
      entry(12, "session_launched"),
      ...gate(20, 2),
      to(22, "building", "pr-open"),
      entry(40, "gate_regate", {}),
      ...gate(40, 3),
      entry(50, "feedback_relaunching", { n: 2 }),
      entry(50, "session_launched"),
      to(50, "pr-open", "building"),
      ...gate(60, 4),
      to(62, "building", "pr-open"),
      entry(70, "comment_forwarded", {}),
      entry(90, "finished", { outcome: "pr-open", total_ms: 90 * MIN, pr_end: "closed" }),
    ]);
    expect(report).toMatchObject({
      end: "closed",
      feedbackRounds: 2,
      gateSendBacks: 1,
      baseMoves: 1,
      sessions: 3,
      firstTry: false,
      totals: { gate: 8 * MIN },
    });
    expect(report!.marks.map((m) => [m.kind, m.atMs / MIN])).toEqual([
      ["gate-failed", 12],
      ["base-moved", 40],
      ["feedback", 50],
      ["feedback", 70],
    ]);
    const { agent, gate: g, review } = report!.totals;
    expect(agent + g + review).toBe(90 * MIN);
  });

  it("measures from the claim, not from the approval line before it", () => {
    const report = runReport([
      entry(-5, "step_changed", { step: "approved" }),
      ...claim,
      to(1, "triage", "building"),
      to(10, "building", "pr-open"),
      entry(20, "finished", { outcome: "pr-open", total_ms: 20 * MIN, pr_end: "merged" }),
    ]);
    expect(report!.segments[0]!.startMs).toBe(0);
    expect(report!.totals).toEqual({ agent: 10 * MIN, gate: 0, review: 10 * MIN });
  });
});
