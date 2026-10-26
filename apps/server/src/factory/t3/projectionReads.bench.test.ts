// @effect-diagnostics nodeBuiltinImport:off - the database is a real file in a temp directory.
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthOrchestrationReadScope } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as Etag from "effect/http/Etag";
import * as HttpRouter from "effect/http/HttpRouter";
import * as SqlClient from "effect/sql/SqlClient";
import { describe } from "vite-plus/test";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import { Attention } from "../attention.ts";
import { FactoryLoop } from "../index.ts";
import { useTempDirs } from "../ledger/testSupport.ts";
import { PipelineRunError, PipelineRuns } from "../pipeline/runsService.ts";
import * as ServerExitService from "./exit.ts";
import { FactoryRoutes, STATUS_PATH } from "./http.ts";
import { FactoryPaths } from "./paths.ts";
import { type SeededThread, seedProjection } from "./projectionFixture.testkit.ts";
import { best, report, reportWall, timed } from "./mainThreadBlocks.testkit.ts";
import * as Sessions from "./sessions.ts";

/**
 * The factory's reads over a database the size of the personal Mac's (about 2,000 threads, 300
 * runs, 50,000 turn items): a read the loop or status page makes blocks the main thread under
 * 50 ms, and the status route answers under 250 ms. A block is the longest gap a 1 ms timer saw;
 * the best of repeated calls counts, since a loaded host preempts any single run.
 */
const THREADS = 2_000;
const RUNS = 300;
const TURN_ITEMS = 50_000;
const BLOCK_BUDGET_MS = 50;
const STATUS_BUDGET_MS = 250;
const SEED_TIMEOUT_MS = 300_000;

/**
 * Threads 1..RUNS have one run each. A fifth of the threads are archived (the multiples of 5), so
 * the runs of threads ending in 0 are at work behind an archive and must not count.
 */
const runStatus = (n: number): Sessions.RunStatus =>
  n % 10 === 0 || n % 10 === 3
    ? "running"
    : n % 10 === 7
      ? "starting"
      : n % 10 === 1
        ? "waiting"
        : "completed";

/** Threads at work and not archived: those ending in 3 or 7, among the first RUNS. */
const AT_WORK = (RUNS / 10) * 2;

const fixture = (): ReadonlyArray<SeededThread> =>
  Array.from({ length: THREADS }, (_, index): SeededThread => {
    const n = index + 1;
    const hasRun = n <= RUNS;
    return {
      archived: n % 5 === 0,
      pullRequests: n % 13 === 0,
      ...(hasRun && {
        runs: [{ ordinal: 1, status: runStatus(n) }],
        items: Math.floor(TURN_ITEMS / RUNS) + (n <= TURN_ITEMS % RUNS ? 1 : 0),
      }),
    };
  });

const tempDir = useTempDirs();

/** The fixture's payloads must be the size of the Mac's: thread 1724, run 1500, item 4913 bytes. */
const assertPayloadSizes = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const averages = (table: string) =>
    sql.unsafe<{ readonly bytes: number }>(
      `SELECT AVG(LENGTH(payload_json)) AS bytes FROM ${table}`,
    );
  for (const [table, bytes] of [
    ["orchestration_v2_projection_threads", 1724],
    ["orchestration_v2_projection_runs", 1500],
    ["orchestration_v2_projection_turn_items", 4913],
  ] as const) {
    const [row] = yield* averages(table);
    assert.approximately(row?.bytes ?? 0, bytes, bytes * 0.05, table);
  }
});

const layerBench = () =>
  Layer.mergeAll(
    Sessions.layerLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          ProjectStore.layer,
          ServerSettings.layerTest(),
          Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
          Layer.mock(ThreadManagement.ThreadManagementService)({}),
          Layer.mock(GitVcsDriver.GitVcsDriver)({}),
          NodeServices.layer,
        ),
      ),
    ),
    ProjectionStore.layer,
  ).pipe(
    Layer.provideMerge(
      SqlitePersistence.layerFromPath(NodePath.join(tempDir("bench"), "state.sqlite")).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
  );

/** Auth over the database the benchmark seeds, as in production. */
const layerEnvironmentAuth = EnvironmentAuth.layer.pipe(
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.layerIdentity),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-factory-bench-" })),
  Layer.provide(NodeServices.layer),
);

const layerRoutes = FactoryRoutes.pipe(
  Layer.provideMerge(
    HttpPlatform.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(Etag.layerWeak),
    ),
  ),
);

/** The status route behind T3's auth, its thread count read by the real sessions service. */
const statusCall = (
  sessions: Sessions.FactorySessions["Service"],
  auth: EnvironmentAuth.EnvironmentAuth["Service"],
) =>
  Effect.gen(function* () {
    const { token } = yield* auth.issueSession({ scopes: [AuthOrchestrationReadScope] });
    const dir = tempDir("factory");
    const context = Context.make(EnvironmentAuth.EnvironmentAuth, auth).pipe(
      Context.add(ServerExitService.ServerExit, ServerExitService.make(Effect.sync(() => {}))),
      Context.add(
        FactoryLoop,
        FactoryLoop.of({
          wake: Effect.void,
          awaitPass: Effect.never,
          passRunning: Effect.succeed(false),
          runningThreads: sessions.runningThreads,
          status: { state: "idle", reason: "no factory config" },
          reload: Effect.void,
          save: () => Effect.die("the benchmark does not save"),
          repoConfigs: Effect.succeed(new Map()),
          watchedRepos: Effect.succeed({ repos: [], departed: [], unresolved: [] }),
        }),
      ),
      Context.add(Attention, {
        list: () => Effect.succeed([]),
        raise: () => Effect.void,
        clear: () => Effect.void,
        passEnded: () => Effect.void,
        setNotify: () => Effect.void,
        dismiss: () => Effect.succeed([]),
      }),
      Context.add(PipelineRuns, {
        start: () => Effect.fail(new PipelineRunError({ kind: "io", message: "not benchmarked" })),
        stop: () => Effect.fail(new PipelineRunError({ kind: "io", message: "not benchmarked" })),
        list: () => Effect.fail(new PipelineRunError({ kind: "io", message: "not benchmarked" })),
        get: () => Effect.fail(new PipelineRunError({ kind: "io", message: "not benchmarked" })),
      }),
      Context.add(FactoryPaths, {
        baseDir: dir,
        worktreesDir: NodePath.join(dir, "worktrees"),
        factoryDir: dir,
        machineConfigPath: NodePath.join(dir, "config.yml"),
      }),
    );
    const { handler, dispose } = HttpRouter.toWebHandler(layerRoutes, { disableLogger: true });
    const request = () =>
      new Request(`http://127.0.0.1${STATUS_PATH}`, {
        headers: { authorization: `Bearer ${token}` },
      });
    return {
      call: Effect.tryPromise(async () => {
        const response = await handler(request(), context);
        const body = (await response.json()) as { threads?: { running: number | null } };
        assert.strictEqual(response.status, 200);
        assert.isNumber(body.threads?.running);
      }),
      dispose: Effect.promise(dispose),
    };
  });

describe("the projection reads on a database the size of the personal Mac's", () => {
  it.live(
    "keep the main thread free and the status route fast",
    () =>
      Effect.gen(function* () {
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const sessions = yield* Sessions.FactorySessions;

        reportWall("seeding the fixture", yield* timed(seedProjection(fixture())));
        yield* assertPayloadSizes;
        assert.strictEqual((yield* store.getShellSnapshot()).threads.length, THREADS * 0.8);

        assert.strictEqual(yield* sessions.runningThreads, AT_WORK);
        const running = yield* best(sessions.runningThreads);
        report("runningThreads", running);

        const pullRequests = yield* best(store.getThreadsWithPullRequests());
        report("getThreadsWithPullRequests (both PR reactors)", pullRequests);

        const status = yield* statusCall(sessions, yield* EnvironmentAuth.EnvironmentAuth);
        const route = yield* best(status.call).pipe(Effect.ensuring(status.dispose));
        report("GET /api/factory/status", route);

        // The unfiltered snapshot ThreadLaunchService's prepare loop calls. Not asserted.
        report("unfiltered getShellSnapshot()", yield* best(store.getShellSnapshot(), 3));

        assert.isBelow(running.blockMs, BLOCK_BUDGET_MS, "runningThreads blocks the main thread");
        assert.isBelow(
          pullRequests.blockMs,
          BLOCK_BUDGET_MS,
          "getThreadsWithPullRequests blocks the main thread",
        );
        assert.isBelow(route.wallMs, STATUS_BUDGET_MS, "GET /api/factory/status is slow");
      }).pipe(Effect.provide(layerEnvironmentAuth.pipe(Layer.provideMerge(layerBench())))),
    // Seeding writes about 300 MB: half a minute alone, several on a host busy with the gate.
    SEED_TIMEOUT_MS,
  );
});
