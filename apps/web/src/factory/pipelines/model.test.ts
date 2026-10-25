import { describe, expect, it } from "vite-plus/test";

import {
  asPipeline,
  edgeLabelText,
  happyPort,
  nodeName,
  problemsFromDecodeErrors,
  slugOf,
  summaryOf,
  trailOfTrace,
} from "./model";
import type { KindInfo, Pipeline } from "./types";

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
    expect(slugOf("Runs", new Set())).toBe("runs-2");
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

describe("nodeName", () => {
  const kinds: ReadonlyArray<KindInfo> = [
    { kind: "end", label: "End", description: "", ports: [], instructions: "none" },
  ];
  const end = { id: "done", kind: "end", result: "done", x: 0, y: 0 } as const;

  it("is the label when the node has one of its own, else the kind", () => {
    const start = { id: "start", kind: "start", x: 0, y: 0 } as const;
    const startKinds: ReadonlyArray<KindInfo> = [
      { kind: "start", label: "Start", description: "", ports: [], instructions: "none" },
    ];
    expect(nodeName(kinds, { ...end, label: "Shipped" })).toBe("Shipped");
    expect(nodeName(startKinds, start)).toBe("Start");
    expect(nodeName(startKinds, { ...start, label: "start" })).toBe("Start");
  });

  it("names an unlabelled end by its result, so two ends never share a name", () => {
    expect(nodeName(kinds, end)).toBe("Done");
    expect(nodeName(kinds, { ...end, id: "stuck", result: "stuck" })).toBe("Stuck");
    expect(nodeName(kinds, { ...end, label: "end" })).toBe("Done");
    expect(nodeName(kinds, { ...end, label: "  " })).toBe("Done");
  });
});

describe("happyPort", () => {
  it("moves the work on at each kind of node", () => {
    expect(happyPort("pr", ["feedback", "base-moved", "merged", "closed"])).toBe("merged");
    expect(happyPort("verify", ["pass", "fail"])).toBe("pass");
    expect(happyPort("agent", ["done", "questions", "stop"])).toBe("done");
    expect(happyPort("ask", ["answered"])).toBe("answered");
    expect(happyPort("start", ["next"])).toBe("next");
  });

  it("falls back to the first outcome, and to none when there is none", () => {
    expect(happyPort(undefined, ["a", "b"])).toBe("a");
    expect(happyPort("pr", ["feedback"])).toBe("feedback");
    expect(happyPort("end", [])).toBeNull();
  });
});

describe("asPipeline", () => {
  it("reads a run's snapshot that has nodes and edges, and nothing else", () => {
    expect(asPipeline(PIPELINE)).toBe(PIPELINE);
    expect(asPipeline({ id: "p", nodes: "no", edges: [] })).toBeNull();
    expect(asPipeline({})).toBeNull();
  });
});

describe("edgeLabelText", () => {
  const edge = { id: "e3", from: "gate", port: "fail", to: "build", max: 3 };

  it("says the limit while editing, and the count against it on a trail", () => {
    expect(edgeLabelText(edge, null)).toBe("fail · max 3");
    expect(edgeLabelText(edge, { e3: 2 })).toBe("fail 2/3");
  });

  it("counts traversals of an edge with no limit only on a trail", () => {
    const open = { id: "e1", from: "start", port: "next", to: "build" };
    expect(edgeLabelText(open, null)).toBe("next");
    expect(edgeLabelText(open, { e1: 2 })).toBe("next ×2");
    expect(edgeLabelText(open, {})).toBe("next");
  });
});
