/** Pipelines the tests share, as bodies: what the editor would save. */
import type { Pipeline } from "./model.ts";

/** Start, one agent, one gate with a retry loop, a done end and a stuck end. */
export const buildAndGate: Pipeline = {
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
    {
      id: "e3",
      from: "gate",
      port: "fail",
      to: "build",
      max: 2,
      instructions: { brief: "The gate failed. Fix it." },
    },
    { id: "e4", from: "gate", port: "pass", to: "done" },
    { id: "e5", from: "build", port: "stop", to: "stuck" },
    { id: "e6", from: "build", port: "questions", to: "stuck" },
  ],
};

/** The full learning loop from the design doc. */
export const buildAndLearn: Pipeline = {
  id: "build-and-learn",
  name: "Build and learn",
  nodes: [
    { id: "start", kind: "start", x: 40, y: 200 },
    {
      id: "build",
      kind: "agent",
      label: "Build",
      x: 280,
      y: 200,
      instructions: { skill: "factory" },
    },
    {
      id: "gate",
      kind: "verify",
      label: "Gate",
      x: 520,
      y: 200,
      check: { commands: ["factory/scripts/check.sh"] },
    },
    { id: "ask", kind: "ask", label: "Ask", x: 280, y: 420 },
    { id: "review", kind: "pr", label: "Review", x: 760, y: 200 },
    {
      id: "learn",
      kind: "learn",
      label: "Learn",
      x: 1000,
      y: 200,
      instructions: { skill: "session-capture" },
    },
    { id: "done", kind: "end", result: "done", x: 1240, y: 200 },
    { id: "stuck", kind: "end", result: "stuck", x: 760, y: 420 },
  ],
  edges: [
    { id: "e1", from: "start", port: "next", to: "build" },
    { id: "e2", from: "build", port: "done", to: "gate" },
    {
      id: "e3",
      from: "gate",
      port: "fail",
      to: "build",
      max: 2,
      instructions: { brief: "The gate failed. Fix it." },
    },
    { id: "e4", from: "gate", port: "pass", to: "review" },
    { id: "e5", from: "build", port: "questions", to: "ask" },
    {
      id: "e6",
      from: "ask",
      port: "answered",
      to: "build",
      max: 3,
      instructions: { brief: "Continue with the answers below." },
    },
    { id: "e7", from: "build", port: "stop", to: "stuck" },
    {
      id: "e8",
      from: "review",
      port: "feedback",
      to: "build",
      max: 5,
      instructions: { brief: "Address the feedback below." },
    },
    { id: "e9", from: "review", port: "base-moved", to: "gate", max: 10 },
    { id: "e10", from: "review", port: "merged", to: "learn" },
    { id: "e11", from: "review", port: "closed", to: "stuck" },
    { id: "e12", from: "learn", port: "done", to: "done" },
  ],
};

export const SKILLS: ReadonlySet<string> = new Set(["factory", "session-capture", "review-gate"]);
