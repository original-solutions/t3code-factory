// @effect-diagnostics nodeBuiltinImport:off - the tests read the stall log the layer writes.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import * as Tracer from "effect/Tracer";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import * as ServerConfig from "../../config.ts";
import { useTempDirs } from "../ledger/testSupport.ts";
import type { TrackedSpanReport } from "../observability/spanRegistry.ts";
import {
  makeWithStallAttribution,
  stallProfileOptedIn,
  withStallAttribution,
} from "./stallAttribution.ts";

const tempDir = useTempDirs();

/** Blocks this thread for `ms` without reading a clock. */
const blockThread = (ms: number) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

interface StallRecord {
  readonly time: string;
  readonly stallMs: number;
  readonly profiled: boolean;
  readonly spans: ReadonlyArray<TrackedSpanReport>;
  readonly oldestInFlight: ReadonlyArray<TrackedSpanReport>;
}

/** The records in the logs directory's factory-event-loop-stalls.ndjson, in order. */
const stallRecords = (logsDir: string): Array<StallRecord> =>
  NodeFS.readFileSync(NodePath.join(logsDir, "factory-event-loop-stalls.ndjson"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as StallRecord);

const serverConfig = (logsDir: string) =>
  Layer.succeed(ServerConfig.ServerConfig, {
    serverTracePath: NodePath.join(logsDir, "server.trace.ndjson"),
  } as ServerConfig.ServerConfig["Service"]);

describe("withStallAttribution", () => {
  it.effect("replaces the Tracer the decorated layer provides", () =>
    Effect.gen(function* () {
      const base = yield* Effect.service(Tracer.Tracer);
      const seen = yield* Effect.service(Tracer.Tracer).pipe(
        Effect.provide(
          withStallAttribution(Layer.succeed(Tracer.Tracer, base)).pipe(
            Layer.provide(serverConfig(tempDir())),
          ),
        ),
        Effect.scoped,
      );
      assert.notStrictEqual(seen, base);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "names the spans in flight during a stall in the warning and in factory-event-loop-stalls.ndjson, even one that ended before detection",
    () =>
      Effect.gen(function* () {
        const logsDir = tempDir();
        const base = yield* Effect.service(Tracer.Tracer);
        const decorated = makeWithStallAttribution({
          intervalMs: 10,
          thresholdMs: 100,
          profile: false,
        })(Layer.succeed(Tracer.Tracer, base));
        const warned = yield* Deferred.make<string>();
        const capture = Logger.make<unknown, void>(({ message }) => {
          const text = String(Array.isArray(message) ? message[0] : message);
          if (text.startsWith("factory event loop stalled"))
            Deferred.doneUnsafe(warned, Effect.succeed(text));
        });
        const warning = yield* Effect.gen(function* () {
          yield* Effect.sync(() => blockThread(250)).pipe(
            Effect.withSpan("ThreadLaunchService.prepareInBackground", { root: true }),
          );
          return yield* Deferred.await(warned);
        }).pipe(
          Effect.provide(
            decorated.pipe(
              Layer.provide(Layer.merge(Logger.layer([capture]), serverConfig(logsDir))),
            ),
          ),
          Effect.scoped,
        );
        assert.include(warning, "ThreadLaunchService.prepareInBackground");

        const lines = NodeFS.readFileSync(
          NodePath.join(logsDir, "factory-event-loop-stalls.ndjson"),
          "utf8",
        )
          .trim()
          .split("\n");
        assert.strictEqual(lines.length, 1);
        const record = JSON.parse(lines[0]!);
        assert.isAtLeast(record.stallMs, 200);
        assert.strictEqual(typeof record.time, "string");
        assert.include(
          record.spans.map((s: { name: string }) => s.name),
          "ThreadLaunchService.prepareInBackground",
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "names the child span that blocked, not the long-lived spans that were already open",
    () =>
      Effect.gen(function* () {
        const logsDir = tempDir();
        const base = yield* Effect.service(Tracer.Tracer);
        const decorated = makeWithStallAttribution({
          intervalMs: 10,
          thresholdMs: 100,
          profile: false,
        })(Layer.succeed(Tracer.Tracer, base));
        const warnings = [yield* Deferred.make<string>(), yield* Deferred.make<string>()];
        let warned = 0;
        const capture = Logger.make<unknown, void>(({ message }) => {
          const text = String(Array.isArray(message) ? message[0] : message);
          if (text.startsWith("factory event loop stalled"))
            Deferred.doneUnsafe(warnings[warned++]!, Effect.succeed(text));
        });
        const warning = yield* Effect.gen(function* () {
          // Connection and worker spans that never end, as in a server that has been up a while.
          for (let i = 0; i < 6; i += 1) yield* Effect.makeSpan(`http.server GET /ws ${i}`);
          // The first stall puts a detector tick after those spans started.
          yield* Effect.sync(() => blockThread(150));
          yield* Deferred.await(warnings[0]!);
          yield* Effect.sync(() => blockThread(250)).pipe(
            Effect.withSpan("PullRequestSyncReactor.sweep"),
            Effect.withSpan("PullRequestSyncReactor.run"),
          );
          return yield* Deferred.await(warnings[1]!);
        }).pipe(
          Effect.provide(
            decorated.pipe(
              Layer.provide(Layer.merge(Logger.layer([capture]), serverConfig(logsDir))),
            ),
          ),
          Effect.scoped,
        );
        assert.include(warning, "during the stall: PullRequestSyncReactor.sweep (");
        assert.include(warning, "oldest in flight: http.server GET /ws 0 (");

        const lines = NodeFS.readFileSync(
          NodePath.join(logsDir, "factory-event-loop-stalls.ndjson"),
          "utf8",
        )
          .trim()
          .split("\n");
        assert.strictEqual(lines.length, 2);
        const record = JSON.parse(lines[1]!);
        assert.strictEqual(record.spans[0].name, "PullRequestSyncReactor.sweep");
        assert.deepStrictEqual(
          record.oldestInFlight.map((s: { name: string }) => s.name),
          [0, 1, 2, 3, 4].map((i) => `http.server GET /ws ${i}`),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "tags each sqlite statement in flight with the connection it ran on, reader or writer",
    () =>
      Effect.gen(function* () {
        const logsDir = tempDir();
        const base = yield* Effect.service(Tracer.Tracer);
        const sql = yield* SqlClient.SqlClient;
        // Enough rows to hold a thread past the stall threshold on any machine. The alias names
        // the connection the statement is meant for, so the test can find it in the report.
        const count = (rows: number, alias: "reader_rows" | "writer_rows") =>
          sql.unsafe<{ readonly n: number }>(
            `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ${rows})
             SELECT COUNT(*) AS ${alias} FROM c`,
          );
        // The reader worker refuses a database that is not in WAL mode, which the server's
        // persistence layer sets, and the first read brings the worker up. Both can stall under
        // load, so they run before the detector starts.
        yield* sql`PRAGMA journal_mode = WAL`;
        yield* count(1, "reader_rows").pipe(NodeSqliteClient.readOnly);

        // Resolves once the client has put a statement on the reader, so the writer's statement
        // blocks the loop while the reader's is in flight on its worker.
        const readerAcquired = yield* Deferred.make<void>();
        const observing: Tracer.Tracer = {
          span(options) {
            const span = base.span(options);
            const attribute = span.attribute;
            span.attribute = function (key, value) {
              if (key === "db.connection" && value === "reader")
                Deferred.doneUnsafe(readerAcquired, Effect.void);
              return attribute.call(this, key, value);
            };
            return span;
          },
          context: base.context,
        };
        const decorated = makeWithStallAttribution({ intervalMs: 10, thresholdMs: 100 })(
          Layer.succeed(Tracer.Tracer, observing),
        );
        // The writer's statement ends inside the stall it causes, so the warning that names it is
        // that stall's, whatever else paused the loop before.
        const warned = yield* Deferred.make<string>();
        const capture = Logger.make<unknown, void>(({ message }) => {
          const text = String(Array.isArray(message) ? message[0] : message);
          if (text.startsWith("factory event loop stalled") && text.includes("writer_rows"))
            Deferred.doneUnsafe(warned, Effect.succeed(text));
        });
        const warning = yield* Effect.gen(function* () {
          const reader = yield* Effect.forkChild(
            count(8_000_000, "reader_rows").pipe(NodeSqliteClient.readOnly),
          );
          yield* Deferred.await(readerAcquired);
          // Inside a transaction the statement runs on the transaction's connection, which the
          // client names on the sql.transaction span, not on the statement's. Most writes run so,
          // under a service span of their own.
          yield* sql.withTransaction(
            count(8_000_000, "writer_rows").pipe(Effect.withSpan("EventSink.commit")),
          );
          yield* Fiber.join(reader);
          return yield* Deferred.await(warned);
        }).pipe(
          Effect.provide(
            decorated.pipe(
              Layer.provide(Layer.merge(Logger.layer([capture]), serverConfig(logsDir))),
            ),
          ),
          Effect.scoped,
        );
        assert.include(warning, "sqlite[writer] (");
        assert.include(warning, "sqlite[reader] (");
        assert.notInclude(warning, "EventSink.commit[");

        const record = stallRecords(logsDir).find((r) =>
          r.spans.some((span) => span.query?.includes("writer_rows")),
        );
        const connections = record!.spans
          .filter((span) => span.name === "sqlite")
          .map((span) => span.connection);
        assert.include(connections, "writer");
        assert.include(connections, "reader");
      }).pipe(
        // The server's Observability layer keeps a statement's span current while it runs, which
        // is what lets the client annotate the connection on it.
        Effect.provideService(Statement.SpanPropagationEnabled, true),
        Effect.provide(
          Layer.merge(
            NodeServices.layer,
            NodeSqliteClient.layer({
              filename: NodePath.join(tempDir(), "state.sqlite"),
              readerWorker: true,
            }),
          ),
        ),
        Effect.scoped,
      ),
  );

  it.effect("profiles the process into stall-profiles/ after a long stall when opted in", () =>
    Effect.gen(function* () {
      const logsDir = tempDir();
      const base = yield* Effect.service(Tracer.Tracer);
      const decorated = makeWithStallAttribution({
        intervalMs: 10,
        thresholdMs: 100,
        profile: true,
        profileThresholdMs: 200,
        profileDurationMs: 50,
      })(Layer.succeed(Tracer.Tracer, base));
      const written = yield* Deferred.make<void>();
      const capture = Logger.make<unknown, void>(({ message }) => {
        const text = String(Array.isArray(message) ? message[0] : message);
        if (text === "factory stall profile written") Deferred.doneUnsafe(written, Effect.void);
      });
      yield* Effect.gen(function* () {
        yield* Effect.sync(() => blockThread(250));
        yield* Deferred.await(written);
      }).pipe(
        Effect.provide(
          decorated.pipe(
            Layer.provide(Layer.merge(Logger.layer([capture]), serverConfig(logsDir))),
          ),
        ),
        Effect.scoped,
      );
      const profiles = NodeFS.readdirSync(NodePath.join(logsDir, "stall-profiles"));
      assert.strictEqual(profiles.length, 1);
      assert.match(profiles[0]!, /\.cpuprofile$/);
      assert.strictEqual(stallRecords(logsDir)[0]?.profiled, true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "does not profile by default: a long stall starts no profile and the record says so",
    () =>
      Effect.gen(function* () {
        const logsDir = tempDir();
        const base = yield* Effect.service(Tracer.Tracer);
        const decorated = makeWithStallAttribution({
          intervalMs: 10,
          thresholdMs: 100,
          profileThresholdMs: 200,
          profileDurationMs: 5,
        })(Layer.succeed(Tracer.Tracer, base));
        const warned = yield* Deferred.make<void>();
        const capture = Logger.make<unknown, void>(({ message }) => {
          const text = String(Array.isArray(message) ? message[0] : message);
          if (text.startsWith("factory event loop stalled"))
            Deferred.doneUnsafe(warned, Effect.void);
        });
        yield* Effect.gen(function* () {
          yield* Effect.sync(() => blockThread(250));
          yield* Deferred.await(warned);
        }).pipe(
          Effect.provide(
            decorated.pipe(
              Layer.provide(Layer.merge(Logger.layer([capture]), serverConfig(logsDir))),
            ),
          ),
          Effect.scoped,
        );
        const record = stallRecords(logsDir)[0]!;
        assert.isAtLeast(record.stallMs, 200);
        assert.strictEqual(record.profiled, false);
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("stallProfileOptedIn", () => {
  it("is on only when T3FAC_STALL_PROFILE is 1", () => {
    assert.isTrue(stallProfileOptedIn({ T3FAC_STALL_PROFILE: "1" }));
    assert.isFalse(stallProfileOptedIn({ T3FAC_STALL_PROFILE: "0" }));
    assert.isFalse(stallProfileOptedIn({ T3FAC_STALL_PROFILE: "" }));
    assert.isFalse(stallProfileOptedIn({}));
  });
});
