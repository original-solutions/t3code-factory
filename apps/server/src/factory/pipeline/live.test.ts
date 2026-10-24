import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { describe } from "vite-plus/test";

import type { FactoryProcess } from "../process.ts";
import type { FactorySessions, ThreadStatus } from "../t3/sessions.ts";
import type { BoundGitHub, Feedback, PullRequest } from "../tracker/github.ts";
import { livePorts, liveTracker } from "./live.ts";

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

describe("livePorts.settle", () => {
  it.effect("waits for the run after the one it last settled, polling every 10 seconds", () =>
    Effect.gen(function* () {
      let current = status(1, "completed", "first");
      let polls = 0;
      const sessions = {
        status: () =>
          Effect.sync(() => {
            polls += 1;
            return current;
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
      assert.deepStrictEqual(yield* ports.settle("t1"), {
        text: "first",
        worktree: "/wt/t1",
        branch: "t3/t1",
      });
      // A message was sent; the projection still shows the run that settled before it.
      const second = yield* Effect.forkChild(ports.settle("t1"), { startImmediately: true });
      assert.strictEqual(polls, 2);
      current = status(2, "running", null);
      yield* TestClock.adjust("10 seconds");
      assert.strictEqual(polls, 3);
      current = status(2, "completed", "second");
      yield* TestClock.adjust("10 seconds");
      assert.strictEqual((yield* Fiber.join(second)).text, "second");
    }),
  );
});

describe("liveTracker.awaitPullRequest", () => {
  it.effect("reads feedback since the last it told, then a base move, then the merge", () =>
    Effect.gen(function* () {
      let pull: Partial<PullRequest> = { open: true, merged: false, baseRef: "main" };
      let tip = "aaaaaaaaaaaaaaaa";
      let feedback: Array<Feedback> = [];
      const sinces: Array<string> = [];
      const github = {
        markPrReady: () => Effect.void,
        pullRequest: () => Effect.sync(() => pull as PullRequest),
        branchTip: () => Effect.sync(() => tip),
        prFeedback: (_pr: number, since: string) =>
          Effect.sync(() => {
            sinces.push(since);
            return feedback.filter((item) => item.createdAt > since);
          }),
      } as unknown as BoundGitHub;
      const tracker = liveTracker({ github, issue: 12, instructors: ["tom"] });
      yield* tracker.markReady(42);

      const waiting = yield* Effect.forkChild(tracker.awaitPullRequest(42), {
        startImmediately: true,
      });
      feedback = [
        {
          id: "review:1",
          author: "tom",
          kind: { kind: "pr-comment" },
          createdAt: "1970-01-01T00:01:00Z",
          body: "Rename the flag.",
          inline: [{ path: "src/a.ts", line: 3, body: "here" }],
          inlineUnread: 0,
        },
      ];
      yield* TestClock.adjust("60 seconds");
      assert.deepStrictEqual(yield* Fiber.join(waiting), {
        port: "feedback",
        detail: "tom:\nRename the flag.\n- src/a.ts:3: here",
      });

      tip = "bbbbbbbbbbbbbbbb";
      assert.deepStrictEqual(yield* tracker.awaitPullRequest(42), {
        port: "base-moved",
        detail: "main moved to bbbbbbbbbbbb",
      });
      // The feedback already told is not read again.
      assert.strictEqual(sinces.at(-1), "1970-01-01T00:01:00Z");

      pull = { ...pull, open: false, merged: true };
      assert.deepStrictEqual(yield* tracker.awaitPullRequest(42), {
        port: "merged",
        detail: null,
      });
    }),
  );
});
