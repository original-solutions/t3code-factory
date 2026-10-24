import { describe, expect, it } from "vite-plus/test";

import { loopEdges, tidyLayout } from "./layout";
import type { Pipeline } from "./types";

// The server's fixtures (apps/server/src/factory/pipeline/fixtures.ts), copied: web cannot import them.
const buildAndGate: Pipeline = {
  id: "build-and-gate",
  name: "Build and gate",
  nodes: [
    { id: "start", kind: "start", x: 40, y: 200 },
    {
      id: "build",
      kind: "agent",
      label: "Build",
      x: 280,
      y: 200,
      instructions: { skill: "factory" },
      fresh: false,
    },
    {
      id: "gate",
      kind: "verify",
      label: "Gate",
      x: 520,
      y: 200,
      check: { commands: ["factory/scripts/check.sh"] },
    },
    { id: "done", kind: "end", result: "done", x: 760, y: 200 },
    { id: "stuck", kind: "end", result: "stuck", x: 520, y: 420 },
  ],
  edges: [
    { id: "e1", from: "start", port: "next", to: "build" },
    { id: "e2", from: "build", port: "done", to: "gate" },
    { id: "e3", from: "gate", port: "fail", to: "build", max: 2 },
    { id: "e4", from: "gate", port: "pass", to: "done" },
    { id: "e5", from: "build", port: "stop", to: "stuck" },
    { id: "e6", from: "build", port: "questions", to: "stuck" },
  ],
};

const buildAndLearn: Pipeline = {
  id: "build-and-learn",
  name: "Build and learn",
  nodes: [
    { id: "start", kind: "start", x: 0, y: 0 },
    {
      id: "build",
      kind: "agent",
      label: "Build",
      x: 0,
      y: 0,
      instructions: { skill: "factory" },
      fresh: false,
    },
    {
      id: "gate",
      kind: "verify",
      label: "Gate",
      x: 0,
      y: 0,
      check: { commands: ["factory/scripts/check.sh"] },
    },
    { id: "ask", kind: "ask", label: "Ask", x: 0, y: 0 },
    { id: "review", kind: "pr", label: "Review", x: 0, y: 0 },
    {
      id: "learn",
      kind: "learn",
      label: "Learn",
      x: 0,
      y: 0,
      instructions: { skill: "session-capture" },
    },
    { id: "done", kind: "end", result: "done", x: 0, y: 0 },
    { id: "stuck", kind: "end", result: "stuck", x: 0, y: 0 },
  ],
  edges: [
    { id: "e1", from: "start", port: "next", to: "build" },
    { id: "e2", from: "build", port: "done", to: "gate" },
    { id: "e3", from: "gate", port: "fail", to: "build", max: 2 },
    { id: "e4", from: "gate", port: "pass", to: "review" },
    { id: "e5", from: "build", port: "questions", to: "ask" },
    { id: "e6", from: "ask", port: "answered", to: "build", max: 3 },
    { id: "e7", from: "build", port: "stop", to: "stuck" },
    { id: "e8", from: "review", port: "feedback", to: "build", max: 5 },
    { id: "e9", from: "review", port: "base-moved", to: "gate", max: 10 },
    { id: "e10", from: "review", port: "merged", to: "learn" },
    { id: "e11", from: "review", port: "closed", to: "stuck" },
    { id: "e12", from: "learn", port: "done", to: "done" },
  ],
};

describe("loopEdges", () => {
  it("finds the edges that go back, and only those", () => {
    expect([...loopEdges(buildAndGate)]).toEqual(["e3"]);
    expect([...loopEdges(buildAndLearn)].sort()).toEqual(["e3", "e6", "e8", "e9"]);
  });
});

describe("tidyLayout", () => {
  it("lays the gate loop out left to right with the stuck end below", () => {
    expect(tidyLayout(buildAndGate)).toEqual({
      start: { x: 40, y: 40 },
      build: { x: 280, y: 40 },
      gate: { x: 520, y: 40 },
      done: { x: 760, y: 40 },
      stuck: { x: 520, y: 240 },
    });
  });

  it("ranks by the longest forward path, stacks a column in walk order and sinks the stuck end", () => {
    expect(tidyLayout(buildAndLearn)).toEqual({
      start: { x: 40, y: 40 },
      build: { x: 280, y: 40 },
      gate: { x: 520, y: 40 },
      ask: { x: 520, y: 240 },
      review: { x: 760, y: 40 },
      learn: { x: 1000, y: 40 },
      done: { x: 1240, y: 40 },
      // Reached from build (rank 2) and review (rank 4): the longer path wins.
      stuck: { x: 1000, y: 440 },
    });
  });

  it("places nodes no edge reaches too", () => {
    const lonely: Pipeline = {
      ...buildAndGate,
      nodes: [...buildAndGate.nodes, { id: "loose", kind: "ask", x: 0, y: 0 }],
    };
    expect(tidyLayout(lonely).loose).toEqual({ x: 40, y: 240 });
  });
});
