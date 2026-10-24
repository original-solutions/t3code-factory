// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Random from "effect/Random";
import { describe } from "vite-plus/test";

import { FactoryProcess } from "../process.ts";
import { FactoryPaths } from "../t3/paths.ts";
import { FactorySessions } from "../t3/sessions.ts";
import { FactoryWatchedRepos } from "../t3/watchedRepos.ts";
import { buildAndGate } from "./fixtures.ts";
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

/** The service over a temp factory dir, with sessions whose runs never settle unless `status` says. */
const setup = (factoryDir: string, status: Effect.Effect<never> = Effect.never): Setup => {
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
          list: Effect.succeed({ repos: [], departed: [], unresolved: [] }),
          listAndRemember: Effect.succeed({ repos: [], departed: [], unresolved: [] }),
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
  status?: Effect.Effect<never>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pipeline-runs-"))),
    (factoryDir) => body({ ...setup(factoryDir, status), factoryDir }),
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

  it.effect("ends a run the server lost as interrupted when it starts", () =>
    withRuns(({ factoryDir, layer }) =>
      Effect.gen(function* () {
        const id = runIdFor("build-and-gate", 0, "0001");
        yield* appendEvent(recordPath(NodePath.join(factoryDir, "pipelines", "runs"), id), 0, {
          event: "started",
          pipeline: encodePipeline(buildAndGate),
          projectRoot: ROOT,
          repo: null,
          issue: null,
        });
        const run = yield* Effect.gen(function* () {
          const runs = yield* PipelineRuns;
          return yield* runs.get(id);
        }).pipe(Effect.provide(layer));
        assert.strictEqual(run.status, "interrupted");
        assert.strictEqual(run.reason, "the server restarted");
      }),
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
