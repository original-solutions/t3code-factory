// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import { describe } from "vite-plus/test";

import { FactoryProcess } from "../process.ts";
import { FactoryPaths } from "../t3/paths.ts";
import { FactorySessions, type ThreadStatus } from "../t3/sessions.ts";
import { FactoryWatchedRepos } from "../t3/watchedRepos.ts";
import type { BoundGitHub } from "../tracker/github.ts";
import { buildAndGate, buildAndLearn } from "./fixtures.ts";
import { encodePipeline } from "./model.ts";
import { appendEvent, readRecord, recordPath, runIdFor } from "./record.ts";
import * as Runs from "./runs.ts";
import { PipelineRuns } from "./runsService.ts";

const ROOT = "/work/widgets";

type Setup = {
  readonly archived: Array<string>;
  readonly launched: Deferred.Deferred<void>;
  /** Done when the first thread is archived. */
  readonly archivedOne: Deferred.Deferred<void>;
  readonly layer: Layer.Layer<PipelineRuns>;
};

const settled = (text: string): ThreadStatus => ({
  worktreePath: "/wt/t1",
  branch: "t3/t1",
  archived: false,
  run: "completed",
  runOrdinal: 1,
  runStartedAt: null,
  runCompletedAt: null,
  lastAssistantMessage: text,
});

/**
 * The service over a temp factory dir, with sessions whose runs never settle unless `status`
 * says, watching `repos` (none by default).
 */
const setup = (
  factoryDir: string,
  status: Effect.Effect<ThreadStatus> = Effect.never,
  repos: ReadonlyArray<{ repo: string; path: string; title: string }> = [],
): Setup => {
  const archived: Array<string> = [];
  const launched = Deferred.makeUnsafe<void>();
  const archivedOne = Deferred.makeUnsafe<void>();
  const sessions = {
    findProject: (root: string) =>
      Effect.succeed(
        root === ROOT ? { id: "p", model: { instanceId: "claudeAgent", model: "m" } } : null,
      ),
    launch: () =>
      Deferred.succeed(launched, undefined).pipe(
        Effect.as({ threadId: "t1", worktreePath: null, branch: null }),
      ),
    status: () => status,
    archive: (threadId: string) =>
      Effect.sync(() => void archived.push(threadId)).pipe(
        Effect.andThen(Deferred.succeed(archivedOne, undefined)),
      ),
  } as unknown as FactorySessions["Service"];
  const layer = Runs.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(FactoryPaths, {
          baseDir: factoryDir,
          worktreesDir: factoryDir,
          factoryDir,
          machineConfigPath: NodePath.join(factoryDir, "config.yml"),
        }),
        Layer.succeed(FactorySessions, sessions),
        Layer.succeed(FactoryProcess, {
          run: () =>
            Effect.succeed({
              exitCode: 0,
              timedOut: false,
              tail: "main\n",
              stderrTail: "",
              truncated: false,
            }),
        }),
        Layer.succeed(FactoryWatchedRepos, {
          list: Effect.succeed({ repos, departed: [], unresolved: [] }),
          listAndRemember: Effect.succeed({ repos, departed: [], unresolved: [] }),
        }),
        NodeServices.layer,
      ),
    ),
  );
  return { archived, launched, archivedOne, layer };
};

/** The service over a temp factory dir that is removed however the test ends. */
const withRuns = <A, E>(
  body: (setup: Setup & { readonly factoryDir: string }) => Effect.Effect<A, E>,
  status?: Effect.Effect<ThreadStatus>,
  repos?: ReadonlyArray<{ repo: string; path: string; title: string }>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pipeline-runs-"))),
    (factoryDir) => body({ ...setup(factoryDir, status, repos), factoryDir }),
    (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
  );

describe("PipelineRuns", () => {
  it.effect("starts a run in the background and stops it: threads archived, record stopped", () =>
    withRuns(({ archived, launched, layer }) =>
      Effect.gen(function* () {
        const runs = yield* PipelineRuns;
        const started = yield* runs.start({
          pipeline: buildAndGate,
          projectRoot: ROOT,
          issue: null,
        });
        assert.strictEqual(started.status, "running");
        assert.strictEqual(started.pipelineId, "build-and-gate");
        yield* Deferred.await(launched);

        const stopped = yield* runs.stop(started.id);
        assert.strictEqual(stopped.status, "stopped");
        assert.strictEqual(stopped.reason, Runs.STOPPED);
        assert.deepStrictEqual(archived, ["t1"]);
        const detail = yield* runs.get(started.id);
        assert.deepStrictEqual(
          detail.events.map((event) => event.event),
          ["started", "entered", "outcome", "moved", "entered", "thread", "ended"],
        );
        assert.deepStrictEqual(
          (yield* runs.list("build-and-gate")).map((run) => run.id),
          [started.id],
        );
        assert.deepStrictEqual(yield* runs.list("other"), []);
      }).pipe(Effect.provide(layer)),
    ),
  );

  it.effect("refuses a root with no T3 project and an id that is not a run", () =>
    withRuns(({ layer }) =>
      Effect.gen(function* () {
        const runs = yield* PipelineRuns;
        const error = yield* Effect.flip(
          runs.start({ pipeline: buildAndGate, projectRoot: "/elsewhere", issue: null }),
        );
        assert.strictEqual(error.kind, "no-project");
        assert.strictEqual((yield* Effect.flip(runs.get("../config"))).kind, "not-found");
      }).pipe(Effect.provide(layer)),
    ),
  );

  it.effect(
    "ends a run the server lost as interrupted when it starts, and archives its threads",
    () =>
      withRuns(({ factoryDir, archived, layer }) =>
        Effect.gen(function* () {
          const runsDir = NodePath.join(factoryDir, "pipelines", "runs");
          const id = runIdFor("build-and-gate", 0, "0001");
          yield* appendEvent(recordPath(runsDir, id), 0, {
            event: "started",
            pipeline: encodePipeline(buildAndGate),
            projectRoot: ROOT,
            repo: null,
            issue: null,
          });
          yield* appendEvent(recordPath(runsDir, id), 1, {
            event: "thread",
            node: "build",
            threadId: "t-lost",
            worktree: null,
            branch: null,
          });
          const finished = runIdFor("build-and-gate", 0, "0002");
          yield* appendEvent(recordPath(runsDir, finished), 0, {
            event: "ended",
            result: "done",
            reason: null,
          });
          const run = yield* Effect.gen(function* () {
            const runs = yield* PipelineRuns;
            return yield* runs.get(id);
          }).pipe(Effect.provide(layer));
          assert.strictEqual(run.status, "interrupted");
          assert.strictEqual(run.reason, Runs.RESTARTED);
          assert.deepStrictEqual(archived, ["t-lost"]);
          assert.strictEqual((yield* readRecord(recordPath(runsDir, finished))).length, 1);
        }),
      ),
  );

  it.effect("lists a pipeline's newest runs without reading another pipeline's records", () =>
    withRuns(({ factoryDir, layer }) =>
      Effect.gen(function* () {
        const runsDir = NodePath.join(factoryDir, "pipelines", "runs");
        const ended = { event: "ended", result: "done", reason: null } as const;
        for (let n = 0; n < Runs.RUNS_LISTED + 5; n++) {
          yield* appendEvent(recordPath(runsDir, runIdFor("build", n * 1000, "0000")), n, ended);
        }
        yield* appendEvent(recordPath(runsDir, runIdFor("build-2", 0, "0000")), 0, ended);
        // A directory under a record's name: reading it as a file fails, so a list that touched it would.
        NodeFS.mkdirSync(recordPath(runsDir, runIdFor("other", 0, "0000")));
        const runs = yield* PipelineRuns.pipe(Effect.provide(layer));
        const listed = yield* runs.list("build");
        assert.strictEqual(listed.length, Runs.RUNS_LISTED);
        assert.strictEqual(listed[0]!.id, runIdFor("build", (Runs.RUNS_LISTED + 4) * 1000, "0000"));
        assert.isTrue(
          listed.every((run) => run.id.startsWith("build-") && !run.id.startsWith("build-2-")),
        );
        assert.deepStrictEqual(
          (yield* runs.list("build-2")).map((run) => run.id),
          [runIdFor("build-2", 0, "0000")],
        );
      }),
    ),
  );

  it.effect(
    "gives a run on a watched repo no tracker without a readable config, so Ask ends it stuck",
    () =>
      withRuns(
        ({ factoryDir, archivedOne, layer }) =>
          Effect.gen(function* () {
            NodeFS.writeFileSync(
              NodePath.join(factoryDir, "config.yml"),
              "gh_config_dir: /gh\nmax_concurrent_runs: 1\n",
            );
            const runs = yield* PipelineRuns;
            const started = yield* runs.start({
              pipeline: buildAndLearn,
              projectRoot: ROOT,
              issue: 12,
            });
            assert.strictEqual(started.repo, "acme/widgets");
            yield* Deferred.await(archivedOne);
            // The run is ending; a stop waits for that end and changes nothing of it.
            const run = yield* runs.stop(started.id);
            assert.strictEqual(run.status, "stuck");
            assert.strictEqual(run.reason, "Ask needs an issue on a watched repo");
          }).pipe(Effect.provide(layer)),
        Effect.succeed(settled("1. Which base?\nFACTORY-STOP: needs-info")),
        [{ repo: "acme/widgets", path: ROOT, title: "Widgets" }],
      ),
  );
  it.effect("ends a run whose executor dies as error, and archives its threads", () =>
    withRuns(
      ({ archived, archivedOne, layer }) =>
        Effect.gen(function* () {
          const runs = yield* PipelineRuns;
          const started = yield* runs.start({
            pipeline: buildAndGate,
            projectRoot: ROOT,
            issue: null,
          });
          yield* Deferred.await(archivedOne);
          const run = yield* runs.get(started.id);
          assert.strictEqual(run.status, "error");
          assert.strictEqual(run.reason, "the projection broke");
          assert.deepStrictEqual(archived, ["t1"]);
        }).pipe(Effect.provide(layer)),
      Effect.die(new Error("the projection broke")),
    ),
  );

  it.effect("picks another id when a record by the first one exists", () =>
    withRuns(({ factoryDir, layer }) =>
      Effect.gen(function* () {
        const hex = (yield* Random.nextIntBetween(0, 0xffff).pipe(Random.withSeed("s")))
          .toString(16)
          .padStart(4, "0");
        const taken = runIdFor("build-and-gate", 0, hex);
        const runsDir = NodePath.join(factoryDir, "pipelines", "runs");
        yield* appendEvent(recordPath(runsDir, taken), 0, {
          event: "ended",
          result: "done",
          reason: null,
        });
        const runs = yield* PipelineRuns;
        const started = yield* runs
          .start({ pipeline: buildAndGate, projectRoot: ROOT, issue: null })
          .pipe(Random.withSeed("s"));
        assert.notStrictEqual(started.id, taken);
        assert.strictEqual((yield* readRecord(recordPath(runsDir, taken))).length, 1);
      }).pipe(Effect.provide(layer)),
    ),
  );

  it.effect("ends its running runs as interrupted when the server stops", () =>
    withRuns(({ factoryDir, archived, launched, layer }) =>
      Effect.gen(function* () {
        const id = yield* Effect.gen(function* () {
          const runs = yield* PipelineRuns;
          const started = yield* runs.start({
            pipeline: buildAndGate,
            projectRoot: ROOT,
            issue: null,
          });
          yield* Deferred.await(launched);
          return started.id;
        }).pipe(Effect.provide(layer));
        const events = yield* readRecord(
          recordPath(NodePath.join(factoryDir, "pipelines", "runs"), id),
        );
        assert.deepStrictEqual(events.at(-1), {
          ms: 0,
          event: "ended",
          result: "interrupted",
          reason: Runs.SERVER_STOPPED,
        });
        assert.deepStrictEqual(archived, ["t1"]);
      }),
    ),
  );
});

const PROJECT_CONFIG = (instructors: string) =>
  `factory:\n  instructors: [${instructors}]\n  base: main\n  provision: []\n  gate: ["true"]\n  limits: { gate_retries: 1 }\n  autonomy: pr\n`;

/** A GitHub whose default branch holds `text` as the project config, counting the reads. */
const githubWithBase = (text: string | null) => {
  const reads = { n: 0 };
  const github = {
    baseConfig: () =>
      Effect.sync(() => {
        reads.n += 1;
        return { branch: "main", tip: "abc", text };
      }),
  } as unknown as BoundGitHub;
  return { github, reads };
};

describe("projectConfigFor", () => {
  const withRoot = <A>(body: (root: string) => Effect.Effect<A, never, FileSystem.FileSystem>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pipeline-root-"))),
      body,
      (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
    ).pipe(Effect.provide(NodeServices.layer));

  it.effect("takes the checkout's config first, and never reads the base for it", () =>
    withRoot((root) =>
      Effect.gen(function* () {
        NodeFS.mkdirSync(NodePath.join(root, ".dw"));
        NodeFS.writeFileSync(NodePath.join(root, ".dw", "config.yml"), PROJECT_CONFIG("tom"));
        const base = githubWithBase(PROJECT_CONFIG("someone"));
        const config = yield* Runs.projectConfigFor(root, base.github);
        assert.deepStrictEqual(
          Option.map(config, (c) => c.instructors),
          Option.some(["tom"]),
        );
        assert.strictEqual(base.reads.n, 0);
      }),
    ),
  );

  it.effect("falls back to the default branch's config, and to none when neither reads", () =>
    withRoot((root) =>
      Effect.gen(function* () {
        const base = githubWithBase(PROJECT_CONFIG("rawphp"));
        const fromBase = yield* Runs.projectConfigFor(root, base.github);
        assert.deepStrictEqual(
          Option.map(fromBase, (c) => c.instructors),
          Option.some(["rawphp"]),
        );
        assert.isTrue(
          Option.isNone(yield* Runs.projectConfigFor(root, githubWithBase(null).github)),
        );
        assert.isTrue(
          Option.isNone(yield* Runs.projectConfigFor(root, githubWithBase("factory: 3").github)),
        );
        assert.isTrue(Option.isNone(yield* Runs.projectConfigFor(root, null)));
      }),
    ),
  );
});
