// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe } from "vite-plus/test";

import { FactoryProcess } from "../process.ts";
import { FactoryPaths } from "../t3/paths.ts";
import { FactorySessions } from "../t3/sessions.ts";
import { FactoryWatchedRepos } from "../t3/watchedRepos.ts";
import { buildAndGate } from "./fixtures.ts";
import { encodePipeline } from "./model.ts";
import { appendEvent, recordPath, runIdFor } from "./record.ts";
import * as Runs from "./runs.ts";
import { PipelineRuns } from "./runsService.ts";

const ROOT = "/work/widgets";

type Setup = {
  readonly archived: Array<string>;
  readonly launched: Deferred.Deferred<void>;
  readonly layer: Layer.Layer<PipelineRuns>;
};

/** The service over a temp factory dir, with sessions whose runs never settle. */
const setup = (factoryDir: string): Setup => {
  const archived: Array<string> = [];
  const launched = Deferred.makeUnsafe<void>();
  const sessions = {
    findProject: (root: string) =>
      Effect.succeed(
        root === ROOT ? { id: "p", model: { instanceId: "claudeAgent", model: "m" } } : null,
      ),
    launch: () =>
      Deferred.succeed(launched, undefined).pipe(
        Effect.as({ threadId: "t1", worktreePath: null, branch: null }),
      ),
    status: () => Effect.never,
    archive: (threadId: string) => Effect.sync(() => void archived.push(threadId)),
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
  return { archived, launched, layer };
};

/** The service over a temp factory dir that is removed however the test ends. */
const withRuns = <A, E>(
  body: (setup: Setup & { readonly factoryDir: string }) => Effect.Effect<A, E>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pipeline-runs-"))),
    (factoryDir) => body({ ...setup(factoryDir), factoryDir }),
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
});
