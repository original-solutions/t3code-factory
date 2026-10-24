import { describe, expect, it } from "vite-plus/test";

import { problemsFromDecodeErrors, slugOf, summaryOf, trailOfTrace } from "./model";
import type { Pipeline } from "./types";

const PIPELINE: Pipeline = {
  id: "p",
  name: "P",
  nodes: [
    { id: "start", kind: "start", x: 0, y: 0 },
    { id: "build", kind: "agent", x: 0, y: 0, instructions: { brief: "" }, fresh: false },
  ],
  edges: [{ id: "e1", from: "start", port: "next", to: "build" }],
};

describe("problemsFromDecodeErrors", () => {
  it("puts a field error on the node or edge at that index of the body sent", () => {
    expect(
      problemsFromDecodeErrors(PIPELINE, [
        { path: "nodes.1.instructions.brief", message: "must be the brief's text" },
        { path: "edges.0.max", message: "must be a whole number of at least 1" },
        { path: "name", message: "must be a name" },
      ]),
    ).toEqual([
      { level: "error", node: "build", message: "instructions.brief must be the brief's text" },
      { level: "error", edge: "e1", message: "max must be a whole number of at least 1" },
      { level: "error", message: "name must be a name" },
    ]);
  });
});

describe("slugOf", () => {
  it("makes an id the server accepts, avoiding ids already taken", () => {
    expect(slugOf("Build & Learn!", new Set())).toBe("build-learn");
    expect(slugOf("Build & Learn", new Set(["build-learn"]))).toBe("build-learn-2");
    expect(slugOf("!!!", new Set())).toBe("pipeline");
  });
});

describe("summaryOf", () => {
  it("names the skill, the first words of a brief, or the command count", () => {
    const base = { id: "n", x: 0, y: 0 };
    expect(
      summaryOf({ ...base, kind: "agent", instructions: { skill: "factory" }, fresh: false }),
    ).toBe("skill factory");
    expect(
      summaryOf({
        ...base,
        kind: "learn",
        instructions: { brief: "Write what you learned into the skill" },
      }),
    ).toBe("brief: Write what you learned into…");
    expect(summaryOf({ ...base, kind: "verify", check: { commands: ["a", "b", "c"] } })).toBe(
      "3 commands",
    );
  });
});

describe("trailOfTrace", () => {
  it("marks visited nodes and edges and the node it waits at", () => {
    const trail = trailOfTrace({
      steps: [
        { kind: "entered", node: "start" },
        { kind: "outcome", node: "start", port: "next" },
        { kind: "moved", edge: "e1" },
        { kind: "entered", node: "build" },
      ],
      taken: { e1: 1 },
      end: { kind: "waiting", node: "build", ports: ["done"] },
    });
    expect([...trail.nodes]).toEqual(["start", "build"]);
    expect([...trail.edges]).toEqual(["e1"]);
    expect(trail.current).toBe("build");
  });
});
