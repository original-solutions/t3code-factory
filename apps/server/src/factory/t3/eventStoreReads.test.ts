// @effect-diagnostics nodeBuiltinImport:off - the database is a real file in a temp directory.
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe } from "vite-plus/test";

import * as OrchestrationEventStore from "../../persistence/OrchestrationEventStore.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { useTempDirs } from "../ledger/testSupport.ts";
import { connectionsOf } from "./spanConnections.testkit.ts";

const tempDir = useTempDirs();

/** The event store over a real database file, so the reader worker is on, as in production. */
const layerEventStore = () =>
  OrchestrationEventStore.layer.pipe(
    Layer.provideMerge(
      SqlitePersistence.layerFromPath(NodePath.join(tempDir("events"), "state.sqlite")).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
  );

// The factory reads the high-water mark on every pass. The stall log lists it beside long stalls
// because a reader span stays open until the blocked main thread handles the worker's reply; the
// proof that it is a bystander, not the blocker, is the connection the statement ran on.
describe("OrchestrationEventStore.latestApplicationSequence", () => {
  it.effect("reads the high-water mark on the reader connection, off the event loop", () =>
    Effect.gen(function* () {
      const { latestApplicationSequence } = yield* OrchestrationEventStore.OrchestrationEventStore;
      assert.strictEqual(yield* latestApplicationSequence, 0);
      assert.deepStrictEqual(yield* connectionsOf(latestApplicationSequence), new Set(["reader"]));
    }).pipe(Effect.provide(layerEventStore())),
  );
});
