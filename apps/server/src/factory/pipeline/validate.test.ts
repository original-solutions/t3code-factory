import { describe, expect, it } from "vite-plus/test";

import { buildAndGate, buildAndLearn, SKILLS } from "./fixtures.ts";
import type { Edge, Node, Pipeline } from "./model.ts";
import { hasErrors, unlimitedCycle, validate } from "./validate.ts";

const errors = (pipeline: Pipeline, skills = SKILLS) =>
  validate(pipeline, skills)
    .filter((problem) => problem.level === "error")
    .map((problem) => problem.message);
const warnings = (pipeline: Pipeline, skills = SKILLS) =>
  validate(pipeline, skills)
    .filter((problem) => problem.level === "warning")
    .map((problem) => problem.message);

const withEdges = (pipeline: Pipeline, edges: ReadonlyArray<Edge>): Pipeline => ({
  ...pipeline,
  edges,
});
const withNodes = (pipeline: Pipeline, nodes: ReadonlyArray<Node>): Pipeline => ({
  ...pipeline,
  nodes,
});

describe("validate", () => {
  it("accepts both fixtures without errors or warnings", () => {
    expect(validate(buildAndGate, SKILLS)).toEqual([]);
    expect(validate(buildAndLearn, SKILLS)).toEqual([]);
  });

  it("needs exactly one start and an end", () => {
    const noStart = withNodes(
      buildAndGate,
      buildAndGate.nodes.filter((node) => node.kind !== "start"),
    );
    expect(errors(noStart)).toContain("the pipeline has no start");
    const twoStarts = withNodes(buildAndGate, [
      ...buildAndGate.nodes,
      { id: "start2", kind: "start", x: 0, y: 0 },
    ]);
    expect(validate(twoStarts, SKILLS)).toContainEqual({
      level: "error",
      message: "the pipeline has more than one start",
      node: "start2",
    });
    const noEnd = withNodes(
      buildAndGate,
      buildAndGate.nodes.filter((node) => node.kind !== "end"),
    );
    expect(errors(noEnd)).toContain("the pipeline has no end");
  });

  it("names a skill the machine does not have, on the node or transition", () => {
    const problems = validate(buildAndLearn, new Set(["factory"]));
    expect(problems).toEqual([
      {
        level: "error",
        message: "Learn names the skill session-capture, which this machine does not have",
        node: "learn",
      },
    ]);
    const skillEdge = withEdges(buildAndGate, [
      ...buildAndGate.edges.filter((edge) => edge.id !== "e3"),
      {
        id: "e3",
        from: "gate",
        port: "fail",
        to: "build",
        max: 2,
        instructions: { skill: "review-loop" },
      },
    ]);
    expect(errors(skillEdge)).toEqual([
      "transition e3 names the skill review-loop, which this machine does not have",
    ]);
  });

  it("rejects edges on unknown nodes, unknown ports, into start, out of an end, or doubled on a port", () => {
    const bad = withEdges(buildAndGate, [
      ...buildAndGate.edges,
      { id: "x1", from: "nowhere", port: "done", to: "gate" },
      { id: "x2", from: "gate", port: "maybe", to: "done" },
      { id: "x3", from: "gate", port: "pass", to: "start" },
      { id: "x4", from: "done", port: "next", to: "gate" },
    ]);
    expect(validate(bad, SKILLS).filter((p) => p.level === "error")).toEqual([
      { level: "error", message: "transition x1 leaves a node that does not exist", edge: "x1" },
      { level: "error", message: "Gate has no outcome maybe", edge: "x2" },
      { level: "error", message: "nothing enters Start: it is the start", edge: "x3" },
      { level: "error", message: "Gate has two transitions on pass", edge: "x3" },
      { level: "error", message: "nothing leaves End: it is an end", edge: "x4" },
      {
        level: "error",
        message: "the loop Gate → End → Gate has no limit on any of its transitions",
      },
    ]);
  });

  it("requires a limit on every loop", () => {
    const unlimited = withEdges(
      buildAndGate,
      buildAndGate.edges.map((edge) => {
        if (edge.id !== "e3") return edge;
        const { max: _, ...rest } = edge;
        return rest;
      }),
    );
    expect(unlimitedCycle(unlimited)).toEqual(["build", "gate", "build"]);
    expect(errors(unlimited)).toEqual([
      "the loop Build → Gate → Build has no limit on any of its transitions",
    ]);
    // A loop of two edges needs only one limit: the design says every cycle contains one limited edge.
    expect(unlimitedCycle(buildAndLearn)).toBeNull();
  });

  it("warns on an outcome with no transition and says what happens", () => {
    const open = withEdges(
      buildAndGate,
      buildAndGate.edges.filter((edge) => edge.id !== "e5"),
    );
    expect(warnings(open)).toEqual(["Build has no transition on stop: a run taking it ends stuck"]);
    expect(hasErrors(validate(open, SKILLS))).toBe(false);
  });

  it("warns on a node the start cannot reach and on a limit outside a loop", () => {
    const island: Pipeline = withNodes(buildAndGate, [
      ...buildAndGate.nodes,
      { id: "lonely", kind: "end", result: "done", x: 0, y: 0 },
    ]);
    expect(warnings(island)).toEqual(["End cannot be reached from the start"]);
    const limited = withEdges(
      buildAndGate,
      buildAndGate.edges.map((edge) => (edge.id === "e4" ? { ...edge, max: 3 } : edge)),
    );
    expect(warnings(limited)).toEqual([
      "the limit on transition e4 has no effect: it is not in a loop",
    ]);
  });

  it("reports duplicate ids", () => {
    const dup = withNodes(buildAndGate, [...buildAndGate.nodes, { ...buildAndGate.nodes[3]! }]);
    expect(errors(dup)).toContain("two nodes have the id done");
  });
});
