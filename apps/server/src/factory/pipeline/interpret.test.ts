import { describe, expect, it } from "vite-plus/test";

import { buildAndGate, buildAndLearn } from "./fixtures.ts";
import { advance, initialCursor, MAX_SIMULATED_STEPS, simulate } from "./interpret.ts";

describe("advance", () => {
  it("follows the edge of the outcome and counts it", () => {
    const start = initialCursor(buildAndGate)!;
    const move = advance(buildAndGate, start, "next");
    expect(move).toEqual({
      kind: "move",
      edge: buildAndGate.edges[0],
      cursor: { node: "build", taken: { e1: 1 } },
    });
  });

  it("ends stuck on an outcome with no transition, naming it", () => {
    const open = { ...buildAndGate, edges: buildAndGate.edges.filter((edge) => edge.id !== "e5") };
    expect(advance(open, { node: "build", taken: {} }, "stop")).toEqual({
      kind: "stuck",
      reason: "Build ended with stop, which has no transition",
    });
  });

  it("takes a limited edge up to its limit and ends stuck past it", () => {
    const first = advance(buildAndGate, { node: "gate", taken: {} }, "fail");
    expect(first.kind).toBe("move");
    const second = advance(buildAndGate, { node: "gate", taken: { e3: 1 } }, "fail");
    expect(second.kind).toBe("move");
    const third = advance(buildAndGate, { node: "gate", taken: { e3: 2 } }, "fail");
    expect(third).toEqual({
      kind: "stuck",
      reason: "Gate ended with fail for the 3rd time; the limit is 2",
      edge: buildAndGate.edges[2],
    });
  });
});

describe("simulate", () => {
  it("walks the happy path to the done end", () => {
    const trace = simulate(buildAndGate, ["next", "done", "pass"]);
    expect(trace.end).toEqual({ kind: "ended", result: "done" });
    expect(trace.steps.filter((step) => step.kind === "entered").map((step) => step.node)).toEqual([
      "start",
      "build",
      "gate",
      "done",
    ]);
    expect(trace.taken).toEqual({ e1: 1, e2: 1, e4: 1 });
  });

  it("waits for the next outcome when the script runs out, and offers the ports", () => {
    const trace = simulate(buildAndGate, ["next", "done"]);
    expect(trace.end).toEqual({ kind: "waiting", node: "gate", ports: ["pass", "fail"] });
  });

  it("loops within the limit and ends stuck past it", () => {
    const within = simulate(buildAndGate, ["next", "done", "fail", "done", "fail", "done", "pass"]);
    expect(within.end).toEqual({ kind: "ended", result: "done" });
    expect(within.taken["e3"]).toBe(2);
    const past = simulate(buildAndGate, ["next", "done", "fail", "done", "fail", "done", "fail"]);
    expect(past.end).toEqual({
      kind: "ended",
      result: "stuck",
      reason: "Gate ended with fail for the 3rd time; the limit is 2",
    });
  });

  it("runs the learning loop end to end", () => {
    const trace = simulate(buildAndLearn, [
      "next",
      "questions",
      "answered",
      "done",
      "fail",
      "done",
      "pass",
      "feedback",
      "done",
      "pass",
      "base-moved",
      "pass",
      "merged",
      "done",
    ]);
    expect(trace.end).toEqual({ kind: "ended", result: "done" });
    expect(trace.steps.filter((step) => step.kind === "moved").map((step) => step.edge)).toEqual([
      "e1",
      "e5",
      "e6",
      "e2",
      "e3",
      "e2",
      "e4",
      "e8",
      "e2",
      "e4",
      "e9",
      "e4",
      "e10",
      "e12",
    ]);
  });

  it("reports a pipeline without a start", () => {
    const noStart = {
      ...buildAndGate,
      nodes: buildAndGate.nodes.filter((node) => node.kind !== "start"),
    };
    expect(simulate(noStart, ["next"]).end).toEqual({ kind: "no-start" });
  });

  it("stops a runaway script", () => {
    // Every cycle has a limit in a valid pipeline, but a script can keep answering an unlimited
    // self-loop on an invalid one; the step cap ends it.
    const loop = {
      ...buildAndGate,
      edges: [
        ...buildAndGate.edges,
        { id: "self", from: "build", port: "questions", to: "build" },
      ].filter((edge) => edge.id !== "e6"),
    };
    const trace = simulate(loop, [
      "next",
      ...Array.from({ length: MAX_SIMULATED_STEPS }, () => "questions"),
    ]);
    expect(trace.end).toEqual({
      kind: "ended",
      result: "stuck",
      reason: `more than ${MAX_SIMULATED_STEPS} steps`,
    });
  });
});
