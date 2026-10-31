import {
  EventId,
  ProjectId,
  PullRequestOperationError,
  SourceControlProviderKind,
  ThreadId,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type PullRequestRef,
  type PullRequestSummary,
  type ThreadPullRequestKey,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import { PullRequestProviderError } from "@t3tools/source-control-core/server/PullRequestProvider";

import * as GitManager from "../../git/GitManager.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as PullRequestSyncReactor from "../../orchestration-v2/PullRequestSyncReactor.ts";
import * as PullRequestService from "../../pullRequest/PullRequestService.ts";
import * as ServerActivation from "../../serverActivation.ts";

// The back-off lives in upstream's PullRequestSyncReactor.ts (a listed seam); its tests live here.

const NOW = "2026-08-28T12:00:00.000Z";
const PROJECT_ID = ProjectId.make("sync-project");

type SyncCommand = Extract<
  OrchestrationV2Command,
  { readonly type: "thread.pull-request-link.sync" }
>;

interface TestThread {
  readonly id: string;
  readonly pullRequests: ReadonlyArray<ThreadPullRequestLink>;
}

const thread = (id: string, pullRequests: ReadonlyArray<ThreadPullRequestLink>): TestThread => ({
  id,
  pullRequests,
});

/** A link the reactor has never read, so it is due on every sweep. */
const makeLink = (number: number, repository = "owner/repository"): ThreadPullRequestLink => ({
  host: "github.com",
  repository,
  number,
  url: `https://github.com/${repository}/pull/${number}`,
  source: "manual",
  linkedAt: "2026-08-10T00:00:00.000Z",
  snapshot: null,
  stack: null,
});

const makeSummary = (input: PullRequestRef): PullRequestSummary => ({
  provider: SourceControlProviderKind.make("github"),
  projectId: input.projectId,
  repository: input.repository,
  number: input.number,
  title: "Pull request",
  url: `https://github.com/${input.repository}/pull/${input.number}`,
  state: "open",
  headBranch: "feature",
  baseBranch: "main",
  updatedAt: "2026-08-27T00:00:00.000Z",
});

const notFound = () =>
  new PullRequestOperationError({
    operation: "summary",
    detail: "GitHub could not find the requested resource, or the credential cannot see it.",
    reason: "not-found",
  });

interface HarnessOptions {
  readonly threads: ReadonlyArray<TestThread>;
  readonly summary: (
    input: PullRequestRef,
  ) => Effect.Effect<PullRequestSummary, PullRequestOperationError>;
  readonly stack?: () => Effect.Effect<null, PullRequestOperationError>;
}

const makeHarness = Effect.fn("makePullRequestSyncBackoffHarness")(function* (
  options: HarnessOptions,
) {
  const activation = yield* Deferred.make<void>();
  const snapshotReads = yield* Queue.unbounded<void>();
  const domainEvents = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
  const stateChanges = yield* Queue.unbounded<ThreadPullRequestKey>();
  const summaryCalls = yield* Ref.make<ReadonlyArray<PullRequestRef>>([]);
  const syncCommands = yield* Ref.make<ReadonlyArray<SyncCommand>>([]);
  const skipped: Array<Record<string, unknown>> = [];

  const logger = Logger.layer([
    Logger.make(({ message }) => {
      const [text, fields] = message as ReadonlyArray<unknown>;
      if (text === "pull request sync skipped") skipped.push(fields as Record<string, unknown>);
    }),
  ]);

  const dependencies = Layer.mergeAll(
    Layer.mock(PullRequestService.PullRequestService)({
      summary: (input) =>
        Ref.update(summaryCalls, (calls) => [...calls, input]).pipe(
          Effect.andThen(options.summary(input)),
        ),
      stack: () => options.stack?.() ?? Effect.succeed(null),
      invalidate: () => Effect.void,
      subscribeStateChanges: Effect.succeed(Stream.fromQueue(stateChanges)),
      withSharedProjectReads: (effect) => effect,
    }),
    Layer.mock(GitManager.GitManager)({
      subscribePullRequestStateChanges: Effect.succeed(Stream.empty),
    }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThreadsWithPullRequests: () =>
        Queue.offer(snapshotReads, undefined).pipe(
          Effect.as(
            options.threads.map((testThread) => ({
              id: ThreadId.make(testThread.id),
              projectId: PROJECT_ID,
              lineage: {
                parentThreadId: null,
                relationshipToParent: null,
                rootThreadId: ThreadId.make(testThread.id),
              },
              settledOverride: null,
              settledAt: null,
              pullRequests: testThread.pullRequests,
            })),
          ),
        ),
    }),
    Layer.mock(Orchestrator.OrchestratorV2)({
      dispatch: (command) =>
        command.type === "thread.pull-request-link.sync"
          ? Ref.update(syncCommands, (recorded) => [...recorded, command]).pipe(
              Effect.as({ sequence: 1, storedEvents: [] }),
            )
          : Effect.die(new Error(`Unexpected command: ${command.type}`)),
      streamDomainEvents: Stream.fromQueue(domainEvents),
    }),
    Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
    Layer.succeed(
      Crypto.Crypto,
      Crypto.make({
        randomBytes: (size) => new Uint8Array(size).fill(1),
        digest: (_algorithm, data) => Effect.succeed(data),
      }),
    ),
  );

  return {
    activation,
    snapshotReads,
    domainEvents,
    stateChanges,
    summaryCalls,
    syncCommands,
    skipped,
    layer: PullRequestSyncReactor.layer.pipe(
      Layer.provide(dependencies),
      Layer.provideMerge(logger),
    ),
  };
});

type Harness = Effect.Success<ReturnType<typeof makeHarness>>;

const start = Effect.fn("startPullRequestSyncBackoffHarness")(function* (fixture: Harness) {
  const reactor = yield* PullRequestSyncReactor.PullRequestSyncReactor;
  yield* reactor.start();
  yield* Deferred.succeed(fixture.activation, undefined);
  yield* Queue.take(fixture.snapshotReads);
  yield* reactor.drain;
  return reactor;
});

/** Runs the one-minute sweep `minutes` more times. */
const sweep = Effect.fn("sweepPullRequestSyncBackoffHarness")(function* (
  fixture: Harness,
  reactor: PullRequestSyncReactor.PullRequestSyncReactor["Service"],
  minutes = 1,
) {
  for (let minute = 0; minute < minutes; minute++) {
    yield* TestClock.adjust("1 minute");
    yield* Queue.take(fixture.snapshotReads);
    yield* reactor.drain;
  }
});

const refresh = Effect.fn("refreshPullRequestSyncBackoffHarness")(function* (
  fixture: Harness,
  reactor: PullRequestSyncReactor.PullRequestSyncReactor["Service"],
  link: ThreadPullRequestLink,
) {
  yield* reactor.requestSync(link);
  yield* Queue.take(fixture.snapshotReads);
  yield* reactor.drain;
});

/** Sends the event a link change on the thread emits, and waits for the read it asks for. */
const linkChanged = Effect.fn("linkChangedPullRequestSyncBackoffHarness")(function* (
  fixture: Harness,
  reactor: PullRequestSyncReactor.PullRequestSyncReactor["Service"],
  link: ThreadPullRequestLink,
) {
  yield* Queue.offer(fixture.domainEvents, {
    type: "thread.pull-request-link-updated",
    id: EventId.make(`event:link:${link.number}`),
    threadId: ThreadId.make("hidden"),
    occurredAt: DateTime.makeUnsafe(Date.parse(NOW)),
    payload: link,
  });
  yield* Queue.take(fixture.snapshotReads);
  yield* reactor.drain;
});

const callsFor = (fixture: Harness, number: number) =>
  Ref.get(fixture.summaryCalls).pipe(
    Effect.map((calls) => calls.filter((call) => call.number === number).length),
  );

const skippedFor = (fixture: Harness, number: number) =>
  fixture.skipped.filter((fields) => String(fields.key).endsWith(`#${number}`));

/** Runs `body` against a started reactor with the clock at NOW. */
const withReactor = (
  options: HarnessOptions,
  body: (
    fixture: Harness,
    reactor: PullRequestSyncReactor.PullRequestSyncReactor["Service"],
  ) => Effect.Effect<void, never, PullRequestSyncReactor.PullRequestSyncReactor>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(NOW));
      const fixture = yield* makeHarness(options);
      yield* Effect.gen(function* () {
        const reactor = yield* start(fixture);
        yield* body(fixture, reactor);
      }).pipe(Effect.provide(fixture.layer));
    }),
  );

const iso = (offsetMinutes: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(Date.parse(NOW) + offsetMinutes * 60_000));

describe("pull request sync for a pull request the host cannot find or the credential cannot see", () => {
  it.effect("stops reading a key after three not-found answers in a row, for good", () =>
    withReactor(
      { threads: [thread("hidden", [makeLink(719)])], summary: () => Effect.fail(notFound()) },
      (fixture, reactor) =>
        Effect.gen(function* () {
          yield* sweep(fixture, reactor, 48 * 60);

          // Read at 12:00, 12:01 and 12:03, then never again.
          assert.strictEqual(yield* callsFor(fixture, 719), 3);
          assert.deepStrictEqual(
            skippedFor(fixture, 719).map((fields) => fields.retryAt ?? fields.unreachable),
            [iso(1), iso(3), true],
          );
        }),
    ),
  );

  it.effect(
    "keeps the one-minute doubling back-off when not-found runs are broken by an answer",
    () => {
      // Not found, not found, answered, then not found.
      let call = 0;
      return withReactor(
        {
          threads: [thread("hidden", [makeLink(719)])],
          summary: (input) =>
            ++call === 3 ? Effect.succeed(makeSummary(input)) : Effect.fail(notFound()),
        },
        (fixture, reactor) =>
          Effect.gen(function* () {
            // Read at 12:00, 12:01 and 12:03 (answered). The 12:04 miss starts a new run, so
            // 12:05 and 12:07 are still read, and only 12:07 makes the key unreachable.
            yield* sweep(fixture, reactor, 60);

            assert.strictEqual(yield* callsFor(fixture, 719), 6);
            assert.deepStrictEqual(
              skippedFor(fixture, 719).map((fields) => fields.retryAt ?? fields.unreachable),
              [iso(1), iso(3), iso(5), iso(7), true],
            );
          }),
      );
    },
  );

  it.effect("starts again from the first step after the host answers", () => {
    let visible = false;
    return withReactor(
      {
        threads: [thread("hidden", [makeLink(719)])],
        summary: (input) =>
          visible ? Effect.succeed(makeSummary(input)) : Effect.fail(notFound()),
      },
      (fixture, reactor) =>
        Effect.gen(function* () {
          // Fails at 12:00 and 12:01; the next read waits for 12:03.
          yield* sweep(fixture, reactor, 2);
          assert.strictEqual(yield* callsFor(fixture, 719), 2);

          visible = true;
          yield* sweep(fixture, reactor);
          assert.strictEqual(yield* callsFor(fixture, 719), 3);

          // Hidden again at 12:04, so the next read is one minute later.
          visible = false;
          yield* sweep(fixture, reactor, 2);
          assert.strictEqual(yield* callsFor(fixture, 719), 5);
        }),
    );
  });

  it.effect(
    "starts again from the first step once the summary answers, even if the stack read fails",
    () => {
      let visible = false;
      return withReactor(
        {
          threads: [thread("hidden", [makeLink(719)])],
          summary: (input) =>
            visible ? Effect.succeed(makeSummary(input)) : Effect.fail(notFound()),
          stack: () =>
            Effect.fail(new PullRequestOperationError({ operation: "stack", detail: "flaky" })),
        },
        (fixture, reactor) =>
          Effect.gen(function* () {
            yield* sweep(fixture, reactor, 2);
            visible = true;
            yield* sweep(fixture, reactor);
            assert.strictEqual(yield* callsFor(fixture, 719), 3);

            visible = false;
            yield* sweep(fixture, reactor, 2);
            assert.strictEqual(yield* callsFor(fixture, 719), 5);
          }),
      );
    },
  );

  it.effect("starts again from the first step after any answer other than not-found", () => {
    let answer: "not-found" | "unreachable" = "not-found";
    return withReactor(
      {
        threads: [thread("hidden", [makeLink(719)])],
        summary: () =>
          Effect.fail(
            answer === "not-found"
              ? notFound()
              : new PullRequestOperationError({
                  operation: "summary",
                  detail: "Could not reach GitHub at github.com.",
                }),
          ),
      },
      (fixture, reactor) =>
        Effect.gen(function* () {
          // Not found at 12:00 and 12:01, unreachable at 12:03 and 12:04, not found at 12:05.
          yield* sweep(fixture, reactor, 2);
          answer = "unreachable";
          yield* sweep(fixture, reactor, 2);
          answer = "not-found";
          yield* sweep(fixture, reactor);

          assert.strictEqual(yield* callsFor(fixture, 719), 5);
          assert.deepStrictEqual(
            skippedFor(fixture, 719)
              .filter((fields) => "retryAt" in fields)
              .map((fields) => fields.retryAt),
            [iso(1), iso(3), iso(6)],
          );
        }),
    );
  });

  it.effect("keeps reading other pull requests, including ones in the same repository", () =>
    withReactor(
      {
        threads: [
          thread("hidden", [makeLink(719), makeLink(720)]),
          thread("other", [makeLink(5, "owner/other")]),
        ],
        summary: (input) =>
          input.number === 719 ? Effect.fail(notFound()) : Effect.succeed(makeSummary(input)),
      },
      (fixture, reactor) =>
        Effect.gen(function* () {
          yield* sweep(fixture, reactor, 10);

          assert.strictEqual(yield* callsFor(fixture, 719), 3);
          assert.strictEqual(yield* callsFor(fixture, 720), 11);
          assert.strictEqual(yield* callsFor(fixture, 5), 11);
        }),
    ),
  );

  it.effect("reads through the back-off when a refresh is requested", () => {
    let visible = false;
    const link = makeLink(719);
    return withReactor(
      {
        threads: [thread("hidden", [link])],
        summary: (input) =>
          visible ? Effect.succeed(makeSummary(input)) : Effect.fail(notFound()),
      },
      (fixture, reactor) =>
        Effect.gen(function* () {
          yield* sweep(fixture, reactor);
          // Still hidden: the refresh reads once, then the sweeps wait out the back-off again.
          yield* refresh(fixture, reactor, link);
          assert.strictEqual(yield* callsFor(fixture, 719), 3);
          yield* sweep(fixture, reactor);
          assert.strictEqual(yield* callsFor(fixture, 719), 3);

          visible = true;
          yield* refresh(fixture, reactor, link);
          assert.strictEqual(yield* callsFor(fixture, 719), 4);
          assert.deepStrictEqual(
            (yield* Ref.get(fixture.syncCommands)).map((command) => command.number),
            [719],
          );
        }),
    );
  });

  it.effect(
    "reads an unreachable key on request, and an answer brings back scheduled reads",
    () => {
      let visible = false;
      const link = makeLink(719);
      return withReactor(
        {
          threads: [thread("hidden", [link])],
          summary: (input) =>
            visible ? Effect.succeed(makeSummary(input)) : Effect.fail(notFound()),
        },
        (fixture, reactor) =>
          Effect.gen(function* () {
            // Unreachable after the 12:03 read.
            yield* sweep(fixture, reactor, 60);
            assert.strictEqual(yield* callsFor(fixture, 719), 3);

            // Still hidden: the refresh reads, and the key stays unreachable.
            yield* refresh(fixture, reactor, link);
            assert.strictEqual(yield* callsFor(fixture, 719), 4);
            yield* sweep(fixture, reactor, 60);
            // The answered refresh is spent, so a later link change does not read again.
            yield* linkChanged(fixture, reactor, link);
            assert.strictEqual(yield* callsFor(fixture, 719), 4);

            visible = true;
            yield* refresh(fixture, reactor, link);
            assert.strictEqual(yield* callsFor(fixture, 719), 5);

            // Scheduled reads are back: the harness never stores a snapshot, so every sweep reads.
            yield* sweep(fixture, reactor, 10);
            assert.strictEqual(yield* callsFor(fixture, 719), 15);
          }),
      );
    },
  );

  it.effect("leaves an unreachable key alone when the server itself asks for a read", () => {
    const link = makeLink(719);
    return withReactor(
      { threads: [thread("hidden", [link])], summary: () => Effect.fail(notFound()) },
      (fixture, reactor) =>
        Effect.gen(function* () {
          yield* sweep(fixture, reactor, 60);
          assert.strictEqual(yield* callsFor(fixture, 719), 3);

          // Any link change on the thread asks again for every link that has no snapshot yet.
          yield* linkChanged(fixture, reactor, link);
          yield* sweep(fixture, reactor, 60);

          assert.strictEqual(yield* callsFor(fixture, 719), 3);
          assert.strictEqual(skippedFor(fixture, 719).length, 3);
        }),
    );
  });

  it.effect("reads an unreachable key when a reader sees the pull request again", () => {
    let visible = false;
    return withReactor(
      {
        threads: [thread("hidden", [makeLink(719)])],
        summary: (input) =>
          visible ? Effect.succeed(makeSummary(input)) : Effect.fail(notFound()),
      },
      (fixture, reactor) =>
        Effect.gen(function* () {
          yield* sweep(fixture, reactor, 60);
          assert.strictEqual(yield* callsFor(fixture, 719), 3);

          // Access granted since: a detail read elsewhere reports the pull request's state.
          visible = true;
          yield* Queue.offer(fixture.stateChanges, {
            host: "github.com",
            repository: "owner/repository",
            number: 719,
          });
          yield* Queue.take(fixture.snapshotReads);
          yield* reactor.drain;

          assert.strictEqual(yield* callsFor(fixture, 719), 4);
          assert.deepStrictEqual(
            (yield* Ref.get(fixture.syncCommands)).map((command) => command.number),
            [719],
          );
        }),
    );
  });

  it.effect("never counts a rate-limited answer toward the not-found run", () => {
    let answers: ReadonlyArray<"not-found" | "rate-limited"> = [
      "not-found",
      "not-found",
      "rate-limited",
      "not-found",
      "not-found",
    ];
    const link = makeLink(719);
    const rateLimited = (nowMs: number) =>
      new PullRequestOperationError({
        operation: "summary",
        detail: "GitHub rate limit reached.",
        cause: new PullRequestProviderError({
          provider: SourceControlProviderKind.make("github"),
          operation: "summary",
          reason: "rate-limited",
          detail: "GitHub rate limit reached.",
          retryAt: nowMs + 60_000,
        }),
      });
    return withReactor(
      {
        threads: [thread("hidden", [link])],
        summary: () =>
          Clock.currentTimeMillis.pipe(
            Effect.flatMap((nowMs) => {
              const [answer = "not-found", ...rest] = answers;
              answers = rest;
              return Effect.fail(answer === "rate-limited" ? rateLimited(nowMs) : notFound());
            }),
          ),
      },
      (fixture, reactor) =>
        Effect.gen(function* () {
          // Not found at 12:00 and 12:01, rate-limited at 12:03, then not found at 12:04,
          // 12:05 and 12:07. Only the last three are a run.
          yield* sweep(fixture, reactor, 60);
          assert.strictEqual(yield* callsFor(fixture, 719), 6);
          assert.deepStrictEqual(
            skippedFor(fixture, 719)
              .filter((fields) => !("count" in fields))
              .map((fields) => fields.retryAt ?? fields.unreachable),
            [iso(1), iso(3), iso(5), iso(7), true],
          );

          // Once unreachable, a rate-limited refresh does not bring back scheduled reads. The
          // refresh itself is still owed an answer, so it reads once more after the limit.
          answers = ["rate-limited"];
          yield* refresh(fixture, reactor, link);
          assert.strictEqual(yield* callsFor(fixture, 719), 7);
          yield* sweep(fixture, reactor, 60);
          assert.strictEqual(yield* callsFor(fixture, 719), 8);
        }),
    );
  });

  it.effect("keeps retrying a transient failure every sweep", () =>
    withReactor(
      {
        threads: [thread("offline", [makeLink(719)])],
        summary: () =>
          Effect.fail(
            new PullRequestOperationError({
              operation: "summary",
              detail: "Could not reach GitHub at github.com.",
            }),
          ),
      },
      (fixture, reactor) =>
        Effect.gen(function* () {
          yield* sweep(fixture, reactor, 10);

          assert.strictEqual(yield* callsFor(fixture, 719), 11);
          const skipped = skippedFor(fixture, 719);
          assert.strictEqual(skipped.length, 11);
          assert.isTrue(skipped.every((fields) => !("retryAt" in fields)));
        }),
    ),
  );
});
