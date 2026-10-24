/**
 * The pipelines a new one starts from: the three prototypes the design was exercised on. The
 * catalog serves them, so the New pipeline dialog offers them beside a blank canvas, and the
 * person gets a working graph to adapt instead of an empty one.
 */
import type { Pipeline } from "./model.ts";

export type Template = {
  readonly description: string;
  readonly pipeline: Pipeline;
};

export const briefAndGate: Template = {
  description: "The simplest useful pipeline: one agent with a brief, one gate, two tries.",
  pipeline: {
    id: "brief-and-gate",
    name: "Brief and gate",
    nodes: [
      { id: "start", kind: "start", x: 40, y: 200 },
      {
        id: "build",
        kind: "agent",
        label: "Build",
        x: 280,
        y: 200,
        instructions: {
          brief:
            "Read the issue named in this message. Implement what it asks for in this worktree with\na failing test first. Run the project's own checks. Commit, push the branch and open a\ndraft pull request with gh. End with FACTORY-DONE: <pull request URL>.\n",
        },
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
      {
        id: "e3",
        from: "gate",
        port: "fail",
        to: "build",
        max: 2,
        instructions: {
          brief:
            "The gate failed. Fix what its output below shows, push, and end with a result line.",
        },
      },
      { id: "e4", from: "gate", port: "pass", to: "done" },
      { id: "e5", from: "build", port: "stop", to: "stuck" },
      { id: "e6", from: "build", port: "questions", to: "stuck" },
    ],
  },
};

export const buildReviewShip: Template = {
  description:
    "The factory's lifecycle plus an agent review before the pull request, with loops on the gate, the review and the feedback.",
  pipeline: {
    id: "build-review-ship",
    name: "Build, review, ship",
    nodes: [
      { id: "start", kind: "start", x: 40, y: 240 },
      {
        id: "build",
        kind: "agent",
        label: "Build",
        x: 280,
        y: 240,
        instructions: { skill: "factory" },
        fresh: false,
      },
      { id: "ask", kind: "ask", label: "Ask", x: 280, y: 480 },
      {
        id: "gate",
        kind: "verify",
        label: "Gate",
        x: 520,
        y: 240,
        check: { commands: ["factory/scripts/check.sh"] },
      },
      {
        id: "review",
        kind: "verify",
        label: "Review",
        x: 760,
        y: 240,
        check: { skill: "review-gate" },
      },
      { id: "pr", kind: "pr", label: "Pull request", x: 1000, y: 240 },
      { id: "done", kind: "end", result: "done", x: 1240, y: 240 },
      { id: "stuck", kind: "end", result: "stuck", x: 1000, y: 480 },
    ],
    edges: [
      { id: "e1", from: "start", port: "next", to: "build" },
      { id: "e2", from: "build", port: "done", to: "gate" },
      { id: "e3", from: "build", port: "questions", to: "ask" },
      {
        id: "e4",
        from: "ask",
        port: "answered",
        to: "build",
        max: 3,
        instructions: {
          brief:
            "The answers to your questions are below. Continue the work and end with a result line.",
        },
      },
      { id: "e5", from: "build", port: "stop", to: "stuck" },
      {
        id: "e6",
        from: "gate",
        port: "fail",
        to: "build",
        max: 2,
        instructions: {
          brief:
            "The gate failed. Fix what its output below shows, push, and end with a result line.",
        },
      },
      { id: "e7", from: "gate", port: "pass", to: "review" },
      {
        id: "e8",
        from: "review",
        port: "fail",
        to: "build",
        max: 3,
        instructions: {
          brief:
            "The reviewer's findings are below. Fix each one, push, and end with a result line.",
        },
      },
      { id: "e9", from: "review", port: "pass", to: "pr" },
      {
        id: "e10",
        from: "pr",
        port: "feedback",
        to: "build",
        max: 5,
        instructions: {
          brief:
            "A person left the feedback below on the pull request. Address it, push, and end with a result line.",
        },
      },
      { id: "e11", from: "pr", port: "base-moved", to: "gate", max: 10 },
      { id: "e12", from: "pr", port: "merged", to: "done" },
      { id: "e13", from: "pr", port: "closed", to: "stuck" },
    ],
  },
};

export const learningLoop: Template = {
  description:
    "Build, gate, check the tests, agent review, pull request, then a learn step: a merged run captures what worked, a stuck run writes a postmortem into the factory skill.",
  pipeline: {
    id: "learning-loop",
    name: "Learning loop",
    nodes: [
      { id: "start", kind: "start", x: 40, y: 260 },
      {
        id: "build",
        kind: "agent",
        label: "Build",
        x: 280,
        y: 260,
        instructions: { skill: "factory" },
        fresh: false,
      },
      { id: "ask", kind: "ask", label: "Ask", x: 280, y: 520 },
      {
        id: "gate",
        kind: "verify",
        label: "Gate",
        x: 520,
        y: 260,
        check: { commands: ["factory/scripts/check.sh"] },
      },
      {
        id: "tests",
        kind: "verify",
        label: "Tests honest",
        x: 760,
        y: 260,
        check: { skill: "test-tests" },
      },
      {
        id: "review",
        kind: "verify",
        label: "Review",
        x: 1000,
        y: 260,
        check: { skill: "review-gate" },
      },
      { id: "pr", kind: "pr", label: "Pull request", x: 1240, y: 260 },
      {
        id: "learn",
        kind: "learn",
        label: "Capture lessons",
        x: 1480,
        y: 260,
        instructions: { skill: "session-capture" },
      },
      {
        id: "postmortem",
        kind: "learn",
        label: "Postmortem",
        x: 1000,
        y: 520,
        instructions: {
          brief:
            "This run ended stuck. Read its record below, find the one lesson that would have let the\nnext run on this repo avoid the same end, and append it to\n~/EA/skills/factory/references/field-lessons.md as one short dated bullet. Do not touch\nthe repo. End with FACTORY-DONE: <the lesson in one line>.\n",
        },
      },
      { id: "done", kind: "end", result: "done", x: 1720, y: 260 },
      { id: "stuck", kind: "end", result: "stuck", x: 1240, y: 520 },
    ],
    edges: [
      { id: "e1", from: "start", port: "next", to: "build" },
      { id: "e2", from: "build", port: "done", to: "gate" },
      { id: "e3", from: "build", port: "questions", to: "ask" },
      {
        id: "e4",
        from: "ask",
        port: "answered",
        to: "build",
        max: 3,
        instructions: {
          brief:
            "The answers to your questions are below. Continue the work and end with a result line.",
        },
      },
      { id: "e5", from: "build", port: "stop", to: "postmortem" },
      {
        id: "e6",
        from: "gate",
        port: "fail",
        to: "build",
        max: 2,
        instructions: {
          brief:
            "The gate failed. Fix what its output below shows, push, and end with a result line.",
        },
      },
      { id: "e7", from: "gate", port: "pass", to: "tests" },
      {
        id: "e8",
        from: "tests",
        port: "fail",
        to: "build",
        max: 2,
        instructions: {
          brief:
            "The test review below found tests that do not prove the behaviour. Fix them, push, and end with a result line.",
        },
      },
      { id: "e9", from: "tests", port: "pass", to: "review" },
      {
        id: "e10",
        from: "review",
        port: "fail",
        to: "build",
        max: 3,
        instructions: {
          brief:
            "The reviewer's findings are below. Fix each one, push, and end with a result line.",
        },
      },
      { id: "e11", from: "review", port: "pass", to: "pr" },
      {
        id: "e12",
        from: "pr",
        port: "feedback",
        to: "build",
        max: 5,
        instructions: {
          brief:
            "A person left the feedback below on the pull request. Address it, push, and end with a result line.",
        },
      },
      { id: "e13", from: "pr", port: "base-moved", to: "gate", max: 10 },
      { id: "e14", from: "pr", port: "merged", to: "learn" },
      { id: "e15", from: "pr", port: "closed", to: "postmortem" },
      { id: "e16", from: "learn", port: "done", to: "done" },
      { id: "e17", from: "postmortem", port: "done", to: "stuck" },
    ],
  },
};

/** In the order the dialog lists them: simplest first. */
export const TEMPLATES: ReadonlyArray<Template> = [briefAndGate, buildReviewShip, learningLoop];
