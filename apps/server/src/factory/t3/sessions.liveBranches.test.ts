// @effect-diagnostics nodeBuiltinImport:off - the database is a real file in a temp directory.
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { describe } from "vite-plus/test";

import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import { useTempDirs } from "../ledger/testSupport.ts";
import { seedProjection } from "./projectionFixture.testkit.ts";
import * as Sessions from "./sessions.ts";

const tempDir = useTempDirs();

const layerSessions = () =>
  Sessions.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        ProjectStore.layer,
        ServerSettings.layerTest(),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
        Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
        Layer.mock(ThreadManagement.ThreadManagementService)({}),
        Layer.mock(GitVcsDriver.GitVcsDriver)({}),
        NodeServices.layer,
        NodeCrypto.layerSecureRandom,
      ),
    ),
    Layer.provideMerge(
      SqlitePersistence.layerFromPath(NodePath.join(tempDir("branches"), "state.sqlite")).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
  );

describe("FactorySessions.liveBranches", () => {
  it.effect("names the branches of threads that are neither archived nor deleted", () =>
    Effect.gen(function* () {
      yield* seedProjection([
        { branch: "t3/live" },
        { branch: "t3/shared" },
        { branch: "t3/shared" },
        { branch: "t3/archived", archived: true },
        { branch: "t3/deleted", deleted: true },
        {},
      ]).pipe(Effect.provide(ProjectionStore.layer));
      const branches = yield* (yield* Sessions.FactorySessions).liveBranches;
      assert.deepStrictEqual([...branches].sort(), ["t3/live", "t3/shared"]);
    }).pipe(Effect.provide(layerSessions())),
  );

  it.effect("fails as a sessions error when the threads cannot be read", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DROP TABLE orchestration_v2_projection_threads`;
      const error = yield* Effect.flip((yield* Sessions.FactorySessions).liveBranches);
      assert.strictEqual(error.operation, "live-branches");
    }).pipe(Effect.provide(layerSessions())),
  );
});
