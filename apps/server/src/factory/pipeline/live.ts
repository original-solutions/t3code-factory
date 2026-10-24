/**
 * The executor's ports over the real factory: T3 sessions for threads, the process runner for
 * commands, the GitHub tracker for questions and pull requests, and the run record on disk.
 * Settlement and the tracker are polled; the factory's own runs are woken by the event stream,
 * which a prototype pipeline run does without.
 */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import { formatTs } from "../ledger/time.ts";
import type { FactoryProcess } from "../process.ts";
import { prepareSessionText, questionsComment } from "../runner/messages.ts";
import type { FactorySessions, Model, RunStatus } from "../t3/sessions.ts";
import { MARKER, type BoundGitHub, type Feedback } from "../tracker/github.ts";
import { PortError, type Ports, type Tracker } from "./execute.ts";
import { appendEvent } from "./record.ts";

/** A run in one of these is done with its turn: what it said is final until the next message. */
const SETTLED: ReadonlySet<RunStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "rolled_back",
  // A turn waiting on a person or an approval: nobody is in the chat, so read what it said.
  "waiting",
]);

const SETTLE_POLL = "10 seconds";
const TRACKER_POLL = "60 seconds";
/** The most command output a gate outcome carries: the end, where the error is. */
const OUTPUT_TAIL = 8000;

const portError = (error: { readonly message: string }) =>
  new PortError({ message: error.message });

/** `ms` as GitHub writes a time, `YYYY-MM-DDTHH:MM:SSZ`, so the two compare as text. */
const utcSecond = (ms: number): string => `${formatTs(ms).slice(0, 19)}Z`;

const tail = (text: string): string =>
  text.length > OUTPUT_TAIL ? `[cut]\n${text.slice(text.length - OUTPUT_TAIL)}` : text;

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
    while (true) {
      const status = yield* sessions.status(threadId).pipe(Effect.mapError(portError));
      if (status.archived) {
        return yield* new PortError({ message: `thread ${threadId} was archived` });
      }
      const ordinal = status.runOrdinal;
      if (
        status.run !== null &&
        SETTLED.has(status.run) &&
        ordinal !== null &&
        ordinal > (settledOrdinal.get(threadId) ?? Number.NEGATIVE_INFINITY)
      ) {
        settledOrdinal.set(threadId, ordinal);
        return {
          text: status.lastAssistantMessage,
          worktree: status.worktreePath,
          branch: status.branch,
        };
      }
      yield* Effect.sleep(SETTLE_POLL);
    }
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
  /** Whose answers, approvals and pull request feedback count. */
  readonly instructors: ReadonlyArray<string>;
}

/**
 * The issue and its pull requests on GitHub. Questions move the issue to `factory:needs-info`;
 * an instructor's `factory:ready` after them is the answer, and moves it to `factory:building`.
 * A pull request's feedback is read from the moment it was marked ready, and each feedback
 * outcome moves that moment on, so nothing is told twice and nothing said meanwhile is lost.
 */
export const liveTracker = (input: LiveTrackerInput): Tracker => {
  const { github, issue, instructors } = input;
  let askedAt: string | null = null;
  const pulls = new Map<number, { since: string; baseTip: string | null }>();

  const baseTipOf = (pr: number) =>
    github
      .pullRequest(pr)
      .pipe(
        Effect.flatMap((pull) =>
          pull === null ? Effect.succeed(null) : github.branchTip(pull.baseRef),
        ),
      );

  return {
    postQuestions: Effect.fn("PipelineTracker.postQuestions")(function* (text) {
      // Before posting, so an answer quicker than the post is still read; the factory's own
      // comments are left out when the answers are read.
      askedAt = utcSecond(yield* Clock.currentTimeMillis);
      yield* github.postComment(issue, questionsComment(prepareSessionText(text)));
      yield* github.setState(issue, "needs-info");
    }, Effect.mapError(portError)),
    awaitAnswer: Effect.fn("PipelineTracker.awaitAnswer")(function* () {
      const since = askedAt ?? utcSecond(yield* Clock.currentTimeMillis);
      while (true) {
        const approval = yield* github.approval(issue, instructors);
        if (approval.kind === "approved" && approval.labeledAt > since) break;
        yield* Effect.sleep(TRACKER_POLL);
      }
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
      pulls.set(pr, { since, baseTip: yield* baseTipOf(pr) });
    }, Effect.mapError(portError)),
    awaitPullRequest: Effect.fn("PipelineTracker.awaitPullRequest")(function* (pr) {
      const state = pulls.get(pr) ?? {
        since: utcSecond(yield* Clock.currentTimeMillis),
        baseTip: null,
      };
      pulls.set(pr, state);
      while (true) {
        const pull = yield* github.pullRequest(pr);
        if (pull === null) {
          return { port: "closed", detail: `pull request #${pr} is gone` } as const;
        }
        if (pull.merged) return { port: "merged", detail: null } as const;
        if (!pull.open) return { port: "closed", detail: null } as const;
        const feedback = yield* github.prFeedback(pr, state.since, state.since, instructors);
        const last = feedback.at(-1);
        if (last !== undefined) {
          state.since = last.createdAt;
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
        yield* Effect.sleep(TRACKER_POLL);
      }
    }, Effect.mapError(portError)),
  };
};
