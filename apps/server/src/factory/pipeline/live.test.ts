import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { describe } from "vite-plus/test";

import type { FactoryProcess } from "../process.ts";
import type { FactorySessions, ThreadStatus } from "../t3/sessions.ts";
import type { BoundGitHub, Feedback, PullRequest } from "../tracker/github.ts";
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
  };
  const github = {
    markPrReady: () => Effect.void,
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

  it.effect("rides out a failed read of the pull request", () =>
    Effect.gen(function* () {
      const { state, tracker } = fakeGitHub();
      yield* tracker.markReady(42);
      state.failPullReads = 2;
      state.pull = { ...state.pull, open: false, merged: true };
      const waiting = yield* Effect.forkChild(tracker.awaitPullRequest(42), {
        startImmediately: true,
      });
      yield* TestClock.adjust("2 minutes");
      assert.deepStrictEqual(yield* Fiber.join(waiting), { port: "merged", detail: null });
    }),
  );
});
