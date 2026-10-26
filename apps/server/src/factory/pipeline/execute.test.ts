import { assert, it } from "@effect/vitest";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { describe } from "vite-plus/test";

import {
  execute,
  NO_PULL_REQUEST,
  NO_RESULT_TWICE,
  notOwnPullRequest,
  pastLimit,
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

/** A reply that never comes: the thread keeps working. */
const NEVER = Symbol("never");

interface Script {
  /** The last assistant message each `settle` answers, in order; a PortError fails it. */
  readonly replies: Array<string | null | PortError | typeof NEVER>;
  /** How long each wait on the pull request takes, on the TestClock. */
  readonly pullRequestWait?: Duration.Input;
  readonly commands?: Array<{ ok: boolean; output: string }>;
  readonly answers?: Array<string>;
  readonly pullRequest?: Array<{ port: PullRequestPort; detail: string | null }>;
  readonly tracker?: boolean;
  /** The branch each pull request comes from; one not named comes from the run's branch. */
  readonly heads?: Record<number, string | null>;
  /** Threads whose next archive fails. */
  readonly archiveFails?: Array<string>;
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
    headBranch: (pr) => Effect.sync(() => script.heads?.[pr] ?? "t3/t1"),
    postQuestions: (text) => Effect.sync(() => void questions.push(text)),
    awaitAnswer: () => Effect.sync(() => ({ text: next("answers", script.answers ?? []) })),
    markReady: (pr) => Effect.sync(() => void ready.push(pr)),
    awaitPullRequest: () =>
      Effect.sleep(script.pullRequestWait ?? "0 seconds").pipe(
        Effect.andThen(Effect.sync(() => next("pull request", script.pullRequest ?? []))),
      ),
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
        if (reply === NEVER) return Effect.never;
        return isPortError(reply)
          ? Effect.fail(reply)
          : Effect.succeed({ ...thread(threadId), text: reply });
      }),
    archive: (threadId) =>
      Effect.suspend(() => {
        const failing = script.archiveFails ?? [];
        const at = failing.indexOf(threadId);
        if (at >= 0) {
          failing.splice(at, 1);
          return Effect.fail(new PortError({ message: `cannot archive ${threadId}` }));
        }
        archived.push(threadId);
        return Effect.void;
      }),
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

const run = { repo: "acme/widgets", issue: 12, limitMinutes: 180 };

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

  it.effect("a second agent node continues the run's thread with its own instructions", () =>
    Effect.gen(function* () {
      const withPolish: Pipeline = {
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
      const end = yield* execute(withPolish, fake.ports, run);
      assert.strictEqual(end.result, "done");
      assert.strictEqual(fake.launches.length, 1);
      assert.deepStrictEqual(fake.sent, [
        { threadId: "t1", message: "Polish the docs.\n\nThe gate's output:\n\nok" },
      ]);
      assert.deepStrictEqual(fake.archived, ["t1"]);
    }),
  );

  it.effect("marks ready the reported pull request that comes from the run's branch", () =>
    Effect.gen(function* () {
      const fake = fakePorts({
        replies: [
          `Fixed. See https://github.com/acme/widgets/pull/5 for the earlier attempt.\nFACTORY-DONE: ${PR_URL}`,
          "FACTORY-DONE: lessons written",
        ],
        commands: [{ ok: true, output: "green" }],
        heads: { 5: "t3/earlier" },
        pullRequest: [{ port: "merged", detail: null }],
      });
      const end = yield* execute(buildAndLearn, fake.ports, run);
      assert.deepStrictEqual(end, { result: "done", reason: null });
      assert.deepStrictEqual(fake.ready, [42]);
    }),
  );

  it.effect(
    "ends stuck at a pr node when no reported pull request comes from the run's branch",
    () =>
      Effect.gen(function* () {
        const fake = fakePorts({
          replies: [`FACTORY-DONE: ${PR_URL}`],
          commands: [{ ok: true, output: "green" }],
          heads: { 42: "t3/someone-else" },
        });
        const end = yield* execute(buildAndLearn, fake.ports, run);
        assert.deepStrictEqual(end, { result: "stuck", reason: notOwnPullRequest("t3/t1") });
        assert.deepStrictEqual(fake.ready, []);
      }),
  );

  it.effect(
    "a reviewer thread that cannot be archived is archived when the run ends; the pass stands",
    () =>
      Effect.gen(function* () {
        const reviewed: Pipeline = {
          ...buildAndGate,
          nodes: buildAndGate.nodes.map((node) =>
            node.kind === "verify" ? { ...node, check: { brief: "Review it." } } : node,
          ),
        };
        const fake = fakePorts({
          replies: ["FACTORY-DONE: built", "Looks right.\nFACTORY-DONE: pass"],
          archiveFails: ["t2"],
        });
        const end = yield* execute(reviewed, fake.ports, run);
        assert.deepStrictEqual(end, { result: "done", reason: null });
        assert.deepStrictEqual(fake.archived, ["t1", "t2"]);
        assert.isFalse(fake.events.some((event) => event.event === "error"));
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
      const end = yield* execute(buildAndLearn, fake.ports, {
        repo: null,
        issue: null,
        limitMinutes: 180,
      });
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
  it.effect("remembers only a pull request on the run's repo", () =>
    Effect.gen(function* () {
      const upstream = "https://github.com/pingdotgg/t3code/pull/900";
      const onlyUpstream = fakePorts({
        replies: [`FACTORY-DONE: ported ${upstream}`],
        commands: [{ ok: true, output: "green" }],
      });
      assert.deepStrictEqual(yield* execute(buildAndLearn, onlyUpstream.ports, run), {
        result: "stuck",
        reason: NO_PULL_REQUEST,
      });
      assert.deepStrictEqual(onlyUpstream.ready, []);

      const both = fakePorts({
        replies: [`FACTORY-DONE: ported ${upstream} in https://github.com/ACME/widgets/pull/42`],
        commands: [{ ok: true, output: "green" }],
        pullRequest: [{ port: "closed", detail: null }],
      });
      yield* execute(buildAndLearn, both.ports, run);
      assert.deepStrictEqual(both.ready, [42]);
    }),
  );

  it.effect("archives a reviewer thread when the run ends on its error", () =>
    Effect.gen(function* () {
      const reviewed: Pipeline = {
        ...buildAndGate,
        nodes: buildAndGate.nodes.map((node) =>
          node.id === "gate" ? { ...node, kind: "verify", check: { skill: "review-gate" } } : node,
        ),
      };
      const fake = fakePorts({
        replies: ["FACTORY-DONE: built", new PortError({ message: "the reviewer is gone" })],
      });
      const end = yield* execute(reviewed, fake.ports, run);
      assert.deepStrictEqual(end, { result: "error", reason: "the reviewer is gone" });
      assert.sameMembers(fake.archived, ["t1", "t2"]);
    }),
  );

  it.effect("records a learner's failure and still ends done", () =>
    Effect.gen(function* () {
      const fake = fakePorts({
        replies: [
          `FACTORY-DONE: ${PR_URL}`,
          new PortError({ message: "the learner's thread is gone" }),
        ],
        commands: [{ ok: true, output: "green" }],
        pullRequest: [{ port: "merged", detail: null }],
      });
      const end = yield* execute(buildAndLearn, fake.ports, run);
      assert.deepStrictEqual(end, { result: "done", reason: null });
      assert.deepInclude(fake.events, { event: "error", message: "the learner's thread is gone" });
      assert.deepInclude(fake.events, {
        event: "outcome",
        node: "learn",
        port: "done",
        detail: null,
      });
      assert.deepStrictEqual(fake.archived, ["t2", "t1"]);
    }),
  );

  it.effect("ends stuck when the work passes the time limit, and archives its threads", () =>
    Effect.gen(function* () {
      const fake = fakePorts({ replies: [NEVER] });
      const running = yield* Effect.forkChild(execute(buildAndGate, fake.ports, run), {
        startImmediately: true,
      });
      yield* TestClock.adjust("180 minutes");
      assert.deepStrictEqual(yield* Fiber.join(running), {
        result: "stuck",
        reason: pastLimit(180),
      });
      assert.deepStrictEqual(fake.archived, ["t1"]);
    }),
  );

  it.effect("does not count the time a pull request waits for a person", () =>
    Effect.gen(function* () {
      const fake = fakePorts({
        replies: [`FACTORY-DONE: ${PR_URL}`, "FACTORY-DONE: learned"],
        commands: [{ ok: true, output: "green" }],
        pullRequestWait: "4 hours",
        pullRequest: [{ port: "merged", detail: null }],
      });
      const running = yield* Effect.forkChild(execute(buildAndLearn, fake.ports, run), {
        startImmediately: true,
      });
      yield* TestClock.adjust("4 hours");
      assert.deepStrictEqual(yield* Fiber.join(running), { result: "done", reason: null });
    }),
  );
});
