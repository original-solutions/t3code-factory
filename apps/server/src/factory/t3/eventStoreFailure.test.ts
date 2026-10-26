import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "../../orchestration-v2/EffectOutbox.ts";
import { EventStoreAppendEventsError } from "../../orchestration-v2/EventStore.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { PersistenceSqlError } from "../../persistence/Errors.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed to create a thread"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "event-store-full" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

/** The first error in `error`'s chain of causes that `is` accepts. */
const findCause = <A>(error: unknown, is: (value: unknown) => value is A): A | undefined => {
  for (let value = error; typeof value === "object" && value !== null;) {
    if (is(value)) return value;
    value = "cause" in value ? value.cause : undefined;
  }
  return undefined;
};

// A full disk fails the append partway through a command. The command must fail with the
// SQLite condition kept, so the failure is visible where it is logged, and nothing is committed.
it.effect("a full database fails the command with the SQLite code kept on the append error", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const threadId = ThreadId.make("thread:event-store-full");
    // No free pages to reuse, and no room to grow: the event row's overflow pages cannot fit.
    yield* sql`VACUUM`;
    yield* sql`PRAGMA max_page_count = 1`;

    const failure = yield* orchestrator
      .dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-event-store-full"),
        threadId,
        projectId: ProjectId.make("project:event-store-full"),
        title: "x".repeat(256 * 1024),
        modelSelection: { instanceId, model: "gpt-5.1-codex" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      })
      .pipe(Effect.flip);

    const append = findCause(failure, Schema.is(EventStoreAppendEventsError));
    assert.ok(append, `no EventStoreAppendEventsError in ${String(failure)}`);
    const sqlError = findCause(append.cause, Schema.is(PersistenceSqlError));
    assert.equal(sqlError?.operation, "OrchestrationEventStore.appendAgentEvents:insert");
    assert.equal(sqlError?.detail, "SQLITE(13) database or disk is full");
    assert.isNull(yield* projections.getThreadShell(threadId));
  }).pipe(Effect.provide(layerTest)),
);
