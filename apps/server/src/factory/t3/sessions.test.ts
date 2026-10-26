// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - the recorded snapshot is read as the wire bytes softfac saw.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  GitCommandError,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as Sessions from "./sessions.ts";

const thread = (
  branch: string | null = null,
  worktreePath: string | null = null,
  archivedAt: string | null = null,
) => ({ branch, worktreePath, archivedAt });

const run = (ordinal: number, status: Sessions.RunStatus) => ({
  id: `run-${ordinal}`,
  ordinal,
  status,
  startedAt: "2026-10-05T06:39:38.376Z",
});

/** A run that was queued and never started: T3 gives it no `startedAt`. */
const unstartedRun = (ordinal: number, status: Sessions.RunStatus) => ({
  id: `run-${ordinal}`,
  ordinal,
  status,
  startedAt: null,
});

/** A message of the run with `ordinal`, which T3 references by the run's `id`. */
const message = (ordinal: number | null, role: string, text: string) => ({
  role,
  text,
  runId: ordinal === null ? null : `run-${ordinal}`,
});

const statusOf = (
  runs: ReadonlyArray<Sessions.ThreadSnapshot["runs"][number]>,
  messages: ReadonlyArray<Sessions.ThreadSnapshot["messages"][number]> = [],
  fields = thread(),
) => Sessions.threadStatusOf({ thread: fields, runs, messages });

describe("threadStatusOf", () => {
  it("reads a real recorded snapshot and ignores unknown fields", () => {
    const snapshot = JSON.parse(
      NodeFS.readFileSync(
        NodePath.join(import.meta.dirname, "fixtures", "t3_thread_snapshot.json"),
        "utf8",
      ),
    ) as { readonly projection: Sessions.ThreadSnapshot };
    assert.deepStrictEqual(Sessions.threadStatusOf(snapshot.projection), {
      run: "completed",
      runOrdinal: 1,
      runStartedAt: 1791106575242,
      runCompletedAt: 1791106579470,
      lastAssistantMessage: "READY",
      worktreePath: "/tmp/t3-spike-home/worktrees/t3-spike-repo/t3code-618ff943",
      branch: "t3code/618ff943",
      archived: false,
    });
  });

  it("takes the run with the highest ordinal whatever the order", () => {
    // The highest ordinal is in the middle, so first, last and lowest all get it wrong.
    const status = statusOf([run(1, "completed"), run(3, "running"), run(2, "failed")]);
    assert.strictEqual(status.run, "running");
  });

  it("skips a cancelled run that never started", () => {
    // Run 1 is working; the person's queued message became run 2 and was cancelled.
    const active: ReadonlyArray<Sessions.RunStatus> = [
      "preparing",
      "queued",
      "starting",
      "running",
      "waiting",
    ];
    for (const expected of active) {
      // The cancelled run comes first, so "last in the array" gets it wrong too.
      const status = statusOf([unstartedRun(2, "cancelled"), run(1, expected)]);
      assert.strictEqual(status.run, expected, expected);
      assert.strictEqual(status.runOrdinal, 1, expected);
    }
  });

  it("keeps the finished run and its message behind a cancelled queued run", () => {
    const status = statusOf(
      [run(1, "completed"), unstartedRun(2, "cancelled")],
      [
        message(1, "user", "do the work"),
        message(1, "assistant", "all done. FACTORY-DONE: ready"),
        message(2, "user", "continue the work"),
      ],
    );
    assert.strictEqual(status.run, "completed");
    assert.strictEqual(status.runOrdinal, 1);
    assert.strictEqual(status.lastAssistantMessage, "all done. FACTORY-DONE: ready");
  });

  it("of a sole cancelled run that never started is cancelled", () => {
    const status = statusOf([unstartedRun(1, "cancelled")]);
    assert.strictEqual(status.run, "cancelled");
    assert.strictEqual(status.runOrdinal, 1);
  });

  it("of a sole cancelled run that started is cancelled", () => {
    const status = statusOf([run(1, "cancelled")]);
    assert.strictEqual(status.run, "cancelled");
    assert.strictEqual(status.runOrdinal, 1);
  });

  it("lets a cancelled run that started decide", () => {
    const status = statusOf([run(1, "completed"), run(2, "cancelled")]);
    assert.strictEqual(status.run, "cancelled");
    assert.strictEqual(status.runOrdinal, 2);
  });

  it("skips every cancelled run that never started", () => {
    const status = statusOf([
      unstartedRun(3, "cancelled"),
      run(1, "running"),
      unstartedRun(2, "cancelled"),
    ]);
    assert.strictEqual(status.run, "running");
    assert.strictEqual(status.runOrdinal, 1);
  });

  it("takes the highest ordinal when every run is cancelled and never started", () => {
    // The highest ordinal comes first, so "last in the array" gets it wrong too.
    const status = statusOf([unstartedRun(2, "cancelled"), unstartedRun(1, "cancelled")]);
    assert.strictEqual(status.run, "cancelled");
    assert.strictEqual(status.runOrdinal, 2);
  });

  it("keeps a queued run that has not started yet", () => {
    // Only a cancelled run is left out: a message still waiting in the queue is the
    // thread's run.
    const status = statusOf([unstartedRun(2, "queued"), run(1, "completed")]);
    assert.strictEqual(status.run, "queued");
    assert.strictEqual(status.runOrdinal, 2);
  });

  it("treats a cancelled run without startedAt as never started", () => {
    const status = statusOf([{ id: "run-2", ordinal: 2, status: "cancelled" }, run(1, "running")]);
    assert.strictEqual(status.run, "running");
    assert.strictEqual(status.runOrdinal, 1);
  });

  it("reads the run's start and end as epoch milliseconds, from a string or a DateTime, null when absent", () => {
    const timed = statusOf([
      {
        id: "run-1",
        ordinal: 1,
        status: "cancelled",
        startedAt: "2026-10-04T09:36:15.242Z",
        completedAt: { epochMilliseconds: 1791106579470 },
      },
    ]);
    assert.strictEqual(timed.runStartedAt, 1791106575242);
    assert.strictEqual(timed.runCompletedAt, 1791106579470);
    const running = statusOf([run(1, "running")]);
    assert.strictEqual(running.runStartedAt, 1791182378376);
    assert.strictEqual(running.runCompletedAt, null);
    assert.strictEqual(statusOf([unstartedRun(1, "cancelled")]).runStartedAt, null);
    // A run cancelled before it started counts from when it was requested; one that failed did not begin.
    const requestedAt = "2026-10-04T09:36:15.113Z";
    const cancelled = { ...unstartedRun(1, "cancelled"), requestedAt };
    assert.strictEqual(statusOf([cancelled]).runStartedAt, 1791106575113);
    assert.strictEqual(
      statusOf([{ ...unstartedRun(1, "failed"), requestedAt }]).runStartedAt,
      null,
    );
    // A wake run's work start is copied from an earlier run, so its own start counts.
    const woken = { ...run(1, "running"), workStartedAt: "2026-10-04T09:36:15.242Z" };
    assert.strictEqual(statusOf([woken]).runStartedAt, 1791182378376);
    assert.strictEqual(statusOf([]).runStartedAt, null);
  });

  it("reports the ordinal of the run it describes", () => {
    // Out of order, with the highest in the middle: the status and the ordinal are of the
    // same run.
    const status = statusOf([run(4, "completed"), run(9, "running"), run(2, "failed")]);
    assert.strictEqual(status.run, "running");
    assert.strictEqual(status.runOrdinal, 9);
  });

  it("without runs has no run and no run ordinal", () => {
    const status = statusOf([]);
    assert.strictEqual(status.run, null);
    assert.strictEqual(status.runOrdinal, null);
    assert.strictEqual(status.lastAssistantMessage, null);
  });

  it("maps every known run status", () => {
    for (const status of Sessions.RUN_STATUSES) {
      assert.strictEqual(statusOf([run(1, status)]).run, status, status);
    }
  });

  it("reports only the reported run's own last assistant message", () => {
    // A run that ended quietly must not be read as ending with an older run's result
    // line, and a message with no run reference is no run's.
    const status = statusOf(
      [run(1, "completed"), run(2, "completed")],
      [
        message(1, "assistant", "FACTORY-DONE: old"),
        message(2, "user", "go again"),
        message(null, "assistant", "orphan"),
      ],
    );
    assert.strictEqual(status.runOrdinal, 2);
    assert.strictEqual(status.lastAssistantMessage, null);
  });

  it("reports the last of the run's assistant messages, not the first", () => {
    // A real run says something on the way ("looking") before its result line.
    const status = statusOf(
      [run(1, "completed")],
      [
        message(1, "assistant", "looking"),
        message(1, "user", "carry on"),
        message(1, "assistant", "FACTORY-DONE: ready"),
      ],
    );
    assert.strictEqual(status.lastAssistantMessage, "FACTORY-DONE: ready");
  });

  it("reports the thread's branch, worktree path and whether it is archived", () => {
    const status = statusOf([], [], thread("t3/abc", "/tmp/wt", "2026-10-05T06:39:38.376Z"));
    assert.strictEqual(status.branch, "t3/abc");
    assert.strictEqual(status.worktreePath, "/tmp/wt");
    assert.strictEqual(status.archived, true);
    assert.strictEqual(statusOf([], [], thread()).archived, false);
  });
});

const projectId = ProjectId.make("project:factory-sessions-test");
const threadId = ThreadId.make("thread:project:factory-sessions-test:1");

const PROJECT_MODEL = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.5" };
const SETTINGS_MODEL = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-sonnet-5-5",
};

const projectCreated = (
  id: string,
  workspaceRoot: string,
  sequence: number,
  defaultModelSelection: ModelSelection | null = null,
) =>
  ({
    sequence,
    eventId: EventId.make(`event:${id}:created`),
    aggregateKind: "project",
    aggregateId: ProjectId.make(id),
    occurredAt: "2026-10-03T00:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "project.created",
    payload: {
      projectId: ProjectId.make(id),
      title: id,
      workspaceRoot,
      defaultModelSelection,
      scripts: [],
      createdAt: "2026-10-03T00:00:00.000Z",
      updatedAt: "2026-10-03T00:00:00.000Z",
    },
  }) as const;

const projectDeleted = (id: string, sequence: number) =>
  ({
    sequence,
    eventId: EventId.make(`event:${id}:deleted`),
    aggregateKind: "project",
    aggregateId: ProjectId.make(id),
    occurredAt: "2026-10-03T00:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "project.deleted",
    payload: { projectId: ProjectId.make(id), deletedAt: "2026-10-03T00:00:00.000Z" },
  }) as const;

const layerProjects = ProjectStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory));

const layerSessions = (
  projections: Partial<ProjectionStore.ProjectionStoreV2["Service"]> = {},
  launches: Partial<ThreadLaunch.ThreadLaunchService["Service"]> = {},
  management: Partial<ThreadManagement.ThreadManagementService["Service"]> = {},
  git: Partial<GitVcsDriver.GitVcsDriver["Service"]> = {},
  // Listed after NodeServices so a stub FileSystem wins over the real one.
  fileSystem: Layer.Layer<FileSystem.FileSystem> = NodeServices.layer,
  settings: ReturnType<typeof ServerSettings.layerTest> = ServerSettings.layerTest(),
) =>
  Layer.mergeAll(
    Sessions.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          layerProjects,
          SqlitePersistence.layerMemory,
          settings,
          Layer.mock(ProjectionStore.ProjectionStoreV2)(projections),
          Layer.mock(ThreadLaunch.ThreadLaunchService)(launches),
          Layer.mock(ThreadManagement.ThreadManagementService)(management),
          Layer.mock(GitVcsDriver.GitVcsDriver)(git),
          NodeServices.layer,
          fileSystem,
        ),
      ),
    ),
    layerProjects,
    NodeServices.layer,
  );

describe("launchBranchOf", () => {
  it("reads the temporary branch T3 named the worktree folder after", () => {
    assert.strictEqual(Sessions.launchBranchOf("/x/t3-2e8db933"), "t3/2e8db933");
    assert.strictEqual(Sessions.launchBranchOf("C:\\x\\t3-2e8db933"), "t3/2e8db933");
  });

  it("is null for no folder, or one not named after a temporary branch", () => {
    for (const path of [
      null,
      "/t3/wt",
      "/x/t3-zz",
      "/x/t3-2e8db93",
      "/x/t3-2e8db933x",
      "/x/2e8db933",
    ]) {
      assert.strictEqual(Sessions.launchBranchOf(path), null, String(path));
    }
  });
});

describe("FactorySessions.worktreesDirectory", () => {
  const withSetting = (worktreesDirectory: string) =>
    layerSessions(
      {},
      {},
      {},
      {},
      NodeServices.layer,
      ServerSettings.layerTest({ worktreesDirectory }),
    );

  it.effect("is the default folder while Settings → Storage names none", () =>
    Effect.gen(function* () {
      const sessions = yield* Sessions.FactorySessions;
      assert.strictEqual(yield* sessions.worktreesDirectory("/base/worktrees"), "/base/worktrees");
    }).pipe(Effect.provide(withSetting(""))),
  );

  it.effect("is the folder Settings → Storage names, where T3 makes new worktrees", () =>
    Effect.gen(function* () {
      const sessions = yield* Sessions.FactorySessions;
      assert.strictEqual(yield* sessions.worktreesDirectory("/base/worktrees"), "/Volumes/ext/wt");
    }).pipe(Effect.provide(withSetting("/Volumes/ext/wt"))),
  );

  it.effect("is null for a setting T3 cannot make worktrees under", () =>
    Effect.gen(function* () {
      const sessions = yield* Sessions.FactorySessions;
      assert.strictEqual(yield* sessions.worktreesDirectory("/base/worktrees"), null);
    }).pipe(Effect.provide(withSetting("relative/wt"))),
  );
});

describe("FactorySessions.findProject", () => {
  it.effect("returns the id of the matching workspace root", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectStore.ProjectStoreV2;
      yield* projects.apply(projectCreated("p-other", "/tmp/other", 1));
      yield* projects.apply(projectCreated("p-spike", "/tmp/t3-spike-repo", 2));
      const sessions = yield* Sessions.FactorySessions;
      assert.deepStrictEqual(yield* sessions.findProject("/tmp/t3-spike-repo"), {
        id: "p-spike",
        model: null,
      });
    }).pipe(Effect.provide(layerSessions())),
  );

  // The session runs on what a person gets in a new thread on the project: the project's
  // default model, else the one in T3's Settings. Nothing in the factory's own config names one.
  it.effect("carries the project's default model over the settings default", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectStore.ProjectStoreV2;
      yield* projects.apply(projectCreated("p-spike", "/tmp/t3-spike-repo", 1, PROJECT_MODEL));
      const sessions = yield* Sessions.FactorySessions;
      assert.deepStrictEqual(yield* sessions.findProject("/tmp/t3-spike-repo"), {
        id: "p-spike",
        model: PROJECT_MODEL,
      });
    }).pipe(
      Effect.provide(
        layerSessions(
          {},
          {},
          {},
          {},
          NodeServices.layer,
          ServerSettings.layerTest({ defaultModelSelection: SETTINGS_MODEL }),
        ),
      ),
    ),
  );

  it.effect("takes the settings default model when the project has none", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectStore.ProjectStoreV2;
      yield* projects.apply(projectCreated("p-spike", "/tmp/t3-spike-repo", 1));
      const sessions = yield* Sessions.FactorySessions;
      const found = yield* sessions.findProject("/tmp/t3-spike-repo");
      assert.strictEqual(found?.id, "p-spike");
      assert.strictEqual(found?.model?.instanceId, "claudeAgent");
      assert.strictEqual(found?.model?.model, "claude-sonnet-5-5");
    }).pipe(
      Effect.provide(
        layerSessions(
          {},
          {},
          {},
          {},
          NodeServices.layer,
          ServerSettings.layerTest({ defaultModelSelection: SETTINGS_MODEL }),
        ),
      ),
    ),
  );

  // T3 resolves a project's model through its settings: an override stored there wins over the
  // project row, a folded install ignores the row, and a disabled provider instance is skipped.
  // The factory asks T3's own resolver, so a session gets what a new thread on the project gets.
  it.effect("takes the model override stored in T3's settings over the project row", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectStore.ProjectStoreV2;
      yield* projects.apply(projectCreated("p-spike", "/tmp/t3-spike-repo", 1));
      const sessions = yield* Sessions.FactorySessions;
      assert.deepStrictEqual(yield* sessions.findProject("/tmp/t3-spike-repo"), {
        id: "p-spike",
        model: PROJECT_MODEL,
      });
    }).pipe(
      Effect.provide(
        layerSessions(
          {},
          {},
          {},
          {},
          NodeServices.layer,
          ServerSettings.layerTest({
            defaultModelSelection: SETTINGS_MODEL,
            projectSettingsOverrides: {
              [ProjectId.make("p-spike")]: { defaultModelSelection: PROJECT_MODEL },
            },
          }),
        ),
      ),
    ),
  );

  it.effect("ignores a model left on the project row once T3 has folded project settings", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectStore.ProjectStoreV2;
      yield* projects.apply(projectCreated("p-spike", "/tmp/t3-spike-repo", 1, PROJECT_MODEL));
      const sessions = yield* Sessions.FactorySessions;
      const found = yield* sessions.findProject("/tmp/t3-spike-repo");
      assert.strictEqual(found?.model?.instanceId, "claudeAgent");
      assert.strictEqual(found?.model?.model, "claude-sonnet-5-5");
    }).pipe(
      Effect.provide(
        layerSessions(
          {},
          {},
          {},
          {},
          NodeServices.layer,
          ServerSettings.layerTest({
            defaultModelSelection: SETTINGS_MODEL,
            projectSettingsFolded: true,
          }),
        ),
      ),
    ),
  );

  it.effect("skips a project model whose provider instance is disabled for the project", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectStore.ProjectStoreV2;
      yield* projects.apply(projectCreated("p-spike", "/tmp/t3-spike-repo", 1, PROJECT_MODEL));
      const sessions = yield* Sessions.FactorySessions;
      const found = yield* sessions.findProject("/tmp/t3-spike-repo");
      assert.strictEqual(found?.model?.instanceId, "claudeAgent");
      assert.strictEqual(found?.model?.model, "claude-sonnet-5-5");
    }).pipe(
      Effect.provide(
        layerSessions(
          {},
          {},
          {},
          {},
          NodeServices.layer,
          ServerSettings.layerTest({
            defaultModelSelection: SETTINGS_MODEL,
            projectSettingsOverrides: {
              [ProjectId.make("p-spike")]: {
                providerInstances: { [ProviderInstanceId.make("codex")]: { enabled: false } },
              },
            },
          }),
        ),
      ),
    ),
  );

  it.effect("carries the provider options the project's model names", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectStore.ProjectStoreV2;
      yield* projects.apply(
        projectCreated("p-spike", "/tmp/t3-spike-repo", 1, {
          ...PROJECT_MODEL,
          options: [{ id: "reasoningEffort", value: "high" }],
        }),
      );
      const sessions = yield* Sessions.FactorySessions;
      assert.deepStrictEqual(yield* sessions.findProject("/tmp/t3-spike-repo"), {
        id: "p-spike",
        model: { ...PROJECT_MODEL, options: [{ id: "reasoningEffort", value: "high" }] },
      });
    }).pipe(Effect.provide(layerSessions())),
  );

  it.effect("has no model when neither the project nor the settings name one", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectStore.ProjectStoreV2;
      yield* projects.apply(projectCreated("p-spike", "/tmp/t3-spike-repo", 1));
      const sessions = yield* Sessions.FactorySessions;
      assert.deepStrictEqual(yield* sessions.findProject("/tmp/t3-spike-repo"), {
        id: "p-spike",
        model: null,
      });
    }).pipe(Effect.provide(layerSessions())),
  );

  it.effect("without a match is null", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectStore.ProjectStoreV2;
      yield* projects.apply(projectCreated("p-other", "/tmp/other", 1));
      const sessions = yield* Sessions.FactorySessions;
      assert.strictEqual(yield* sessions.findProject("/tmp/t3-spike-repo"), null);
    }).pipe(Effect.provide(layerSessions())),
  );

  it.effect("ignores deleted projects", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectStore.ProjectStoreV2;
      yield* projects.apply(projectCreated("p-old", "/tmp/t3-spike-repo", 1));
      yield* projects.apply(projectDeleted("p-old", 2));
      const sessions = yield* Sessions.FactorySessions;
      assert.strictEqual(yield* sessions.findProject("/tmp/t3-spike-repo"), null);
      yield* projects.apply(projectCreated("p-new", "/tmp/t3-spike-repo", 3));
      assert.deepStrictEqual(yield* sessions.findProject("/tmp/t3-spike-repo"), {
        id: "p-new",
        model: null,
      });
    }).pipe(Effect.provide(layerSessions())),
  );

  it.effect("matches the whole root, not a prefix or a trailing slash", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectStore.ProjectStoreV2;
      yield* projects.apply(projectCreated("p-a", "/tmp/t3-spike-repo-2", 1));
      yield* projects.apply(projectCreated("p-b", "/tmp/t3-spike-repo/", 2));
      const sessions = yield* Sessions.FactorySessions;
      assert.strictEqual(yield* sessions.findProject("/tmp/t3-spike-repo"), null);
    }).pipe(Effect.provide(layerSessions())),
  );

  it.effect("fails as a sessions error when the project store fails, not as no project", () =>
    Effect.gen(function* () {
      const sessions = yield* Sessions.FactorySessions;
      const error = yield* Effect.flip(sessions.findProject("/tmp/t3-spike-repo"));
      assert.strictEqual(error._tag, "FactorySessionsError");
      assert.strictEqual(error.operation, "find-project");
    }).pipe(
      Effect.provide(
        Sessions.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(ProjectStore.ProjectStoreV2)({
                findActiveByWorkspaceRoot: () =>
                  Effect.fail(
                    new ProjectStore.ProjectStoreV2Error({
                      operation: "findActiveByWorkspaceRoot",
                      cause: new Error("database is locked"),
                    }),
                  ),
              }),
              SqlitePersistence.layerMemory,
              Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
              Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
              Layer.mock(ThreadManagement.ThreadManagementService)({}),
              Layer.mock(GitVcsDriver.GitVcsDriver)({}),
              ServerSettings.layerTest(),
              NodeServices.layer,
            ),
          ),
        ),
      ),
    ),
  );
});

describe("FactorySessions.launch", () => {
  const request: Sessions.LaunchRequest = {
    commandId: "softfac:issue-5:attempt-1",
    projectId,
    title: "Build issue 5",
    baseRef: "main",
    startFromOrigin: true,
    message: "/factory 5",
    model: { instanceId: "claudeAgent", model: "claude-sonnet-5-5" },
  };

  it.effect(
    "starts a thread in a new worktree, full-access, default interaction, under the caller's command id",
    () =>
      Effect.gen(function* () {
        const inputs: Array<ThreadLaunch.ThreadLaunchInput> = [];
        const launched = yield* Effect.gen(function* () {
          const sessions = yield* Sessions.FactorySessions;
          return yield* sessions.launch(request);
        }).pipe(
          Effect.provide(
            layerSessions(
              {},
              {
                launch: (input) =>
                  Effect.sync(() => {
                    inputs.push(input);
                    return {
                      threadId,
                      resumed: false,
                      projection: {
                        thread: { branch: null, worktreePath: null },
                      } as OrchestrationV2ThreadProjection,
                    };
                  }),
              },
            ),
          ),
        );
        assert.deepStrictEqual(launched, { threadId, worktreePath: null, branch: null });
        assert.strictEqual(inputs.length, 1);
        const input = inputs[0]!;
        assert.strictEqual(input.commandId, "softfac:issue-5:attempt-1");
        assert.strictEqual(input.projectId, projectId);
        assert.strictEqual(input.title, "Build issue 5");
        assert.deepStrictEqual(input.modelSelection, {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-sonnet-5-5",
        });
        assert.strictEqual(input.runtimeMode, "full-access");
        assert.strictEqual(input.interactionMode, "default");
        assert.deepStrictEqual(input.workspaceStrategy, {
          type: "worktree",
          baseRef: "main",
          startFromOrigin: true,
        });
        assert.strictEqual(input.initialMessage?.text, "/factory 5");
        assert.deepStrictEqual(input.initialMessage?.attachments, []);
        assert.strictEqual(input.threadId, undefined);
        assert.strictEqual(input.reuseExistingThread, undefined);
      }),
  );

  it.effect("passes the model's provider options on to T3", () =>
    Effect.gen(function* () {
      const inputs: Array<ThreadLaunch.ThreadLaunchInput> = [];
      yield* Effect.gen(function* () {
        const sessions = yield* Sessions.FactorySessions;
        return yield* sessions.launch({
          ...request,
          model: { ...request.model, options: [{ id: "reasoningEffort", value: "high" }] },
        });
      }).pipe(
        Effect.provide(
          layerSessions(
            {},
            {
              launch: (input) =>
                Effect.sync(() => {
                  inputs.push(input);
                  return {
                    threadId,
                    resumed: false,
                    projection: {
                      thread: { branch: null, worktreePath: null },
                    } as OrchestrationV2ThreadProjection,
                  };
                }),
            },
          ),
        ),
      );
      assert.deepStrictEqual(inputs[0]!.modelSelection, {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-5-5",
        options: [{ id: "reasoningEffort", value: "high" }],
      });
    }),
  );

  it.effect("reports the branch and worktree path once T3 has them", () =>
    Effect.gen(function* () {
      const sessions = yield* Sessions.FactorySessions;
      const launched = yield* sessions.launch(request);
      assert.deepStrictEqual(launched, {
        threadId,
        worktreePath: "/tmp/wt/t3-abc",
        branch: "t3/abc",
      });
    }).pipe(
      Effect.provide(
        layerSessions(
          {},
          {
            launch: () =>
              Effect.succeed({
                threadId,
                resumed: true,
                projection: {
                  thread: { branch: "t3/abc", worktreePath: "/tmp/wt/t3-abc" },
                } as OrchestrationV2ThreadProjection,
              }),
          },
        ),
      ),
    ),
  );

  const rejectsWithoutLaunching = (blank: Sessions.LaunchRequest) =>
    Effect.gen(function* () {
      let launches = 0;
      const error = yield* Effect.gen(function* () {
        const sessions = yield* Sessions.FactorySessions;
        return yield* Effect.flip(sessions.launch(blank));
      }).pipe(
        Effect.provide(
          layerSessions(
            {},
            {
              launch: () =>
                Effect.sync(() => {
                  launches += 1;
                  return {
                    threadId,
                    resumed: false,
                    projection: {
                      thread: { branch: null, worktreePath: null },
                    } as OrchestrationV2ThreadProjection,
                  };
                }),
            },
          ),
        ),
      );
      assert.strictEqual(error._tag, "FactorySessionsError");
      assert.strictEqual(error.operation, "launch");
      assert.strictEqual(launches, 0);
    });

  it.effect.each([
    { name: "command id", blank: { ...request, commandId: "  " } },
    { name: "project id", blank: { ...request, projectId: "  " } },
    { name: "provider instance id", blank: { ...request, model: { instanceId: "", model: "m" } } },
  ])("rejects a blank $name as a sessions error without reaching T3", ({ blank }) =>
    rejectsWithoutLaunching(blank),
  );

  it.effect("fails as a sessions error when T3 rejects the launch", () =>
    Effect.gen(function* () {
      const sessions = yield* Sessions.FactorySessions;
      const error = yield* Effect.flip(sessions.launch(request));
      assert.strictEqual(error._tag, "FactorySessionsError");
      assert.strictEqual(error.operation, "launch");
    }).pipe(
      Effect.provide(
        layerSessions(
          {},
          {
            launch: (input) =>
              Effect.fail(
                new ThreadLaunch.ThreadLaunchError({
                  operation: "resolve-project",
                  commandId: input.commandId,
                  projectId: input.projectId,
                  cause: "Project not found.",
                }),
              ),
          },
        ),
      ),
    ),
  );

  const launchedThread = {
    launch: () =>
      Effect.succeed({
        threadId,
        resumed: false,
        projection: {
          thread: { branch: null, worktreePath: null },
        } as OrchestrationV2ThreadProjection,
      }),
  };
  const PR_URL = "https://github.com/rawphp/softfac/pull/12";

  it.effect("links the pull request a launch continues to the new thread", () =>
    Effect.gen(function* () {
      const commands: Array<Command> = [];
      const launched = yield* Effect.gen(function* () {
        const sessions = yield* Sessions.FactorySessions;
        return yield* sessions.launch({ ...request, pullRequestUrl: PR_URL });
      }).pipe(Effect.provide(layerSessions({}, launchedThread, recordingDispatch(commands))));
      assert.deepStrictEqual(launched, { threadId, worktreePath: null, branch: null });
      assert.deepStrictEqual(commands, [
        {
          type: "thread.pull-request.link",
          commandId: CommandId.make("softfac:issue-5:attempt-1:pull-request-link"),
          threadId,
          host: "github.com",
          repository: "rawphp/softfac",
          number: 12,
          url: PR_URL,
          source: "agent",
        },
      ]);
    }),
  );

  it.effect("links nothing for a launch without a pull request", () =>
    Effect.gen(function* () {
      const commands: Array<Command> = [];
      yield* Effect.gen(function* () {
        const sessions = yield* Sessions.FactorySessions;
        return yield* sessions.launch(request);
      }).pipe(Effect.provide(layerSessions({}, launchedThread, recordingDispatch(commands))));
      assert.deepStrictEqual(commands, []);
    }),
  );

  it.effect("returns the launched thread when T3 refuses the link", () =>
    Effect.gen(function* () {
      const refusal = new Orchestrator.OrchestratorCommandRejectedError({
        commandId: CommandId.make("softfac:issue-5:attempt-1:pull-request-link"),
        commandType: "thread.pull-request.link",
      });
      const launched = yield* Effect.gen(function* () {
        const sessions = yield* Sessions.FactorySessions;
        return yield* sessions.launch({ ...request, pullRequestUrl: PR_URL });
      }).pipe(
        Effect.provide(
          layerSessions({}, launchedThread, { dispatch: () => Effect.fail(refusal) as never }),
        ),
      );
      assert.deepStrictEqual(launched, { threadId, worktreePath: null, branch: null });
    }),
  );

  it.effect("returns the launched thread without a link when the URL cannot be read", () =>
    Effect.gen(function* () {
      const commands: Array<Command> = [];
      const launched = yield* Effect.gen(function* () {
        const sessions = yield* Sessions.FactorySessions;
        return yield* sessions.launch({ ...request, pullRequestUrl: "not a url" });
      }).pipe(Effect.provide(layerSessions({}, launchedThread, recordingDispatch(commands))));
      assert.deepStrictEqual(launched, { threadId, worktreePath: null, branch: null });
      assert.deepStrictEqual(commands, []);
    }),
  );
});

describe("FactorySessions.status and thread", () => {
  const appThread = (fields: ReturnType<typeof thread>) =>
    ({
      ...fields,
      archivedAt: fields.archivedAt === null ? null : DateTime.makeUnsafe(fields.archivedAt),
    }) as unknown as OrchestrationV2AppThread;

  it.effect("status reads the run, its last assistant message and the thread fields", () =>
    Effect.gen(function* () {
      const sessions = yield* Sessions.FactorySessions;
      assert.deepStrictEqual(yield* sessions.status(threadId), {
        run: "completed",
        runOrdinal: 2,
        runStartedAt: 1791182378376,
        runCompletedAt: null,
        lastAssistantMessage: "FACTORY-DONE: https://example.test/pr/1",
        worktreePath: "/tmp/wt/t3-abc",
        branch: "t3/abc",
        archived: false,
      });
    }).pipe(
      Effect.provide(
        layerSessions({
          getThreadRecords: (id) =>
            Effect.succeed({
              thread: appThread(thread("t3/abc", "/tmp/wt/t3-abc")),
              runs: [run(1, "completed"), run(2, "completed")].map((r) => ({
                ...r,
                threadId: id,
              })),
              messages: [
                message(1, "assistant", "first"),
                message(2, "assistant", "FACTORY-DONE: https://example.test/pr/1"),
              ],
            } as never),
        }),
      ),
    ),
  );

  it.effect("status of a thread T3 does not know is not found", () =>
    Effect.gen(function* () {
      const sessions = yield* Sessions.FactorySessions;
      const error = yield* Effect.flip(sessions.status(threadId));
      assert.strictEqual(error._tag, "FactoryThreadNotFoundError");
      if (error._tag === "FactoryThreadNotFoundError") {
        assert.strictEqual(error.threadId, threadId);
      }
    }).pipe(
      Effect.provide(
        layerSessions({
          getThreadRecords: (id) =>
            Effect.fail(new ProjectionStore.ProjectionStoreThreadNotFoundError({ threadId: id })),
        }),
      ),
    ),
  );

  it.effect("thread reads the thread's own fields and works when the runs cannot be read", () =>
    Effect.gen(function* () {
      const sessions = yield* Sessions.FactorySessions;
      assert.deepStrictEqual(yield* sessions.thread(threadId), {
        worktreePath: "/tmp/wt/t3-abc",
        branch: "t3/abc",
        archived: true,
      });
      const error = yield* Effect.flip(sessions.status(threadId));
      assert.strictEqual(error._tag, "FactorySessionsError");
    }).pipe(
      Effect.provide(
        layerSessions({
          getThread: () =>
            Effect.succeed(appThread(thread("t3/abc", "/tmp/wt/t3-abc", "2026-10-05T00:00:00Z"))),
          getThreadRecords: (id) =>
            Effect.fail(
              new ProjectionStore.ProjectionStoreReadError({
                threadId: id,
                cause: new Error("a run row did not decode"),
              }),
            ),
        }),
      ),
    ),
  );

  it.effect("a blank thread id names no thread", () =>
    Effect.gen(function* () {
      const sessions = yield* Sessions.FactorySessions;
      assert.strictEqual(
        (yield* Effect.flip(sessions.status("")))._tag,
        "FactoryThreadNotFoundError",
      );
      assert.strictEqual(
        (yield* Effect.flip(sessions.thread("  ")))._tag,
        "FactoryThreadNotFoundError",
      );
    }).pipe(
      Effect.provide(
        layerSessions({
          getThread: () => Effect.die("a blank id must not reach the store"),
          getThreadRecords: () => Effect.die("a blank id must not reach the store"),
        }),
      ),
    ),
  );

  it.effect("thread fails as a sessions error when the thread cannot be read", () =>
    Effect.gen(function* () {
      const sessions = yield* Sessions.FactorySessions;
      const error = yield* Effect.flip(sessions.thread(threadId));
      assert.strictEqual(error._tag, "FactorySessionsError");
      if (error._tag === "FactorySessionsError") {
        assert.strictEqual(error.operation, "thread");
      }
    }).pipe(
      Effect.provide(
        layerSessions({
          getThread: (id) =>
            Effect.fail(
              new ProjectionStore.ProjectionStoreReadError({
                threadId: id,
                cause: new Error("the thread row did not decode"),
              }),
            ),
        }),
      ),
    ),
  );

  it.effect("thread of a thread T3 does not know is not found", () =>
    Effect.gen(function* () {
      const sessions = yield* Sessions.FactorySessions;
      const error = yield* Effect.flip(sessions.thread(threadId));
      assert.strictEqual(error._tag, "FactoryThreadNotFoundError");
    }).pipe(
      Effect.provide(
        layerSessions({
          getThread: (id) =>
            Effect.fail(new ProjectionStore.ProjectionStoreThreadNotFoundError({ threadId: id })),
        }),
      ),
    ),
  );
});

class DispatchRejected extends Schema.TaggedError<DispatchRejected>()("DispatchRejected", {
  message: Schema.String,
}) {}

type Command = Parameters<ThreadManagement.ThreadManagementService["Service"]["dispatch"]>[0];

/** A dispatch that records its commands and answers like T3 does, which the adapter ignores. */
const recordingDispatch = (commands: Array<Command>) => ({
  dispatch: (command: Command) =>
    Effect.sync(() => {
      commands.push(command);
      return {} as never;
    }),
});

describe("FactorySessions.send", () => {
  it.effect("dispatches a message with automatic delivery under the caller's command id", () =>
    Effect.gen(function* () {
      const commands: Array<Command> = [];
      yield* Effect.gen(function* () {
        const sessions = yield* Sessions.FactorySessions;
        yield* sessions.send(threadId, "softfac:issue-5:send-1", "carry on");
      }).pipe(Effect.provide(layerSessions({}, {}, recordingDispatch(commands))));
      assert.deepStrictEqual(commands, [
        {
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "server",
          commandId: CommandId.make("softfac:issue-5:send-1"),
          threadId,
          messageId: MessageId.make("message:softfac:issue-5:send-1"),
          text: "carry on",
          attachments: [],
          deliveryIntent: "auto",
          dispatchMode: { type: "start_immediately" },
        },
      ]);
    }),
  );

  it.effect("never reads the thread first", () =>
    Effect.gen(function* () {
      const sessions = yield* Sessions.FactorySessions;
      yield* sessions.send(threadId, "softfac:issue-5:send-1", "carry on");
    }).pipe(
      Effect.provide(
        layerSessions(
          {
            getThread: () => Effect.die("send must not read the thread"),
            getThreadRecords: () => Effect.die("send must not read the thread"),
          },
          {},
          recordingDispatch([]),
        ),
      ),
    ),
  );

  it.effect("rejects a blank command id as a sessions error without dispatching", () =>
    Effect.gen(function* () {
      const commands: Array<Command> = [];
      const error = yield* Effect.gen(function* () {
        const sessions = yield* Sessions.FactorySessions;
        return yield* Effect.flip(sessions.send(threadId, "  ", "carry on"));
      }).pipe(Effect.provide(layerSessions({}, {}, recordingDispatch(commands))));
      assert.strictEqual(error._tag, "FactorySessionsError");
      if (error._tag === "FactorySessionsError") assert.strictEqual(error.operation, "send");
      assert.strictEqual(commands.length, 0);
    }),
  );

  it.effect("rejects a blank thread id as a thread not found without dispatching", () =>
    Effect.gen(function* () {
      const commands: Array<Command> = [];
      const error = yield* Effect.gen(function* () {
        const sessions = yield* Sessions.FactorySessions;
        return yield* Effect.flip(sessions.send("", "softfac:issue-5:send-1", "carry on"));
      }).pipe(Effect.provide(layerSessions({}, {}, recordingDispatch(commands))));
      assert.strictEqual(error._tag, "FactoryThreadNotFoundError");
      assert.strictEqual(commands.length, 0);
    }),
  );

  it.effect("fails as a sessions error when the dispatch fails otherwise", () =>
    Effect.gen(function* () {
      const sessions = yield* Sessions.FactorySessions;
      const error = yield* Effect.flip(sessions.send(threadId, "softfac:issue-5:send-1", "x"));
      assert.strictEqual(error._tag, "FactorySessionsError");
      if (error._tag === "FactorySessionsError") assert.strictEqual(error.operation, "send");
    }).pipe(
      Effect.provide(
        layerSessions(
          {},
          {},
          {
            dispatch: () =>
              Effect.fail(new DispatchRejected({ message: "no such thread" })) as never,
          },
        ),
      ),
    ),
  );

  const sendRefused = (refusal: Orchestrator.OrchestratorV2Error) =>
    Effect.gen(function* () {
      const sessions = yield* Sessions.FactorySessions;
      return yield* Effect.flip(sessions.send(threadId, "softfac:issue-5:send-1", "x"));
    }).pipe(
      Effect.provide(layerSessions({}, {}, { dispatch: () => Effect.fail(refusal) as never })),
    );

  it.effect("fails as message rejected when T3 refuses the message", () =>
    Effect.gen(function* () {
      const refusal = new Orchestrator.OrchestratorCommandRejectedError({
        commandId: CommandId.make("softfac:issue-5:send-1"),
        commandType: "message.dispatch",
      });
      const error = yield* sendRefused(refusal);
      assert.strictEqual(error._tag, "FactoryMessageRejectedError");
      if (error._tag === "FactoryMessageRejectedError") {
        assert.strictEqual(error.threadId, threadId);
        assert.strictEqual(error.commandId, "softfac:issue-5:send-1");
        assert.strictEqual(error.cause, refusal);
      }
    }),
  );

  it.effect("fails as message rejected when the command id was refused before", () =>
    Effect.gen(function* () {
      const error = yield* sendRefused(
        new Orchestrator.OrchestratorCommandPreviouslyRejectedError({
          commandId: CommandId.make("softfac:issue-5:send-1"),
          commandType: "message.dispatch",
          detail: "Thread is archived.",
        }),
      );
      assert.strictEqual(error._tag, "FactoryMessageRejectedError");
    }),
  );
});

const archiveCommand = (command: Command) => {
  assert.strictEqual(command.type, "thread.archive");
  return command as Extract<Command, { readonly type: "thread.archive" }>;
};

/** A thread projection read that answers each call in turn, then repeats the last. */
const readsInTurn = (
  reads: ReadonlyArray<"live" | "archived" | "unknown" | "broken">,
  counter: { gets: number; records: number },
) => ({
  getThread: (id: ThreadId) => {
    const kind = reads[Math.min(counter.gets, reads.length - 1)]!;
    counter.gets += 1;
    switch (kind) {
      case "live":
        return Effect.succeed({ ...thread("t3/abc", "/tmp/wt/t3-abc"), archivedAt: null } as never);
      case "archived":
        return Effect.succeed({
          ...thread("t3/abc", "/tmp/wt/t3-abc"),
          archivedAt: DateTime.makeUnsafe("2026-10-05T00:00:00Z"),
        } as never);
      case "unknown":
        return Effect.fail(
          new ProjectionStore.ProjectionStoreThreadNotFoundError({ threadId: id }),
        );
      case "broken":
        return Effect.fail(
          new ProjectionStore.ProjectionStoreReadError({
            threadId: id,
            cause: new Error("the thread row did not decode"),
          }),
        );
    }
  },
  getThreadRecords: () => {
    counter.records += 1;
    return Effect.die("archive reads only the thread's own fields");
  },
});

const runArchive = (
  reads: ReadonlyArray<"live" | "archived" | "unknown" | "broken">,
  dispatchFails: boolean,
  attempts = 1,
) =>
  Effect.gen(function* () {
    const counter = { gets: 0, records: 0 };
    const commands: Array<Command> = [];
    const results = yield* Effect.gen(function* () {
      const sessions = yield* Sessions.FactorySessions;
      const outcomes = [];
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        outcomes.push(yield* Effect.result(sessions.archive(threadId)));
      }
      return outcomes;
    }).pipe(
      Effect.provide(
        layerSessions(
          readsInTurn(reads, counter),
          {},
          dispatchFails
            ? {
                dispatch: (command) =>
                  Effect.sync(() => {
                    commands.push(command);
                  }).pipe(
                    Effect.andThen(
                      Effect.fail(new DispatchRejected({ message: "dispatch failed" }) as never),
                    ),
                  ),
              }
            : recordingDispatch(commands),
        ),
      ),
    );
    return { results, commands, counter };
  });

describe("FactorySessions.archive", () => {
  it.effect("reads the thread, then archives it under a command id of its own", () =>
    Effect.gen(function* () {
      const { results, commands, counter } = yield* runArchive(["live"], false);
      assert.strictEqual(results[0]!._tag, "Success");
      assert.strictEqual(commands.length, 1);
      const command = archiveCommand(commands[0]!);
      assert.strictEqual(command.threadId, threadId);
      assert.isTrue(command.commandId.startsWith(`factory-archive:${threadId}:`));
      assert.deepStrictEqual(Object.keys(command).toSorted(), ["commandId", "threadId", "type"]);
      assert.strictEqual(counter.gets, 1);
      assert.strictEqual(counter.records, 0);
    }),
  );

  it.effect("sends a new command id for every attempt", () =>
    Effect.gen(function* () {
      const { commands } = yield* runArchive(["live"], false, 2);
      assert.strictEqual(commands.length, 2);
      assert.notStrictEqual(
        archiveCommand(commands[0]!).commandId,
        archiveCommand(commands[1]!).commandId,
      );
    }),
  );

  it.effect("of an archived thread succeeds and dispatches nothing", () =>
    Effect.gen(function* () {
      const { results, commands } = yield* runArchive(["archived"], false);
      assert.strictEqual(results[0]!._tag, "Success");
      assert.strictEqual(commands.length, 0);
    }),
  );

  it.effect("of a thread T3 does not know succeeds and dispatches nothing", () =>
    Effect.gen(function* () {
      const { results, commands } = yield* runArchive(["unknown"], false);
      assert.strictEqual(results[0]!._tag, "Success");
      assert.strictEqual(commands.length, 0);
    }),
  );

  it.effect("of a blank thread id succeeds without a read or a dispatch", () =>
    Effect.gen(function* () {
      const counter = { gets: 0, records: 0 };
      const commands: Array<Command> = [];
      yield* Effect.gen(function* () {
        const sessions = yield* Sessions.FactorySessions;
        yield* sessions.archive("");
      }).pipe(
        Effect.provide(
          layerSessions(readsInTurn(["live"], counter), {}, recordingDispatch(commands)),
        ),
      );
      assert.strictEqual(commands.length, 0);
      assert.strictEqual(counter.gets, 0);
      assert.strictEqual(counter.records, 0);
    }),
  );

  it.effect("still archives when the first read fails otherwise", () =>
    Effect.gen(function* () {
      const { results, commands } = yield* runArchive(["broken"], false);
      assert.strictEqual(results[0]!._tag, "Success");
      assert.strictEqual(commands.length, 1);
    }),
  );

  it.effect("succeeds when a failed archive left the thread archived", () =>
    Effect.gen(function* () {
      const { results, commands, counter } = yield* runArchive(["live", "archived"], true);
      assert.strictEqual(results[0]!._tag, "Success");
      assert.strictEqual(commands.length, 1);
      assert.strictEqual(counter.gets, 2);
    }),
  );

  it.effect("succeeds when a failed archive is followed by a thread T3 does not know", () =>
    Effect.gen(function* () {
      const { results } = yield* runArchive(["live", "unknown"], true);
      assert.strictEqual(results[0]!._tag, "Success");
    }),
  );

  it.effect("fails with the archive error when the thread is still live", () =>
    Effect.gen(function* () {
      const { results, counter } = yield* runArchive(["live"], true);
      const result = results[0]!;
      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure") {
        const error = result.failure;
        assert.strictEqual(error._tag, "FactorySessionsError");
        if (error._tag === "FactorySessionsError") {
          assert.strictEqual(error.operation, "archive");
          assert.instanceOf(error.cause, DispatchRejected);
        }
      }
      assert.strictEqual(counter.gets, 2);
    }),
  );

  it.effect("fails with the archive error when the second read fails too", () =>
    Effect.gen(function* () {
      const { results, counter } = yield* runArchive(["live", "broken"], true);
      const result = results[0]!;
      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure" && result.failure._tag === "FactorySessionsError") {
        assert.instanceOf(result.failure.cause, DispatchRejected);
      }
      assert.strictEqual(counter.gets, 2);
    }),
  );
});

interface GitCall {
  readonly cwd: string;
  readonly args: ReadonlyArray<string>;
  readonly env: unknown;
  readonly allowNonZeroExit: unknown;
  readonly timeoutMs: unknown;
}

const gitResult = (exitCode: number, stderr = "") =>
  ({ exitCode, stdout: "", stderr, stdoutTruncated: false, stderrTruncated: false }) as never;

/** A git driver that records its calls and answers each with `answer`. */
const recordingGit = (
  calls: Array<GitCall>,
  answer: () => ReturnType<GitVcsDriver.GitVcsDriver["Service"]["execute"]>,
) => ({
  execute: (input: Parameters<GitVcsDriver.GitVcsDriver["Service"]["execute"]>[0]) => {
    calls.push({
      cwd: input.cwd,
      args: input.args,
      env: input.env,
      allowNonZeroExit: input.allowNonZeroExit,
      timeoutMs: input.timeoutMs,
    });
    return answer();
  },
});

/** A projection with no live thread on any worktree. */
const noThreadsOnWorktrees = { getThreadWorktreePaths: () => Effect.succeed([]) };

const removeWorktree = (path: string) =>
  Effect.gen(function* () {
    const sessions = yield* Sessions.FactorySessions;
    return yield* sessions.removeWorktree(path);
  });

describe("FactorySessions.removeWorktree", () => {
  it.effect("refuses a relative path without running git", () =>
    Effect.gen(function* () {
      const calls: Array<GitCall> = [];
      const error = yield* Effect.flip(removeWorktree("t3code-abc")).pipe(
        Effect.provide(
          layerSessions(
            noThreadsOnWorktrees,
            {},
            {},
            recordingGit(calls, () => Effect.succeed(gitResult(0))),
          ),
        ),
      );
      assert.strictEqual(error._tag, "FactorySessionsError");
      if (error._tag === "FactorySessionsError") {
        assert.strictEqual(error.operation, "remove-worktree");
      }
      assert.strictEqual(calls.length, 0);
    }),
  );

  it.effect("runs git worktree remove --force from the worktree itself", () =>
    Effect.gen(function* () {
      const calls: Array<GitCall> = [];
      yield* removeWorktree("/tmp/wt/t3-abc").pipe(
        Effect.provide(
          layerSessions(
            noThreadsOnWorktrees,
            {},
            {},
            recordingGit(calls, () => Effect.succeed(gitResult(0))),
          ),
        ),
      );
      assert.deepStrictEqual(calls, [
        {
          cwd: "/tmp/wt/t3-abc",
          args: ["worktree", "remove", "--force", "--", "/tmp/wt/t3-abc"],
          env: { LC_ALL: "C" },
          allowNonZeroExit: true,
          // A big node_modules outlasts git's 30 s default.
          timeoutMs: 10 * 60 * 1000,
        },
      ]);
    }),
  );

  it.effect("counts a worktree already gone from disk as removed", () =>
    Effect.gen(function* () {
      const calls: Array<GitCall> = [];
      yield* removeWorktree("/tmp/factory-sessions-test-no-such-dir/wt").pipe(
        Effect.provide(
          layerSessions(
            noThreadsOnWorktrees,
            {},
            {},
            recordingGit(calls, () =>
              Effect.succeed(
                gitResult(
                  128,
                  "fatal: '/tmp/factory-sessions-test-no-such-dir/wt' is not a working tree\n",
                ),
              ),
            ),
          ),
        ),
      );
      assert.strictEqual(calls.length, 1);
    }),
  );

  it.effect("counts a git that cannot start in a directory that is gone as removed", () =>
    Effect.gen(function* () {
      yield* removeWorktree("/tmp/factory-sessions-test-no-such-dir/wt").pipe(
        Effect.provide(
          layerSessions(
            noThreadsOnWorktrees,
            {},
            {},
            recordingGit([], () =>
              Effect.fail(
                new GitCommandError({
                  operation: "factory.sessions.removeWorktree",
                  command: "git worktree remove",
                  cwd: "/tmp/factory-sessions-test-no-such-dir/wt",
                  detail: "spawn git ENOENT",
                }),
              ),
            ),
          ),
        ),
      );
    }),
  );

  it.effect("removes the directory itself after a wait when git leaves it not empty", () =>
    Effect.gen(function* () {
      const path = "/tmp/factory-sessions-test/wt";
      const removed: Array<{
        path: string;
        options:
          | { readonly recursive?: boolean | undefined; readonly force?: boolean | undefined }
          | undefined;
      }> = [];
      const calls: Array<GitCall> = [];
      // A stub FileSystem answers at once, so the fiber reaches the 3 s wait
      // on the fork itself and the test clock alone decides when it ends.
      const fileSystem = FileSystem.layerNoop({
        exists: () => Effect.succeed(true),
        remove: (removedPath, options) =>
          Effect.sync(() => {
            removed.push({ path: removedPath, options });
          }),
      });
      // Build the layer (real IO) before the fork, so the fork only runs what
      // the test clock controls.
      const sessions = yield* Sessions.FactorySessions.pipe(
        Effect.provide(
          layerSessions(
            noThreadsOnWorktrees,
            {},
            {},
            recordingGit(calls, () =>
              Effect.succeed(
                gitResult(128, `error: failed to delete '${path}': Directory not empty\n`),
              ),
            ),
            fileSystem,
          ),
        ),
      );
      const fiber = yield* sessions
        .removeWorktree(path)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust("2999 millis");
      assert.isUndefined(fiber.pollUnsafe());
      assert.deepStrictEqual(removed, []);
      yield* TestClock.adjust("1 millis");
      yield* Fiber.join(fiber);
      assert.deepStrictEqual(removed, [{ path, options: { recursive: true } }]);
      assert.strictEqual(calls.length, 1);
    }),
  );

  /**
   * removeWorktree on a directory git leaves not empty, with a stub FileSystem
   * whose delete fails `failures` times first. The layer is built (real IO)
   * before the fork, so the test clock alone decides when the waits end.
   */
  const removeLeftNotEmpty = (failures: number) =>
    Effect.gen(function* () {
      const path = "/tmp/factory-sessions-test/wt";
      const deletes: Array<string> = [];
      const fileSystem = FileSystem.layerNoop({
        exists: () => Effect.succeed(true),
        remove: (removedPath) =>
          Effect.suspend(() => {
            deletes.push(removedPath);
            return deletes.length <= failures
              ? Effect.fail(
                  PlatformError.systemError({
                    _tag: "Unknown",
                    module: "FileSystem",
                    method: "remove",
                    pathOrDescriptor: removedPath,
                    description: "Directory not empty",
                  }),
                )
              : Effect.void;
          }),
      });
      const sessions = yield* Sessions.FactorySessions.pipe(
        Effect.provide(
          layerSessions(
            noThreadsOnWorktrees,
            {},
            {},
            recordingGit([], () =>
              Effect.succeed(
                gitResult(128, `error: failed to delete '${path}': Directory not empty\n`),
              ),
            ),
            fileSystem,
          ),
        ),
      );
      const fiber = yield* sessions
        .removeWorktree(path)
        .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
      return { fiber, deletes };
    });

  it.effect("deletes again while a writer in the directory finishes", () =>
    Effect.gen(function* () {
      const { fiber, deletes } = yield* removeLeftNotEmpty(2);
      yield* TestClock.adjust("3 seconds");
      assert.strictEqual(deletes.length, 1);
      yield* TestClock.adjust("2999 millis");
      assert.strictEqual(deletes.length, 1);
      yield* TestClock.adjust("1 millis");
      assert.strictEqual(deletes.length, 2);
      assert.isUndefined(fiber.pollUnsafe());
      yield* TestClock.adjust("3 seconds");
      const result = yield* Fiber.join(fiber);
      assert.strictEqual(result._tag, "Success");
      assert.strictEqual(deletes.length, 3);
    }),
  );

  it.effect("fails after three deletes over about 10 s when the writer never stops", () =>
    Effect.gen(function* () {
      const { fiber, deletes } = yield* removeLeftNotEmpty(Number.POSITIVE_INFINITY);
      yield* TestClock.adjust("9 seconds");
      const result = yield* Fiber.join(fiber);
      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.strictEqual(result.failure._tag, "FactorySessionsError");
        if (result.failure._tag === "FactorySessionsError") {
          assert.strictEqual(result.failure.operation, "remove-worktree");
        }
      }
      assert.strictEqual(deletes.length, 3);
      yield* TestClock.adjust("1 minute");
      assert.strictEqual(deletes.length, 3);
    }),
  );

  it.effect(
    "fails naming the directory and keeps it when a stopped removal left it outside any worktree",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "factory-sessions-remove-" });
          yield* fs.writeFileString(`${dir}/left-behind.txt`, "a writer's file\n");
          const error = yield* Effect.flip(removeWorktree(dir)).pipe(
            Effect.provide(
              layerSessions(
                noThreadsOnWorktrees,
                {},
                {},
                recordingGit([], () =>
                  Effect.succeed(
                    gitResult(
                      128,
                      "fatal: not a git repository (or any of the parent directories): .git\n",
                    ),
                  ),
                ),
              ),
            ),
          );
          assert.strictEqual(error._tag, "FactorySessionsError");
          if (error._tag === "FactorySessionsError") {
            assert.strictEqual(error.operation, "remove-worktree");
            assert.include(String(error.cause), dir);
          }
          assert.isTrue(yield* fs.exists(`${dir}/left-behind.txt`));
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "fails and keeps the directory when git itself fails while the worktree is on disk",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "factory-sessions-remove-" });
          const error = yield* Effect.flip(removeWorktree(dir)).pipe(
            Effect.provide(
              layerSessions(
                noThreadsOnWorktrees,
                {},
                {},
                recordingGit([], () =>
                  Effect.fail(
                    new GitCommandError({
                      operation: "factory.sessions.removeWorktree",
                      command: "git worktree remove",
                      cwd: dir,
                      detail: "spawn git EACCES",
                    }),
                  ),
                ),
              ),
            ),
          );
          assert.strictEqual(error._tag, "FactorySessionsError");
          if (error._tag === "FactorySessionsError") {
            assert.strictEqual(error.operation, "remove-worktree");
          }
          assert.isTrue(yield* fs.exists(dir));
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("fails and keeps the directory on any other git error", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "factory-sessions-remove-" });
        const calls: Array<GitCall> = [];
        const error = yield* Effect.flip(removeWorktree(dir)).pipe(
          Effect.provide(
            layerSessions(
              noThreadsOnWorktrees,
              {},
              {},
              recordingGit(calls, () => Effect.succeed(gitResult(128, "fatal: cannot lock ref\n"))),
            ),
          ),
        );
        assert.strictEqual(error._tag, "FactorySessionsError");
        if (error._tag === "FactorySessionsError") {
          assert.strictEqual(error.operation, "remove-worktree");
        }
        assert.strictEqual(calls.length, 1);
        assert.isTrue(yield* fs.exists(dir));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("archives every live thread on the worktree before git removes it", () =>
    Effect.gen(function* () {
      const order: Array<string> = [];
      const child = ThreadId.make("thread:project:factory-sessions-test:child");
      const other = ThreadId.make("thread:project:factory-sessions-test:other");
      yield* removeWorktree("/tmp/wt/t3-abc").pipe(
        Effect.provide(
          layerSessions(
            {
              getThreadWorktreePaths: () =>
                Effect.succeed([
                  { threadId: child, worktreePath: "/tmp/wt/t3-abc" },
                  { threadId: other, worktreePath: "/tmp/wt/t3-other" },
                ]),
              getThread: () =>
                Effect.succeed({
                  ...thread("t3/abc", "/tmp/wt/t3-abc"),
                  archivedAt: null,
                } as never),
            },
            {},
            {
              dispatch: (command) =>
                Effect.sync(() => {
                  order.push(`${command.type} ${"threadId" in command ? command.threadId : ""}`);
                }) as never,
            },
            {
              execute: () =>
                Effect.sync(() => {
                  order.push("git worktree remove");
                  return gitResult(0);
                }),
            },
          ),
        ),
      );
      assert.deepStrictEqual(order, [`thread.archive ${child}`, "git worktree remove"]);
    }),
  );

  it.effect("leaves the worktree whole when a thread on it cannot be archived", () =>
    Effect.gen(function* () {
      const calls: Array<GitCall> = [];
      const error = yield* Effect.flip(removeWorktree("/tmp/wt/t3-abc")).pipe(
        Effect.provide(
          layerSessions(
            {
              getThreadWorktreePaths: () =>
                Effect.succeed([{ threadId, worktreePath: "/tmp/wt/t3-abc" }]),
              getThread: () =>
                Effect.succeed({
                  ...thread("t3/abc", "/tmp/wt/t3-abc"),
                  archivedAt: null,
                } as never),
            },
            {},
            {
              dispatch: () =>
                Effect.fail(new DispatchRejected({ message: "dispatch failed" }) as never),
            },
            recordingGit(calls, () => Effect.succeed(gitResult(0))),
          ),
        ),
      );
      assert.strictEqual(error.operation, "archive");
      assert.strictEqual(calls.length, 0);
    }),
  );

  it.effect("leaves the worktree whole when the threads on it cannot be read", () =>
    Effect.gen(function* () {
      const calls: Array<GitCall> = [];
      const error = yield* Effect.flip(removeWorktree("/tmp/wt/t3-abc")).pipe(
        Effect.provide(
          layerSessions(
            {
              getThreadWorktreePaths: () =>
                Effect.fail(new ProjectionStore.ProjectionStoreSetupError({ cause: "locked" })),
            },
            {},
            {},
            recordingGit(calls, () => Effect.succeed(gitResult(0))),
          ),
        ),
      );
      assert.strictEqual(error.operation, "archive");
      assert.strictEqual(calls.length, 0);
    }),
  );
});

describe("FactorySessions.brokenWorktrees", () => {
  const listBroken = Effect.gen(function* () {
    return yield* (yield* Sessions.FactorySessions).brokenWorktrees;
  });

  it.effect(
    "names the live threads whose worktree is gone or is not a git checkout, with every thread on that path",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "factory-sessions-broken-" });
          // A checkout, a half-removed one with only an ignored folder left, and one deleted.
          yield* fs.makeDirectory(`${dir}/whole`);
          yield* fs.writeFileString(`${dir}/whole/.git`, "gitdir: /repo/.git/worktrees/whole\n");
          yield* fs.makeDirectory(`${dir}/remnant/source`, { recursive: true });
          const live = [
            { threadId: ThreadId.make("whole"), worktreePath: `${dir}/whole` },
            { threadId: ThreadId.make("child"), worktreePath: `${dir}/remnant` },
            { threadId: ThreadId.make("deleted"), worktreePath: `${dir}/deleted` },
          ];
          // The archived session keeps its path, so the ledger's thread id is on it.
          const all = [
            ...live,
            { threadId: ThreadId.make("session"), worktreePath: `${dir}/remnant` },
          ];
          const broken = yield* listBroken.pipe(
            Effect.provide(
              layerSessions({
                getThreadWorktreePaths: (options) =>
                  Effect.succeed(options?.includeArchived === true ? all : live),
              }),
            ),
          );
          assert.deepStrictEqual(broken, [
            {
              threadId: "child",
              worktreePath: `${dir}/remnant`,
              threadsOnPath: ["child", "session"],
            },
            { threadId: "deleted", worktreePath: `${dir}/deleted`, threadsOnPath: ["deleted"] },
          ]);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("does not call a worktree broken when its .git cannot be checked", () =>
    Effect.gen(function* () {
      const bound = [{ threadId: ThreadId.make("t"), worktreePath: "/wt/t3-locked" }];
      const broken = yield* listBroken.pipe(
        Effect.provide(
          layerSessions(
            { getThreadWorktreePaths: () => Effect.succeed(bound) },
            {},
            {},
            {},
            FileSystem.layerNoop({
              exists: (path) =>
                Effect.fail(
                  PlatformError.systemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "exists",
                    pathOrDescriptor: path,
                  }),
                ),
            }),
          ),
        ),
      );
      assert.deepStrictEqual(broken, []);
    }),
  );

  it.effect(
    "leaves out a thread this server archived, so a person's unarchive sticks, but not one whose archive failed",
    () =>
      Effect.gen(function* () {
        const archived = ThreadId.make("archived-then-unarchived");
        const failed = ThreadId.make("archive-failed");
        // Both are live and on a deleted folder whatever the archive did, as after an unarchive.
        const bound = [
          { threadId: archived, worktreePath: "/tmp/factory-sessions-test-no-such-dir/a" },
          { threadId: failed, worktreePath: "/tmp/factory-sessions-test-no-such-dir/b" },
        ];
        const found = yield* Effect.gen(function* () {
          const sessions = yield* Sessions.FactorySessions;
          yield* sessions.archive(archived);
          yield* Effect.flip(sessions.archive(failed));
          return yield* sessions.brokenWorktrees;
        }).pipe(
          Effect.provide(
            layerSessions(
              {
                getThreadWorktreePaths: () => Effect.succeed(bound),
                getThread: () =>
                  Effect.succeed({ ...thread("t3/abc", "/x"), archivedAt: null } as never),
              },
              {},
              {
                dispatch: (command) =>
                  "threadId" in command && command.threadId === failed
                    ? Effect.fail(new DispatchRejected({ message: "dispatch failed" }) as never)
                    : (Effect.succeed({}) as never),
              },
            ),
          ),
        );
        assert.deepStrictEqual(
          found.map((thread) => thread.threadId),
          [failed],
        );
      }),
  );

  it.effect("leaves out a thread that was already archived when the factory archived it", () =>
    Effect.gen(function* () {
      const bound = [{ threadId, worktreePath: "/tmp/factory-sessions-test-no-such-dir/a" }];
      const found = yield* Effect.gen(function* () {
        const sessions = yield* Sessions.FactorySessions;
        yield* sessions.archive(threadId);
        return yield* sessions.brokenWorktrees;
      }).pipe(
        Effect.provide(
          layerSessions({
            // Archived when the factory asks, live again (a person unarchived it) when it looks.
            getThread: () =>
              Effect.succeed({
                ...thread("t3/abc", "/x"),
                archivedAt: DateTime.makeUnsafe("2026-10-05T00:00:00Z"),
              } as never),
            getThreadWorktreePaths: () => Effect.succeed(bound),
          }),
        ),
      );
      assert.deepStrictEqual(found, []);
    }),
  );

  it.effect("fails as a sessions error when the projection cannot be read", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(listBroken).pipe(
        Effect.provide(
          layerSessions({
            getThreadWorktreePaths: () =>
              Effect.fail(new ProjectionStore.ProjectionStoreSetupError({ cause: "locked" })),
          }),
        ),
      );
      assert.strictEqual(error.operation, "broken-worktrees");
    }),
  );
});
