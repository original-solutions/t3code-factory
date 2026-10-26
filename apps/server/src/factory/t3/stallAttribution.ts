import { RotatingFileSink } from "@t3tools/shared/logging";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Tracer from "effect/Tracer";

import * as ServerConfig from "../../config.ts";
import {
  makeSpanRegistry,
  type TrackedSpanReport,
  wrapTracer,
} from "../observability/spanRegistry.ts";
import { startStallDetector } from "../observability/stallDetector.ts";
import { makeStallProfiler } from "../observability/stallProfiler.ts";

const STALL_LOG_MAX_BYTES = 256 * 1024;
const REPORTED_SPANS = 5;

// A statement reads as `sqlite[reader] (32574 ms) SELECT ...`. The connection matters: a reader
// statement's span stays open until the blocked main thread handles the worker's reply, so it
// ages by the length of a stall it did not cause, while only a writer statement can be the cause.
const listed = (label: string, spans: ReadonlyArray<TrackedSpanReport>) =>
  spans.length === 0
    ? ""
    : `; ${label}: ${spans
        .map(
          (s) =>
            `${s.name}${s.connection === undefined ? "" : `[${s.connection}]`} (${s.ageMs} ms)${s.query === undefined ? "" : ` ${s.query}`}`,
        )
        .join(", ")}`;

export interface StallAttributionOptions {
  readonly intervalMs?: number;
  readonly thresholdMs?: number;
  /**
   * Set true to CPU-profile the process after a long stall. Off by default: starting V8's
   * profiler walks every compiled code object on the main thread, and on a large heap under
   * load that walk has itself stalled the loop for 10 to 25 s, longer than the stall it was
   * meant to explain.
   */
  readonly profile?: boolean;
  /** Tests shorten these; the profiler's defaults are 5 s and 30 s. */
  readonly profileThresholdMs?: number;
  readonly profileDurationMs?: number;
}

/**
 * Wraps the Tracer in the layer's output so the factory can name the root spans and SQL statements
 * running when the event loop stalled. It writes its own warning and
 * `factory-event-loop-stalls.ndjson` and leaves upstream's EventLoopMonitor alone. Its Tracer wins
 * over `self`'s because `Layer.provideMerge` merges the receiving layer's outputs last.
 */
export const makeWithStallAttribution =
  (options: StallAttributionOptions = {}) =>
  <A, E, R>(self: Layer.Layer<A, E, R>) =>
    Layer.provideMerge(attributionLayer(options), self);

/** The opt-in for stall-triggered CPU profiles: `T3FAC_STALL_PROFILE=1` in the server's environment. */
export const stallProfileOptedIn = (env: Record<string, string | undefined>) =>
  env.T3FAC_STALL_PROFILE === "1";

export const withStallAttribution = makeWithStallAttribution({
  profile: stallProfileOptedIn(globalThis.process.env),
});

const attributionLayer = (options: StallAttributionOptions) =>
  Layer.effect(
    Tracer.Tracer,
    Effect.gen(function* () {
      const base = yield* Tracer.Tracer;
      const { serverTracePath } = yield* ServerConfig.ServerConfig;
      const path = yield* Path.Path;
      const services = yield* Effect.context<never>();
      const runFork = Effect.runForkWith(services);
      const logsDir = path.dirname(serverTracePath);
      const filePath = path.join(logsDir, "factory-event-loop-stalls.ndjson");

      const registry = makeSpanRegistry();
      const sink = yield* Effect.try(
        () =>
          new RotatingFileSink({
            filePath,
            maxBytes: STALL_LOG_MAX_BYTES,
            maxFiles: 1,
            throwOnError: true,
          }),
      ).pipe(
        Effect.catch(() =>
          Effect.logWarning("factory event loop stall log unavailable", { filePath }).pipe(
            Effect.as(undefined),
          ),
        ),
      );
      const profileOnStall =
        options.profile !== true
          ? undefined
          : makeStallProfiler({
              dir: path.join(logsDir, "stall-profiles"),
              ...(options.profileThresholdMs !== undefined && {
                thresholdMs: options.profileThresholdMs,
              }),
              ...(options.profileDurationMs !== undefined && {
                durationMs: options.profileDurationMs,
              }),
              onWritten: (file) =>
                void runFork(Effect.logInfo("factory stall profile written", { file })),
              onError: (error) =>
                void runFork(
                  Effect.logWarning("factory stall profile failed", { error: String(error) }),
                ),
            });

      yield* Effect.acquireRelease(
        Effect.sync(() =>
          startStallDetector({
            intervalMs: options.intervalMs ?? 250,
            thresholdMs: options.thresholdMs ?? 2000,
            onStall: ({ stallMs, windowStartMs, windowEndMs }) => {
              const spans = registry.active(windowStartMs, windowEndMs, REPORTED_SPANS);
              const oldestInFlight = registry.oldestInFlight(windowEndMs, REPORTED_SPANS);
              // Started first so the record can say whether this stall began a profile. The
              // log scan reads that to tell a profile's own stall from the one that caused it.
              const profiled = profileOnStall?.(stallMs) ?? false;
              if (sink !== undefined) {
                try {
                  sink.write(
                    `${JSON.stringify({ time: DateTime.formatIso(DateTime.nowUnsafe()), stallMs, profiled, spans, oldestInFlight })}\n`,
                  );
                } catch {
                  runFork(
                    Effect.logWarning("factory event loop stall log write failed", { filePath }),
                  );
                }
              }
              runFork(
                Effect.logWarning(
                  `factory event loop stalled for ${stallMs} ms${listed("during the stall", spans)}${listed("oldest in flight", oldestInFlight)}`,
                  { stallMs, profiled, spans, oldestInFlight },
                ),
              );
            },
          }),
        ),
        (stop) => Effect.sync(stop),
      );

      return wrapTracer(base, registry);
    }),
  );
