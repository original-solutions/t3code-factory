import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { describe } from "vite-plus/test";

import type { FactoryProcess } from "../process.ts";
import type { FactorySessions, ThreadStatus } from "../t3/sessions.ts";
import { MARKER, type BoundGitHub, type Feedback, type PullRequest } from "../tracker/github.ts";
import { PortError } from "./execute.ts";
import { livePorts, liveTracker, MAX_READ_FAILURES } from "./live.ts";

const status = (ordinal: number, run: ThreadStatus["run"], text: string | null): ThreadStatus => ({
  worktreePath: "/wt/t1",
  branch: "t3/t1",
  archived: false,
  run,
  runOrdinal: ordinal,
  runStartedAt: null,
  runCompletedAt: null,
  lastAssistantMessage: text,
});

/** Ports whose thread status is whatever `read` answers now, counting the reads. */
const portsReading = (read: () => Effect.Effect<ThreadStatus, PortError>) => {
  const reads = { n: 0 };
  const sessions = {
    status: () =>
      Effect.suspend(() => {
        reads.n += 1;
        return read();
      }),
  } as unknown as FactorySessions["Service"];
  const ports = livePorts({
    runId: "r",
    projectId: "p",
    model: { instanceId: "claudeAgent", model: "m" },
    base: "main",
    recordPath: "/dev/null",
    sessions,
    process: {} as FactoryProcess["Service"],
    tracker: null,
  });
  return { ports, reads };
};

describe("livePorts.settle", () => {
  it.effect("waits for the run after the one it last settled, polling every 10 seconds", () =>
    Effect.gen(function* () {
      let current = status(1, "completed", "first");
      const { ports, reads } = portsReading(() => Effect.succeed(current));
      assert.deepStrictEqual(yield* ports.settle("t1"), {
        text: "first",
        worktree: "/wt/t1",
        branch: "t3/t1",
      });
      // A message was sent; the projection still shows the run that settled before it.
      const second = yield* Effect.forkChild(ports.settle("t1"), { startImmediately: true });
      assert.strictEqual(reads.n, 2);
      current = status(2, "running", null);
      yield* TestClock.adjust("10 seconds");
      assert.strictEqual(reads.n, 3);
      current = status(2, "completed", "second");
      yield* TestClock.adjust("10 seconds");
      assert.strictEqual((yield* Fiber.join(second)).text, "second");
    }),
  );

  it.effect("keeps waiting while a turn waits for a person", () =>
    Effect.gen(function* () {
      let current = status(1, "waiting", "Shall I go on?");
      const { ports } = portsReading(() => Effect.succeed(current));
      const settling = yield* Effect.forkChild(ports.settle("t1"), { startImmediately: true });
      yield* TestClock.adjust("10 minutes");
      current = status(1, "completed", "FACTORY-DONE: went on");
      yield* TestClock.adjust("10 seconds");
      assert.strictEqual((yield* Fiber.join(settling)).text, "FACTORY-DONE: went on");
    }),
  );

  it.effect(
    "fails when the thread was archived, and settles a run that failed or was interrupted",
    () =>
      Effect.gen(function* () {
        const gone = portsReading(() =>
          Effect.succeed({ ...status(1, "running", null), archived: true }),
        );
        const error = yield* Effect.flip(gone.ports.settle("t1"));
        assert.strictEqual(error.message, "thread t1 was archived");

        const failed = portsReading(() => Effect.succeed(status(1, "failed", "it broke")));
        assert.strictEqual((yield* failed.ports.settle("t1")).text, "it broke");
        const interrupted = portsReading(() => Effect.succeed(status(1, "interrupted", null)));
        assert.isNull((yield* interrupted.ports.settle("t1")).text);
      }),
  );

  it.effect("rides out failed reads, and gives up after ten in a row", () =>
    Effect.gen(function* () {
      let failing = MAX_READ_FAILURES - 1;
      const flaky = portsReading(() =>
        failing-- > 0
          ? Effect.fail(new PortError({ message: "the projection is busy" }))
          : Effect.succeed(status(1, "completed", "done")),
      );
      const settling = yield* Effect.forkChild(flaky.ports.settle("t1"), {
        startImmediately: true,
      });
      yield* TestClock.adjust("2 minutes");
      assert.strictEqual((yield* Fiber.join(settling)).text, "done");

      const broken = portsReading(() =>
        Effect.fail(new PortError({ message: "the projection is gone" })),
      );
      const failing10 = yield* Effect.forkChild(Effect.flip(broken.ports.settle("t1")), {
        startImmediately: true,
      });
      yield* TestClock.adjust("2 minutes");
      const error = yield* Fiber.join(failing10);
      assert.strictEqual(broken.reads.n, MAX_READ_FAILURES);
      assert.include(error.message, "the projection is gone");
    }),
  );
});

/** Ports whose process runner answers each command from `results`, in order, recording the lines. */
const portsRunning = (
  results: Array<{ exitCode: number | null; timedOut: boolean; tail: string }>,
) => {
  const ran: Array<{ command: string; cwd: string | undefined }> = [];
  const process = {
    run: (request: { command: string; cwd?: string }) =>
      Effect.sync(() => {
        ran.push({ command: request.command, cwd: request.cwd });
        const result = results.shift();
        if (result === undefined) throw new Error("the command script ran out");
        return { ...result, stderrTail: "", truncated: false };
      }),
  } as unknown as FactoryProcess["Service"];
  const ports = livePorts({
    runId: "r",
    projectId: "p",
    model: { instanceId: "claudeAgent", model: "m" },
    base: "main",
    recordPath: "/dev/null",
    sessions: {} as FactorySessions["Service"],
    process,
    tracker: null,
  });
  return { ports, ran };
};

describe("livePorts.commands", () => {
  it.effect("runs every line in the worktree and passes when all exit 0", () =>
    Effect.gen(function* () {
      const { ports, ran } = portsRunning([
        { exitCode: 0, timedOut: false, tail: "ok\n" },
        { exitCode: 0, timedOut: false, tail: "green\n" },
      ]);
      const result = yield* ports.commands(["vp i", "vp test"], "/wt/t1");
      assert.deepStrictEqual(result, { ok: true, output: "$ vp i\nok\n$ vp test\ngreen\n" });
      assert.deepStrictEqual(ran, [
        { command: "vp i", cwd: "/wt/t1" },
        { command: "vp test", cwd: "/wt/t1" },
      ]);
    }),
  );

  it.effect(
    "fails at the first line that exits non-zero, times out or dies, and runs no more",
    () =>
      Effect.gen(function* () {
        const failing = portsRunning([{ exitCode: 1, timedOut: false, tail: "1 failed\n" }]);
        assert.deepStrictEqual(yield* failing.ports.commands(["vp test", "vp lint"], "/wt"), {
          ok: false,
          output: "$ vp test\n1 failed\n\n[exited 1]",
        });
        assert.strictEqual(failing.ran.length, 1);

        const slow = portsRunning([{ exitCode: null, timedOut: true, tail: "" }]);
        assert.deepStrictEqual(yield* slow.ports.commands(["sleep 1d"], "/wt"), {
          ok: false,
          output: "$ sleep 1d\n\n[timed out]",
        });

        const killed = portsRunning([{ exitCode: null, timedOut: false, tail: "" }]);
        assert.deepStrictEqual(yield* killed.ports.commands(["vp test"], "/wt"), {
          ok: false,
          output: "$ vp test\n\n[exited by a signal]",
        });
      }),
  );

  it.effect("keeps the tail of long output, where the error is", () =>
    Effect.gen(function* () {
      const { ports } = portsRunning([
        { exitCode: 1, timedOut: false, tail: `${"x".repeat(9000)}\nthe error` },
      ]);
      const result = yield* ports.commands(["vp test"], "/wt");
      assert.isTrue(result.output.startsWith("[cut]\n"));
      assert.isTrue(result.output.endsWith("\nthe error\n[exited 1]"));
      assert.isAtMost(result.output.length, 8000 + "[cut]\n".length);
    }),
  );
});

const feedbackItem = (id: string, createdAt: string, body: string): Feedback => ({
  id,
  author: "tom",
  kind: { kind: "pr-comment" },
  createdAt,
  body,
  inline: [],
  inlineUnread: 0,
});

/** A pull request on GitHub as the tracker reads it; `prFeedback` keeps GitHub's strict `>`. */
const fakeGitHub = () => {
  const state = {
    pull: { open: true, merged: false, baseRef: "main" } as Partial<PullRequest>,
    tip: "aaaaaaaaaaaaaaaa",
    feedback: [] as Array<Feedback>,
    /** Reads of the pull request that fail before one succeeds. */
    failPullReads: 0,
    /** What `approval` answers; `labeledAt` is a GitHub time. */
    approval: { kind: "refused" } as { kind: string; labeledAt?: string },
    comments: [] as Array<{ id: string; author: string; createdAt: string; body: string }>,
    posted: [] as Array<{ issue: number; body: string }>,
    states: [] as Array<string>,
    /** The `instructors` each read was given. */
    askedWith: [] as Array<ReadonlyArray<string>>,
  };
  const github = {
    markPrReady: () => Effect.void,
    postComment: (issue: number, body: string) =>
      Effect.sync(() => void state.posted.push({ issue, body })),
    setState: (_issue: number, next: string) => Effect.sync(() => void state.states.push(next)),
    approval: (_issue: number, instructors: ReadonlyArray<string>) =>
      Effect.sync(() => {
        state.askedWith.push(instructors);
        return state.approval;
      }),
    activitySince: (_issue: number, since: string, instructors: ReadonlyArray<string>) =>
      Effect.sync(() => {
        state.askedWith.push(instructors);
        return {
          comments: state.comments.filter((comment) => comment.createdAt > since),
          bodyEdit: null,
          dropped: [],
        };
      }),
    pullRequest: () =>
      Effect.suspend(() =>
        state.failPullReads-- > 0
          ? Effect.fail(new PortError({ message: "gh timed out" }))
          : Effect.succeed(state.pull as PullRequest),
      ),
    branchTip: () => Effect.sync(() => state.tip),
    prFeedback: (_pr: number, since: string) =>
      Effect.sync(() => state.feedback.filter((item) => item.createdAt > since)),
  } as unknown as BoundGitHub;
  return { state, tracker: liveTracker({ github, issue: 12, instructors: ["tom"] }) };
};

describe("liveTracker.awaitPullRequest", () => {
  it.effect("reads feedback once, then a base move, then the merge", () =>
    Effect.gen(function* () {
      const { state, tracker } = fakeGitHub();
      yield* tracker.markReady(42);
      const waiting = yield* Effect.forkChild(tracker.awaitPullRequest(42), {
        startImmediately: true,
      });
      state.feedback = [
        {
          ...feedbackItem("review:1", "1970-01-01T00:01:00Z", "Rename the flag."),
          inline: [{ path: "src/a.ts", line: 3, body: "here" }],
        },
      ];
      yield* TestClock.adjust("60 seconds");
      assert.deepStrictEqual(yield* Fiber.join(waiting), {
        port: "feedback",
        detail: "tom:\nRename the flag.\n- src/a.ts:3: here",
      });

      state.tip = "bbbbbbbbbbbbbbbb";
      assert.deepStrictEqual(yield* tracker.awaitPullRequest(42), {
        port: "base-moved",
        detail: "main moved to bbbbbbbbbbbb",
      });

      state.pull = { ...state.pull, open: false, merged: true };
      assert.deepStrictEqual(yield* tracker.awaitPullRequest(42), {
        port: "merged",
        detail: null,
      });
    }),
  );

  it.effect("tells feedback that arrived in the same second as the last told", () =>
    Effect.gen(function* () {
      const { state, tracker } = fakeGitHub();
      yield* tracker.markReady(42);
      state.feedback = [feedbackItem("pr-comment:1", "1970-01-01T00:01:00Z", "First.")];
      assert.deepStrictEqual(yield* tracker.awaitPullRequest(42), {
        port: "feedback",
        detail: "tom:\nFirst.",
      });
      state.feedback.push(feedbackItem("pr-comment:2", "1970-01-01T00:01:00Z", "Second."));
      assert.deepStrictEqual(yield* tracker.awaitPullRequest(42), {
        port: "feedback",
        detail: "tom:\nSecond.",
      });
    }),
  );

  it.effect("rides out failed reads of the pull request for hours, and gives up after four", () =>
    Effect.gen(function* () {
      const { state, tracker } = fakeGitHub();
      yield* tracker.markReady(42);
      // Ten minutes of an expired login would have ended the run under a count of ten polls.
      state.failPullReads = 90;
      state.pull = { ...state.pull, open: false, merged: true };
      const waiting = yield* Effect.forkChild(tracker.awaitPullRequest(42), {
        startImmediately: true,
      });
      yield* TestClock.adjust("2 hours");
      assert.deepStrictEqual(yield* Fiber.join(waiting), { port: "merged", detail: null });

      state.failPullReads = Number.POSITIVE_INFINITY;
      const failing = yield* Effect.forkChild(Effect.flip(tracker.awaitPullRequest(42)), {
        startImmediately: true,
      });
      yield* TestClock.adjust("5 hours");
      const error = yield* Fiber.join(failing);
      assert.include(error.message, "gh timed out");
      assert.include(error.message, "(for 240 minutes)");
    }),
  );

  it.effect(
    "names the branch a pull request comes from, none for a fork's, and rides out a failed read",
    () =>
      Effect.gen(function* () {
        const { state, tracker } = fakeGitHub();
        state.pull = { ...state.pull, headRef: "t3/issue-7", crossRepository: false };
        state.failPullReads = 2;
        const reading = yield* Effect.forkChild(tracker.headBranch(42), { startImmediately: true });
        yield* TestClock.adjust("2 minutes");
        assert.strictEqual(yield* Fiber.join(reading), "t3/issue-7");
        state.pull = { ...state.pull, crossRepository: true };
        assert.isNull(yield* tracker.headBranch(42));
      }),
  );
});

describe("liveTracker.postQuestions and awaitAnswer", () => {
  it.effect(
    "posts the questions, waits for an instructor's fresh approval, and answers their comments",
    () =>
      Effect.gen(function* () {
        const { state, tracker } = fakeGitHub();
        yield* TestClock.adjust("1 hour");
        yield* tracker.postQuestions("1. Which base?");
        assert.strictEqual(state.posted.length, 1);
        assert.include(state.posted[0]!.body, "1. Which base?");
        assert.deepStrictEqual(state.states, ["needs-info"]);

        // The label from before the questions is not the answer.
        state.approval = { kind: "approved", labeledAt: "1970-01-01T00:30:00Z" };
        state.comments = [
          { id: "c0", author: "tom", createdAt: "1970-01-01T00:20:00Z", body: "An old note." },
        ];
        const waiting = yield* Effect.forkChild(tracker.awaitAnswer(), { startImmediately: true });
        yield* TestClock.adjust("5 minutes");
        assert.deepStrictEqual(state.states, ["needs-info"]);

        state.comments.push(
          { id: "c1", author: "tom", createdAt: "1970-01-01T01:02:00Z", body: "Use main." },
          { id: "c2", author: "bot", createdAt: "1970-01-01T01:02:30Z", body: `${MARKER} noted` },
        );
        state.approval = { kind: "approved", labeledAt: "1970-01-01T01:03:00Z" };
        yield* TestClock.adjust("1 minute");
        assert.deepStrictEqual(yield* Fiber.join(waiting), { text: "tom:\nUse main." });
        assert.deepStrictEqual(state.states, ["needs-info", "building"]);
        assert.isTrue(state.askedWith.every((given) => given.length === 1 && given[0] === "tom"));
      }),
  );

  it.effect("says so when the issue was approved again without a comment", () =>
    Effect.gen(function* () {
      const { state, tracker } = fakeGitHub();
      yield* tracker.postQuestions("1. Really?");
      state.approval = { kind: "approved", labeledAt: "1970-01-01T00:01:00Z" };
      const waiting = yield* Effect.forkChild(tracker.awaitAnswer(), { startImmediately: true });
      yield* TestClock.adjust("1 minute");
      assert.deepStrictEqual(yield* Fiber.join(waiting), {
        text: "No comments; the issue was approved again.",
      });
    }),
  );
});
