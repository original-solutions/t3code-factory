/**
 * The executor's ports over the real factory: T3 sessions for threads, the process runner for
 * commands, the GitHub tracker for questions and pull requests, and the run record on disk.
 * Settlement and the tracker are polled; the factory's own runs are woken by the event stream,
 * which a prototype pipeline run does without.
 */
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import { formatTs } from "../ledger/time.ts";
import type { FactoryProcess } from "../process.ts";
import { prepareSessionText, questionsComment } from "../runner/messages.ts";
import type { FactorySessions, Model, RunStatus } from "../t3/sessions.ts";
import { MARKER, type BoundGitHub, type Feedback } from "../tracker/github.ts";
import { PortError, type Ports, type Tracker } from "./execute.ts";
import { appendEvent } from "./record.ts";

/**
 * A run in one of these is done with its turn: what it said is final until the next message.
 * `waiting` is not: a turn that stopped for input or an approval waits for a person in T3, as the
 * factory's own runs do, since a message sent to it would only join that same run.
 */
const SETTLED: ReadonlySet<RunStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "rolled_back",
]);

const SETTLE_POLL = "10 seconds";
const TRACKER_POLL = "60 seconds";
/** The most command output a gate outcome carries: the end, where the error is. */
const OUTPUT_TAIL = 8000;
/** Failed reads of a thread in a row that a settle rides out before the run ends with the error. */
export const MAX_READ_FAILURES = 10;
/**
 * How long the waits on a person (an answer, the pull request) keep failing to read GitHub before
 * the run ends with the error. Such a wait can last days, and an outage or an expired login of
 * minutes must not end it, so the cap is a span of failing, not a count of polls.
 */
const TRACKER_PATIENCE: Duration.Input = "4 hours";

/** When a poll gives up: after this many failed reads in a row, or after failing for this long. */
type Patience = { readonly failures: number } | { readonly failingFor: Duration.Input };

const portError = (error: { readonly message: string }) =>
  new PortError({ message: error.message });

/** `ms` as GitHub writes a time, `YYYY-MM-DDTHH:MM:SSZ`, so the two compare as text. */
const utcSecond = (ms: number): string => `${formatTs(ms).slice(0, 19)}Z`;

/** The second before `time`, a GitHub time, so a read from it includes `time`'s own second. */
const secondBefore = (time: string): string => utcSecond(Date.parse(time) - 1000);

const tail = (text: string): string =>
  text.length > OUTPUT_TAIL ? `[cut]\n${text.slice(text.length - OUTPUT_TAIL)}` : text;

/**
 * Runs `attempt` every `every` until it answers a value. A failed read is logged and tried again
 * at the next poll, until the `patience` runs out; then the wait ends as a `PortError`.
 */
const poll = Effect.fn("PipelineLive.poll")(function* <A, E extends { readonly message: string }>(
  what: string,
  every: Duration.Input,
  attempt: Effect.Effect<A | undefined, E>,
  patience: Patience,
) {
  let failures = 0;
  let failingSince: number | null = null;
  while (true) {
    const result = yield* Effect.result(attempt);
    if (Result.isSuccess(result)) {
      if (result.success !== undefined) return result.success;
      failures = 0;
      failingSince = null;
    } else {
      failures += 1;
      const now = yield* Clock.currentTimeMillis;
      failingSince ??= now;
      const message = `${what} failed: ${result.failure.message}`;
      if ("failures" in patience) {
        if (failures >= patience.failures) {
          return yield* new PortError({ message: `${message} (${failures} times in a row)` });
        }
      } else if (now - failingSince >= Duration.toMillis(patience.failingFor)) {
        const minutes = Math.round((now - failingSince) / 60_000);
        return yield* new PortError({ message: `${message} (for ${minutes} minutes)` });
      }
      yield* Effect.logWarning(message);
    }
    yield* Effect.sleep(every);
  }
});

export interface LiveInput {
  readonly runId: string;
  readonly projectId: string;
  readonly model: Model;
  /** The branch a thread with no run branch to start from starts from. */
  readonly base: string;
  readonly recordPath: string;
  readonly sessions: FactorySessions["Service"];
  readonly process: FactoryProcess["Service"];
  readonly tracker: Tracker | null;
}

export const livePorts = (input: LiveInput): Ports => {
  const { sessions, process } = input;
  let commands = 0;
  const commandId = (what: string) => `pipeline:${input.runId}:${what}:${++commands}`;
  /** The ordinal of the run each thread last settled, so a settle waits for the run after it. */
  const settledOrdinal = new Map<string, number>();

  const settle: Ports["settle"] = Effect.fn("PipelineLive.settle")(function* (threadId) {
    const settled = yield* poll(
      `reading thread ${threadId}`,
      SETTLE_POLL,
      sessions.status(threadId).pipe(
        Effect.map((status) => {
          if (status.archived) return { archived: true } as const;
          const ordinal = status.runOrdinal;
          const newer =
            status.run !== null &&
            SETTLED.has(status.run) &&
            ordinal !== null &&
            ordinal > (settledOrdinal.get(threadId) ?? Number.NEGATIVE_INFINITY);
          return newer ? ({ archived: false, status, ordinal } as const) : undefined;
        }),
      ),
      { failures: MAX_READ_FAILURES },
    );
    if (settled.archived) {
      return yield* new PortError({ message: `thread ${threadId} was archived` });
    }
    settledOrdinal.set(threadId, settled.ordinal);
    return {
      text: settled.status.lastAssistantMessage,
      worktree: settled.status.worktreePath,
      branch: settled.status.branch,
    };
  });

  return {
    launch: (request) =>
      sessions
        .launch({
          commandId: commandId("launch"),
          projectId: input.projectId,
          title: request.title,
          baseRef: request.fromBranch ?? input.base,
          startFromOrigin: false,
          message: request.message,
          model: input.model,
        })
        .pipe(
          Effect.map((launched) => ({
            threadId: launched.threadId,
            worktree: launched.worktreePath,
            branch: launched.branch,
          })),
          Effect.mapError(portError),
        ),
    send: (threadId, message) =>
      sessions.send(threadId, commandId("send"), message).pipe(Effect.mapError(portError)),
    settle,
    archive: (threadId) => sessions.archive(threadId).pipe(Effect.mapError(portError)),
    commands: Effect.fn("PipelineLive.commands")(function* (lines, cwd) {
      let output = "";
      for (const line of lines) {
        const result = yield* process
          .run({ command: line, shell: true, cwd })
          .pipe(Effect.mapError(portError));
        output += `$ ${line}\n${result.tail}`;
        if (result.timedOut || result.exitCode !== 0) {
          const how = result.timedOut ? "timed out" : `exited ${result.exitCode ?? "by a signal"}`;
          return { ok: false, output: tail(`${output}\n[${how}]`) };
        }
      }
      return { ok: true, output: tail(output) };
    }),
    tracker: input.tracker,
    record: (event) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((ms) => appendEvent(input.recordPath, ms, event)),
        Effect.mapError(portError),
      ),
  };
};

const feedbackText = (items: ReadonlyArray<Feedback>): string =>
  items
    .map((item) => {
      const inline = item.inline.map(
        (comment) =>
          `- ${comment.path}${comment.line === null ? "" : `:${comment.line}`}: ${comment.body}`,
      );
      return [`${item.author}:`, item.body, ...inline].filter((line) => line !== "").join("\n");
    })
    .join("\n\n");

export interface LiveTrackerInput {
  readonly github: BoundGitHub;
  readonly issue: number;
  /** Whose answers, approvals and pull request feedback count. Never empty: see `runs.ts`. */
  readonly instructors: ReadonlyArray<string>;
}

/** What the tracker remembers of a pull request between waits. */
interface PullState {
  /** The time of the newest feedback told, or when the pull request was marked ready. */
  since: string;
  /** The ids told at `since`: GitHub times are to the second, so a later read includes that second. */
  readonly told: Set<string>;
  baseTip: string | null;
}

/**
 * The issue and its pull requests on GitHub. Questions move the issue to `factory:needs-info`;
 * an instructor's `factory:ready` after them is the answer, and moves it to `factory:building`.
 * A pull request's feedback is read from the moment it was marked ready, and each feedback
 * outcome moves that moment on, so nothing is told twice and nothing said meanwhile is lost.
 * Reads in the waits ride out failures (see `poll`); writes fail at once.
 */
export const liveTracker = (input: LiveTrackerInput): Tracker => {
  const { github, issue, instructors } = input;
  let askedAt: string | null = null;
  const pulls = new Map<number, PullState>();

  const baseTipOf = (pr: number) =>
    github
      .pullRequest(pr)
      .pipe(
        Effect.flatMap((pull) =>
          pull === null ? Effect.succeed(null) : github.branchTip(pull.baseRef),
        ),
      );

  /** The next thing that happened on the pull request, or undefined when nothing has. */
  const lookAt = Effect.fn("PipelineTracker.lookAt")(function* (pr: number, state: PullState) {
    const pull = yield* github.pullRequest(pr);
    if (pull === null) return { port: "closed", detail: `pull request #${pr} is gone` } as const;
    if (pull.merged) return { port: "merged", detail: null } as const;
    if (!pull.open) return { port: "closed", detail: null } as const;
    const from = secondBefore(state.since);
    const feedback = (yield* github.prFeedback(pr, from, from, instructors)).filter(
      (item) => !state.told.has(item.id),
    );
    const last = feedback.at(-1);
    if (last !== undefined) {
      if (last.createdAt !== state.since) state.told.clear();
      state.since = last.createdAt;
      for (const item of feedback) {
        if (item.createdAt === last.createdAt) state.told.add(item.id);
      }
      return { port: "feedback", detail: feedbackText(feedback) } as const;
    }
    const tip = yield* github.branchTip(pull.baseRef);
    if (state.baseTip === null) state.baseTip = tip;
    else if (tip !== state.baseTip) {
      state.baseTip = tip;
      return {
        port: "base-moved",
        detail: `${pull.baseRef} moved to ${tip.slice(0, 12)}`,
      } as const;
    }
    return undefined;
  });

  return {
    headBranch: (pr) =>
      poll(
        `reading pull request #${pr}`,
        TRACKER_POLL,
        github.pullRequest(pr).pipe(
          Effect.map((pull) => ({
            branch: pull === null || pull.crossRepository ? null : pull.headRef,
          })),
        ),
        { failingFor: TRACKER_PATIENCE },
      ).pipe(Effect.map((found) => found.branch)),
    postQuestions: Effect.fn("PipelineTracker.postQuestions")(function* (text) {
      // Before posting, so an answer quicker than the post is still read; the factory's own
      // comments are left out when the answers are read.
      askedAt = utcSecond(yield* Clock.currentTimeMillis);
      yield* github.postComment(issue, questionsComment(prepareSessionText(text)));
      yield* github.setState(issue, "needs-info");
    }, Effect.mapError(portError)),
    awaitAnswer: Effect.fn("PipelineTracker.awaitAnswer")(function* () {
      const since = askedAt ?? utcSecond(yield* Clock.currentTimeMillis);
      yield* poll(
        `reading the approval of issue #${issue}`,
        TRACKER_POLL,
        github
          .approval(issue, instructors)
          .pipe(
            Effect.map((approval) =>
              approval.kind === "approved" && approval.labeledAt > since ? true : undefined,
            ),
          ),
        { failingFor: TRACKER_PATIENCE },
      );
      const activity = yield* github.activitySince(issue, since, instructors);
      yield* github.setState(issue, "building");
      const comments = activity.comments
        .filter((comment) => !comment.body.includes(MARKER))
        .map((comment) => `${comment.author}:\n${comment.body}`);
      const edit =
        activity.bodyEdit === null ? [] : [`The issue now reads:\n${activity.bodyEdit.body}`];
      const text = [...comments, ...edit].join("\n\n");
      return { text: text === "" ? "No comments; the issue was approved again." : text };
    }, Effect.mapError(portError)),
    markReady: Effect.fn("PipelineTracker.markReady")(function* (pr) {
      const since = utcSecond(yield* Clock.currentTimeMillis);
      yield* github.markPrReady(pr);
      pulls.set(pr, { since, told: new Set(), baseTip: yield* baseTipOf(pr) });
    }, Effect.mapError(portError)),
    awaitPullRequest: Effect.fn("PipelineTracker.awaitPullRequest")(function* (pr) {
      const state: PullState = pulls.get(pr) ?? {
        since: utcSecond(yield* Clock.currentTimeMillis),
        told: new Set(),
        baseTip: null,
      };
      pulls.set(pr, state);
      return yield* poll(`reading pull request #${pr}`, TRACKER_POLL, lookAt(pr, state), {
        failingFor: TRACKER_PATIENCE,
      });
    }),
  };
};
