// @effect-diagnostics nodeBuiltinImport:off - the database is a real file in a temp directory.
import * as NodePath from "node:path";

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
      ),
    ),
    Layer.provideMerge(
      SqlitePersistence.layerFromPath(NodePath.join(tempDir("activity"), "state.sqlite")).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
  );

/** Appends an agent event of `threadId` that happened at `occurredAt`, as the event store writes one. */
const event = (id: string, threadId: string, version: number, occurredAt: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
        actor_kind, payload_json, metadata_json, application_event_version
      )
      VALUES (
        ${id}, 'thread', ${threadId}, ${version}, 'turn-item.updated', ${occurredAt},
        'server', '{}', '{}', 2
      )
    `;
  });

describe("FactorySessions.lastActivity", () => {
  it.effect("is when the thread's newest event happened, not another thread's", () =>
    Effect.gen(function* () {
      yield* event("e1", "thread-1", 1, "2026-10-31T01:00:00.000Z");
      yield* event("e2", "thread-1", 2, "2026-10-31T01:05:00.000Z");
      yield* event("e3", "thread-2", 1, "2026-10-31T02:00:00.000Z");
      const sessions = yield* Sessions.FactorySessions;
      assert.strictEqual(
        yield* sessions.lastActivity("thread-1"),
        Date.parse("2026-10-31T01:05:00.000Z"),
      );
      assert.isNull(yield* sessions.lastActivity("thread-3"));
    }).pipe(Effect.provide(layerSessions())),
  );

  it.effect("fails as a sessions error when the events cannot be read", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DROP TABLE orchestration_events`;
      const error = yield* Effect.flip((yield* Sessions.FactorySessions).lastActivity("thread-1"));
      assert.strictEqual(error.operation, "last-activity");
    }).pipe(Effect.provide(layerSessions())),
  );
});
