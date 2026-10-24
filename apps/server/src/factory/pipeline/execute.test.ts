import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe } from "vite-plus/test";

import {
  execute,
  NO_PULL_REQUEST,
  NO_RESULT_TWICE,
  PortError,
  RESULT_LINE_REMINDER,
  type Ports,
  type PullRequestPort,
  type Tracker,
} from "./execute.ts";
import { buildAndGate, buildAndLearn } from "./fixtures.ts";
import type { Pipeline } from "./model.ts";
import type { RunEvent } from "./runsService.ts";

const isPortError = Schema.is(PortError);

/** Answers what the script says next for one port, and fails the test when it runs out. */
const next = <A>(name: string, script: Array<A>): A => {
  const value = script.shift();
  if (value === undefined) throw new Error(`the ${name} script ran out`);
  return value;
};

interface Script {
  /** The last assistant message each `settle` answers, in order; a PortError fails it. */
  readonly replies: Array<string | null | PortError>;
  readonly commands?: Array<{ ok: boolean; output: string }>;
  readonly answers?: Array<string>;
  readonly pullRequest?: Array<{ port: PullRequestPort; detail: string | null }>;
  readonly tracker?: boolean;
}

const fakePorts = (script: Script) => {
  const events: Array<RunEvent> = [];
  const launches: Array<{ title: string; message: string; fromBranch: string | null }> = [];
  const sent: Array<{ threadId: string; message: string }> = [];
  const archived: Array<string> = [];
  const ran: Array<{ lines: ReadonlyArray<string>; cwd: string }> = [];
  const questions: Array<string> = [];
  const ready: Array<number> = [];
  const thread = (threadId: string) => ({
    threadId,
    worktree: `/wt/${threadId}`,
    branch: `t3/${threadId}`,
  });
  const tracker: Tracker = {
    postQuestions: (text) => Effect.sync(() => void questions.push(text)),
    awaitAnswer: () => Effect.sync(() => ({ text: next("answers", script.answers ?? []) })),
    markReady: (pr) => Effect.sync(() => void ready.push(pr)),
    awaitPullRequest: () => Effect.sync(() => next("pull request", script.pullRequest ?? [])),
  };
  const ports: Ports = {
    launch: (input) =>
      Effect.sync(() => {
        launches.push(input);
        // T3 prepares the worktree after the launch answers, so the first answer has none.
        return { threadId: `t${launches.length}`, worktree: null, branch: null };
      }),
    send: (threadId, message) => Effect.sync(() => void sent.push({ threadId, message })),
    settle: (threadId) =>
      Effect.suspend(() => {
        const reply = next("replies", script.replies);
        return isPortError(reply)
          ? Effect.fail(reply)
          : Effect.succeed({ ...thread(threadId), text: reply });
      }),
    archive: (threadId) => Effect.sync(() => void archived.push(threadId)),
    commands: (lines, cwd) =>
      Effect.sync(() => {
        ran.push({ lines, cwd });
        return next("commands", script.commands ?? []);
      }),
    tracker: script.tracker === false ? null : tracker,
    record: (event) => Effect.sync(() => void events.push(event)),
  };
  return { ports, events, launches, sent, archived, ran, questions, ready };
};

const run = { repo: "acme/widgets", issue: 12 };

/** The record without the thread lines, which the tests that follow nodes do not care about. */
const steps = (events: ReadonlyArray<RunEvent>) =>
  events.filter((event) => event.event !== "thread");

const PR_URL = "https://github.com/acme/widgets/pull/42";

describe("execute", () => {
  it.effect("walks a linear run and records every step", () =>
    Effect.gen(function* () {
      const fake = fakePorts({
        replies: [`Built it.\nFACTORY-DONE: ${PR_URL}`],
        commands: [{ ok: true, output: "all green" }],
      });
      const end = yield* execute(buildAndGate, fake.ports, run);
      assert.deepStrictEqual(end, { result: "done", reason: null });
      assert.deepStrictEqual(steps(fake.events), [
        { event: "entered", node: "start", visit: 1 },
        { event: "outcome", node: "start", port: "next", detail: null },
        { event: "moved", edge: "e1" },
        { event: "entered", node: "build", visit: 1 },
        { event: "outcome", node: "build", port: "done", detail: PR_URL },
        { event: "moved", edge: "e2" },
        { event: "entered", node: "gate", visit: 1 },
        { event: "outcome", node: "gate", port: "pass", detail: "all green" },
        { event: "moved", edge: "e4" },
        { event: "entered", node: "done", visit: 1 },
        { event: "ended", result: "done", reason: null },
      ]);
      // The launch is from the base, titled by the pipeline and step, and carries the preamble.
      assert.strictEqual(fake.launches.length, 1);
      const [launch] = fake.launches;
      assert.strictEqual(launch!.title, "Build and gate: Build");
      assert.strictEqual(launch!.fromBranch, null);
      assert.isTrue(launch!.message.startsWith("/factory\n\n"));
      assert.include(
        launch!.message,
        "unattended as part of the pipeline Build and gate, step Build",
      );
      assert.include(launch!.message, "The issue is acme/widgets#12.");
      // The gate ran in the worktree T3 prepared after the launch.
      assert.deepStrictEqual(fake.ran, [{ lines: ["factory/scripts/check.sh"], cwd: "/wt/t1" }]);
      assert.deepStrictEqual(fake.archived, ["t1"]);
    }),
  );

  it.effect(
    "sends the loop edge's instructions with the gate output, then ends stuck at the limit",
    () =>
      Effect.gen(function* () {
        const fake = fakePorts({
          replies: ["FACTORY-DONE: built", "FACTORY-DONE: fixed", "FACTORY-DONE: fixed again"],
          commands: [
            { ok: false, output: "lint: 1 error" },
            { ok: false, output: "lint: still 1 error" },
            { ok: false, output: "lint: 1 error forever" },
          ],
        });
        const end = yield* execute(buildAndGate, fake.ports, run);
        assert.deepStrictEqual(end, {
          result: "stuck",
          reason: "Gate ended with fail for the 3rd time; the limit is 2",
        });
        assert.strictEqual(fake.launches.length, 1);
        assert.deepStrictEqual(fake.sent, [
          {
            threadId: "t1",
            message: "The gate failed. Fix it.\n\nThe gate's output:\n\nlint: 1 error",
          },
          {
            threadId: "t1",
            message: "The gate failed. Fix it.\n\nThe gate's output:\n\nlint: still 1 error",
          },
        ]);
        const builds = fake.events.filter(
          (event) => event.event === "entered" && event.node === "build",
        );
        assert.deepStrictEqual(
          builds.map((event) => (event.event === "entered" ? event.visit : 0)),
          [1, 2, 3],
        );
        assert.deepStrictEqual(fake.events.at(-1), {
          event: "ended",
          result: "stuck",
          reason: "Gate ended with fail for the 3rd time; the limit is 2",
        });
        assert.deepStrictEqual(fake.archived, ["t1"]);
      }),
  );

  it.effect("launches a fresh agent node from the run's branch and archives it", () =>
    Effect.gen(function* () {
      const withReview: Pipeline = {
        ...buildAndGate,
        nodes: [
          ...buildAndGate.nodes,
          {
            id: "polish",
            kind: "agent",
            label: "Polish",
            x: 0,
            y: 0,
            instructions: { brief: "Polish the docs." },
            fresh: true,
          },
        ],
        edges: [
          ...buildAndGate.edges.filter((edge) => edge.id !== "e4"),
          { id: "e4", from: "gate", port: "pass", to: "polish" },
          { id: "e7", from: "polish", port: "done", to: "done" },
        ],
      };
      const fake = fakePorts({
        replies: ["FACTORY-DONE: built", "FACTORY-DONE: polished"],
        commands: [{ ok: true, output: "ok" }],
      });
      const end = yield* execute(withReview, fake.ports, run);
      assert.strictEqual(end.result, "done");
      assert.strictEqual(fake.launches.length, 2);
      const polish = fake.launches[1]!;
      assert.strictEqual(polish.fromBranch, "t3/t1");
      assert.strictEqual(polish.title, "Build and gate: Polish");
      assert.isTrue(polish.message.startsWith("Polish the docs.\n\nThe gate's output:\n\nok\n\n"));
      // The fresh thread is archived once it answered; the main thread when the run ends.
      assert.deepStrictEqual(fake.archived, ["t2", "t1"]);
    }),
  );

  it.effect("posts questions, waits for answers and sends them on", () =>
    Effect.gen(function* () {
      const fake = fakePorts({
        replies: ["1. Which base?\nFACTORY-STOP: needs-info", "FACTORY-STOP: stuck"],
        answers: ["Use main."],
      });
      const end = yield* execute(buildAndLearn, fake.ports, run);
      assert.deepStrictEqual(fake.questions, ["1. Which base?"]);
      assert.deepStrictEqual(fake.sent, [
        {
          threadId: "t1",
          message: "Continue with the answers below.\n\nThe answers:\n\nUse main.",
        },
      ]);
      assert.deepInclude(fake.events, {
        event: "waiting",
        node: "ask",
        on: "an answer on the issue",
      });
      assert.deepInclude(fake.events, {
        event: "outcome",
        node: "ask",
        port: "answered",
        detail: "Use main.",
      });
      assert.deepStrictEqual(end, { result: "stuck", reason: null });
    }),
  );

  it.effect("ends stuck at an ask node when the run has no issue on a watched repo", () =>
    Effect.gen(function* () {
      const fake = fakePorts({
        replies: ["1. Which base?\nFACTORY-STOP: needs-info"],
        tracker: false,
      });
      const end = yield* execute(buildAndLearn, fake.ports, { repo: null, issue: null });
      assert.deepStrictEqual(end, {
        result: "stuck",
        reason: "Ask needs an issue on a watched repo",
      });
    }),
  );

  it.effect("marks the pull request ready once, follows feedback and the merge, and learns", () =>
    Effect.gen(function* () {
      const fake = fakePorts({
        replies: [
          `FACTORY-DONE: ${PR_URL}`,
          `FACTORY-DONE: ${PR_URL}`,
          "Wrote two lessons.\nFACTORY-DONE: lessons written",
        ],
        commands: [
          { ok: true, output: "green" },
          { ok: true, output: "green again" },
        ],
        pullRequest: [
          { port: "feedback", detail: "Rename the flag." },
          { port: "merged", detail: null },
        ],
      });
      const end = yield* execute(buildAndLearn, fake.ports, run);
      assert.deepStrictEqual(end, { result: "done", reason: null });
      assert.deepStrictEqual(fake.ready, [42]);
      assert.deepStrictEqual(fake.sent, [
        {
          threadId: "t1",
          message: "Address the feedback below.\n\nThe feedback:\n\nRename the flag.",
        },
      ]);
      assert.deepInclude(fake.events, { event: "waiting", node: "review", on: "pull request #42" });
      // The learner is a fresh thread from the run's branch, given the record so far.
      const learner = fake.launches[1]!;
      assert.strictEqual(learner.title, "Build and learn: Learn");
      assert.strictEqual(learner.fromBranch, "t3/t1");
      assert.isTrue(learner.message.startsWith("/session-capture\n\nThe run's record:\n\n"));
      assert.include(learner.message, "- Build (build), visit 2");
      assert.include(learner.message, "  ended with feedback: Rename the flag.");
      assert.include(learner.message, "  took e8 (1 of 5)");
      assert.deepStrictEqual(fake.archived, ["t2", "t1"]);
      assert.deepInclude(fake.events, {
        event: "outcome",
        node: "learn",
        port: "done",
        detail: "Wrote two lessons.\nFACTORY-DONE: lessons written",
      });
    }),
  );

  it.effect("ends stuck at a pr node when no pull request was reported", () =>
    Effect.gen(function* () {
      const fake = fakePorts({
        replies: ["FACTORY-DONE: built it"],
        commands: [{ ok: true, output: "green" }],
      });
      const end = yield* execute(buildAndLearn, fake.ports, run);
      assert.deepStrictEqual(end, { result: "stuck", reason: NO_PULL_REQUEST });
    }),
  );

  it.effect("sends one reminder on a missing result line, and stops on the second", () =>
    Effect.gen(function* () {
      const fake = fakePorts({ replies: ["Working on it.", "Still working."] });
      const end = yield* execute(buildAndGate, fake.ports, run);
      assert.deepStrictEqual(fake.sent, [{ threadId: "t1", message: RESULT_LINE_REMINDER }]);
      assert.deepInclude(fake.events, {
        event: "outcome",
        node: "build",
        port: "stop",
        detail: NO_RESULT_TWICE,
      });
      assert.deepStrictEqual(end, { result: "stuck", reason: null });
    }),
  );

  it.effect("passes a reviewer check on FACTORY-DONE and fails it with the message otherwise", () =>
    Effect.gen(function* () {
      const reviewed: Pipeline = {
        ...buildAndGate,
        nodes: buildAndGate.nodes.map((node) =>
          node.id === "gate" ? { ...node, kind: "verify", check: { skill: "review-gate" } } : node,
        ),
      };
      const fake = fakePorts({
        replies: [
          "FACTORY-DONE: built",
          "The tests are missing.\nFACTORY-STOP: stuck",
          "FACTORY-DONE: added tests",
          "Looks right.\nFACTORY-DONE",
        ],
      });
      const end = yield* execute(reviewed, fake.ports, run);
      assert.deepStrictEqual(end, { result: "done", reason: null });
      assert.strictEqual(fake.launches.length, 3);
      assert.isTrue(fake.launches[1]!.message.startsWith("/review-gate\n\n"));
      assert.include(fake.launches[1]!.message, "Review the work on this branch.");
      assert.strictEqual(fake.launches[1]!.fromBranch, "t3/t1");
      assert.include(
        fake.sent[0]!.message,
        "The gate's output:\n\nThe tests are missing.\nFACTORY-STOP: stuck",
      );
      assert.deepStrictEqual(fake.archived, ["t2", "t3", "t1"]);
    }),
  );

  it.effect("records a port's error and ends the run with it", () =>
    Effect.gen(function* () {
      const fake = fakePorts({ replies: [new PortError({ message: "T3 does not know t1" })] });
      const end = yield* execute(buildAndGate, fake.ports, run);
      assert.deepStrictEqual(end, { result: "error", reason: "T3 does not know t1" });
      assert.deepStrictEqual(fake.events.slice(-2), [
        { event: "error", message: "T3 does not know t1" },
        { event: "ended", result: "error", reason: "T3 does not know t1" },
      ]);
      assert.deepStrictEqual(fake.archived, ["t1"]);
    }),
  );
});
