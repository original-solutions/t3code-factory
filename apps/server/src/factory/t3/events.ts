import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as RuntimeLayer from "../../orchestration-v2/runtimeLayer.ts";
import { latestRun, type RunStatus } from "./sessions.ts";

/**
 * When the factory hears that a session's run changed, so it need not wait for
 * its next pass. Built on T3's event sink, called in-process.
 */

export class EventsError extends Schema.TaggedError<EventsError>()("FactoryEventsError", {
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return "Factory events failed.";
  }
}

/** The fields of a `run.created` or `run.updated` event the stream reads. */
export interface RunUpdate {
  readonly threadId: string;
  readonly id: string;
  readonly ordinal: number;
  readonly status: RunStatus;
  /** Absent for a run that never started. */
  readonly startedAt?: unknown;
}

/**
 * The thread ids from `updates` each time that thread's latest run changes status. T3 writes
 * `run.updated` for more than status, so an update that leaves the latest run and its status as
 * they were emits nothing. The latest run is chosen as `status` does, so a cancelled queued run
 * cannot hide the working one. Each run of the stream starts empty: a thread in flight emits once.
 */
export const latestRunStatusChanges = <E, R>(
  updates: Stream.Stream<RunUpdate, E, R>,
): Stream.Stream<string, E, R> =>
  Stream.suspend(() => {
    const runsByThread = new Map<string, Map<string, RunUpdate>>();
    const lastEmitted = new Map<string, string>();
    return updates.pipe(
      Stream.filterMap((update) => {
        let runs = runsByThread.get(update.threadId);
        if (runs === undefined) {
          runs = new Map();
          runsByThread.set(update.threadId, runs);
        }
        runs.set(update.id, update);
        const latest = latestRun(Array.from(runs.values()));
        if (latest === undefined) return Result.failVoid;
        // A started run outranks every lower ordinal for good.
        if (latest.startedAt !== null && latest.startedAt !== undefined) {
          for (const [id, run] of runs) {
            if (run.ordinal < latest.ordinal) runs.delete(id);
          }
        }
        const key = `${latest.id}:${latest.status}`;
        if (lastEmitted.get(update.threadId) === key) return Result.failVoid;
        lastEmitted.set(update.threadId, key);
        return Result.succeed(update.threadId);
      }),
    );
  });

export class FactoryEvents extends Context.Service<
  FactoryEvents,
  {
    /**
     * The id of a thread each time its latest run changes status. Each run of
     * the stream starts at the live position and replays no history. A stream
     * that fails ends: run it again, and let the next pass read the status
     * changes that fell in the gap, since they are never replayed.
     */
    readonly runStatusChanges: Stream.Stream<string, EventsError>;
  }
>()("t3/factory/t3/events/FactoryEvents") {}

export const make = Effect.gen(function* () {
  const sink = yield* EventSink.EventSinkV2;

  // One unfiltered live tail, not a stream per event type: a new run's first
  // status is in `run.created`, and two typed streams merged would not keep a
  // run's created and updated events in sequence order.
  const runUpdates = Stream.unwrap(
    sink.latestSequence().pipe(Effect.map((afterSequence) => sink.stream({ afterSequence }))),
  ).pipe(
    Stream.filterMap(({ event }) =>
      event.type === "run.created" || event.type === "run.updated"
        ? Result.succeed<RunUpdate>({
            threadId: event.threadId,
            id: event.payload.id,
            ordinal: event.payload.ordinal,
            status: event.payload.status,
            startedAt: event.payload.startedAt,
          })
        : Result.failVoid,
    ),
  );

  return FactoryEvents.of({
    runStatusChanges: latestRunStatusChanges(runUpdates).pipe(
      Stream.mapError((cause) => new EventsError({ cause })),
    ),
  });
});

export const layer = Layer.effect(FactoryEvents, make);

/**
 * `layer` with the event sink the application runs on: its live stream is that instance's own,
 * so a second sink would see nothing. `RuntimeLayer.layerEventSink` is the one layer value every
 * other service takes the sink from, so a build shares one instance. `server.ts` has the stores
 * it reads in scope where the factory is merged in, but does not expose the sink itself.
 */
export const layerLive = layer.pipe(Layer.provide(RuntimeLayer.layerEventSink));
