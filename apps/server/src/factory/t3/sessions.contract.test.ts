/**
 * Runs the adapter against T3's real orchestration layers (orchestrator, stores, effect worker,
 * launch service, a real git worktree) with the Claude replay transcript from provider-testing as
 * the provider. It answers one question on every upstream sync: does the adapter still work
 * against this upstream?
 */
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import {
  MULTI_TURN_FIRST_PROMPT,
  MULTI_TURN_SECOND_PROMPT,
} from "../../orchestration-v2/testkit/fixtures/shared.ts";
import {
  MULTI_TURN_TRANSCRIPT,
  SETTINGS_MODEL,
  SIMPLE_PROMPT,
  SIMPLE_TRANSCRIPT,
  createProject,
  git,
  initRepoWithCommit,
  layerGit,
  layerRuntime,
  projectId,
  runStatusesUntilTerminal,
} from "./contract.testkit.ts";
import * as Sessions from "./sessions.ts";

it.live(
  "launches a thread in a new worktree, reads its status to completion, and starts one thread per command id",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const base = yield* fs.makeTempDirectoryScoped({ prefix: "t3-factory-sessions-" });
        const repo = path.join(base, "repo");
        const worktreesDir = path.join(base, "worktrees");
        yield* fs.makeDirectory(repo);
        yield* fs.makeDirectory(worktreesDir);
        const baseRef = yield* initRepoWithCommit(repo);

        yield* Effect.gen(function* () {
          yield* createProject(repo);

          const sessions = yield* Sessions.FactorySessions;
          // The kit's project has no default model, so the settings default is the one.
          assert.deepStrictEqual(yield* sessions.findProject(repo), {
            id: projectId,
            model: SETTINGS_MODEL,
          });
          assert.strictEqual(yield* sessions.findProject(`${repo}/`), null);

          const request: Sessions.LaunchRequest = {
            commandId: "softfac:factory-sessions-contract:attempt-1",
            projectId,
            title: "Factory contract",
            baseRef,
            startFromOrigin: false,
            message: MULTI_TURN_FIRST_PROMPT,
            model: { instanceId: "claudeAgent", model: "claude-sonnet-4-6" },
          };
          const launched = yield* sessions.launch(request);
          const threadId = ThreadId.make(launched.threadId);

          // The worktree is prepared and the provider turn run after launch
          // returns; the run's own events say when it is over.
          assert.strictEqual((yield* runStatusesUntilTerminal(threadId)).at(-1), "completed");

          const status = yield* sessions.status(launched.threadId);
          assert.strictEqual(status.run, "completed");
          assert.strictEqual(status.runOrdinal, 1);
          assert.include(status.lastAssistantMessage ?? "", "first fixture turn complete");
          assert.isFalse(status.archived);
          assert.isNotNull(status.branch);
          assert.isNotNull(status.worktreePath);
          const worktreePath = status.worktreePath!;
          assert.isTrue(yield* fs.exists(path.join(worktreePath, ".git")));
          assert.strictEqual(path.dirname(path.dirname(worktreePath)), worktreesDir);
          assert.strictEqual(yield* git(worktreePath, ["branch", "--show-current"]), status.branch);
          assert.strictEqual(
            yield* git(worktreePath, ["rev-parse", "HEAD"]),
            yield* git(repo, ["rev-parse", baseRef]),
          );

          assert.deepStrictEqual(yield* sessions.thread(launched.threadId), {
            worktreePath,
            branch: status.branch,
            archived: false,
          });

          // The same command id again is the same launch: the thread it made,
          // and no second run.
          const again = yield* sessions.launch(request);
          assert.strictEqual(again.threadId, launched.threadId);
          const after = yield* sessions.status(launched.threadId);
          assert.strictEqual(after.runOrdinal, 1);
          assert.strictEqual(after.run, "completed");

          // A message after the first run starts the second. The same command
          // id again is the same message: no third run.
          const secondRun = yield* runStatusesUntilTerminal(threadId, 2).pipe(
            Effect.forkChild({ startImmediately: true }),
          );
          const sendId = "softfac:factory-sessions-contract:send-1";
          yield* sessions.send(launched.threadId, sendId, MULTI_TURN_SECOND_PROMPT);
          assert.strictEqual((yield* Fiber.join(secondRun)).at(-1), "completed");
          const second = yield* sessions.status(launched.threadId);
          assert.strictEqual(second.run, "completed");
          assert.strictEqual(second.runOrdinal, 2);
          assert.include(second.lastAssistantMessage ?? "", "second fixture turn complete");
          yield* sessions.send(launched.threadId, sendId, MULTI_TURN_SECOND_PROMPT);
          const resent = yield* sessions.status(launched.threadId);
          assert.strictEqual(resent.runOrdinal, 2);
          assert.include(resent.lastAssistantMessage ?? "", "second fixture turn complete");
          // The one-message proof does not lean on runOrdinal alone: the thread
          // holds the second prompt once, under the id the command id gave it.
          const projection = yield* ProjectionStore.ProjectionStoreV2;
          const records = yield* projection.getThreadRecords(threadId, ["messages"], {
            messageRoles: ["user"],
          });
          const sent = records.messages.filter((message) => message.id === `message:${sendId}`);
          assert.strictEqual(sent.length, 1);

          // Archiving twice, and a thread T3 does not know, change nothing.
          yield* sessions.archive(launched.threadId);
          assert.isTrue((yield* sessions.thread(launched.threadId)).archived);
          yield* sessions.archive(launched.threadId);
          yield* sessions.archive("thread:project:factory-sessions-contract:unknown");

          // Archiving leaves the worktree on disk; removing it keeps the branch.
          assert.isTrue(yield* fs.exists(worktreePath));
          yield* sessions.removeWorktree(worktreePath);
          assert.isFalse(yield* fs.exists(worktreePath));
          assert.include(yield* git(repo, ["branch", "--list", status.branch!]), status.branch!);
          assert.notInclude(yield* git(repo, ["worktree", "list", "--porcelain"]), worktreePath);
          yield* sessions.removeWorktree(worktreePath);
        }).pipe(
          Effect.provide(layerRuntime({ repo, worktreesDir, transcript: MULTI_TURN_TRANSCRIPT })),
        );
      }),
    ).pipe(Effect.provide(Layer.merge(layerGit, NodeServices.layer))),
);

it.live("finds a thread whose worktree lost its checkout, and not once it is archived", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const base = yield* fs.makeTempDirectoryScoped({ prefix: "t3-factory-sessions-" });
      const repo = path.join(base, "repo");
      const worktreesDir = path.join(base, "worktrees");
      yield* fs.makeDirectory(repo);
      yield* fs.makeDirectory(worktreesDir);
      const baseRef = yield* initRepoWithCommit(repo);

      yield* Effect.gen(function* () {
        yield* createProject(repo);
        const sessions = yield* Sessions.FactorySessions;
        const launched = yield* sessions.launch({
          commandId: "softfac:factory-sessions-contract:broken-worktree",
          projectId,
          title: "Factory contract",
          baseRef,
          startFromOrigin: false,
          message: SIMPLE_PROMPT,
          model: { instanceId: "claudeAgent", model: "claude-sonnet-4-6" },
        });
        const threadId = ThreadId.make(launched.threadId);
        assert.strictEqual((yield* runStatusesUntilTerminal(threadId)).at(-1), "completed");
        const worktreePath = (yield* sessions.thread(launched.threadId)).worktreePath!;
        assert.deepStrictEqual(yield* sessions.brokenWorktrees, []);

        // What a removal stopped partway leaves: the folder, without its checkout.
        yield* fs.remove(path.join(worktreePath, ".git"));
        assert.deepStrictEqual(yield* sessions.brokenWorktrees, [
          { threadId: launched.threadId, worktreePath, threadsOnPath: [launched.threadId] },
        ]);

        // An archived thread keeps its path, so a later find still names it beside a live one.
        yield* sessions.archive(launched.threadId);
        assert.strictEqual((yield* sessions.thread(launched.threadId)).worktreePath, worktreePath);
        assert.deepStrictEqual(yield* sessions.brokenWorktrees, []);
      }).pipe(Effect.provide(layerRuntime({ repo, worktreesDir, transcript: SIMPLE_TRANSCRIPT })));
    }),
  ).pipe(Effect.provide(Layer.merge(layerGit, NodeServices.layer))),
);
