/**
 * The gate of a building run, ported from softfac's `runner/gating.rs` `gate`: a fresh checkout
 * of the pull request's head merged with the base tip, the project's commands in it, and the
 * decision that follows, and the wait for the project's required CI checks before the pull
 * request is marked ready; and `regate`, the same gate for a `pr-open` pull request whose head or
 * base moved since its last pass. The checkout, the commands and the removal are `FactoryGate`'s
 * (`gate.ts`), which also writes the attempt's `gate_checkout` and `gate_command` lines; this
 * module decides what they mean.
 *
 * Each call reads the ledger first and does only what it does not record, so calling it again
 * resumes whatever an earlier call left half done. A failure of the tracker, of T3 or of the
 * checkout is an error, with nothing final written, and the next call decides again.
 */

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { transition, type Action } from "../domain/lifecycle.ts";
import {
  WorkspaceUnexpectedError,
  commandCode,
  gateResultsComment,
  gateRoot,
  leftoverCheckouts,
  regateResultsComment,
  removeEmptyGateRoot,
  removeLeftoverCheckouts,
  type CommandResult,
  type FactoryGate,
  type GateError,
  type GateOptions,
} from "../gate.ts";
import { ledgerCall as ledger, type LedgerError } from "../ledger/errors.ts";
import { makeCause, type RunEvent } from "../ledger/events.ts";
import { readRun } from "../ledger/read.ts";
import { asciiLower, runIdToString, type RunId } from "../ledger/runId.ts";
import type { FactorySessions, ThreadStatus } from "../t3/sessions.ts";
import { isCommitId, sanitize } from "../text.ts";
import type { BoundGitHub, CheckStatus, IssueDetail, PullRequest } from "../tracker/github.ts";
import {
  WrongRepoError,
  append,
  checkBinding,
  sessionBusy,
  stopOf,
  textStop,
  threadStatus,
  withLedger,
  type BuildingContext,
  type BuildingError,
  type Out,
} from "./building.ts";
import {
  BASE_KEPT_MOVING,
  CHECKS_HEAD_MOVED,
  END_WITH_DONE,
  STOPPED_BY_HAND,
  THREAD_GONE,
  checksFailureMessage,
  failureMessage,
  howItEnded,
  mergeConflictMessage,
  prepareOutputTail,
} from "./messages.ts";
import {
  GATE_PASSED,
  GATE_SENDING,
  attemptsSincePass,
  movedSince,
  nextGateAttempt,
  pendingRelaunch,
  readProgress,
  regateAttempt,
  type Moved,
  type PassRecord,
  type Relaunch,
  type Seen,
} from "./progress.ts";
import { branchRefused, relaunchSession } from "./relaunch.ts";
import {
  abandon,
  applyActions,
  closedIssue,
  endOwnMerge,
  endRun,
  goStuck,
  progressFrom,
  recordedReason,
  stopSession,
  type Progress,
  type Stop,
} from "./run.ts";

export { mergeConflictMessage } from "./messages.ts";
export { movedSince, type Moved } from "./progress.ts";

/**
 * What the gate asks of the factory besides what a building run asks: the base tip, who marked a
 * pull request ready, the gate itself, and what a failed re-gate needs to launch the session that
 * fixes it.
 */
export interface GateContext extends BuildingContext {
  readonly tracker: BuildingContext["tracker"] &
    Pick<BoundGitHub, "branchTip" | "readyBy" | "checks">;
  readonly gate: Pick<FactoryGate["Service"], "run">;
  readonly maxConcurrentGates: number;
  readonly gateOptions?: GateOptions;
  readonly repoPath: string;
  readonly ghConfigDir: string;
  readonly sessions: BuildingContext["sessions"] &
    Pick<FactorySessions["Service"], "findProject" | "launch">;
}

/** The project names no gate command: nothing can pass, and the pass marker could not tell a gate command from a provision command. */
export class NoGateCommandsError extends Schema.TaggedError<NoGateCommandsError>()(
  "NoGateCommandsError",
  { repo: Schema.String },
) {
  override get message(): string {
    return `${this.repo}: the project config names no gate command`;
  }
}

export type GateStepError = BuildingError | GateError | NoGateCommandsError;

/** What `gate` did. */
export type GateStep =
  /**
   * Every command passed. The pull request is ready for review, the results are on it and the
   * issue is `pr-open`. The run is not finished: it stays open while its pull request waits for
   * a person.
   */
  | { readonly kind: "passed"; readonly pr: number }
  /** An attempt failed and was sent into the session. `advance` reports the run ready for the gate again only after the session has finished a new run. */
  | { readonly kind: "sent-back"; readonly attempt: number }
  /** The issue went to `stuck`. The pull request stays open, a draft. `reason` is as the ledger records it. */
  | { readonly kind: "stuck"; readonly reason: string }
  /**
   * Nothing to gate yet, or any more: the run is finished, has no pull request or session, is not
   * `building`, or its session is still working. Also the answer when the pull request's head
   * moved while the commands ran: the next call gates the new head. Nothing was decided, though a
   * gate run that did happen is on record.
   */
  | { readonly kind: "not-ready" }
  /** The pull request was merged or closed, so the run is finished and is never looked at again. A pass on the commit that was merged is recorded and moves the issue to `pr-open` first. */
  | { readonly kind: "ended" }
  /** A person closed the issue: the session's thread is archived and the run is finished, with no command run and nothing written on GitHub. */
  | { readonly kind: "abandoned" }
  /** This run has a gate running already: its lock is held. */
  | { readonly kind: "running" }
  /**
   * Every command passed and the project names required checks that have not all finished on the
   * commit that was gated. Nothing is marked ready; the next call reads them again.
   */
  | { readonly kind: "checks-pending" }
  /**
   * Only `regate` says this: the pull request's head and the base branch's tip are the ones the
   * last pass ran against, so there is nothing to gate again. Two reads were made and nothing was
   * written.
   */
  | { readonly kind: "unchanged" }
  /** `max_concurrent_gates` gates run already; the next call tries again. */
  | { readonly kind: "queued"; readonly running: number; readonly max: number };

const NOT_READY = { kind: "not-ready" } as const;

/** `attempt` as the stuck comment counts it: "1 attempt", "2 attempts". */
const attempts = (n: number): string => `${n} ${n === 1 ? "attempt" : "attempts"}`;

/** The results of a pass, as the comment needs them: the last `count` command lines of the attempt. */
const resultsOf = (pass: PassRecord): ReadonlyArray<CommandResult> =>
  pass.lines.slice(Math.max(0, pass.lines.length - pass.count)).map((line) => ({
    command: line.command,
    exitCode: line.exitCode,
    durationMs: line.durationMs,
    timedOut: false,
    output: "",
  }));

/** The gate's stuck path: `goStuck` with the gate as the step, and the reason as the ledger records it. */
const stuckWith = (
  ctx: GateContext,
  out: Out,
  issue: number,
  at: Progress,
  code: string,
  stop: Stop,
): Effect.Effect<GateStep, GateStepError> =>
  Effect.gen(function* () {
    const opened = yield* out.open;
    yield* goStuck(ctx, issue, opened, at, code, stop);
    return { kind: "stuck", reason: recordedReason(stop) } as const;
  });

/**
 * The gate's stop for a pull request that is not the run's own (`checkBinding`), or is gone:
 * `pr-not-bound`, with the session's last `message` for the stuck comment when there is a session.
 */
const stuckUnbound = (
  ctx: GateContext,
  out: Out,
  issue: number,
  at: Progress,
  message: string | null,
  unbound: { readonly public: string; readonly detail?: string },
): Effect.Effect<GateStep, GateStepError> =>
  stuckWith(
    ctx,
    out,
    issue,
    at,
    "pr-not-bound",
    stopOf(unbound.public, message, unbound.detail === undefined ? {} : { detail: unbound.detail }),
  );

/**
 * The rest of a passing gate once the pass is recorded: stop the session and remove its
 * worktree (the branch stays, locally and on `origin`), mark the pull request ready, post the
 * results (each skipped when the ledger says it is done), move the issue to `pr-open` and write
 * the `state_changed` line. The run is not finished: it stays open while its pull request waits
 * for a person. `stillOpen` is false for a pull request that was merged or closed in the
 * meantime: nothing is posted on it, and the issue still moves on.
 *
 * The stop comes first, before any write on GitHub, so a call cut short after it finds the
 * thread archived and the worktree line written, and does neither again.
 */
const finishPass = (
  ctx: GateContext,
  out: Out,
  issue: number,
  at: Progress,
  pass: PassRecord,
  pr: number,
  stillOpen: boolean,
): Effect.Effect<GateStep, GateStepError> =>
  Effect.gen(function* () {
    const opened = yield* out.open;
    yield* stopSession(ctx, opened, at);
    const moved = yield* Effect.fromResult(transition("building", { kind: "pr-ready", pr }));
    const actions = moved.actions.filter(
      (action) =>
        stillOpen || (action.kind !== "mark-pr-ready" && action.kind !== "post-gate-results"),
    );
    const comment = gateResultsComment(resultsOf(pass), pass.attempt, pass.sha, pass.baseSha);
    yield* applyActions(ctx, issue, opened, at, actions, makeCause("gate", "gate-passed"), {
      comment,
    });
    return { kind: "passed", pr } as const;
  });

/** Whether the checks the project names still have to be decided for the pass on `sha`. */
const checksWanted = (ctx: GateContext, seen: Seen, sha: string): boolean =>
  ctx.project.requiredChecks.length > 0 && seen.checksPassed !== sha;

/**
 * The `gate-sending` step of `attempt` when its `gate_sent_back` is missing: the send was started
 * and may or may not have reached the session.
 */
const owedSend = (seen: Seen, attempt: number): Seen["sending"] =>
  seen.sending !== null &&
  seen.sending.attempt === attempt &&
  seen.commandAttempts.has(attempt) &&
  !seen.sentBackAttempts.has(attempt)
    ? seen.sending
    : null;

/**
 * Writes the missing `gate_sent_back` of an `owed` send when the session has run since it: the
 * send did reach it, so the attempt is used. True when it was written.
 */
const recoverSend = (
  out: Out,
  attempt: number,
  owed: NonNullable<Seen["sending"]>,
  status: ThreadStatus,
): Effect.Effect<boolean, GateStepError> =>
  status.runOrdinal !== null && status.runOrdinal > owed.runOrdinal
    ? append(
        out,
        { event: "gate_sent_back", data: { attempt, run_ordinal: owed.runOrdinal } },
        "gate",
        "gate-send-recovered",
        { attempt },
      ).pipe(Effect.as(true))
    : Effect.succeed(false);

/**
 * Puts a pull request someone else took out of draft back to draft before a failure is handled,
 * as `advance` does: only the gate marks it ready. Null when there was nothing to do or it went
 * back; a call that fails leaves it as it is, and stuck, while a rate limit is an error, so the
 * next call asks again. `message` is the session's last message, for the stuck comment.
 */
const backToDraft = (
  ctx: GateContext,
  out: Out,
  pr: number,
  pull: PullRequest | null,
  stuck: (code: string, stop: Stop) => Effect.Effect<GateStep, GateStepError>,
  message: string | null,
): Effect.Effect<GateStep | null, GateStepError> =>
  Effect.gen(function* () {
    if (pull === null || !pull.open || pull.isDraft) return null;
    const drafted = yield* Effect.result(ctx.tracker.markPrDraft(pr));
    if (drafted._tag === "Failure") {
      if (drafted.failure._tag === "GitHubRateLimited") return yield* drafted.failure;
      return yield* stuck(
        "pr-not-bound",
        stopOf(`the session reported PR #${pr} but it is not a draft`, message),
      );
    }
    yield* append(out, { event: "pr_set_draft", data: { pr } }, "gate", "pr-set-draft");
    return null;
  });

/**
 * Sends a failed attempt (`ordinal` is that of the session run it was gated on) back into the
 * session under the command id `softfac:<run>:gate:<attempt>:<ordinal>`, and records that it
 * went. The `gate-sending` step comes first: with it a later call knows which run this attempt
 * was gated on. `why` is the reason of the lines the send writes.
 */
const sendBack = (
  ctx: GateContext,
  out: Out,
  run: RunId,
  seen: Seen,
  at: Progress,
  attempt: number,
  ordinal: number,
  text: string,
  why: string,
): Effect.Effect<GateStep, GateStepError> =>
  Effect.gen(function* () {
    const issue = Number(run.issue);
    if (
      seen.sending === null ||
      seen.sending.attempt !== attempt ||
      seen.sending.runOrdinal !== ordinal
    ) {
      yield* append(
        out,
        { event: "step_changed", data: { step: `${GATE_SENDING} ${attempt} ${ordinal}` } },
        "gate",
        "gate-sending",
        { attempt },
      );
    }
    const failed = yield* Effect.fromResult(
      transition("building", { kind: "gate-failed", output: `${END_WITH_DONE}\n\n${text}` }),
    );
    // The id holds the ordinal: a retry before the session ran again is the same command, and
    // a send after a newer run is a new one even if T3 dedupes by id.
    const commandId = `softfac:${runIdToString(run)}:gate:${attempt}:${ordinal}`;
    yield* applyActions(ctx, issue, yield* out.open, at, failed.actions, makeCause("gate", why), {
      send: { commandId, attempt, runOrdinal: ordinal },
    });
    return { kind: "sent-back", attempt } as const;
  });

/**
 * What is left of a passing gate when the project names required checks: they must all have
 * passed on the commit that was gated before the pull request is marked ready.
 *
 * A failure that was sent but never recorded (`gate-sending` with no `gate_sent_back`) is
 * checked first: when the session has run again since, the send did reach it, and the missing
 * line is written whatever the pull request looks like now. Then the pull request is read: one
 * that is no longer open gets nothing marked ready, as for any recorded pass, and one whose head
 * is not the gated commit goes `stuck`, because no check on another commit says anything about
 * this pass. Then the checks are read for the gated commit, unless a read already found one
 * failed: that decision stands, so a check run again since cannot mark ready a pull request
 * whose failure may already be in the session. The ledger keeps only the names of the checks
 * that failed, so a failure sent again names them without GitHub's result or link.
 *
 * All passed: the issue text is judged again, as before the pass was recorded, since the wait can
 * be long; then the read is recorded (`checks_read`, the decision) and the pass is finished. One
 * failed, even while others are pending: the read is recorded, a pull request someone took out
 * of draft goes back to draft, and the failure goes back into the session like a gate failure,
 * using the pass's attempt (the last one goes `stuck`); the pass is then void, and a new run is
 * gated afresh. Pending or missing: `checks-pending` and nothing is written, until
 * `limits.checks_minutes` after the pass, when the read is recorded and the issue goes `stuck`
 * with a fixed reason (a check that never appeared has its own).
 */
const awaitChecks = (
  ctx: GateContext,
  out: Out,
  run: RunId,
  seen: Seen,
  at: Progress,
  pass: PassRecord,
  gating: { readonly threadId: string; readonly pr: number },
): Effect.Effect<GateStep, GateStepError> =>
  Effect.gen(function* () {
    const { threadId, pr } = gating;
    const issue = Number(run.issue);
    const attempt = pass.attempt;
    const stuck = (code: string, stop: Stop) => stuckWith(ctx, out, issue, at, code, stop);
    const owed = owedSend(seen, attempt);
    if (owed !== null) {
      const status = yield* threadStatus(ctx, threadId);
      if (status === null) return yield* stuck("thread-gone", stopOf(THREAD_GONE, null));
      if (yield* recoverSend(out, attempt, owed, status)) {
        return { kind: "sent-back", attempt } as const;
      }
    }
    const pull = yield* ctx.tracker.pullRequest(pr);
    if (pull === null || !pull.open) return yield* finishPass(ctx, out, issue, at, pass, pr, false);
    if (pull.headSha.toLowerCase() !== pass.sha) {
      return yield* stuck("checks-head-moved", { reason: CHECKS_HEAD_MOVED });
    }
    const recorded =
      seen.checksFailed !== null && seen.checksFailed.sha === pass.sha
        ? seen.checksFailed.failed
        : null;
    let failed: ReadonlyArray<CheckStatus>;
    let read: RunEvent | null = null;
    if (recorded !== null) {
      failed = recorded;
    } else {
      const checks = yield* ctx.tracker.checks(pass.sha, ctx.project.requiredChecks);
      read = {
        event: "checks_read",
        data: {
          sha: pass.sha,
          checks: checks.map((c) => ({ name: c.name, state: c.state })),
        },
      };
      failed = checks.filter((c) => c.state === "failed");
      if (failed.length === 0) {
        if (checks.every((c) => c.state === "passed")) {
          const why = yield* textStop(ctx, issue, seen);
          if (why !== null) return yield* stuck(why.code, { reason: why.reason });
          yield* append(out, read, "gate", "required-checks-read", { attempt });
          return yield* finishPass(ctx, out, issue, at, pass, pr, true);
        }
        const minutes = ctx.project.limits.checksMinutes;
        const waited = ctx.clock() - pass.atMs;
        if (waited < minutes * 60_000) return { kind: "checks-pending" } as const;
        yield* append(out, read, "gate", "checks-timed-out", { attempt });
        const reason = checks.some((c) => c.state === "missing")
          ? `a required check was not reported within ${minutes} minutes`
          : `the required checks did not finish within ${minutes} minutes`;
        return yield* stuck("checks-timed-out", { reason });
      }
    }
    const status = yield* threadStatus(ctx, threadId);
    if (status === null) return yield* stuck("thread-gone", stopOf(THREAD_GONE, null));
    // Without an ordinal the run cannot be told from another one, and a failure is not sent
    // into a run that is still going: nothing is decided, and the session is what is waited
    // for, not the checks.
    if (status.runOrdinal === null) return NOT_READY;
    if (sessionBusy(seen, status)) return NOT_READY;
    if (read !== null) yield* append(out, read, "gate", "required-checks-failed", { attempt });
    const drafted = yield* backToDraft(ctx, out, pr, pull, stuck, status.lastAssistantMessage);
    if (drafted !== null) return drafted;
    const message = checksFailureMessage(pass.sha, failed);
    const since = attemptsSincePass(seen, attempt);
    if (since > ctx.project.limits.gateRetries) {
      const sessionText = prepareOutputTail(message);
      return yield* stuck("checks-retries-used-up", {
        reason: `the required checks failed after ${attempts(since)}`,
        ...(sessionText !== "" && { sessionText }),
      });
    }
    return yield* sendBack(
      ctx,
      out,
      run,
      seen,
      at,
      attempt,
      status.runOrdinal,
      message,
      "required-checks-failed",
    );
  });

/**
 * Runs the project's provision and gate commands in a fresh checkout of the pull request's head
 * and decides, from their exit codes and nobody's word, whether the build passed. Call it with a
 * run that `advance` reported as ready for the gate.
 *
 * `ctx.project` must be the config the caller loaded from the base branch. The commands are never
 * read from the checkout: a pull request could otherwise edit its own gate.
 *
 * First the session is read (a thread T3 no longer has is a stop) and the pull request is bound
 * to the run again (it may have changed since `advance`; one that is open must be a draft). A
 * pull request a person merged or closed ends the run with nothing gated. Then the tip of the
 * base branch is read and `FactoryGate` makes the checkout, under `<dataDir>/gate/<run>/<n>`:
 * the head and that tip fetched by their ids, the head checked out and the tip merged into it.
 * The commands run on the merged tree, so a branch that passes alone and breaks once the base
 * has moved does not pass. A merge conflict is a failed attempt with no command run, told to the
 * session in fixed words. The ledger gets where the gate ran and on which commits, then each
 * command's result.
 *
 * All passed: the pull request is read again (it must still be the session's own and at the
 * commit that was gated; a head that moved is no pass and no failure, and the next call gates
 * the new head; one closed without a merge ends the run; one merged has its pass recorded and
 * ends the run with nothing posted), then the base tip (one that moved sends the gate round
 * again on the new merge, up to `limits.regates` times since the last pass, then `stuck`), then
 * the issue text as `watch` judges it. Then the ledger gets `gate-passed <sha> <n>` before
 * anything is marked ready, and `finishPass` does the rest. Calling `gate` again after an error
 * resumes: with that step in the ledger nothing is run again and only the transition is
 * finished, `state_changed` is the commit marker and is written last, a posted results comment
 * is skipped when the ledger records it, and marking the pull request ready is safe to repeat.
 * An attempt that died before the step is run again under the same number.
 *
 * When the project names `required_checks`, the pass is not finished at once: the pull request
 * stays a draft until every named check has passed on the commit that was gated (`awaitChecks`).
 * Until then the answer is `checks-pending` and each call reads the checks again, with no
 * checkout and no command, up to `limits.checks_minutes` after the pass. A failed check goes
 * back into the session as a failed attempt.
 *
 * A failure (a command, a provision command or a conflict) puts a pull request someone else took
 * out of draft back to draft, then goes into the session with `END_WITH_DONE` in front, under the
 * command id `softfac:<run>:gate:<attempt>:<ordinal>`, with the `gate-sending` step before the
 * send and `gate_sent_back` after it. `gate_retries` failures since the last pass may go back;
 * the one after that goes `stuck` with `the gate failed after <n> attempts` and the output in
 * the comment (a conflict's paths stay in the ledger).
 *
 * Before any of that, a closed issue ends the run: a person's move is `abandoned` (the thread is
 * archived, the run finished, nothing written on GitHub, no command run), and the run's own
 * merged pull request closing it is `ended` unless a pass is recorded, which the rest of the
 * gate finishes. A run an operator stopped by hand goes `stuck` as stopped by hand, with no
 * checkout and no command.
 */
export const gate = (ctx: GateContext, run: RunId): Effect.Effect<GateStep, GateStepError> =>
  withLedger(ctx, run, (out) =>
    Effect.gen(function* () {
      if (asciiLower(run.repo) !== asciiLower(ctx.repo)) {
        return yield* new WrongRepoError({ run, repo: ctx.repo });
      }
      const seen = readProgress((yield* ledger(() => readRun(ctx.dataDir, run))).entries);
      const threadId = seen.threadId;
      const last = seen.lastPr;
      if (threadId === null || last === null || seen.finished) return NOT_READY;
      const issue = Number(run.issue);
      // Before anything is decided or written: a closed issue is a person's move, or the run's
      // own merged pull request, which ends the run here unless a recorded pass finishes it below.
      const { closing } = yield* closedIssue(ctx, run, seen);
      if (closing.kind === "persons-move") {
        yield* abandon(ctx, yield* out.open, run, seen, "gate");
        return { kind: "abandoned" } as const;
      }
      if (closing.kind === "own-merge" && seen.pass === null) {
        yield* endOwnMerge(ctx, yield* out.open, run, seen, "gate", closing.pull);
        return { kind: "ended" } as const;
      }
      const at = progressFrom("gate", seen, "triage");
      // A decision to give up that is already in the ledger stands, and is carried out without
      // asking T3 or git anything.
      if (seen.stuck !== null) {
        return yield* stuckWith(ctx, out, issue, at, "stuck-resumed", { reason: seen.stuck });
      }
      // `stop-run.sh` ended the run: no attempt starts, and the run goes `stuck` as stopped by
      // hand, its thread archived first.
      if (seen.stopRequested && at.state === "building") {
        return yield* stuckWith(ctx, out, issue, at, "stop-requested", { reason: STOPPED_BY_HAND });
      }
      // Every write is done: the run stays open while its pull request waits for a person.
      if (at.state === "pr-open") return { kind: "passed", pr: last.pr } as const;
      if (at.state !== "building") return NOT_READY;
      // The gate already passed: what is left is the rest of the transition. No checkout is
      // made, no command is run, and neither the session nor the pull request's binding is
      // looked at again; a pull request that is no longer open gets nothing posted on it.
      if (seen.pass !== null) {
        if (checksWanted(ctx, seen, seen.pass.sha)) {
          return yield* awaitChecks(ctx, out, run, seen, at, seen.pass, { threadId, pr: last.pr });
        }
        const pull = yield* ctx.tracker.pullRequest(last.pr);
        const stillOpen = pull !== null && pull.open;
        return yield* finishPass(ctx, out, issue, at, seen.pass, last.pr, stillOpen);
      }
      return yield* gateAttempts(
        ctx,
        out,
        run,
        seen,
        at,
        buildingMode(ctx, out, run, seen, at, {
          threadId,
          pr: last.pr,
          prUrl: last.url,
          regates: seen.regates,
        }),
      );
    }),
  );

/**
 * What `gate` and `regate` each supply around the attempts `gateAttempts` runs on one pull
 * request. A `building` run's pull request has a session that the gate waits for and sends a
 * failure to. A ready pull request (`regate`) passed the gate and waits for a person: it has no
 * session to wait for or to send a failure to, any branch is its own, a merged or closed pull
 * request ends the run, a failure starts a new session instead, and its pass does not wait for
 * the required checks again.
 */
interface GateMode {
  readonly pr: number;
  readonly prUrl: string;
  /** How often the base moved since the last pass before this call: the regate limit counts from it. */
  readonly regates: number;
  /**
   * What the mode reads before the attempt `first`, and how it recovers a send the ledger says
   * began (`owed`: the `gate-sending` step with no `gate_sent_back`). The answer is the steps of
   * the attempt that is gated, or what the gate did instead: `not-ready` while the session is
   * busy, `stuck` when its thread is gone, or the end of a recovered re-gate failure.
   */
  readonly begin: (
    first: number,
    owed: Seen["sending"],
  ) => Effect.Effect<AttemptSteps | GateStep, GateStepError>;
}

/**
 * The steps of one attempt that depend on what is gated. Each is read from the mode's own
 * fields: the session's run and branch for a building run, the pull request's branch for a ready
 * one. A step's answer is a `GateStep` when the gate is done with the attempt; `GateStep` has
 * `kind` and neither `AttemptSteps` nor `PullRequest` does, which is how `gateAttempts` tells.
 */
interface AttemptSteps {
  /** The attempt the gate runs under: one more than `first` when the mode found that one used. */
  readonly attempt: number;
  /**
   * Binds the pull request to the run as the mode sees it, and answers the pull request to gate.
   * A building run's pull request must be the session's own on its branch, and a draft when
   * `mustBeDraft` (before the commands run, not after); one that is gone is `stuck`. A ready pull
   * request a person merged or closed is `ended`, and binds whichever branch it is on.
   */
  readonly bind: (
    pull: PullRequest | null,
    mustBeDraft: boolean,
  ) => Effect.Effect<PullRequest | GateStep, GateStepError>;
  /** Notes once, for a building run, that someone took its pull request out of draft while the commands ran. */
  readonly noteReadyOutside: (pull: PullRequest) => Effect.Effect<void, GateStepError>;
  /** The rest of a recorded pass on a pull request that is still open. */
  readonly passed: (pass: PassRecord) => Effect.Effect<GateStep, GateStepError>;
  /**
   * Before a failure is counted: a building run's pull request someone took out of draft goes back
   * to draft, and the step when that cannot be done. Null to go on.
   */
  readonly beforeFailure: () => Effect.Effect<GateStep | null, GateStepError>;
  /** A failure with a retry left: into the session, or a new session from `pull`'s branch. */
  readonly failed: (pull: PullRequest, text: string) => Effect.Effect<GateStep, GateStepError>;
}

/**
 * `gateAttempts` for a `building` run's pull request, which the session `threadId` opened: the
 * gate waits for the session to have finished a run, binds the pull request to its branch, and
 * sends a failure back into it under that run's ordinal.
 */
const buildingMode = (
  ctx: GateContext,
  out: Out,
  run: RunId,
  seen: Seen,
  at: Progress,
  gating: {
    readonly threadId: string;
    readonly pr: number;
    readonly prUrl: string;
    readonly regates: number;
  },
): GateMode => {
  const { threadId, pr, prUrl, regates } = gating;
  const issue = Number(run.issue);
  const stuck = (code: string, stop: Stop) => stuckWith(ctx, out, issue, at, code, stop);
  return {
    pr,
    prUrl,
    regates,
    begin: (first, owed) =>
      Effect.gen(function* () {
        // The thread, read first, to wait for the session.
        const status = yield* threadStatus(ctx, threadId);
        if (status === null) return yield* stuck("thread-gone", stopOf(THREAD_GONE, null));
        // A newer run is visible: the send did reach the session, so the attempt is used. Record
        // that at once, and gate afresh as the next attempt once the run has ended.
        const attempt =
          owed !== null && (yield* recoverSend(out, first, owed, status)) ? first + 1 : first;
        // Wait for the session to have finished a run to gate, which has an ordinal.
        if (sessionBusy(seen, status)) return NOT_READY;
        const ordinal = status.runOrdinal;
        if (ordinal === null) return NOT_READY;
        const message = status.lastAssistantMessage;
        const branch = status.branch;
        return {
          attempt,
          bind: (pull, mustBeDraft) => {
            const unbound = checkBinding(
              pull,
              pr,
              ctx.project.base,
              branch,
              mustBeDraft,
              seen.resumedFrom,
              status.worktreePath,
            );
            if (unbound !== null || pull === null) {
              return stuckUnbound(
                ctx,
                out,
                issue,
                at,
                message,
                unbound ?? { public: `the session reported PR #${pr} but it does not exist` },
              );
            }
            return Effect.succeed(pull);
          },
          // Said once for the run, with who did it when GitHub knows. A failed read only costs
          // the name. The pull request is not stuck: the factory was about to mark it ready itself.
          noteReadyOutside: (pull) =>
            pull.open && !pull.isDraft && !seen.readyOutside
              ? Effect.gen(function* () {
                  const by = yield* ctx.tracker.readyBy(pr).pipe(Effect.orElseSucceed(() => null));
                  yield* append(
                    out,
                    { event: "pr_ready_outside", data: { pr, ...(by !== null && { by }) } },
                    "gate",
                    "pr-ready-outside",
                    { attempt },
                  );
                })
              : Effect.void,
          passed: (pass) => {
            // `seen` was read before this pass: a read of the checks in it was about an earlier one.
            const unread: Seen = { ...seen, checksPassed: null, checksFailed: null };
            if (checksWanted(ctx, unread, pass.sha)) {
              return awaitChecks(ctx, out, run, unread, at, pass, { threadId, pr });
            }
            return finishPass(ctx, out, issue, at, pass, pr, true);
          },
          beforeFailure: () =>
            Effect.gen(function* () {
              const pullNow = yield* ctx.tracker.pullRequest(pr);
              return yield* backToDraft(ctx, out, pr, pullNow, stuck, message);
            }),
          // The session the failure goes to, which the gate has read: the run it was gated on.
          failed: (_pull, text) =>
            sendBack(ctx, out, run, seen, at, attempt, ordinal, text, "gate-failed"),
        };
      }),
  };
};

/**
 * `gateAttempts` for a pull request that is ready for review (`regate`). `resumed` is a re-gate
 * an earlier call began (`Seen.regating`): a stuck decision that call did not finish may have put
 * the pull request back to draft, so a pass sets the ready state again.
 */
const readyMode = (
  ctx: GateContext,
  out: Out,
  run: RunId,
  seen: Seen,
  at: Progress,
  gating: {
    readonly resumed: boolean;
    readonly pr: number;
    readonly prUrl: string;
    readonly regates: number;
  },
): GateMode => {
  const { resumed, pr, prUrl, regates } = gating;
  const issue = Number(run.issue);
  const stuck = (code: string, stop: Stop) => stuckWith(ctx, out, issue, at, code, stop);
  // A ready pull request that a person merged or closed is done with, and not stuck.
  const ended = (pull: PullRequest | null) =>
    Effect.gen(function* () {
      yield* endRun(ctx, yield* out.open, at, prUrl, pull, "gate");
      return { kind: "ended" } as const;
    });
  return {
    pr,
    prUrl,
    regates,
    begin: (attempt, owed) =>
      Effect.gen(function* () {
        // A re-gate does not depend on the session, which has been stopped since the pass: a
        // failure starts a new one. A failed re-gate whose new session the ledger records (it is
        // launched before the failure is marked sent, with ordinal 0: the new thread has no run
        // yet) has only the transition left. One whose launch is not recorded is run again, and
        // launches under the same command id.
        if (owed !== null && seen.launchedSinceSending) {
          yield* append(
            out,
            { event: "gate_sent_back", data: { attempt, run_ordinal: 0 } },
            "gate",
            "gate-send-recovered",
            { attempt },
          );
          return yield* finishRegateFailure(ctx, out, issue, at, pr, attempt);
        }
        return {
          attempt,
          // A pull request's branch does not change, so a re-gate binds whichever it is.
          bind: (pull) => {
            if (pull === null || !pull.open) return ended(pull);
            const unbound = checkBinding(
              pull,
              pr,
              ctx.project.base,
              pull.headRef,
              false,
              seen.resumedFrom,
            );
            if (unbound !== null) return stuckUnbound(ctx, out, issue, at, null, unbound);
            return Effect.succeed(pull);
          },
          noteReadyOutside: () => Effect.void,
          // A ready pull request stays ready, with the results posted again; the required checks
          // are not waited for again (softfac's rule).
          passed: (pass) => finishRegatePass(ctx, out, issue, at, pass, pr, resumed),
          beforeFailure: () => Effect.succeed(null),
          failed: (pull, text) =>
            Effect.gen(function* () {
              // The failure is about to put a session back to work, so the text it works on is
              // checked as `watch` checks it: someone who is not an instructor may have changed
              // it. A change archives the session first and goes `stuck`, so nothing is sent.
              const why = yield* textStop(ctx, issue, seen);
              if (why !== null) return yield* stuck(why.code, { reason: why.reason });
              // No session to send the failure to: its worktree was removed at the pass. A new
              // session starts from the pull request's branch.
              return yield* relaunchForRegate(
                ctx,
                out,
                issue,
                at,
                run,
                { pr, prUrl, branch: pull.headRef },
                { attempt, message: text },
              );
            }),
        };
      }),
  };
};

/**
 * The gate's runs on one pull request, from what the mode reads first to the decision: the
 * attempts, the base branch moving between them, and what follows a pass or a failure. `gate`
 * and `regate` call it with their mode (`GateMode`).
 */
const gateAttempts = (
  ctx: GateContext,
  out: Out,
  run: RunId,
  seen: Seen,
  at: Progress,
  mode: GateMode,
): Effect.Effect<GateStep, GateStepError> =>
  Effect.gen(function* () {
    const { pr, prUrl } = mode;
    const issue = Number(run.issue);
    const stuck = (code: string, stop: Stop) => stuckWith(ctx, out, issue, at, code, stop);

    // An attempt that was sent (the `gate-sending` step is in the ledger) whose `gate_sent_back`
    // is missing is the mode's to recover.
    const first = nextGateAttempt(seen);
    const begun = yield* mode.begin(first, owedSend(seen, first));
    if ("kind" in begun) return begun;
    const steps = begun;
    const { attempt } = steps;

    const bound = yield* steps.bind(yield* ctx.tracker.pullRequest(pr), true);
    if ("kind" in bound) return bound;
    const pull = bound;
    // The session's own pull request that a person merged or closed before the gate could run:
    // nothing is left to gate, and nothing is marked ready.
    if (!pull.open) {
      yield* endRun(ctx, yield* out.open, at, prUrl, pull, "gate");
      return { kind: "ended" } as const;
    }
    // The commit the gate is about is the one the pull request holds now, and it is a commit
    // id: the decision that it passed names it.
    const head = pull.headSha.toLowerCase();
    if (!isCommitId(head)) {
      return yield* new WorkspaceUnexpectedError({
        what: "the pull request's head is not a commit id",
      });
    }
    if (ctx.project.gate.length === 0) return yield* new NoGateCommandsError({ repo: ctx.repo });

    // The commit the head is merged with is the tip the base branch has now.
    let baseSha = (yield* ctx.tracker.branchTip(ctx.project.base)).toLowerCase();
    let regates = mode.regates;

    // Once the commands pass, a base branch that moved while they ran sends the gate round again
    // on the new merge, so the loop ends in a decision or in `stuck`.
    for (;;) {
      const ran = yield* ctx.gate.run({
        dataDir: ctx.dataDir,
        run,
        attempt,
        repo: ctx.repo,
        head,
        base: baseSha,
        provision: ctx.project.provision,
        gate: ctx.project.gate,
        maxConcurrentGates: ctx.maxConcurrentGates,
        ...(ctx.gateOptions !== undefined && { options: ctx.gateOptions }),
      });
      if (ran._tag === "running") return { kind: "running" } as const;
      if (ran._tag === "queued") {
        return { kind: "queued", running: ran.running, max: ran.max } as const;
      }
      // The attempt's lines are in the ledger: where it ran, then every command that ran, or
      // the conflict line that counts it.
      if (ran._tag === "pass") {
        // The commands can run for a long time. The pull request must still be the run's own,
        // whole, and still at the commit that was gated, before anything is marked ready.
        const boundNow = yield* steps.bind(yield* ctx.tracker.pullRequest(pr), false);
        if ("kind" in boundNow) return boundNow;
        const pullNow = boundNow;
        // One a person closed without a merge while the commands ran is a decision against the
        // work: the run ends, and the commands' pass is not recorded. One that was merged has
        // its pass recorded first, when it is a pass on the commit that was merged.
        const merged = !pullNow.open && pullNow.merged;
        if (!pullNow.open && !merged) {
          yield* endRun(ctx, yield* out.open, at, prUrl, pullNow, "gate");
          return { kind: "ended" } as const;
        }
        if (pullNow.headSha.toLowerCase() !== head) return NOT_READY;
        // The base branch is read again, and the issue text looked at again, before the pass is
        // recorded. Neither matters to a merged pull request: nothing moves under it.
        if (!merged) {
          const tip = (yield* ctx.tracker.branchTip(ctx.project.base)).toLowerCase();
          if (tip !== baseSha) {
            if (regates >= ctx.project.limits.regates) {
              return yield* stuck("base-kept-moving", { reason: BASE_KEPT_MOVING });
            }
            yield* append(
              out,
              {
                event: "gate_regate",
                data: { sha: head, base_sha: tip, previous_base_sha: baseSha },
              },
              "gate",
              "gate-regated",
              { attempt },
            );
            regates += 1;
            baseSha = tip;
            continue;
          }
          const why = yield* textStop(ctx, issue, seen);
          if (why !== null) return yield* stuck(why.code, { reason: why.reason });
        }
        yield* steps.noteReadyOutside(pullNow);
        // Record the decision before anything is marked ready: a call that dies after
        // `gh pr ready` must not look at a draft that is gone.
        yield* append(
          out,
          { event: "step_changed", data: { step: `${GATE_PASSED} ${head} ${ran.gateCount}` } },
          "gate",
          "gate-passed",
          { attempt },
        );
        const pass: PassRecord = {
          attempt,
          sha: head,
          baseSha,
          atMs: ctx.clock(),
          lines: ran.commands.map((result) => ({
            attempt,
            command: result.command,
            exitCode: result.exitCode,
            durationMs: result.durationMs,
          })),
          count: ran.gateCount,
        };
        // An earlier pass's results can be on the pull request; these are new.
        at.gateResultsPosted = false;
        if (merged) {
          yield* finishPass(ctx, out, issue, at, pass, pr, false);
          yield* endRun(ctx, yield* out.open, at, prUrl, pullNow, "gate");
          return { kind: "ended" } as const;
        }
        return yield* steps.passed(pass);
      }

      const conflict = ran._tag === "conflict";
      const text = conflict
        ? mergeConflictMessage(ctx.project.base, ran.paths)
        : failureMessage(ran.failure);
      const drafted = yield* steps.beforeFailure();
      if (drafted !== null) return drafted;
      // Every attempt since the last pass failed. `gate_retries` of them may go back into the
      // session; the one after that is the end.
      const since = attemptsSincePass(seen, attempt);
      if (since > ctx.project.limits.gateRetries) {
        const failedAfter = `the gate failed after ${attempts(since)}`;
        // The conflicted paths and the command output are text from the session's repo, and
        // output can hold what a command printed from its environment: the public comment gets
        // the factory's fixed line, and the ledger and the caller the whole message. Command
        // output ends with the error, so a long one is cut from the front.
        const stop: Stop = {
          reason: conflict
            ? `${failedAfter}: the branch conflicts with the base branch ${sanitize(ctx.project.base, false)}`
            : `${failedAfter}: ${commandCode(ran.failure.command)} failed (${howItEnded(ran.failure)})`,
          detail: `${failedAfter}\n\n${prepareOutputTail(text)}`,
        };
        return yield* stuck("gate-retries-used-up", stop);
      }
      return yield* steps.failed(pull, text);
    }
  });

/**
 * The rest of a passing gate on a pull request that was ready already: a new comment with the
 * results and the head and base they ran against. The state does not change. When an earlier
 * call began this re-gate (`reassert`), part of a failure or a stuck decision it did not finish
 * may be on GitHub (the pull request back to draft, the issue assigned or labelled otherwise), so
 * the ready state is set again, each call safe to repeat: the pull request ready, the issue
 * assigned and labelled `pr-open`, the status comment.
 */
const finishRegatePass = (
  ctx: GateContext,
  out: Out,
  issue: number,
  at: Progress,
  pass: PassRecord,
  pr: number,
  reassert: boolean,
): Effect.Effect<GateStep, GateStepError> =>
  Effect.gen(function* () {
    const comment = regateResultsComment(resultsOf(pass), pass.attempt, pass.sha, pass.baseSha);
    const actions: ReadonlyArray<Action> = reassert
      ? [
          { kind: "mark-pr-ready", pr },
          { kind: "assign-to-machine" },
          { kind: "set-label", state: "pr-open" },
          { kind: "update-status-comment" },
          // Last: the step it writes says the pass is complete, so a call cut short before it
          // finds the pass recorded and does the re-assertions again.
          { kind: "post-gate-results", pr },
        ]
      : [{ kind: "post-gate-results", pr }];
    yield* applyActions(
      ctx,
      issue,
      yield* out.open,
      at,
      actions,
      makeCause("gate", "gate-passed"),
      {
        comment,
      },
    );
    return { kind: "passed", pr } as const;
  });

/**
 * A failed re-gate whose failure the new session already has (the ledger says it was sent back,
 * with ordinal 0): what is left of the transition, without sending again. The pull request goes
 * back to draft, the issue is assigned and labelled `building` again, and the state change, which
 * comes last, commits it.
 */
const finishRegateFailure = (
  ctx: GateContext,
  out: Out,
  issue: number,
  at: Progress,
  pr: number,
  attempt: number,
): Effect.Effect<GateStep, GateStepError> =>
  Effect.gen(function* () {
    const failed = yield* Effect.fromResult(
      transition("pr-open", { kind: "regate-failed", pr, output: "" }),
    );
    const actions = failed.actions.filter((action) => action.kind !== "send-gate-failure");
    yield* applyActions(ctx, issue, yield* out.open, at, actions, makeCause("gate", "gate-failed"));
    return { kind: "sent-back", attempt } as const;
  });

/**
 * A failed re-gate of a ready pull request, with no session to send it to: the session was
 * stopped and its worktree removed when the gate passed. A new session is launched from the pull
 * request's branch at its tip on `origin` (see `relaunchSession`), and its first message carries
 * the failure. It pushes to the same branch, so the same pull request is updated. `pull` is the
 * pull request; `failure` is the failure, which uses one attempt.
 *
 * What is written, in order: the session is stopped if it still has a worktree (a run that was
 * `pr-open` before the worktree went at the pass), the `regate_relaunching` line (the decision,
 * with the branch and the failure text, before any launch call), the launch under the command id
 * `softfac:<run>:regate:<attempt>`, the `session_launched` line with `resumed_from`, the
 * `gate_sent_back` line (ordinal 0: the new thread has no run yet), and then the pull request
 * back to draft, the issue assigned and labelled `building` and the state change that commits it,
 * as `finishRegateFailure` does.
 *
 * From the decision line on the failure is decided, and no call runs the gate again for it:
 * `regate` goes to `resumeRelaunch` first. A branch that cannot be passed to `git push` safely
 * sends the issue `stuck` before anything is decided.
 */
const relaunchForRegate = (
  ctx: GateContext,
  out: Out,
  issue: number,
  at: Progress,
  run: RunId,
  pull: { readonly pr: number; readonly prUrl: string; readonly branch: string },
  failure: { readonly attempt: number; readonly message: string },
): Effect.Effect<GateStep, GateStepError> =>
  Effect.gen(function* () {
    const refused = branchRefused(pull.branch);
    if (refused !== null) return yield* stuckWith(ctx, out, issue, at, "launch-failed", refused);
    // Reads first: a failing read is an error with nothing written.
    const detail = yield* ctx.tracker.issue(issue);
    const opened = yield* out.open;
    yield* stopSession(ctx, opened, at);
    const relaunch: Relaunch = {
      fixes: { kind: "regate", attempt: failure.attempt },
      branch: pull.branch,
      message: failure.message,
    };
    yield* ledger(() =>
      opened.append(
        {
          event: "regate_relaunching",
          data: { attempt: failure.attempt, branch: relaunch.branch, message: relaunch.message },
        },
        makeCause("gate", "gate-sending", { attempt: failure.attempt }),
      ),
    );
    return yield* launchForRegate(
      ctx,
      out,
      issue,
      at,
      run,
      { pr: pull.pr, prUrl: pull.prUrl, earlierCall: false },
      detail,
      relaunch,
    );
  });

/**
 * Finishes a relaunch that an earlier call decided (the ledger has its `regate_relaunching` line
 * and no `session_launched` after it) before anything else is looked at: the launch is sent again
 * under the same command id, so T3 answers with the thread it made, or makes it now, and the
 * transition is completed as `relaunchForRegate` completes it. The gate is not run again and the
 * pull request and the base branch are not read: the failure is decided, and a person's merge or
 * close, a closed issue or a changed text is judged by the next pass on a run that now tracks the
 * new thread, which archives it. A failing T3 call is an error with nothing written.
 */
const resumeRelaunch = (
  ctx: GateContext,
  out: Out,
  issue: number,
  at: Progress,
  run: RunId,
  pull: { readonly pr: number; readonly prUrl: string },
  relaunch: Relaunch,
): Effect.Effect<GateStep, GateStepError> =>
  Effect.gen(function* () {
    const detail = yield* ctx.tracker.issue(issue);
    return yield* launchForRegate(
      ctx,
      out,
      issue,
      at,
      run,
      { ...pull, earlierCall: true },
      detail,
      relaunch,
    );
  });

/**
 * The launch of a decided relaunch and what follows it: `relaunchSession`, then the
 * `gate_sent_back` line (ordinal 0) and the rest of the transition. `earlierCall` says an earlier
 * call reached this point.
 */
const launchForRegate = (
  ctx: GateContext,
  out: Out,
  issue: number,
  at: Progress,
  run: RunId,
  from: { readonly pr: number; readonly prUrl: string; readonly earlierCall: boolean },
  detail: IssueDetail,
  relaunch: Relaunch,
): Effect.Effect<GateStep, GateStepError> =>
  Effect.gen(function* () {
    // Only a re-gate relaunch comes here; a feedback one is the feedback step's.
    const attempt = regateAttempt(relaunch);
    if (attempt === null) return NOT_READY;
    const opened = yield* out.open;
    const launched = yield* relaunchSession(ctx, opened, at, run, from, detail, relaunch);
    if (launched.kind === "stuck") return { kind: "stuck", reason: launched.reason } as const;
    yield* append(
      out,
      { event: "gate_sent_back", data: { attempt, run_ordinal: 0 } },
      "gate",
      "gate-failed",
      { attempt },
    );
    return yield* finishRegateFailure(ctx, out, issue, at, from.pr, attempt);
  });

/** What `regate` did, and what moved since the last recorded pass, for the run's line. */
export interface Regated {
  readonly step: GateStep;
  readonly moved: Moved | null;
}

/**
 * Removes the checkouts of this run that are still on disk: an earlier call died between making
 * one and removing it. One gate runs at a time for a run, so every one is a leftover. A checkout
 * that cannot be removed is noted in the ledger, once for each directory (unless the run is
 * finished, which takes no more lines), and is tried again by the next call.
 */
const removeLeftovers = (
  ctx: GateContext,
  out: Out,
  run: RunId,
  seen: Seen,
): Effect.Effect<void, LedgerError> =>
  Effect.gen(function* () {
    const root = yield* ledger(() => gateRoot(ctx.dataDir, run));
    yield* removeLeftoverCheckouts(root, (dir, error) =>
      seen.finished || seen.cleanupFailed.has(dir)
        ? Effect.void
        : append(
            out,
            { event: "gate_cleanup_failed", data: { dir, error } },
            "gate",
            "gate-cleanup-failed",
          ),
    );
    yield* removeEmptyGateRoot(root);
  });

/**
 * Whether a pull request's `head` and its base branch's `tip` are the ones a recorded pass ran
 * against: `regate` answers `unchanged` when they are, and the pass starts no gate. A pass with
 * no head or no base recorded never is.
 */
export const unchangedSince = (
  passedHead: string,
  passedAgainst: string,
  head: string,
  tip: string,
): boolean =>
  passedHead !== "" &&
  passedAgainst !== "" &&
  movedSince(passedHead, passedAgainst, head, tip) === null;

/**
 * The pull request of a `pr-open` run and what its last recorded pass ran against, for the pass
 * to compare with GitHub before it starts the gate (see `lastPass`).
 */
export interface LastPass {
  readonly pr: number;
  /** The head the pass ran on. */
  readonly head: string;
  /** The base branch tip it ran against; empty when the ledger has none. */
  readonly base: string;
}

/**
 * What `regate` does first for a run, read from its ledger alone: nothing (`not-ready`: the run
 * is finished, is not `pr-open`, has no session or no pull request, or a feedback relaunch that
 * is decided and not committed is the feedback step's to finish, and the run is never gated
 * meanwhile); the stuck decision it recorded; the relaunch an earlier call decided and did not
 * record; the re-gate an earlier call began (`resume`); or the comparison of the pull request
 * and the base tip with its last pass (`compare`). `regate` follows it, and `lastPass` answers
 * only for `compare`, so a state one of them resumes is never one the other skips.
 */
type RegateEntry =
  | { readonly kind: "not-ready" }
  | { readonly kind: "stuck"; readonly reason: string }
  | { readonly kind: "relaunch"; readonly relaunch: Relaunch }
  | { readonly kind: "resume" }
  | { readonly kind: "compare" };

const regateEntry = (seen: Seen): RegateEntry => {
  if (seen.threadId === null || seen.lastPr === null || seen.finished) return { kind: "not-ready" };
  if (seen.stuck !== null) return { kind: "stuck", reason: seen.stuck };
  if (seen.state !== "pr-open") return { kind: "not-ready" };
  if (seen.relaunch !== null && regateAttempt(seen.relaunch) === null) return { kind: "not-ready" };
  const pending = pendingRelaunch(seen);
  if (pending !== null) return { kind: "relaunch", relaunch: pending };
  if (seen.regating) return { kind: "resume" };
  return { kind: "compare" };
};

/**
 * What `regate` compares the pull request and the base tip with, when that comparison is the
 * first thing it would do for the run (`regateEntry` says `compare`), its worktree line is
 * written and no checkout of an earlier gate is left on disk. `null` for any other run, which is
 * left to the gate. Reads the ledger and the run's gate directory only.
 */
export const lastPass = (
  dataDir: string,
  run: RunId,
): Effect.Effect<LastPass | null, LedgerError> =>
  ledger(() => {
    const seen = readProgress(readRun(dataDir, run).entries);
    if (regateEntry(seen).kind !== "compare" || seen.lastPr === null || seen.pass === null) {
      return null;
    }
    if (!seen.worktreeDone || leftoverCheckouts(dataDir, run).length > 0) return null;
    return { pr: seen.lastPr.pr, head: seen.pass.sha, base: seen.pass.baseSha };
  });

/**
 * Gates a pull request that is ready for review again when its head or the base branch has moved,
 * and ends the run when the pull request has been merged or closed. Call it for a run that is
 * `pr-open` and not finished, on every pass.
 *
 * The run stays open while its pull request waits for a person: `finished` is the summary line
 * and is written when the pull request ends (or the run goes `stuck`), not when the issue reaches
 * `pr-open`. A run that reached `pr-open` before the pass removed worktrees has its session
 * archived and its worktree removed first, once (see `stopSession`).
 *
 * Each call reads the pull request and the tip of the base branch: two API reads for a quiet
 * pass, and nothing else. A pull request that is merged or closed (or gone) finishes the run at
 * once: the session's thread is archived, then the summary line, the only other write, and the
 * answer is `ended`; nothing is gated and nothing is posted. When the head and the tip are the
 * ones the last recorded pass ran against the answer is `unchanged`. A head or a tip that differs
 * (a push to the branch, by anyone, or a moved base) writes a `gate_regate` line and runs the
 * gate on the head merged with the tip, as `gate` runs it, as a new attempt: the pass closed its
 * own. A re-gate that fails or conflicts goes to a new session like any failure, and
 * `gate_retries` counts the failures since the last pass, so a run that passed has its whole
 * send-back budget again. A base that moves again while it runs sends it round again, up to
 * `limits.regates` re-gates since the last pass, and then the issue goes `stuck` with a fixed
 * reason.
 *
 * A pass posts a new comment naming the base it ran against, and the pull request stays ready;
 * the project's required checks are not waited for again (softfac's rule). A failure puts the
 * pull request back to draft, assigns the issue and labels it `building`, and
 * starts a new session from the pull request's branch on `origin` with the failure in its first
 * message (see `relaunchForRegate`): the old session was stopped, and its worktree removed, when
 * the gate passed, so it does not matter whether its thread is still there. A relaunch that an
 * earlier call decided (its `regate_relaunching` line) and did not record is finished first,
 * without the gate and whatever the pull request, the issue or the base look like now (see
 * `resumeRelaunch`). The gate checks the issue text before it records a pass, as `gate` does. A
 * feedback relaunch that is decided and not committed is the feedback step's, never this one's:
 * the answer is `not-ready` with nothing written. Every call it can make can be made again after
 * a crash: the GitHub call comes first and the ledger line after it, the `state_changed` line is
 * last and is the commit marker, the comment is at-least-once, and a re-gate that was cut short
 * is resumed from the ledger without being counted twice, and its pass sets the ready state again,
 * as a stuck decision the earlier call did not finish may have put the pull request back to
 * draft. A pull request merged or closed while a re-gate was under way ends the run, as one found
 * before a re-gate does; an issue a person closed meanwhile abandons it. The answer also says
 * what moved since the last pass, for the run's line; a re-gate that an earlier call began says
 * what that call's line recorded.
 */
export const regate = (ctx: GateContext, run: RunId): Effect.Effect<Regated, GateStepError> =>
  withLedger(ctx, run, (out) =>
    Effect.gen(function* () {
      if (asciiLower(run.repo) !== asciiLower(ctx.repo)) {
        return yield* new WrongRepoError({ run, repo: ctx.repo });
      }
      const seen = readProgress((yield* ledger(() => readRun(ctx.dataDir, run))).entries);
      yield* removeLeftovers(ctx, out, run, seen);
      const entry = regateEntry(seen);
      const last = seen.lastPr;
      if (entry.kind === "not-ready" || last === null) return { step: NOT_READY, moved: null };
      const issue = Number(run.issue);
      const at = progressFrom("gate", seen, "triage");
      if (entry.kind === "stuck") {
        const step = yield* stuckWith(ctx, out, issue, at, "stuck-resumed", {
          reason: entry.reason,
        });
        return { step, moved: null };
      }
      // A relaunch that an earlier call decided comes first, whatever the pull request, the
      // issue or the base look like now: the thread it made is on no run until it is finished.
      if (entry.kind === "relaunch") {
        const step = yield* resumeRelaunch(
          ctx,
          out,
          issue,
          at,
          run,
          { pr: last.pr, prUrl: last.url },
          entry.relaunch,
        );
        return { step, moved: seen.regateMoved };
      }
      let regates = seen.regates;
      if (entry.kind === "resume") {
        // A re-gate that an earlier call began. Its pass is recorded and the results are not
        // posted yet; or its failure is recorded as sent and the transition is not committed; or
        // it is to be run again, under the same attempt number.
        if (seen.regatePassed && seen.pass !== null) {
          const pull = yield* ctx.tracker.pullRequest(last.pr);
          if (pull === null || !pull.open) {
            yield* endRun(ctx, yield* out.open, at, last.url, pull, "gate");
            return { step: { kind: "ended" }, moved: null };
          }
          // The call that began it may have drafted the pull request on a stuck path it did not
          // finish before the pass was recorded: the ready state is set again.
          const step = yield* finishRegatePass(ctx, out, issue, at, seen.pass, last.pr, true);
          return { step, moved: seen.regateMoved };
        }
        if (seen.regateSentBack && seen.sending !== null) {
          const step = yield* finishRegateFailure(
            ctx,
            out,
            issue,
            at,
            last.pr,
            seen.sending.attempt,
          );
          return { step, moved: seen.regateMoved };
        }
        // The pull request first, as before a re-gate: one merged or closed while the re-gate
        // ran ends the run, whoever closed the issue. Then a re-gate under way for an issue a
        // person closed is not run again.
        const pull = yield* ctx.tracker.pullRequest(last.pr);
        if (pull === null || !pull.open) {
          yield* endRun(ctx, yield* out.open, at, last.url, pull, "gate");
          return { step: { kind: "ended" }, moved: null };
        }
        if ((yield* ctx.tracker.issue(issue)).closed) {
          yield* abandon(ctx, yield* out.open, run, seen, "gate");
          return { step: { kind: "abandoned" }, moved: null };
        }
      } else {
        // A run that reached `pr-open` before a pass removed worktrees still has its session and
        // its worktree: they go now, as the pass would have taken them, with nothing else
        // written. Once the worktree line is there this is never done again.
        if (!seen.worktreeDone) yield* stopSession(ctx, yield* out.open, at);
        // The pull request first: a merge or a close is noticed at once, and a push to the
        // branch is a head the last pass did not see. Then the base branch.
        const pull = yield* ctx.tracker.pullRequest(last.pr);
        if (pull === null || !pull.open) {
          yield* endRun(ctx, yield* out.open, at, last.url, pull, "gate");
          return { step: { kind: "ended" }, moved: null };
        }
        const head = pull.headSha.toLowerCase();
        const tip = (yield* ctx.tracker.branchTip(ctx.project.base)).toLowerCase();
        const passedHead = seen.pass?.sha ?? "";
        const passedAgainst = seen.pass?.baseSha ?? "";
        if (unchangedSince(passedHead, passedAgainst, head, tip)) {
          return { step: { kind: "unchanged" }, moved: null };
        }
        if (!isCommitId(head)) {
          return yield* new WorkspaceUnexpectedError({
            what: "the pull request's head is not a commit id",
          });
        }
        // Only a gate that is about to run asks: a person who closed the issue has taken the work
        // over, as for a run in any other state, and the pull request is left as it is (nothing
        // is written on GitHub). A merge by the run's own pull request was found above.
        if ((yield* ctx.tracker.issue(issue)).closed) {
          yield* abandon(ctx, yield* out.open, run, seen, "gate");
          return { step: { kind: "abandoned" }, moved: null };
        }
        yield* append(
          out,
          {
            event: "gate_regate",
            data: { sha: head, base_sha: tip, previous_base_sha: passedAgainst },
          },
          "gate",
          "gate-regated",
        );
        regates += 1;
      }
      const step = yield* gateAttempts(
        ctx,
        out,
        run,
        seen,
        at,
        readyMode(ctx, out, run, seen, at, {
          resumed: entry.kind === "resume",
          pr: last.pr,
          prUrl: last.url,
          regates,
        }),
      );
      // What moved is read from the ledger, not kept from above: a base that moved again while
      // the commands ran had `gateAttempts` write another `gate_regate` line, and a call resumed
      // later reads the newest one, so the live answer is the same as the resumed one.
      const after = readProgress((yield* ledger(() => readRun(ctx.dataDir, run))).entries);
      return { step, moved: after.regateMoved };
    }),
  );
