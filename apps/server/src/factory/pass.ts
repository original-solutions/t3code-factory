/**
 * One pass of the factory: the watched repos (T3's projects that opt in), the project config and
 * tracker login of each, every
 * unfinished run, the claims that have no run, then new issues. Ported from softfac's `tick.rs`
 * (`run_keeping`, `load_repos`, `runs`, `untracked_claims`, `unassigned_claims` and `claim`) up
 * to the claim; the steps that follow a run (issues #16 to #20) and the dry run are not here.
 *
 * Pure over `PassWorld`: every read and write goes through it, so the tests script a world and
 * `index.ts` builds the live one. Every line goes to `out` as it is decided. Each pass writes
 * `pass_started` first and `pass_finished` last to the machine log.
 */
import * as Effect from "effect/Effect";

import type { Attention, NewItem } from "./attention.ts";
import type { HandPause } from "./claims.ts";
import {
  ambiguousMessage,
  ambiguousRepos,
  type MachineConfig,
  type ProjectConfig,
  type WatchedListing,
  type WatchedRepo,
} from "./config.ts";
import { stateLabel, type State } from "./domain/lifecycle.ts";
import type { LedgerError } from "./ledger/errors.ts";
import type { CauseStep, ErrorKind, MachineEvent } from "./ledger/events.ts";
import { holdsSlot, type RunInfo } from "./ledger/listRuns.ts";
import { asciiLower, runIdToString, type RunId } from "./ledger/runId.ts";
import { duration, formatTs } from "./ledger/time.ts";
import type {
  AdvanceOutcome,
  BadEnd,
  BuildingError,
  Evidence,
  ForwardOutcome,
  InterruptOutcome,
  LimitOutcome,
  WatchOutcome,
} from "./runner/building.ts";
import type { FeedbackError, FeedbackStep } from "./runner/feedback.ts";
import { unchangedSince, type GateStepError, type LastPass } from "./runner/gating.ts";
import { mention, type StartError, type StartOutcome } from "./runner/start.ts";
import type { SessionsError } from "./t3/sessions.ts";
import type { StopRequestOutcome } from "./runner/stop.ts";
import { sanitize } from "./text.ts";
import { LIST_LIMIT, type Blocker, type Listing, type UnassignedClaim } from "./tracker/github.ts";

/** An error of the pass's own: what kind it is for the machine log, and what it says. */
export interface PassError {
  readonly kind: ErrorKind;
  readonly message: string;
}

/** A watched repo with its project config and the login its tracker knows the factory by. */
export interface Repo {
  readonly watched: WatchedRepo;
  readonly project: ProjectConfig;
  readonly trackerUser: string;
}

/** A watched repo, with its config or without it. */
export type Loaded =
  | { readonly kind: "ready"; readonly repo: Repo }
  /** The name of a repo that could not be loaded, already reported. */
  | { readonly kind: "broken"; readonly name: string };

/** What the tracker's cut-short scan found: see `unassignedClaims` on the tracker. */
export interface ClaimScanResult {
  readonly claims: ReadonlyArray<UnassignedClaim>;
  /** Issues whose label history could not be read, each with the tracker's message. */
  readonly unread: ReadonlyArray<{ readonly issue: number; readonly message: string }>;
}

/** Everything a pass reads and writes. */
export interface PassWorld {
  /**
   * The repos to watch, read anew at the start of each pass: the environment's T3 projects whose
   * checkout opts in, and the opted-in checkouts the reader could not identify this time.
   */
  readonly watchedRepos: Effect.Effect<WatchedListing, PassError>;
  /** The repo's project config, from `.dw/config.yml` at the tip of its default branch. */
  readonly project: (repo: WatchedRepo) => Effect.Effect<ProjectConfig, PassError>;
  /** The login the repo's tracker knows the factory by. */
  readonly trackerUser: (repo: WatchedRepo) => Effect.Effect<string, PassError>;
  /** Every run that is not finished, oldest first; with `only`, the runs of that one issue. */
  readonly unfinishedRuns: (only?: {
    readonly repo: string;
    readonly issue: number;
  }) => Effect.Effect<ReadonlyArray<RunInfo>, LedgerError>;
  /** The open `factory:ready` issues nobody is assigned to, and whether the listing was cut. */
  readonly readyIssues: (repo: Repo) => Effect.Effect<Listing<number>, PassError>;
  /** The open `factory:triage` issues the factory's login is the only assignee of. */
  readonly triageIssues: (repo: Repo) => Effect.Effect<Listing<number>, PassError>;
  /**
   * The claims of this factory's that were cut short: see `unassignedClaims` on the tracker.
   * `known` is the issues the pass has a run for, whose label history is not read.
   */
  readonly unassignedClaims: (
    repo: Repo,
    known: ReadonlySet<number>,
  ) => Effect.Effect<ClaimScanResult, PassError>;
  /** Moves a claim that was cut short to `factory:proposed`, with the cut-short comment. */
  readonly releaseClaim: (repo: Repo, issue: number, from: State) => Effect.Effect<void, PassError>;
  /** The open issues the tracker marks as blocking the issue. */
  readonly openBlockers: (
    repo: Repo,
    issue: number,
  ) => Effect.Effect<ReadonlyArray<Blocker>, PassError>;
  /** The open issues the issue's `## Depends on` text names. */
  readonly dependsOnBlockers: (
    repo: Repo,
    issue: number,
  ) => Effect.Effect<ReadonlyArray<Blocker>, PassError>;
  /** The claim: `runner/start.ts`. */
  readonly start: (repo: Repo, issue: number) => Effect.Effect<StartOutcome, StartError>;
  /** The claim gone on with, never made: `resume` in `runner/start.ts`. */
  readonly resume: (repo: Repo, issue: number) => Effect.Effect<StartOutcome, StartError>;
  /**
   * Takes the stop request an operator left for the run (`factory/scripts/stop-run.sh`) into its
   * ledger: `runner/stop.ts` `takeStopRequest`.
   */
  readonly takeStopRequest: (run: RunId) => Effect.Effect<StopRequestOutcome, LedgerError>;
  /** The time limit: `runner/building.ts` `timeLimit`. */
  readonly timeLimit: (repo: Repo, run: RunId) => Effect.Effect<LimitOutcome, BuildingError>;
  /** The text watch: `watch`. */
  readonly watch: (repo: Repo, run: RunId) => Effect.Effect<WatchOutcome, BuildingError>;
  /** The instructors' comments and edits of the issue body, sent to the session: `forward`. */
  readonly forward: (repo: Repo, run: RunId) => Effect.Effect<ForwardOutcome, BuildingError>;
  /** The session's result: `advance`. */
  readonly advance: (repo: Repo, run: RunId) => Effect.Effect<AdvanceOutcome, BuildingError>;
  /**
   * The newest sign of T3 trouble in the machine log within the last ten minutes (a failed `t3`
   * preflight or an `error` of kind `t3`), as its text; null for none. Read once a pass, and only
   * when a session ended badly.
   */
  readonly t3Trouble: () => Effect.Effect<string | null, LedgerError>;
  /** The server starts recorded in the machine log in the last day (`server_started`), oldest first: the rest of the evidence `interrupted` gets. */
  readonly t3Starts: () => Effect.Effect<ReadonlyArray<number>, LedgerError>;
  /** The `server_stopping` each start of the last day follows, whatever its age, oldest first. */
  readonly t3Stops: () => Effect.Effect<ReadonlyArray<number>, LedgerError>;
  /** Decides about a session `advance` said ended badly, with the pass's evidence: `interrupted`. */
  readonly interrupted: (
    repo: Repo,
    run: RunId,
    evidence: Evidence,
  ) => Effect.Effect<InterruptOutcome, BuildingError>;
  /** Whether the run's gate is running now. */
  readonly gateRunning: (run: RunId) => boolean;
  /**
   * Whether a gate send is pending in the run's ledger (`gateSendPending`): only the gate records
   * that the send arrived, so a pass that finds one calls the gate whatever the session is doing.
   */
  readonly hasPendingGateSend: (run: RunId) => Effect.Effect<boolean, LedgerError>;
  /**
   * Starts the run's gate (`runner/gating.ts`) in the background and returns at once: a pass
   * never waits for a gate. The ledger has the result, and the next pass carries on from there.
   */
  readonly gate: (repo: Repo, run: RunId) => Effect.Effect<GateStart>;
  /**
   * The instructors' feedback on a `pr-open` run's pull request and issue, acted on at most once
   * every ten minutes per run: `runner/feedback.ts`. A run it acts on is not gated this pass.
   */
  readonly feedback: (repo: Repo, run: RunId) => Effect.Effect<FeedbackStep, FeedbackError>;
  /**
   * What a `pr-open` run's last recorded pass ran against, when the pass can compare it with
   * GitHub before it starts the gate; null for a run the gate has more to do for:
   * `runner/gating.ts` `lastPass`.
   */
  readonly lastPass: (run: RunId) => Effect.Effect<LastPass | null, LedgerError>;
  /** The tip of the repo's base branch, in lower case. */
  readonly baseTip: (repo: Repo) => Effect.Effect<string, PassError>;
  /** Whether GitHub has the issue closed. */
  readonly issueClosed: (repo: Repo, issue: number) => Effect.Effect<boolean, PassError>;
  /** When the issue of each stuck attention item was last read, by item id, in epoch milliseconds; kept from pass to pass. */
  readonly stuckReads: Map<string, number>;
  /** The head of the open pull request, in lower case; null for one that is merged, closed or gone. */
  readonly openHead: (repo: Repo, pr: number) => Effect.Effect<string | null, PassError>;
  /** Appends an `error` line to the run's own ledger. */
  readonly recordError: (
    run: RunId,
    step: CauseStep,
    kind: ErrorKind,
    message: string,
  ) => Effect.Effect<void, LedgerError>;
  /** The claims pause a person made, when there is one. */
  readonly handPause: () => HandPause | null;
  readonly nowMs: () => number;
  /** Writes one event to the machine log. */
  readonly record: (event: MachineEvent) => Effect.Effect<void, LedgerError>;
  /** The open attention items: what the pass raises when it needs a person, and what it clears. */
  readonly attention: Pick<Attention["Service"], "list" | "raise" | "clear">;
}

/** What starting a gate did: it runs now, or `max_concurrent_gates` are running already. */
export type GateStart =
  | { readonly kind: "started" }
  | { readonly kind: "queued"; readonly running: number; readonly max: number };

/** The line of a run that ended in `stuck`. The reason is not printed: it can hold text the session or GitHub wrote. */
export const stuckLine = (run: string): string =>
  `stuck, the reason is in the ledger of run ${run}`;

/** The attention item of a run that ended in `stuck`, whether a pass or a background gate saw it end. */
export const stuckItem = (repo: string, issue: number, run: string): NewItem => ({
  id: `run:${run}:stuck`,
  kind: "stuck",
  repo,
  issue,
  run,
  message: `${plain(repo)}${mention(issue)} ${stuckLine(run)}`,
});

/** The attention line for a run whose issue a person closed, after the issue's label. */
const abandonedText = (label: string): string =>
  `${label} Abandoned: the issue was closed, so the factory stopped the session and closed the run`;

/**
 * The item `abandoned` raises for a run whose issue a person closed, which the background gate
 * raises too when it is the step that finds the issue closed.
 */
export const abandonedItem = (repo: string, issue: number, run: string): NewItem => ({
  id: `attention:${run}:abandoned`,
  kind: "attention",
  repo,
  issue,
  run,
  message: abandonedText(`${plain(repo)}${mention(issue)}`),
});

/** The counts the pass prints in its last line. */
export interface Report {
  runs: number;
  claimed: number;
  errors: number;
  attention: number;
}

/** What the pass has to say about one issue, collected as its steps go and printed at the end. */
interface Notes {
  readonly repo: string;
  readonly issue: number;
  readonly label: string;
  readonly state: string;
  readonly parts: Array<string>;
  readonly errors: Array<NoteError>;
  /** The attention items to raise when the notes are flushed. */
  readonly raises: Array<NewItem>;
  /** How `advance` found the session's run ended, when it ended badly: the pass decides about it after every run. */
  endedBadly: BadEnd | null;
}

/** An error, as printed and as recorded. */
interface NoteError {
  /** The error line, without its `error: ` prefix. */
  readonly line: string;
  readonly step: CauseStep;
  readonly kind: ErrorKind;
  /** What went wrong, before it is cleaned for the ledger. */
  readonly message: string;
  /**
   * T3's session layer did not answer (a `FactorySessionsError`): the error also goes to the
   * machine log, where `t3Trouble` reads the sign that sessions ending badly were an interruption.
   * softfac has such a sign from its own T3 check of each repo, a server call; this factory's
   * project lookup is in-process and cannot fail when T3 is down, so the calls that do fail are
   * the sign.
   */
  readonly t3Down?: boolean;
}

/** `text` with nothing in it that could drive a terminal or hide text. */
export const plain = (text: string): string => sanitize(text, false);

/** An error of the pass's own, in the words `what` and `detail`. */
const passError = (kind: ErrorKind, what: string, detail: string): NoteError => ({
  line: `${plain(what)}${plain(detail)}`,
  step: "pass",
  kind,
  message: `${what}${detail}`,
});

/**
 * What an error of a run's step was about, for its `error` line. Every call `start` makes is a
 * tracker call, whatever host the tracker runs on; the gate's checkout is git.
 */
export const errorKind = (error: StartError | BuildingError | GateStepError): ErrorKind => {
  switch (error._tag) {
    case "WorkspaceFailedError":
    case "WorkspaceUnexpectedError":
    case "WorkspaceCleanupError":
    case "WorkspaceIoError":
    case "WorkspaceSpawnError":
      return "git";
    case "GitHubSpawnError":
    case "GitHubInvalidArgument":
    case "GitHubFailed":
    case "GitHubTimedOut":
    case "GitHubOutputTooLarge":
    case "GitHubParse":
    case "GitHubRateLimited":
      return "tracker";
    case "GateRunningError":
    case "GateCommandSpawnError":
    case "GateRecordError":
      return "gate";
    case "FactorySessionsError":
    case "FactoryThreadNotFoundError":
    case "FactoryMessageRejectedError":
      return "t3";
    case "WrongRepoError":
    case "NoGateCommandsError":
      return "config";
    default:
      // The run's own record disagrees with what the step expected.
      return "ledger";
  }
};

/**
 * The sessions operations that are a call on T3 itself: one that fails is T3 in trouble, the sign
 * `t3Trouble` reads. `launch` is left out, as it also fails on the worktree (git, `origin`) and on
 * bad ids, and so is `remove-worktree`, which is git on this machine.
 */
const T3_OPERATIONS: ReadonlySet<SessionsError["operation"]> = new Set([
  "find-project",
  "status",
  "thread",
  "send",
  "archive",
]);

/** Repos match as run ids do: `owner/name` folded with `asciiLower`. */
const sameRepo = (a: string, b: string) => asciiLower(a) === asciiLower(b);

const GATE_RUNNING = "gate running";
const PULL_REQUEST_ENDED = "its pull request was merged or closed, the run is finished";
/** The line of a building run whose gate this pass started. */
const GATE_STARTED = "gate started in the background";
/** The words for a gate that could not start: `max_concurrent_gates` are running. */
export const gateQueued = (start: { readonly running: number; readonly max: number }) =>
  `gate queued: ${start.running} gates running, max_concurrent_gates is ${start.max}`;
/** The line of a run whose gate passed. */
export const GATE_PASSED_LINE = "the gate passed and the pull request is ready for review";

const FROM_TEXT = " (from Depends on, add the GitHub link)";

/** `blocked by #13, acme/widgets#7`: a blocker in the repo being claimed from is written by its number alone. */
const blockedBy = (repo: string, blockers: ReadonlyArray<Blocker>, suffix: string): string =>
  `blocked by ${blockers
    .map((b) =>
      sameRepo(b.repo, repo)
        ? `${mention(b.number)}${suffix}`
        : `${plain(b.repo)}${mention(b.number)}${suffix}`,
    )
    .join(", ")}`;

const plural = (n: number, one: string) => (n === 1 ? one : `${one}s`);

/** The machine log's text limit, as softfac prepares session text: cleaned, trimmed, cut. */
const SESSION_TEXT_LIMIT = 4000;
const prepareText = (text: string): string => {
  const trimmed = text.replaceAll("\r\n", "\n").trim();
  const chars = Array.from(trimmed);
  const cut =
    chars.length > SESSION_TEXT_LIMIT
      ? `${chars.slice(0, SESSION_TEXT_LIMIT).join("")}\n[cut]`
      : trimmed;
  return sanitize(cut, true);
};

/** A pass in flight: the counts, the lines, and whether the machine log has failed once. */
class Pass {
  readonly report: Report = { runs: 0, claimed: 0, errors: 0, attention: 0 };
  private logFailed = false;
  private readonly world: PassWorld;
  private readonly out: (line: string) => void;

  constructor(world: PassWorld, out: (line: string) => void) {
    this.world = world;
    this.out = out;
  }

  line(text: string): void {
    this.out(text);
  }

  error(text: string): void {
    this.report.errors += 1;
    this.out(`error: ${text}`);
  }

  /**
   * A line a person has to act on about `run`, the machine log's `attention` event for it with
   * the ledger.md `reason` code, and an attention item whose message is the line.
   */
  attention(notes: Notes, text: string, run: string, reason: string): Effect.Effect<void> {
    this.report.attention += 1;
    this.out(`ATTENTION: ${text}`);
    return this.record({ event: "attention", data: { run, reason } }).pipe(
      Effect.andThen(
        this.world.attention.raise({
          id: `attention:${run}:${reason}`,
          kind: "attention",
          repo: notes.repo,
          issue: notes.issue,
          run,
          message: text,
        }),
      ),
    );
  }

  /**
   * Writes `event` to the machine log. A log that cannot be written is an error line once per
   * pass and nothing else: it is not an event, which could not be written either.
   */
  record(event: MachineEvent): Effect.Effect<void> {
    return this.world.record(event).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          if (this.logFailed) return;
          this.logFailed = true;
          this.error(`machine log: ${plain(error.message)}`);
        }),
      ),
    );
  }

  /**
   * Prints `error` as an error line and records it: as an `error` line in the ledger of `run`
   * when there is one that can take it, in the machine log otherwise (with the run's id when a
   * run's ledger could not take it). A run's error that says a T3 call failed (`t3Down`) goes to
   * both, so the machine log holds the T3 trouble of this pass for the next one to read.
   * `unreadable` is a run whose own ledger cannot be read.
   */
  fail(run: RunId | null, error: NoteError, unreadable = false): Effect.Effect<void> {
    this.error(error.line);
    const message = prepareText(error.message);
    const toMachineLog = (id: string | null) =>
      this.record({
        event: "error",
        data: { ...(id === null ? {} : { run: id }), step: error.step, kind: error.kind, message },
      });
    if (run === null) return toMachineLog(null);
    const id = runIdToString(run);
    if (unreadable) return toMachineLog(id);
    return this.world.recordError(run, error.step, error.kind, message).pipe(
      Effect.matchEffect({
        onFailure: () => toMachineLog(id),
        onSuccess: () => (error.t3Down === true ? toMachineLog(id) : Effect.void),
      }),
    );
  }

  notes(repo: string, issue: number, state: State | null): Notes {
    return {
      repo,
      issue,
      label: `${plain(repo)}${mention(issue)}`,
      state: state ?? "starting",
      parts: [],
      errors: [],
      raises: [],
      endedBadly: null,
    };
  }

  /** The step called `label` in the pass line failed for this issue; the ledger records it under `step`. */
  failed(notes: Notes, label: string, step: CauseStep, error: StartError | BuildingError): void {
    notes.errors.push({
      line: `${notes.label} ${label}: ${plain(error.message)}`,
      step,
      kind: errorKind(error),
      message: error.message,
      t3Down: error._tag === "FactorySessionsError" && T3_OPERATIONS.has(error.operation),
    });
  }

  /** An error of the pass's own about this issue, in the words `what` and `detail`. */
  trouble(notes: Notes, kind: ErrorKind, what: string, detail: string): void {
    const error = passError(kind, what, detail);
    notes.errors.push({ ...error, line: `${notes.label} ${error.line}` });
  }

  /** The run ended in `stuck`. */
  stuck(notes: Notes, run: string): void {
    notes.parts.push(stuckLine(run));
    notes.raises.push(stuckItem(notes.repo, notes.issue, run));
  }

  flush(notes: Notes, run: RunId | null): Effect.Effect<void> {
    if (notes.parts.length > 0) {
      this.line(`${notes.label} ${notes.state}: ${notes.parts.join(", ")}`);
    }
    return Effect.forEach(notes.raises, (item) => this.world.attention.raise(item), {
      discard: true,
    }).pipe(
      Effect.andThen(
        Effect.forEach(notes.errors, (error) => this.fail(run, error), { discard: true }),
      ),
    );
  }

  sayIfCut(repo: string, state: State, cut: boolean): void {
    if (cut) {
      this.line(
        `${plain(repo)}: more than ${LIST_LIMIT} open ${stateLabel(state)} issues, so the oldest were not read`,
      );
    }
  }
}

/** One pass. Calls `out` with each line as it is decided. */
export const runPass = (
  world: PassWorld,
  machine: MachineConfig,
  out: (line: string) => void,
): Effect.Effect<Report> =>
  Effect.gen(function* () {
    const pass = new Pass(world, out);
    yield* pass.record({ event: "pass_started", data: {} });
    const listed = yield* Effect.result(world.watchedRepos);
    if (listed._tag === "Failure") {
      // Without the list nothing is worked, and nothing is cleared: a repo that is missing from
      // an unread list has not left it.
      yield* pass.fail(null, passError(listed.failure.kind, "", listed.failure.message));
    }
    const listing =
      listed._tag === "Success" ? listed.success : { repos: [], departed: [], unresolved: [] };
    const watched = listing.repos;
    // A repo whose T3 project was deleted has nothing the factory still needs a person for. Only
    // the reader's `departed` says so: a repo whose project stays (a branch without the opt-in,
    // an unreadable checkout) keeps its items, since `stuck` and `needs-info` are raised once.
    if (listed._tag === "Success") {
      yield* world.attention.clear(
        (item) => item.repo !== null && listing.departed.some((repo) => sameRepo(repo, item.repo!)),
      );
      if (listing.unresolved.length > 0) {
        pass.line(
          `watched: ${listing.unresolved.length} project(s) could not be settled this pass (${listing.unresolved.map(plain).join(", ")})`,
        );
      }
    }
    const repos = yield* loadRepos(world, watched, pass);
    // Without the ledger there is no telling how many runs are active, so nothing is claimed.
    const infos = yield* runs(world, pass);
    if (infos !== null) {
      const known = new Known(infos);
      yield* workRuns(world, repos, known, pass);
      yield* untrackedClaims(world, repos, known, pass);
      yield* unassignedClaims(world, repos, known, pass);
      yield* claim(world, repos, known, machine, pass);
      // Last: a claim of an issue put back to `ready` ends its older pr-open run, and a re-gate
      // takes a gate slot.
      yield* prOpenRuns(world, repos, known, pass);
      // A run-bound attention item whose run is no longer unfinished (stopped, abandoned, timed
      // out, claimed on) is over. `stuck` and `needs-info` items are about finished runs and stay.
      if (!known.lost) {
        yield* world.attention.clear(
          (item) =>
            item.kind === "attention" &&
            item.run !== null &&
            !known.infos.some((info) => runIdToString(info.id) === item.run),
        );
      }
    }
    yield* closedStuck(world, repos, pass);
    const report = pass.report;
    pass.line(
      `pass done: ${report.runs} runs, ${report.claimed} claimed, ${report.errors} errors, ${report.attention} need attention`,
    );
    yield* pass.record({ event: "pass_finished", data: { ...report } });
    return report;
  });

/**
 * How often the issue of one stuck item is read at most. Stuck items stay until a person or the
 * issue closes them, so they pile up: at 40 of them a 60 second poll would spend 2,400 reads an
 * hour of the login's 5,000 points. At one read in 10 minutes it is about 240.
 */
export const STUCK_READ_EVERY_MS = 10 * 60 * 1000;

/**
 * Clears the item of a stuck run whose issue GitHub has closed: a person is done with it, or its
 * pull request merged and closed it. Only stuck items of the repos loaded this pass are asked
 * about, each at most once every `STUCK_READ_EVERY_MS`. An item whose issue cannot be read stays,
 * with a line that is not an error: an issue that can never be read again (deleted, transferred)
 * must not fail every pass.
 */
const closedStuck = (
  world: PassWorld,
  repos: ReadonlyArray<Loaded>,
  pass: Pass,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const items = yield* world.attention.list();
    for (const id of world.stuckReads.keys()) {
      if (!items.some((item) => item.id === id)) world.stuckReads.delete(id);
    }
    const now = world.nowMs();
    for (const item of items) {
      const { repo: name, issue } = item;
      if (item.kind !== "stuck" || name === null || issue === null) continue;
      const loaded = repos.find((l) => l.kind === "ready" && sameRepo(l.repo.watched.repo, name));
      if (loaded === undefined || loaded.kind !== "ready") continue;
      const last = world.stuckReads.get(item.id);
      if (last !== undefined && now >= last && now - last < STUCK_READ_EVERY_MS) continue;
      world.stuckReads.set(item.id, now);
      const closed = yield* Effect.result(world.issueClosed(loaded.repo, issue));
      if (closed._tag === "Failure") {
        pass.line(
          plain(
            `${name}${mention(issue)}: cannot read whether the issue is closed: ${closed.failure.message}`,
          ),
        );
      } else if (closed.success) {
        yield* world.attention.clear((open) => open.id === item.id);
        world.stuckReads.delete(item.id);
      }
    }
  });

/**
 * The project config and tracker login of every watched repo. A repo whose config cannot be
 * loaded is reported and its issues are left alone; so is one whose tracker login cannot be read,
 * and one that two T3 projects name (`ambiguousRepos`).
 */
const loadRepos = (
  world: PassWorld,
  watchedRepos: ReadonlyArray<WatchedRepo>,
  pass: Pass,
): Effect.Effect<Array<Loaded>> =>
  Effect.gen(function* () {
    const repos: Array<Loaded> = [];
    const ambiguous = ambiguousRepos(watchedRepos);
    const said = new Set<string>();
    for (const watched of watchedRepos) {
      const key = asciiLower(watched.repo);
      const paths = ambiguous.get(key);
      if (paths !== undefined) {
        // Said once per repo, not per project: the repo is skipped whole.
        if (!said.has(key)) {
          said.add(key);
          const message = `${watched.repo}: ${ambiguousMessage(paths)}`;
          pass.error(plain(message));
          yield* pass.record({
            event: "repo_skipped",
            data: {
              repo: watched.repo,
              reason: "ambiguous-project",
              message: prepareText(message),
            },
          });
          repos.push({ kind: "broken", name: watched.repo });
        }
        continue;
      }
      const project = yield* Effect.result(world.project(watched));
      if (project._tag === "Failure") {
        const message = project.failure.message;
        pass.error(
          `${plain(watched.repo)}: project config not loaded, repo skipped: ${plain(message)}`,
        );
        yield* pass.record({
          event: "repo_skipped",
          data: { repo: watched.repo, reason: "config-not-loaded", message: prepareText(message) },
        });
        repos.push({ kind: "broken", name: watched.repo });
        continue;
      }
      const user = yield* Effect.result(world.trackerUser(watched));
      if (user._tag === "Failure") {
        yield* pass.fail(
          null,
          passError(
            user.failure.kind,
            `${watched.repo}: cannot read the tracker's login: `,
            user.failure.message,
          ),
        );
        repos.push({ kind: "broken", name: watched.repo });
        continue;
      }
      repos.push({
        kind: "ready",
        repo: { watched, project: project.success, trackerUser: user.success },
      });
    }
    return repos;
  });

/** Every unfinished run, counted; a run whose file cannot be read is an error line and counts as active. */
const runs = (world: PassWorld, pass: Pass): Effect.Effect<ReadonlyArray<RunInfo> | null> =>
  Effect.gen(function* () {
    const listed = yield* Effect.result(world.unfinishedRuns());
    if (listed._tag === "Failure") {
      yield* pass.fail(
        null,
        passError("ledger", "cannot read the run ledger: ", listed.failure.message),
      );
      return null;
    }
    for (const info of listed.success) {
      pass.report.runs += 1;
      if (info.unreadable) {
        const id = runIdToString(info.id);
        // Its own ledger is what cannot be read, so the machine log takes the error.
        yield* pass.fail(
          info.id,
          passError(
            "ledger",
            `run ${id}: its ledger file cannot be read, so nothing was done for it and it counts as active`,
            "",
          ),
          true,
        );
        continue;
      }
    }
    return listed.success;
  });

/**
 * Works each confirmed run: a stop request an operator left for it is taken into its ledger, then
 * the time limit, for every state (the runner decides which runs it applies to). A run in `triage` (or with no state yet) is gone on with by `resume`, from
 * its ledger, so a run cut short after the launch was sent is finished and its session never runs
 * on untracked. A building run has its text watched and its session's result read by `advance`
 * on every pass, as softfac's `building` does, also once its session has reported its pull
 * request: `advance` puts a pull request someone took out of draft back to draft and judges the
 * session's latest run, and only when it says `ready-for-gate` is the gate started, in the
 * background (softfac's `softfac gate` child). A run left in `needs-info` or `stuck` (an end cut short) is finished by `advance`, so its
 * thread is archived and its slot freed. A run in `pr-open` is not worked here: `prOpenRuns`
 * gates it again at the end. A run of a repo that is not loaded is left alone. None of it is a new
 * claim, so none is counted as one. An issue put back to `ready` is left to the claim step, which
 * finishes its run when it claims the issue.
 */
const workRuns = (
  world: PassWorld,
  repos: ReadonlyArray<Loaded>,
  known: Known,
  pass: Pass,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    // The runs whose session `advance` found ended badly: they are decided together below.
    const ended: Array<EndedBadly> = [];
    for (const info of [...known.infos]) {
      if (info.unreadable || !info.confirmed) continue;
      // A pull request that waits for a person is gated again after the others (`prOpenRuns`).
      if (info.state === "pr-open") continue;
      const loaded = repos.find(
        (l) => l.kind === "ready" && sameRepo(l.repo.watched.repo, info.id.repo),
      );
      if (loaded === undefined || loaded.kind !== "ready") continue;
      const repo = loaded.repo;
      const name = repo.watched.repo;
      const issue = Number(info.id.issue);
      const notes = pass.notes(name, issue, info.state);
      if (world.gateRunning(info.id)) {
        // The gate has the run: nothing else is done for it (softfac's `work_runs`). A stop
        // request waits, so the gate's own result decides the state first.
        notes.parts.push(GATE_RUNNING);
      } else if (yield* takeStopRequestThenWithin(world, repo, info, notes, pass)) {
        if (inTriage(info)) yield* resumeRun(world, repo, info, notes, pass);
        else if (info.state === "building") yield* followBuilding(world, repo, info, notes, pass);
        // A run left in `needs-info` or `stuck` has its end done by `advance` (softfac's `finishing`).
        else if (info.state === "needs-info" || info.state === "stuck") {
          yield* advanceRun(world, repo, info, notes, pass);
        }
      }
      if (notes.endedBadly !== null) ended.push({ info, repo, what: notes.endedBadly });
      yield* known.refresh(world, pass, name, issue);
      yield* pass.flush(notes, info.id);
    }
    yield* decideInterruptions(world, ended, pass);
  });

/** A run `advance` found ended badly, with the repo it is in. */
interface EndedBadly {
  readonly info: RunInfo;
  readonly repo: Repo;
  readonly what: BadEnd;
}

/** How a pass says a session ended, from what `advance` called it. */
const endedAs = (what: BadEnd): string =>
  what === "thread-gone" ? "the T3 thread is gone" : `session ended as ${what}`;

/**
 * Decides, for the sessions `advance` found ended badly in this pass, whether each is an
 * interruption or a stop (`interrupted` in `runner/building.ts`). The evidence is the same for all
 * of them: the newest T3 trouble in the machine log, and how many sessions ended badly. The log
 * is read once, and not at all when none did. A log that cannot be read is an error line, and then
 * only two or more sessions that ended badly are decided; a lone one waits for the next pass.
 */
const decideInterruptions = (
  world: PassWorld,
  ended: ReadonlyArray<EndedBadly>,
  pass: Pass,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (ended.length === 0) return;
    const trouble = yield* Effect.result(
      Effect.all([world.t3Trouble(), world.t3Starts(), world.t3Stops()], { concurrency: 1 }),
    );
    let t3Error: string | null = null;
    let t3Starts: ReadonlyArray<number> = [];
    let t3Stops: ReadonlyArray<number> = [];
    if (trouble._tag === "Failure") {
      yield* pass.fail(
        null,
        passError(
          "ledger",
          "cannot read the machine log for T3 trouble: ",
          trouble.failure.message,
        ),
      );
      // Without the log a lone session cannot be told from a stop, and a stop cannot be undone:
      // those runs stay as they are and `advance` reports them again next pass. Two or more need
      // no log.
      if (ended.length < 2) return;
    } else {
      [t3Error, t3Starts, t3Stops] = trouble.success;
    }
    const evidence: Evidence = { t3Error, endedInPass: ended.length, t3Starts, t3Stops };
    for (const { info, repo, what } of ended) {
      const notes = pass.notes(repo.watched.repo, Number(info.id.issue), info.state);
      const why = endedAs(what);
      const decided = yield* Effect.result(world.interrupted(repo, info.id, evidence));
      if (decided._tag === "Failure") {
        pass.failed(notes, "interrupted", "advance", decided.failure);
      } else {
        const outcome = decided.success;
        switch (outcome.kind) {
          case "resumed":
            notes.parts.push(
              `${why}; interrupted, sent it a resume (${outcome.resumes} of ${outcome.limit})`,
            );
            break;
          case "relaunched":
            yield* relaunched(
              pass,
              notes,
              why,
              ` (${outcome.resumes} of ${outcome.limit})`,
              outcome.start,
            );
            break;
          case "unchanged":
            notes.parts.push(`${why}, but ${outcome.why}; left alone`);
            break;
          case "stuck":
            pass.stuck(notes, runIdToString(info.id));
            break;
        }
      }
      yield* pass.flush(notes, info.id);
    }
  });

/**
 * What a pass says of the next attempt that a relaunch started: `counted` is the resume count,
 * when there is one to say.
 */
const relaunched = (
  pass: Pass,
  notes: Notes,
  why: string,
  counted: string,
  start: StartOutcome,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    switch (start.kind) {
      case "started":
        notes.parts.push(
          `${why}; interrupted, relaunched as run ${runIdToString(start.run)}${counted}`,
        );
        break;
      case "stuck":
        notes.parts.push(`${why}; interrupted, relaunched${counted}`);
        pass.stuck(notes, runIdToString(start.run));
        break;
      case "abandoned":
        notes.parts.push(`${why}; interrupted, relaunching${counted}`);
        yield* abandoned(pass, notes, null, start.mayHaveSession, start.error);
        break;
      case "skipped":
      case "refused":
        notes.parts.push(
          `${why}; interrupted, relaunching${counted}, the new attempt starts on the next pass`,
        );
        break;
    }
  });

/**
 * The gate started for every run whose issue is `pr-open`, once each, after the claims (softfac's
 * `pr_open_runs`), unless nothing moved since its last pass (see `unchanged`): such a run costs
 * no process and no gate slot, and the pass says nothing of it. A stop request left for the run
 * is dropped first, and the pass says so. The gate (`regate`) deals with a merged or closed pull request, a re-gate under
 * way, a relaunch not yet recorded, a run whose worktree line is not written yet, a checkout an
 * earlier gate left on disk, and a read that fails. A run of a repo that is not loaded is left
 * alone.
 */
const prOpenRuns = (
  world: PassWorld,
  repos: ReadonlyArray<Loaded>,
  known: Known,
  pass: Pass,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const tips = new Map<string, string | null>();
    for (const info of [...known.infos]) {
      if (info.unreadable || info.state !== "pr-open") continue;
      const loaded = repos.find(
        (l) => l.kind === "ready" && sameRepo(l.repo.watched.repo, info.id.repo),
      );
      if (loaded === undefined || loaded.kind !== "ready") continue;
      const repo = loaded.repo;
      const notes = pass.notes(repo.watched.repo, Number(info.id.issue), info.state);
      if (world.gateRunning(info.id)) {
        notes.parts.push(GATE_RUNNING);
      } else {
        // A stop asked for while the run was building waits for its gate (see `workRuns`). Once
        // the gate passed it is dropped here, before a failed re-gate relaunches a session.
        yield* takeStopRequest(world, pass, info, notes);
        // Instructor feedback comes before all of that: a run it acted on is not gated this
        // pass, whatever its head and its base did, because the gate runs when the new
        // session's first run ends.
        if (yield* actedOnFeedback(world, repo, info, notes, pass)) {
          // Said.
        } else if (!(yield* unchanged(world, repo, info.id, tips))) {
          yield* startGate(world, repo, info, notes);
        }
      }
      yield* pass.flush(notes, info.id);
    }
  });

/**
 * Calls the feedback step for a `pr-open` run and says what it did. True when it did anything,
 * which is when the run is not gated in this pass; false for a run with no new feedback, for which
 * nothing was written and nothing is said. A step that fails is said, and then the run is treated
 * as one with no feedback: a read that fails every pass must not keep a moved head or base from
 * being gated, or a merged pull request from being ended. The step does not take a gate lock:
 * gates run as fibers of this process and `gateRunning` was asked first.
 */
const actedOnFeedback = (
  world: PassWorld,
  repo: Repo,
  info: RunInfo,
  notes: Notes,
  pass: Pass,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const run = runIdToString(info.id);
    const stepped = yield* Effect.result(world.feedback(repo, info.id));
    if (stepped._tag === "Failure") {
      pass.failed(notes, "feedback", "forward", stepped.failure);
      return false;
    }
    const outcome = stepped.success;
    switch (outcome.kind) {
      case "none":
        return false;
      case "relaunched":
        notes.parts.push(
          `instructor feedback (${outcome.items} ${plural(outcome.items, "item")}) on PR https://github.com/${info.id.repo}/pull/${outcome.pr}: a new session was launched on its branch, the PR is a draft again`,
        );
        break;
      case "stuck":
        pass.stuck(notes, run);
        break;
      case "ended":
        notes.parts.push(PULL_REQUEST_ENDED);
        break;
      case "abandoned":
        yield* abandoned(pass, notes, run, []);
        break;
    }
    return true;
  });

/**
 * Whether `regate` would find the run's pull request and its repo's base tip where its last pass
 * left them, by the reads it makes before it answers `unchanged`. A run it would do more for, or
 * a read that fails, is not unchanged: the gate deals with it, and says what failed. `tips` holds
 * each repo's base tip as the pass first read it, by lowercase name, so it is read at most once a
 * pass. It is read before the pull request, and `null` once a read of the repo failed: the repo's
 * other runs then go to the gate without a read that could wait for its timeout again.
 */
const unchanged = (
  world: PassWorld,
  repo: Repo,
  run: RunId,
  tips: Map<string, string | null>,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const last = yield* Effect.result(world.lastPass(run));
    if (last._tag === "Failure" || last.success === null) return false;
    const key = asciiLower(repo.watched.repo);
    if (!tips.has(key)) {
      const read = yield* Effect.result(world.baseTip(repo));
      tips.set(key, read._tag === "Success" ? read.success : null);
    }
    const tip = tips.get(key) ?? null;
    if (tip === null) return false;
    const head = yield* Effect.result(world.openHead(repo, last.success.pr));
    if (head._tag === "Failure") {
      tips.set(key, null);
      return false;
    }
    if (head.success === null) return false;
    return unchangedSince(last.success.head, last.success.base, head.success, tip);
  });

/**
 * Takes the run's stop request into its ledger, and says so. A request that cannot be taken is an
 * error line and the file stays for the next pass; the run is worked all the same.
 */
const takeStopRequest = (
  world: PassWorld,
  pass: Pass,
  info: RunInfo,
  notes: Notes,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const taken = yield* Effect.result(world.takeStopRequest(info.id));
    if (taken._tag === "Failure") {
      pass.failed(notes, "stop request", "pass", taken.failure);
    } else if (taken.success === "recorded") {
      notes.parts.push("stop requested by hand");
    } else if (taken.success === "not-building") {
      notes.parts.push("stop request dropped: the run is not building");
    }
  });

/** Takes the stop request, then checks the time limit: true when the run is still to be worked. */
const takeStopRequestThenWithin = (
  world: PassWorld,
  repo: Repo,
  info: RunInfo,
  notes: Notes,
  pass: Pass,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    yield* takeStopRequest(world, pass, info, notes);
    return yield* withinLimit(world, repo, info, notes, pass);
  });

/** The time limit for the run. False when the run was stopped or the call failed: it is done for this pass. */
const withinLimit = (
  world: PassWorld,
  repo: Repo,
  info: RunInfo,
  notes: Notes,
  pass: Pass,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const outcome = yield* Effect.result(world.timeLimit(repo, info.id));
    if (outcome._tag === "Failure") {
      pass.failed(notes, "time limit", "pass", outcome.failure);
      return false;
    }
    if (outcome.success.kind === "stopped") {
      pass.stuck(notes, runIdToString(info.id));
      return false;
    }
    return true;
  });

/** `resume` for a run in `triage`. */
const resumeRun = (
  world: PassWorld,
  repo: Repo,
  info: RunInfo,
  notes: Notes,
  pass: Pass,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const issue = Number(info.id.issue);
    const outcome = yield* Effect.result(world.resume(repo, issue));
    if (outcome._tag === "Failure") {
      if (outcome.failure._tag === "GateRunningError") notes.parts.push(GATE_RUNNING);
      else pass.failed(notes, "start", "start", outcome.failure);
      return;
    }
    switch (outcome.success.kind) {
      case "started":
        notes.parts.push("session started, the issue is building");
        break;
      case "stuck":
        pass.stuck(notes, runIdToString(outcome.success.run));
        break;
      case "abandoned":
        yield* abandoned(
          pass,
          notes,
          runIdToString(info.id),
          outcome.success.mayHaveSession,
          outcome.success.error,
        );
        break;
      case "skipped":
      case "refused": {
        const moved = outcome.success.kind === "skipped" ? outcome.success.moved : undefined;
        if (moved === "ready") notes.parts.push(READY_AGAIN);
        else {
          const run = runIdToString(info.id);
          yield* stalled(pass, notes, run, outcome.success.reason, moved === "closed");
        }
        break;
      }
    }
  });

/** The line of a run whose gate was held back because something was sent to its session. */
const GATE_WAITS = "the gate waits for the next pass because a comment was sent";

/**
 * The watch, then `forward`, then `advance`, for a building run: what the session did, in a line.
 * A forward that failed may have sent something before it did, so it counts as having sent; a
 * pass where something was sent does not start the gate, since the message starts a new run
 * that the gate would judge too early. A forward that cannot write the ledger leaves the run
 * alone for the pass.
 */
const followBuilding = (
  world: PassWorld,
  repo: Repo,
  info: RunInfo,
  notes: Notes,
  pass: Pass,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const watched = yield* Effect.result(world.watch(repo, info.id));
    if (watched._tag === "Failure") return pass.failed(notes, "watch", "watch", watched.failure);
    if (watched.success.kind === "stopped") return pass.stuck(notes, runIdToString(info.id));
    let sent = false;
    const forwarded = yield* Effect.result(world.forward(repo, info.id));
    if (forwarded._tag === "Failure") {
      pass.failed(notes, "forward", "forward", forwarded.failure);
      if (errorKind(forwarded.failure) === "ledger") return;
      sent = true;
    } else {
      const { comments, bodyEdit, skipped } = forwarded.success;
      if (skipped === "abandoned") {
        return yield* abandoned(pass, notes, runIdToString(info.id), []);
      }
      if (comments > 0) notes.parts.push(`forwarded ${comments} ${plural(comments, "comment")}`);
      if (bodyEdit) notes.parts.push("forwarded the edited issue body");
      sent = comments > 0 || bodyEdit;
    }
    yield* advanceRun(world, repo, info, notes, pass, sent);
  });

/** Starts the run's gate in the background, and says so, or that it is queued. */
const startGate = (
  world: PassWorld,
  repo: Repo,
  info: RunInfo,
  notes: Notes,
): Effect.Effect<void> =>
  Effect.map(world.gate(repo, info.id), (start) => {
    notes.parts.push(start.kind === "started" ? GATE_STARTED : gateQueued(start));
  });

/**
 * `advance` for a run, and what it did in a line. The gate is not started when `sent` says
 * something was sent into the session this pass.
 */
const advanceRun = (
  world: PassWorld,
  repo: Repo,
  info: RunInfo,
  notes: Notes,
  pass: Pass,
  sent = false,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const run = runIdToString(info.id);
    const advanced = yield* Effect.result(world.advance(repo, info.id));
    // A `NotBuildingError` is a run that finished meanwhile: softfac prints it as an error too.
    if (advanced._tag === "Failure")
      return pass.failed(notes, "advance", "advance", advanced.failure);
    // softfac's `advance_and_gate`: the gate starts for a session that finished, and for a run with
    // a gate send pending while the session still lives, which only the gate can settle.
    let wantsGate = false;
    switch (advanced.success.kind) {
      case "running":
        notes.parts.push("session still running");
        break;
      case "reminded":
        notes.parts.push("session ended without a result line, sent it a reminder");
        break;
      case "paused":
        notes.parts.push(
          "session stopped by hand, waiting for an instructor's comment on the pull request or the issue",
        );
        break;
      case "ready-for-gate":
        notes.parts.push("session finished");
        wantsGate = true;
        break;
      case "passed":
        notes.parts.push(GATE_PASSED_LINE);
        break;
      case "needs-info":
        notes.parts.push(
          "session asked questions, the issue is now needs-info and the run is finished",
        );
        notes.raises.push({
          id: `run:${run}:needs-info`,
          kind: "needs-info",
          repo: notes.repo,
          issue: notes.issue,
          run,
          message: `${notes.label} needs-info, the session asked questions on the issue`,
        });
        break;
      case "stuck":
        pass.stuck(notes, run);
        break;
      case "ended":
        notes.parts.push(PULL_REQUEST_ENDED);
        break;
      case "abandoned":
        yield* abandoned(pass, notes, run, []);
        break;
      case "ended-badly":
        // Said at the decision, after every run has been through the pass.
        notes.endedBadly = advanced.success.what;
        break;
      case "relaunched":
        yield* relaunched(pass, notes, endedAs("thread-gone"), "", advanced.success.start);
        break;
    }
    const kind = advanced.success.kind;
    const mayGatePending =
      kind === "running" || kind === "reminded" || kind === "paused" || kind === "ready-for-gate";
    let pending = false;
    if (mayGatePending) {
      const read = yield* Effect.result(world.hasPendingGateSend(info.id));
      if (read._tag === "Failure") {
        return pass.trouble(notes, "ledger", "gate send check", read.failure.message);
      }
      pending = read.success;
    }
    if (wantsGate && sent && !pending) notes.parts.push(GATE_WAITS);
    else if (wantsGate || pending) yield* startGate(world, repo, info, notes);
  });

/**
 * The run's issue was closed by a person, so the run is over and its session stopped. Says so,
 * and asks for a person to look: that the issue was closed on purpose is their call to check.
 * `mayHaveSession` names the runs that sent a launch and never got a thread, whose session this
 * could not archive; each is raised with the command id to look for. `error` is why `start` could
 * not end a later run of the issue, which the next pass tries again.
 */
const abandoned = (
  pass: Pass,
  notes: Notes,
  run: string | null,
  mayHaveSession: ReadonlyArray<RunId>,
  error?: StartError,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    notes.parts.push("the issue is closed, the run is closed");
    if (error !== undefined) pass.failed(notes, "start", "start", error);
    if (run !== null) {
      yield* pass.attention(notes, abandonedText(notes.label), run, "abandoned");
    }
    for (const id of mayHaveSession) {
      const name = runIdToString(id);
      yield* pass.attention(
        notes,
        `${notes.label} the issue was closed, and a session may exist for ${name}: look for launch command id softfac:${name}:launch in T3 Code and archive that thread by hand`,
        name,
        "session-may-exist",
      );
    }
  });

/**
 * A ready issue the limit holds back only because of its own triage run whose session may be
 * running: only the claim would finish that run (`finishOlderRuns`), so the slot never frees.
 */
const waitsOnItself = (pass: Pass, notes: Notes, run: string): Effect.Effect<void> =>
  pass.attention(
    notes,
    `${notes.label} run ${run} is not progressing and holds a slot: its issue is ready again, and the new claim waits for a slot this run holds. Put the issue back to \`factory:triage\` assigned to the factory's user so \`start\` can finish this run, or free a slot`,
    run,
    "not-progressing",
  );

const READY_AGAIN = "its issue is ready again, so it is left to the claim step";

/** A confirmed run still in `triage` (or before any state): what `finishOlderRuns` would end. */
const inTriage = (run: RunInfo): boolean =>
  !run.unreadable && run.confirmed && (run.state === null || run.state === "triage");

/**
 * A confirmed run in `triage` that `resume` would not take, for `why`: a person moved or closed
 * its issue, so nothing in the pass will move it, and it holds a slot. softfac's `stalled` words.
 * A closed issue's run is ended by `start` when it finds the issue closed (`abandoned`); this is
 * for the run it left alone, so its line says how to let the start finish it.
 */
const stalled = (
  pass: Pass,
  notes: Notes,
  run: string,
  why: string,
  closed: boolean,
): Effect.Effect<void> => {
  const back =
    "put it back to `factory:triage` assigned to the factory's user so `start` can finish it";
  const advice = closed
    ? `If it was closed by mistake, reopen it and ${back}`
    : `If you moved the issue by hand, ${back}`;
  return pass.attention(
    notes,
    `${notes.label} run ${run} is not progressing and holds a slot: ${plain(why)}. ${advice}`,
    run,
    "not-progressing",
  );
};

/**
 * The unfinished runs as this pass knows them: listed once at the start of the pass, then the
 * runs of an issue read again after each `start` for it, so the ledger is not listed whole again.
 */
class Known {
  infos: ReadonlyArray<RunInfo>;
  /** An issue's runs could not be read again, so how many runs are active is not known. */
  lost = false;

  constructor(infos: ReadonlyArray<RunInfo>) {
    this.infos = infos;
  }

  of(repo: string, issue: number): ReadonlyArray<RunInfo> {
    return this.infos.filter((i) => i.id.issue === String(issue) && sameRepo(i.id.repo, repo));
  }

  /** The issues this pass knows a run for in the repo. */
  issues(repo: string): ReadonlySet<number> {
    return new Set(
      this.infos.filter((i) => sameRepo(i.id.repo, repo)).map((i) => Number(i.id.issue)),
    );
  }

  /** Reads the issue's runs again. A ledger that cannot be read is an error line, once a pass. */
  refresh(world: PassWorld, pass: Pass, repo: string, issue: number): Effect.Effect<void> {
    return Effect.matchEffect(world.unfinishedRuns({ repo, issue }), {
      onSuccess: (fresh) =>
        Effect.sync(() => {
          const others = this.infos.filter(
            (i) => !(i.id.issue === String(issue) && sameRepo(i.id.repo, repo)),
          );
          this.infos = [...others, ...fresh];
        }),
      onFailure: (error) => {
        if (this.lost) return Effect.void;
        this.lost = true;
        return pass.fail(null, passError("ledger", "cannot read the run ledger: ", error.message));
      },
    });
  }
}

/**
 * Claims `start` began that left no run it can go on from: the issue is `factory:triage` and
 * assigned to the factory's login alone, and no unfinished run for it is confirmed (`RunInfo`).
 * `resume` finishes such an issue (the design sends it to `stuck`), in the run it left when there
 * is one, so a stuck path cut short is tried again on every pass. They are claims already made,
 * so the limit on new claims does not apply to them.
 */
const untrackedClaims = (
  world: PassWorld,
  repos: ReadonlyArray<Loaded>,
  known: Known,
  pass: Pass,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (const loaded of repos) {
      if (loaded.kind !== "ready") continue;
      const repo = loaded.repo;
      const name = repo.watched.repo;
      const listing = yield* Effect.result(world.triageIssues(repo));
      if (listing._tag === "Failure") {
        yield* pass.fail(
          null,
          passError("tracker", `${name}: cannot list the triage issues: `, listing.failure.message),
        );
        continue;
      }
      pass.sayIfCut(name, "triage", listing.success.cut);
      for (const issue of listing.success.items) {
        if (known.of(name, issue).some((i) => i.unreadable || i.confirmed)) continue;
        const notes = pass.notes(name, issue, "triage");
        const run = yield* noteStart(world, pass, known, notes, repo, issue, "resume", {
          claimed: (run) => `no run on record, claimed in run ${run}`,
          notTaken: "no run on record, not ours to resume",
          stuck: "no run on record",
        });
        yield* pass.flush(notes, run);
      }
    }
  });

/**
 * Moves claims that were cut short to `factory:proposed`: the issue is `factory:triage` or
 * `factory:building`, nobody is assigned, no unfinished run is for it, and it has not changed for
 * the grace period the tracker applies. An issue that someone is assigned to is not looked at.
 */
const unassignedClaims = (
  world: PassWorld,
  repos: ReadonlyArray<Loaded>,
  known: Known,
  pass: Pass,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (const loaded of repos) {
      if (loaded.kind !== "ready") continue;
      const repo = loaded.repo;
      const name = repo.watched.repo;
      const issues = yield* Effect.result(world.unassignedClaims(repo, known.issues(name)));
      if (issues._tag === "Failure") {
        yield* pass.fail(
          null,
          passError(
            "tracker",
            `${name}: cannot list the unassigned claims: `,
            issues.failure.message,
          ),
        );
        continue;
      }
      for (const { issue, message } of issues.success.unread) {
        yield* pass.fail(
          null,
          passError(
            "tracker",
            `${name}${mention(issue)}: cannot read its label history: `,
            message,
          ),
        );
      }
      for (const { issue, state } of issues.success.claims) {
        if (known.of(name, issue).length > 0) continue;
        const notes = pass.notes(name, issue, state);
        const released = yield* Effect.result(world.releaseClaim(repo, issue, state));
        if (released._tag === "Success") {
          notes.parts.push("no run on record and no assignee, moved to proposed");
          yield* pass.record({
            event: "claim_repaired",
            data: { repo: name, issue: String(issue), outcome: "reconciled" },
          });
        } else {
          pass.trouble(notes, "tracker", "cannot move it to proposed: ", released.failure.message);
        }
        yield* pass.flush(notes, null);
      }
    }
  });

/** The newest of the issue's unfinished runs, or null when there is none. */
const newestRun = (runs: ReadonlyArray<RunInfo>): RunId | null =>
  runs
    .map((info) => info.id)
    .reduce<RunId | null>(
      (best, id) => (best === null || id.attempt > best.attempt ? id : best),
      null,
    );

/**
 * The run a `start` that failed made: the newest unfinished one after the call when it is a newer
 * attempt than `before`, the newest before the call. A failed start may have made a run or
 * reopened the newest, so only a run that is new belongs to the failure.
 */
const madeSince = (after: RunId | null, before: RunId | null): RunId | null =>
  after !== null && (before === null || after.attempt > before.attempt) ? after : null;

/** The words a start's outcome puts on the issue's line, by outcome. */
interface StartWords {
  readonly claimed: (run: string) => string;
  readonly notTaken: string;
  readonly stuck: string;
}

/**
 * Calls `call` (`start`, or `resume` for a claim already made) for the issue and puts what it
 * did on `notes`: the run it names, when it made one, is the run the notes' errors belong to.
 * The issue's runs are read again into `known` after the call. A refused claim is a
 * `claim_skipped`; a claim counts only when the issue was `ready`.
 */
const noteStart = (
  world: PassWorld,
  pass: Pass,
  known: Known,
  notes: Notes,
  repo: Repo,
  issue: number,
  call: "start" | "resume",
  words: StartWords,
): Effect.Effect<RunId | null> =>
  Effect.gen(function* () {
    const name = repo.watched.repo;
    const before = newestRun(known.of(name, issue));
    // The issue was claimed again, so what was open about its earlier runs is over.
    const clearEarlier = world.attention.clear(
      (item) => item.repo !== null && sameRepo(item.repo, name) && item.issue === issue,
    );
    const outcome = yield* Effect.result(world[call](repo, issue));
    if (outcome._tag === "Failure" && outcome.failure._tag === "GateRunningError") {
      // Nothing was called or written.
      notes.parts.push(GATE_RUNNING);
      return null;
    }
    yield* known.refresh(world, pass, name, issue);
    if (outcome._tag === "Failure") {
      pass.failed(notes, "start", "start", outcome.failure);
      return madeSince(newestRun(known.of(name, issue)), before);
    }
    switch (outcome.success.kind) {
      case "started": {
        const run = runIdToString(outcome.success.run);
        notes.parts.push(words.claimed(run));
        if (notes.state === "ready") pass.report.claimed += 1;
        yield* clearEarlier;
        return outcome.success.run;
      }
      case "abandoned": {
        // The runs the call ended are not told apart; the newest one known before it stands for them.
        const run = before === null ? null : runIdToString(before);
        yield* abandoned(pass, notes, run, outcome.success.mayHaveSession, outcome.success.error);
        return null;
      }
      case "skipped":
        notes.parts.push(words.notTaken);
        return null;
      case "refused":
        notes.parts.push(words.notTaken);
        if (notes.state === "ready") {
          yield* pass.record({
            event: "claim_skipped",
            data: { repo: name, issue: String(issue), reason: "unapproved" },
          });
        }
        return null;
      case "stuck": {
        const run = runIdToString(outcome.success.run);
        notes.parts.push(words.stuck);
        // The new run's item is raised when the pass flushes, so it outlives this clear.
        yield* clearEarlier;
        pass.stuck(notes, run);
        return outcome.success.run;
      }
    }
  });

/** A watched repo's ready issues still to try this pass, oldest first, and how many of its runs hold a slot. */
interface Queue {
  readonly repo: Repo;
  readonly issues: Array<number>;
  held: number;
}

/** Sets each queue's `held` from the runs that hold a slot, and returns the machine's count. */
const count = (known: Known, queues: ReadonlyArray<Queue>): number => {
  const holding = known.infos.filter(holdsSlot).map((run) => run.id.repo);
  for (const queue of queues) {
    queue.held = holding.filter((repo) => sameRepo(repo, queue.repo.watched.repo)).length;
  }
  return holding.length;
};

/**
 * Claims `factory:ready` issues with `start` while fewer than `max_concurrent_runs` runs are
 * active on the machine. Each claim goes to the repo with the fewest runs holding a slot among
 * the repos that still have a ready issue to try, the one listed first by T3 on
 * a tie, and the runs are counted again after every claim, so free slots spread across the
 * repos. Within a repo the issues go by number, which is the order they were opened in.
 */
const claim = (
  world: PassWorld,
  repos: ReadonlyArray<Loaded>,
  known: Known,
  machine: MachineConfig,
  pass: Pass,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    // A start before this step left runs that could not be read again.
    if (known.lost) return;
    const paused = world.handPause();
    // Ready issues that were not tried because the limit was reached. Every repo is still
    // listed, so the count is the whole machine's.
    let left = 0;
    const queues: Array<Queue> = [];
    for (const loaded of repos) {
      if (loaded.kind !== "ready") continue;
      const repo = loaded.repo;
      const name = repo.watched.repo;
      const listing = yield* Effect.result(world.readyIssues(repo));
      if (listing._tag === "Failure") {
        yield* pass.fail(
          null,
          passError("tracker", `${name}: cannot list the ready issues: `, listing.failure.message),
        );
        continue;
      }
      pass.sayIfCut(name, "ready", listing.success.cut);
      // GitHub numbers go by number, which is the order they were opened in.
      const issues = [...new Set(listing.success.items)].sort((a, b) => a - b);
      queues.push({ repo, issues, held: 0 });
    }
    let active = count(known, queues);
    // A blocked issue takes no slot, so its repo stays the one with the fewest and its next
    // issue is tried.
    for (;;) {
      const queue = queues
        .filter((q) => q.issues.length > 0)
        .reduce<Queue | null>((best, q) => (best === null || q.held < best.held ? q : best), null);
      if (queue === null) break;
      const repo = queue.repo;
      const name = repo.watched.repo;
      const issue = queue.issues.shift()!;
      const notes = pass.notes(name, issue, "ready");
      // An issue with a run whose gate is running waits: `start` would finish that run under
      // its gate. It takes no slot, no blocker read, and is not counted as left over.
      const gating = known.of(name, issue).some((info) => world.gateRunning(info.id));
      if (gating) {
        notes.parts.push(GATE_RUNNING);
        yield* pass.flush(notes, null);
        continue;
      }
      // Checked before the blockers: a person paused claims, so no claim is started. The pause is
      // the machine's, said once after the loop.
      if (paused !== null) continue;
      // Before the blockers: with no slot free nothing is claimed, so they are not read. Every
      // issue left is counted as left over, blocked or not. The issue's own triage runs end with
      // this claim (`finishOlderRuns`). One with no session leaves nothing running, so its slot is
      // the claim's; one whose session may be running keeps its slot, so no second session
      // starts past the limit.
      const own = known.of(name, issue).filter(inTriage);
      const freed = own.filter((run) => !run.session).length;
      if (active - freed >= machine.maxConcurrentRuns) {
        left += 1;
        yield* pass.record({
          event: "claim_skipped",
          data: { repo: name, issue: String(issue), reason: "limit" },
        });
        // Its own running sessions fill the limit alone: when every other run frees its slot,
        // the claim still waits, and only the claim would end them.
        const running = own.filter((run) => run.session);
        if (running.length > 0 && running.length >= machine.maxConcurrentRuns) {
          yield* waitsOnItself(pass, notes, runIdToString(running[0]!.id));
        }
        continue;
      }
      // A blocked issue takes no slot. Nothing is written for it, and a read that fails holds it
      // back too. The `## Depends on` text is read only when no linked blocker is open.
      const linked = yield* Effect.result(world.openBlockers(repo, issue));
      if (linked._tag === "Failure") {
        pass.trouble(
          notes,
          "tracker",
          "cannot read the issue's dependencies: ",
          linked.failure.message,
        );
        yield* pass.flush(notes, null);
        continue;
      }
      let blocked: string | null = null;
      if (linked.success.length > 0) {
        blocked = blockedBy(name, linked.success, "");
      } else {
        const text = yield* Effect.result(world.dependsOnBlockers(repo, issue));
        if (text._tag === "Failure") {
          pass.trouble(
            notes,
            "tracker",
            "cannot read the issue's Depends on: ",
            text.failure.message,
          );
          yield* pass.flush(notes, null);
          continue;
        }
        if (text.success.length > 0) blocked = blockedBy(name, text.success, FROM_TEXT);
      }
      if (blocked !== null) {
        notes.parts.push(blocked);
        yield* pass.flush(notes, null);
        yield* pass.record({
          event: "claim_skipped",
          data: { repo: name, issue: String(issue), reason: "blocked" },
        });
        continue;
      }
      const run = yield* noteStart(world, pass, known, notes, repo, issue, "start", {
        claimed: (run) => `claimed, session started in run ${run}`,
        notTaken: "not claimed",
        stuck: "claimed, but the launch failed",
      });
      yield* pass.flush(notes, run);
      if (known.lost) return;
      // Count again: a claim that ended in `stuck`, or in an error that left the issue in
      // `triage`, changes how many runs are active, and which repo has the fewest.
      active = count(known, queues);
    }
    if (paused !== null) {
      pass.line(
        `claims paused: by hand since ${formatTs(paused.sinceMs)}, for ${duration(Math.max(0, world.nowMs() - paused.sinceMs))}; no ready issue claimed`,
      );
      yield* pass.record({ event: "claim_skipped", data: { reason: "paused" } });
    }
    if (left > 0) {
      pass.line(
        `limit reached: ${left} ready ${plural(left, "issue")} ${left === 1 ? "was" : "were"} not claimed, max_concurrent_runs is ${machine.maxConcurrentRuns}`,
      );
    }
  });
