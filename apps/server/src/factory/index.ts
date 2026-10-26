// @effect-diagnostics nodeBuiltinImport:off - the host name goes on every `claimed` line, as softfac writes it; a gate lock is a file.
// @effect-diagnostics globalDate:off - the ledger stamps lines with the wall clock, as softfac does.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";

import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";

import * as AttentionService from "./attention.ts";
import { Attention, CONFIG_ITEM_ID, type NewItem, type PassOutcome } from "./attention.ts";
import { loadHandPause, loadPendingDeploy } from "./claims.ts";
import {
  DEFAULT_POLL_SECONDS,
  formatConfigError,
  loadMachineConfig,
  parseProjectConfig,
  PROJECT_CONFIG_PATH,
  type ConfigError,
  type MachineConfig,
  type ProjectConfig,
  type RepoConfigReading,
  type WatchedListing,
  type WatchedRepo,
} from "./config.ts";
import { readLowestFreeSpace, type FreeSpace } from "./disk.ts";
import { overload, readLoad, type Load } from "./load.ts";
import * as Gate from "./gate.ts";
import { guardLogStreams } from "./logStreams.ts";
import { FactoryGate, clearGateLocks, gateLockFile } from "./gate.ts";
import type { State } from "./domain/lifecycle.ts";
import { ledgerCall as ledger, type LedgerError } from "./ledger/errors.ts";
import { makeCause, type CauseStep, type ErrorKind, type MachineEvent } from "./ledger/events.ts";
import { Ledger } from "./ledger/ledger.ts";
import { listUnfinishedRuns, runsByThread } from "./ledger/listRuns.ts";
import { readRun } from "./ledger/read.ts";
import { runIdToString, type RunId } from "./ledger/runId.ts";
import {
  MachineLog,
  serverStartsSince,
  serverStopsForStartsSince,
  t3TroubleSince,
} from "./ledger/machineLog.ts";
import { runLoop, type Loop } from "./loop.ts";
import {
  GATE_PASSED_LINE,
  abandonedItem,
  errorKind,
  gateQueued,
  lastGoodCopy,
  plain,
  runPass,
  stuckItem,
  stuckLine,
  type BrokenThreadMemo,
  type LastGood,
  type PassError,
  type PassWorld,
  type Repo,
  type Report,
} from "./pass.ts";
import * as PipelineRuns from "./pipeline/runs.ts";
import * as Process from "./process.ts";
import { FactoryProcess } from "./process.ts";
import { readProgress, type Moved } from "./runner/progress.ts";
import { saveMachineConfig, type SaveError, type SaveResult } from "./settings.ts";
import type { FactoryStatus } from "./status.ts";
import {
  advance,
  forward,
  gateSendPending,
  interrupted,
  timeLimit,
  watch,
  type BuildingContext,
  type InterruptContext,
} from "./runner/building.ts";
import { feedback, type FeedbackContext } from "./runner/feedback.ts";
import {
  gate as gateStep,
  lastPass,
  regate,
  type GateStep,
  type GateStepError,
} from "./runner/gating.ts";
import { CUT_SHORT_COMMENT } from "./runner/messages.ts";
import { runProject } from "./runner/run.ts";
import { isOurs, newestSays, resume, start, utcSecond, type StartContext } from "./runner/start.ts";
import { takeStopRequest } from "./runner/stop.ts";
import * as Events from "./t3/events.ts";
import * as ServerExitService from "./t3/exit.ts";
import * as Paths from "./t3/paths.ts";
import * as T3Sessions from "./t3/sessions.ts";
import * as WatchedRepos from "./t3/watchedRepos.ts";
import {
  bindProcess,
  ClaimMemo,
  makeGitHub,
  type GitHubError,
  type IssueSummary,
  isNotReceived,
} from "./tracker/github.ts";

// server.ts imports this module before it builds a layer, so from here on a full disk under
// launchd drops log lines instead of ending the server, during startup too.
guardLogStreams();

export type { FactoryStatus } from "./status.ts";

export type { RepoConfigReading } from "./config.ts";

/**
 * The running factory, for the code that wakes it (a thread's run changing, a person's request).
 * Its `status` is what the status report (`status.ts`) is built on, and follows `reload`.
 */
export class FactoryLoop extends Context.Service<
  FactoryLoop,
  Loop & {
    readonly status: FactoryStatus;
    /**
     * Reads the machine config again and applies it: the next pass runs on it, and a pass under
     * way finishes on the config it started with. A config that is missing or does not load
     * leaves the factory idle.
     */
    readonly reload: Effect.Effect<void>;
    /**
     * Applies a request body to the machine config file and reloads (see `saveMachineConfig`).
     * Saves and reloads run one at a time, and a save is not cut short once it has begun, so the
     * file on disk and the config the loop runs on do not part.
     */
    readonly save: (body: unknown) => Effect.Effect<SaveResult, SaveError>;
    /** What the passes last read of each repo's project config, by repo name. */
    readonly repoConfigs: Effect.Effect<ReadonlyMap<string, RepoConfigReading>>;
    /**
     * The watched projects as the reader lists them now, for the settings page. A listing that
     * fails fails with the reader's error, which the settings report shows as `watch_error`;
     * nothing answers an empty list for it. Reading it changes nothing the pass reports.
     */
    readonly watchedRepos: Effect.Effect<WatchedListing, WatchedRepos.WatchedReposError>;
    /** How many threads have an agent at work (FactorySessions' `runningThreads`). */
    readonly runningThreads: Effect.Effect<number, T3Sessions.SessionsError>;
  }
>()("t3/factory/FactoryLoop") {}

const idle = (reason: string): FactoryStatus => ({ state: "idle", reason });

/**
 * How long an issue must have sat in `factory:triage` or `factory:building` with no assignee
 * before the pass treats it as a claim that was cut short: long enough that a claim in flight
 * (the label is swapped and the assignee follows within seconds) is never raced.
 */
const CLAIM_GRACE_MS = 15 * 60 * 1000;

const asPassError =
  (kind: PassError["kind"], prefix = "") =>
  (error: { readonly message: string }): PassError => ({
    kind,
    message: `${prefix}${error.message}`,
  });

/** The pass error of a failed tracker call, marked transient when GitHub never received it. */
const asTrackerPassError = (error: GitHubError): PassError => ({
  kind: "tracker",
  message: error.message,
  transient: isNotReceived(error),
});

const byNumber = (a: number, b: number) => a - b;

/** The numbers of the issues nobody is assigned to, by number. */
const unassignedByNumber = (items: ReadonlyArray<IssueSummary>) =>
  items
    .filter((item) => item.assignees.length === 0)
    .map((item) => item.number)
    .sort(byNumber);

/** The numbers of the issues `user` is the only assignee of, by number. */
const assignedOnlyTo = (items: ReadonlyArray<IssueSummary>, user: string) =>
  items
    .filter((item) => isOurs(item.assignees, user))
    .map((item) => item.number)
    .sort(byNumber);

/** A project config that could not be had: the pass's error, and the same problems per field. */
interface ProjectReadError extends PassError {
  readonly errors: ReadonlyArray<ConfigError>;
}

/** The checkout's own `.dw/config.yml`, for a repo whose default branch `branch` has none on GitHub. */
const fromCheckout = Effect.fn("Factory.fromCheckout")(function* (
  checkout: string,
  branch: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(checkout, PROJECT_CONFIG_PATH);
  const text = yield* fs.readFileString(file).pipe(
    Effect.mapError((error): ProjectReadError => {
      const message = `${PROJECT_CONFIG_PATH} is not on ${branch} on GitHub, and cannot read ${file}: ${error.message}`;
      return { kind: "config", message, errors: [{ file, message }] };
    }),
  );
  return { file, text };
});

/**
 * The project config of a repo: `.dw/config.yml` at the tip of the default branch on GitHub,
 * or, only when GitHub says the file is not there, the copy in the watched checkout's working
 * tree. Some repos keep the file off GitHub because their gate holds machine-specific commands.
 * Either way the config must name the default branch as its `base`.
 */
const projectFromBase = Effect.fn("Factory.projectFromBase")(function* (
  github: ReturnType<typeof makeGitHub>,
  checkout: string,
) {
  const found = yield* github.baseConfig().pipe(
    Effect.mapError((error): ProjectReadError => ({
      kind: "config",
      message: `cannot read ${PROJECT_CONFIG_PATH} from GitHub: ${error.message}`,
      transient: isNotReceived(error),
      errors: [
        {
          file: PROJECT_CONFIG_PATH,
          message: `cannot read ${PROJECT_CONFIG_PATH} from GitHub: ${error.message}`,
        },
      ],
    })),
  );
  const { file, text } =
    found.text !== null
      ? { file: `${found.branch}:${PROJECT_CONFIG_PATH}`, text: found.text }
      : yield* fromCheckout(checkout, found.branch);
  const parsed = parseProjectConfig(text, file);
  if (Result.isFailure(parsed)) {
    return yield* Effect.fail<ProjectReadError>({
      kind: "config",
      message: parsed.failure.map(formatConfigError).join("; "),
      errors: parsed.failure,
    });
  }
  if (parsed.success.base !== found.branch) {
    const rule =
      found.text !== null
        ? "the config must be committed on its own base branch"
        : "a checkout's config must name the default branch as its base";
    const message = `${file} names base \`${parsed.success.base}\`, but the repo's default branch is \`${found.branch}\`: ${rule}`;
    return yield* Effect.fail<ProjectReadError>({
      kind: "config",
      message,
      errors: [{ file, field: "factory.base", message }],
    });
  }
  return parsed.success;
});

/** What the live world runs its gates with, and what it does when one ends. */
export interface LiveGate {
  readonly gate: FactoryGate["Service"];
  /** Run when a gate ends with a decision (`gateDecided`), so the next pass carries on at once. */
  readonly wake: Effect.Effect<void>;
  /** The factory's scope: a gate still running when it closes is interrupted, and its cleanup runs. */
  readonly scope: Scope.Scope;
  /** How the machine's load is read. Default `os.loadavg`; a test passes the load it needs. */
  readonly readLoad?: () => Load;
}

/** The run's line when its gate, started in the background, has ended. */
const gateWords = (run: string, step: GateStep): string => {
  switch (step.kind) {
    case "passed":
      return GATE_PASSED_LINE;
    case "sent-back":
      return `the gate failed on attempt ${step.attempt} and was sent back into the session`;
    case "stuck":
      return stuckLine(run);
    case "not-ready":
      return "nothing to gate";
    case "ended":
      return "the pull request was merged or closed, the run is finished";
    case "abandoned":
      return "the issue is closed, the run is closed";
    case "running":
      return "gate running";
    case "checks-pending":
      return "gate passed, waiting for the required checks to finish";
    case "queued":
      return gateQueued(step);
    case "unchanged":
      return "nothing moved";
  }
};

/** What started a re-gate, in the run's line. */
const MOVED_WORDS: Record<Moved, string> = {
  head: "the pull request's head moved",
  both: "the pull request's head and the base branch moved",
  conflict: "GitHub says the pull request conflicts with the base branch",
  earlier: "an earlier version of the factory began this re-gate",
};

/**
 * The run's line when the background re-gate of its `pr-open` pull request has ended; null for a
 * quiet one. A pass or failure starts with what started the re-gate: the head moved, the head and
 * base, a reported conflict, a re-gate an earlier version began, or no pass on record to compare
 * with.
 */
export const regateWords = (
  run: string,
  repo: string,
  step: GateStep,
  moved: Moved | null,
): string | null => {
  const said = moved === null ? "no pass was on record" : MOVED_WORDS[moved];
  switch (step.kind) {
    case "unchanged":
      return null;
    case "passed":
      return `${said}, the gate passed again, PR https://github.com/${repo}/pull/${step.pr} stays ready for review`;
    case "sent-back":
      return `${said}, the gate failed on attempt ${step.attempt}, the PR is a draft again and the session was told`;
    case "not-ready":
      return "the gate waits for the session";
    default:
      return gateWords(run, step);
  }
};

/**
 * The attention item for a gate that ended, or null: a gate that ended `stuck` or `abandoned`
 * needs a person, the same item `pass.ts` raises when `advance` finds the run so.
 */
export const gateItem = (
  repo: string,
  issue: number,
  run: string,
  step: GateStep | null,
): NewItem | null => {
  switch (step?.kind) {
    case "stuck":
      return stuckItem(repo, issue, run);
    case "abandoned":
      return abandonedItem(repo, issue, run);
    default:
      return null;
  }
};

/**
 * Whether a gate that ended changed something the next pass should act on at once. A gate that
 * decided nothing (the session still at work, another gate running, an error such as a rate
 * limit) waits for the normal poll, so the loop does not spin on it.
 */
export const gateDecided = (step: GateStep | null): boolean =>
  step !== null &&
  (step.kind === "passed" ||
    step.kind === "sent-back" ||
    step.kind === "stuck" ||
    step.kind === "ended" ||
    step.kind === "abandoned");

/**
 * What a world keeps for as long as the factory runs, however often a reload builds a new one:
 * the claim judgements, the runs whose gate this process is running now (a gate holds the
 * run's lock file only while an attempt runs; this covers the whole call), when each stuck
 * item's issue was last read, and which threads on a broken worktree are ruled out or waiting.
 */
export interface LiveShared {
  readonly gating: Set<string>;
  readonly claimMemo: ClaimMemo;
  readonly stuckReads: Map<string, number>;
  readonly brokenThreads: BrokenThreadMemo;
  readonly configSkips: Map<string, number>;
  readonly lastGood: Map<string, LastGood>;
}

/**
 * When this server's process started, as epoch milliseconds: what the `server_started` line
 * records at boot, for `interrupted` to compare a run's times with. A restart of the server is
 * what cuts a running session off.
 */
export const serverStartedMs = (): number => Math.round(performance.timeOrigin);

/**
 * How far back `t3Starts` reads server starts: a day, longer than any run's time limit. The stops
 * are read by the start they belong to, whatever their age.
 */
const SERVER_STARTS_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The pass over this machine: GitHub through `gh`, the ledger under `dataDir`, the wall clock.
 * It does not know which repos are watched or where the worktrees are: `startFactory` adds
 * `watchedRepos` and `freeSpace`.
 */
export const liveWorld = (
  machine: MachineConfig,
  dataDir: string,
  process: FactoryProcess["Service"],
  // What a pass reads a checkout's project config through.
  files: Layer.Layer<FileSystem.FileSystem | Path.Path>,
  sessions: T3Sessions.FactorySessions["Service"],
  clock: () => number,
  host: string,
  attention: Pick<Attention["Service"], "list" | "raise" | "clear">,
  live: LiveGate,
  gateRemoteBase?: string,
  onProject?: (repo: string, reading: RepoConfigReading) => void,
  // Built once per process by the factory, so a reload's new world goes on from the old one's.
  { gating, claimMemo, stuckReads, brokenThreads, configSkips, lastGood }: LiveShared = {
    gating: new Set(),
    claimMemo: new ClaimMemo(),
    stuckReads: new Map(),
    brokenThreads: { notFactory: new Set(), unsettled: new Map() },
    configSkips: new Map(),
    lastGood: new Map(),
  },
): Omit<PassWorld, "watchedRepos" | "freeSpace"> => {
  const load = live.readLoad ?? readLoad;
  const withProcess = <A, E>(effect: Effect.Effect<A, E, FactoryProcess>) =>
    Effect.provideService(effect, FactoryProcess, process);
  const githubFor = (watched: WatchedRepo) =>
    makeGitHub({ repo: watched.repo, ghConfigDir: machine.ghConfigDir });
  const trackerFor = (watched: WatchedRepo) => bindProcess(githubFor(watched), process);
  const tracker = (effect: Effect.Effect<unknown, GitHubError, FactoryProcess>) =>
    withProcess(effect).pipe(Effect.mapError(asPassError("tracker")));
  const startContext = (repo: Repo): StartContext => ({
    repo: repo.watched.repo,
    trackerUser: repo.trackerUser,
    machine: host,
    project: repo.project,
    dataDir,
    tracker: trackerFor(repo.watched),
    repoPath: repo.watched.path,
    ghConfigDir: machine.ghConfigDir,
    sessions,
    clock,
  });
  // A run's steps get the repo's project with the run's own base: the one its launch recorded.
  const buildingContext = (repo: Repo, project: ProjectConfig): BuildingContext => ({
    repo: repo.watched.repo,
    trackerUser: repo.trackerUser,
    machine: host,
    project,
    dataDir,
    tracker: trackerFor(repo.watched),
    sessions,
    clock,
  });
  // The steps of a building run that can also start the next attempt: `advance` finishes a
  // relaunch, `interrupted` decides one. The tracker and the sessions are the same for both.
  const interruptContext = (repo: Repo, project: ProjectConfig): InterruptContext => ({
    ...buildingContext(repo, project),
    repoProject: repo.project,
    repoPath: repo.watched.path,
    ghConfigDir: machine.ghConfigDir,
    tracker: trackerFor(repo.watched),
    sessions,
  });
  const gateContext = (repo: Repo, project: ProjectConfig): FeedbackContext => ({
    ...buildingContext(repo, project),
    tracker: trackerFor(repo.watched),
    repoPath: repo.watched.path,
    ghConfigDir: machine.ghConfigDir,
    sessions,
    gate: live.gate,
    maxConcurrentGates: machine.maxConcurrentGates,
    feedbackSeconds: machine.feedbackSeconds,
    gateOptions: {
      ghConfigDir: machine.ghConfigDir,
      clock,
      ...(gateRemoteBase !== undefined && { remoteBase: gateRemoteBase }),
    },
  });
  const recordError = (run: RunId, step: CauseStep, kind: ErrorKind, message: string) =>
    ledger(() => {
      const out = Ledger.open(dataDir, run, { clock });
      try {
        out.append(
          { event: "error", data: { step, kind, message } },
          makeCause(step, "step-failed"),
        );
      } finally {
        out.close();
      }
    });
  /**
   * Whether GitHub says the run's pull request conflicts with its base. The gate of such a run
   * takes no slot (it records the conflict without a checkout), so it starts even when every slot
   * is taken. A run with no pull request on record, or a read that fails, is no conflict.
   */
  const conflicting = Effect.fn("Factory.conflicting")(
    function* (repo: Repo, run: RunId) {
      const last = (yield* ledger(() => readProgress(readRun(dataDir, run).entries))).lastPr;
      if (last === null) return false;
      const pull = yield* trackerFor(repo.watched).pullRequest(last.pr);
      return pull !== null && pull.open && pull.mergeable === "conflicting";
    },
    Effect.orElseSucceed(() => false),
  );
  /**
   * The gate as a background fiber: its line is logged when it ends, as the pass's lines are, an
   * error goes to the run's ledger, a `stuck` or `abandoned` end raises its attention item, and the loop is
   * woken so the next pass carries on at once.
   */
  const startGate = Effect.fn("Factory.startGate")(function* (repo: Repo, run: RunId) {
    const id = runIdToString(run);
    if (gating.size >= machine.maxConcurrentGates && !(yield* conflicting(repo, run))) {
      return { kind: "queued", running: gating.size, max: machine.maxConcurrentGates } as const;
    }
    // Under load one gate runs at a time; the only gate always starts, so no run waits on a
    // machine busy with work that is not the factory's. Like a queued gate, nothing is written.
    if (gating.size > 0) {
      const over = overload(machine.maxLoadPerCore, load);
      if (over !== null) {
        return { kind: "high-load", oneMinute: over.oneMinute, limit: over.limit } as const;
      }
    }
    gating.add(id);
    const label = plain(`${repo.watched.repo}#${run.issue}`);
    /** The run's gate: a re-gate for a `pr-open` run, the gate of a building run otherwise. */
    const decide: Effect.Effect<
      { readonly state: State; readonly step: GateStep; readonly moved: Moved | null },
      GateStepError
    > = Effect.gen(function* () {
      const seen = yield* ledger(() => readProgress(readRun(dataDir, run).entries));
      const context = gateContext(repo, runProject(repo.project, seen.base));
      const state = seen.state;
      if (state === "pr-open") {
        const regated = yield* regate(context, run);
        return { state, step: regated.step, moved: regated.moved };
      }
      return { state: state ?? "building", step: yield* gateStep(context, run), moved: null };
    });
    yield* decide.pipe(
      Effect.matchEffect({
        onSuccess: ({ state, step, moved }) => {
          const words =
            state === "pr-open"
              ? regateWords(id, repo.watched.repo, step, moved)
              : gateWords(id, step);
          return (
            words === null ? Effect.void : Effect.logInfo(`${label} ${state}: ${words}`)
          ).pipe(Effect.as(step));
        },
        onFailure: (error) =>
          Effect.logError(`error: ${label} gate: ${plain(error.message)}`).pipe(
            Effect.andThen(
              recordError(run, "gate", errorKind(error), error.message).pipe(
                Effect.catch((failed) =>
                  Effect.logError(
                    `error: ${label} gate: cannot record the error: ${plain(failed.message)}`,
                  ),
                ),
              ),
            ),
            Effect.as(null),
          ),
      }),
      Effect.ensuring(Effect.sync(() => gating.delete(id))),
      Effect.tap((step) => {
        const item = gateItem(repo.watched.repo, Number(run.issue), id, step);
        return item === null ? Effect.void : attention.raise(item);
      }),
      Effect.flatMap((step) => (gateDecided(step) ? live.wake : Effect.void)),
      Effect.forkIn(live.scope),
    );
    return { kind: "started" } as const;
  });
  return {
    project: (watched) =>
      withProcess(
        projectFromBase(githubFor(watched), watched.path).pipe(Effect.provide(files)),
      ).pipe(
        Effect.tap((project) =>
          Effect.sync(() => onProject?.(watched.repo, { kind: "ok", project })),
        ),
        Effect.tapError((error) =>
          // A transient failure with a last good copy says nothing new about the config: the
          // pass runs on that copy and the last reading stands. Without a copy the repo is
          // skipped, and the reading says why.
          lastGoodCopy(lastGood, watched.repo, "project", error) !== undefined
            ? Effect.void
            : Effect.sync(() =>
                onProject?.(watched.repo, { kind: "errors", errors: error.errors }),
              ),
        ),
        Effect.mapError((error): PassError => ({
          kind: error.kind,
          message: error.message,
          ...(error.transient === undefined ? {} : { transient: error.transient }),
        })),
      ),
    trackerUser: (watched) =>
      withProcess(githubFor(watched).login()).pipe(Effect.mapError(asTrackerPassError)),
    unfinishedRuns: (only) => ledger(() => listUnfinishedRuns(dataDir, only)),
    readyIssues: (repo: Repo) =>
      withProcess(githubFor(repo.watched).listIssues("ready")).pipe(
        Effect.map((listing) => ({ items: unassignedByNumber(listing.items), cut: listing.cut })),
        Effect.mapError(asPassError("tracker")),
      ),
    triageIssues: (repo: Repo) =>
      withProcess(githubFor(repo.watched).listIssues("triage")).pipe(
        Effect.map((listing) => ({
          items: assignedOnlyTo(listing.items, repo.trackerUser),
          cut: listing.cut,
        })),
        Effect.mapError(asPassError("tracker")),
      ),
    unassignedClaims: (repo: Repo, known: ReadonlySet<number>) =>
      withProcess(
        githubFor(repo.watched).unassignedClaims(
          utcSecond(clock() - CLAIM_GRACE_MS),
          repo.trackerUser,
          known,
          claimMemo,
        ),
      ).pipe(
        Effect.map((scan) => ({
          claims: scan.claims,
          unread: scan.unread.map((u) => ({ issue: u.issue, message: u.error.message })),
        })),
        Effect.mapError(asPassError("tracker")),
      ),
    // Comment first, then label, as a refusal does: a failed label call leaves the issue where a
    // later pass finds it again. The comment counts as already posted only when it is the issue's
    // newest factory comment and newer than the label event that began this claim. An unreadable
    // label time posts it: at-least-once beats an unexplained move.
    releaseClaim: (repo: Repo, issue: number, from: State) => {
      const gh = githubFor(repo.watched);
      return tracker(
        Effect.gen(function* () {
          const newest = yield* gh.newestFactoryComment(issue);
          let explained = false;
          if (newestSays(newest, CUT_SHORT_COMMENT)) {
            const labeled = yield* Effect.result(gh.labeledAt(issue, from));
            explained =
              Result.isSuccess(labeled) &&
              labeled.success !== null &&
              newest.createdAt > labeled.success;
          }
          if (!explained) yield* gh.postComment(issue, CUT_SHORT_COMMENT);
          yield* gh.setState(issue, "proposed");
        }),
      ).pipe(Effect.asVoid);
    },
    openBlockers: (repo: Repo, issue: number) =>
      withProcess(githubFor(repo.watched).openBlockers(issue)).pipe(
        Effect.mapError(asPassError("tracker")),
      ),
    dependsOnBlockers: (repo: Repo, issue: number) =>
      withProcess(githubFor(repo.watched).textBlockers(issue)).pipe(
        Effect.mapError(asPassError("tracker")),
      ),
    start: (repo: Repo, issue: number) => start(startContext(repo), issue),
    resume: (repo: Repo, issue: number) => resume(startContext(repo), issue),
    takeStopRequest: (run) => takeStopRequest(dataDir, run, clock),
    timeLimit: (repo, run, base) =>
      timeLimit(buildingContext(repo, runProject(repo.project, base)), run),
    watch: (repo, run, base) => watch(buildingContext(repo, runProject(repo.project, base)), run),
    forward: (repo, run, base) =>
      forward(buildingContext(repo, runProject(repo.project, base)), run),
    advance: (repo, run, base) =>
      advance(interruptContext(repo, runProject(repo.project, base)), run),
    t3Trouble: () => ledger(() => t3TroubleSince(dataDir, clock())),
    t3Starts: () => ledger(() => serverStartsSince(dataDir, clock() - SERVER_STARTS_WINDOW_MS)),
    t3Stops: () =>
      ledger(() => serverStopsForStartsSince(dataDir, clock() - SERVER_STARTS_WINDOW_MS)),
    interrupted: (repo, run, base, evidence) =>
      interrupted(interruptContext(repo, runProject(repo.project, base)), run, evidence),
    gateRunning: (run) =>
      gating.has(runIdToString(run)) || NodeFS.existsSync(gateLockFile(dataDir, run)),
    hasPendingGateSend: (run) =>
      ledger(() => gateSendPending(readProgress(readRun(dataDir, run).entries))),
    lastPass: (run) => lastPass(dataDir, run),
    issueClosed: (repo, issue) =>
      withProcess(githubFor(repo.watched).issue(issue)).pipe(
        Effect.map((detail) => detail.closed),
        Effect.mapError(asPassError("tracker")),
      ),
    stuckReads,
    openPull: (repo, pr) =>
      trackerFor(repo.watched)
        .pullRequest(pr)
        .pipe(
          Effect.map((pull) =>
            pull === null || !pull.open
              ? null
              : { head: pull.headSha.toLowerCase(), mergeable: pull.mergeable },
          ),
          Effect.mapError(asPassError("tracker")),
        ),
    gate: startGate,
    load,
    feedback: (repo, run, base) => feedback(gateContext(repo, runProject(repo.project, base)), run),
    recordError,
    handPause: () => loadHandPause(dataDir),
    pendingDeploy: () => loadPendingDeploy(dataDir),
    threadsOnBrokenWorktrees: () =>
      sessions.brokenWorktrees.pipe(Effect.mapError(asPassError("t3"))),
    sessionRuns: () =>
      ledger(() => runsByThread(dataDir)).pipe(Effect.mapError(asPassError("ledger"))),
    brokenThreads,
    configSkips,
    lastGood,
    archiveThread: (threadId) =>
      sessions.archive(threadId).pipe(Effect.mapError(asPassError("t3"))),
    nowMs: clock,
    attention,
    record: (event: MachineEvent) =>
      ledger(() => {
        const log = MachineLog.open(dataDir, { clock });
        try {
          log.append(event);
        } finally {
          log.close();
        }
      }),
  };
};

export const hostName = (): string => {
  try {
    return NodeOS.hostname() || "unknown";
  } catch {
    return "unknown";
  }
};

/**
 * The threads the unfinished runs under `dataDir` name as their sessions'. A run whose file
 * cannot be read names none.
 */
export const ownedThreads = (dataDir: string): Effect.Effect<ReadonlySet<string>, LedgerError> =>
  ledger(() => {
    const ids = new Set<string>();
    for (const info of listUnfinishedRuns(dataDir)) {
      if (info.unreadable || !info.session) continue;
      try {
        const threadId = readProgress(readRun(dataDir, info.id).entries).threadId;
        if (threadId !== null) ids.add(threadId);
      } catch {
        // Unreadable since it was listed: the next refresh reads it again.
      }
    }
    return ids;
  });

/**
 * Reads the owned threads again into `owned`. A listing that fails is logged and keeps the set
 * it had: the next refresh, or the next scheduled pass, covers what it missed.
 */
const refreshOwned = (dataDir: string, owned: Ref.Ref<ReadonlySet<string>>) =>
  ownedThreads(dataDir).pipe(
    Effect.flatMap((ids) => Ref.set(owned, ids)),
    Effect.catch((error) =>
      Effect.logWarning(`factory cannot list the threads it owns: ${error.message}`),
    ),
  );

/**
 * Runs one events stream to its end, waking for each thread in `owned`. A lookup is a set read,
 * so the many events of threads the factory does not own cost nothing. The stream's own failure
 * is the caller's to handle.
 */
export const wakeOn = (
  owned: Ref.Ref<ReadonlySet<string>>,
  events: Stream.Stream<string, Events.EventsError>,
  wake: Effect.Effect<void>,
): Effect.Effect<void, Events.EventsError> =>
  Stream.runForEach(events, (threadId) =>
    Effect.flatMap(Ref.get(owned), (ids) => (ids.has(threadId) ? wake : Effect.void)),
  );

/**
 * Wakes the loop when T3 says the latest run of a thread the factory owns changed status. A
 * stream that ends or fails is run again after `restartDelay`; the status changes in the gap are
 * not replayed, and the next pass reads them.
 */
const wakeOnOwnedThreads = (
  owned: Ref.Ref<ReadonlySet<string>>,
  events: Events.FactoryEvents["Service"],
  loop: Loop,
  restartDelay: Duration.Input,
) =>
  wakeOn(owned, events.runStatusChanges, loop.wake).pipe(
    Effect.catch((error) => Effect.logWarning("factory events stream failed, restarting", error)),
    Effect.andThen(Effect.sleep(restartDelay)),
    Effect.forever,
  );

/** How a pass ended, for the count of passes that error in a row. */
const outcomeOf = (exit: Exit.Exit<Report>, lastError: () => string | null): PassOutcome => {
  if (Exit.isSuccess(exit)) {
    const errors = exit.value.errors;
    return errors === 0
      ? { ok: true }
      : { ok: false, message: lastError() ?? `${errors} error lines` };
  }
  return {
    ok: false,
    message: Cause.hasInterruptsOnly(exit.cause)
      ? "the pass was stopped before it finished"
      : `the pass died: ${String(Cause.squash(exit.cause))}`,
  };
};

/** What the factory's runtime can be told, for a test that cannot wait. */
export interface RuntimeOptions {
  /** How long to wait before the events stream is run again. Default 5 seconds. */
  readonly restartDelay?: Duration.Input;
  /** Where the gate fetches `<owner>/<name>.git` from. Default `https://github.com`; a test passes a `file://` base. */
  readonly gateRemoteBase?: string;
  /** Called with each world a start or reload builds, once the world is built: for a test that needs the pass world a reload built. */
  readonly onWorld?: (world: PassWorld) => void;
  /** How a directory's free space is read. Default `statfs`; a test passes the sizes it needs. */
  readonly readFreeSpace?: (path: string) => FreeSpace;
  /** How the machine's load is read. Default `os.loadavg`; a test passes the load it needs. */
  readonly readLoad?: () => Load;
}

/** A pass of a factory with no config to run on. */
const NO_PASS: Report = { runs: 0, claimed: 0, errors: 0, attention: 0 };

/** The config a pass runs on, with the world built for it. */
interface Current {
  readonly machine: MachineConfig;
  readonly world: PassWorld;
}

const startFactory = Effect.fn("Factory.startFactory")(function* (options: RuntimeOptions) {
  const { factoryDir, machineConfigPath, worktreesDir } = yield* Paths.FactoryPaths;
  const attention = yield* Attention;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const process = yield* FactoryProcess;
  const sessions = yield* T3Sessions.FactorySessions;
  const watched = yield* WatchedRepos.FactoryWatchedRepos;
  const gate = yield* FactoryGate;
  const events = yield* Events.FactoryEvents;
  const scope = yield* Effect.scope;
  // Gates run inside this server, so a lock file left from an earlier run belongs to a dead gate.
  const cleared = yield* clearGateLocks(factoryDir);
  if (cleared > 0) yield* Effect.logInfo(`cleared ${cleared} gate lock(s)`);

  // What `reload` changes and the loop reads: a pass takes `current` once, at its start.
  const state: {
    current: Current | null;
    loop: Loop | null;
    status: FactoryStatus;
    watched: ReadonlyArray<string>;
  } = {
    current: null,
    loop: null,
    status: idle("no factory config"),
    watched: [],
  };
  const readings = new Map<string, RepoConfigReading>();
  // The repos the pass's last listing named, for the status; a pass lists them anew before it works.
  const listWatched = watched.listAndRemember.pipe(
    Effect.tap((listing) =>
      Effect.sync(() => {
        const repos = listing.repos.map((entry) => entry.repo);
        state.watched = repos;
        if (state.status.state === "running") {
          state.status = { ...state.status, settings: { ...state.status.settings, repos } };
        }
      }),
    ),
  );
  const shared: LiveShared = {
    gating: new Set(),
    claimMemo: new ClaimMemo(),
    stuckReads: new Map(),
    brokenThreads: { notFactory: new Set(), unsettled: new Map() },
    configSkips: new Map(),
    lastGood: new Map(),
  };
  // The threads of the unfinished runs, read at start and after every pass: a pass is what
  // launches and finishes sessions, so between passes the set does not change.
  const owned = yield* Ref.make<ReadonlySet<string>>(new Set());
  yield* refreshOwned(factoryDir, owned);

  const onePass = Effect.gen(function* () {
    const current = state.current;
    if (current === null) return NO_PASS;
    // Each line is logged as it is decided, so a pass that hangs or dies has said what it did.
    const context = yield* Effect.context<never>();
    const log = Effect.runSyncWith(context);
    let lastError: string | null = null;
    return yield* runPass(current.world, current.machine, (line) => {
      if (line.startsWith("error: ")) lastError = line;
      log(Effect.logInfo(line));
    }).pipe(Effect.onExit((exit) => attention.passEnded(outcomeOf(exit, () => lastError))));
  }).pipe(Effect.ensuring(refreshOwned(factoryDir, owned)));

  const start = Effect.fn("Factory.start")(function* (machine: MachineConfig) {
    // The loop is made after the world, so a gate that ends wakes whatever loop there is then.
    const world: PassWorld = {
      ...liveWorld(
        machine,
        factoryDir,
        process,
        Layer.mergeAll(
          Layer.succeed(FileSystem.FileSystem)(fileSystem),
          Layer.succeed(Path.Path)(path),
        ),
        sessions,
        () => Date.now(),
        hostName(),
        attention,
        {
          gate,
          wake: Effect.suspend(() => state.loop?.wake ?? Effect.void),
          scope,
          ...(options.readLoad !== undefined && { readLoad: options.readLoad }),
        },
        options.gateRemoteBase,
        (repo, reading) => {
          readings.set(repo, reading);
        },
        shared,
      ),
      // Where the list comes from is known here alone.
      watchedRepos: listWatched.pipe(Effect.mapError(asPassError("t3"))),
      // The sessions write under the worktrees folder T3 uses now, the gate under the factory dir.
      freeSpace: () =>
        sessions.worktreesDirectory(worktreesDir).pipe(
          Effect.mapError(asPassError("t3")),
          Effect.flatMap((worktrees) =>
            Effect.try({
              try: () =>
                readLowestFreeSpace(
                  [...(worktrees === null ? [] : [worktrees]), factoryDir],
                  options.readFreeSpace,
                ),
              // Local disk, as softfac files it: the kind the machine's own files have.
              catch: (cause): PassError => ({
                kind: "ledger",
                message: cause instanceof Error ? cause.message : String(cause),
              }),
            }),
          ),
        ),
    };
    options.onWorld?.(world);
    state.current = { machine, world };
    state.status = {
      state: "running",
      settings: {
        pollSeconds: machine.pollSeconds,
        maxConcurrentRuns: machine.maxConcurrentRuns,
        repos: state.watched,
      },
    };
    if (state.loop !== null) {
      yield* Effect.logInfo("factory config reloaded");
      return yield* state.loop.wake;
    }
    // This start, for `interrupted` to weigh a session that ended badly against: a restart cut
    // it off if it was running then. A log that cannot take the line costs that evidence, not
    // the boot.
    yield* world
      .record({ event: "server_started", data: { started_at: serverStartedMs() } })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("cannot record the server start in the machine log", cause),
        ),
      );
    // And the stop, as this scope closes: the server's shutdown marks every running turn
    // `cancelled` about then, so a run that ended between this line and the next start was cut
    // off by the restart, however long the server stays down.
    yield* Scope.addFinalizer(
      scope,
      Effect.gen(function* () {
        const stoppingAt = yield* Clock.currentTimeMillis;
        yield* world.record({ event: "server_stopping", data: { stopping_at: stoppingAt } });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("cannot record the server stop in the machine log", cause),
        ),
      ),
    );
    yield* Effect.logInfo("factory started");
    // The first pass runs at once, on the config just set.
    const loop = yield* runLoop(
      onePass,
      () => state.current?.machine.pollSeconds ?? DEFAULT_POLL_SECONDS,
    ).pipe(Effect.provideService(Scope.Scope, scope));
    state.loop = loop;
    yield* Effect.forkIn(
      wakeOnOwnedThreads(owned, events, loop, options.restartDelay ?? "5 seconds"),
      scope,
    );
  });

  const reloadNow = Effect.gen(function* () {
    const loaded = yield* Effect.result(loadMachineConfig(machineConfigPath));
    if (Result.isFailure(loaded)) {
      for (const error of loaded.failure.errors) {
        yield* Effect.logError(formatConfigError(error));
      }
      yield* attention.raise({
        id: CONFIG_ITEM_ID,
        kind: "config",
        repo: null,
        issue: null,
        run: null,
        message: `machine config not loaded: ${loaded.failure.errors.map(formatConfigError).join("; ")}`,
      });
      state.current = null;
      state.status = idle("factory config failed to load");
      return;
    }
    yield* attention.clear((item) => item.id === CONFIG_ITEM_ID);
    if (Option.isNone(loaded.success)) {
      yield* Effect.logInfo(`no factory config at ${machineConfigPath}`);
      state.current = null;
      state.status = idle("no factory config");
      return;
    }
    const { config: machine, warnings } = loaded.success.value;
    for (const warning of warnings) {
      yield* Effect.logWarning(formatConfigError(warning));
    }
    yield* attention.setNotify(machine.notify);
    yield* start(machine);
  }).pipe(Effect.provideService(FileSystem.FileSystem, fileSystem));

  // One reload or save at a time, and none cut short half way: two at once from idle would
  // make two loops, and a save cut short after the write leaves the loop on the old config.
  // The settings page reads the list untapped: only the pass writes `state.watched` and the status.
  const watchedRepos = watched.list;
  const lock = yield* Semaphore.make(1);
  const reload = lock.withPermits(1)(Effect.uninterruptible(reloadNow));
  const save = (body: unknown) =>
    lock
      .withPermits(1)(
        Effect.uninterruptible(
          saveMachineConfig(machineConfigPath, body, {
            reload: reloadNow,
            repoConfigs: Effect.sync(() => new Map(readings)),
            watchedRepos,
          }),
        ),
      )
      .pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );

  yield* reload;
  return {
    wake: Effect.suspend(() => state.loop?.wake ?? Effect.void),
    awaitPass: Effect.suspend(() => state.loop?.awaitPass ?? Effect.never),
    passRunning: Effect.suspend(() => state.loop?.passRunning ?? Effect.succeed(false)),
    get status() {
      return state.status;
    },
    reload,
    save,
    runningThreads: sessions.runningThreads,
    repoConfigs: Effect.sync(() => new Map(readings)),
    watchedRepos,
  } satisfies FactoryLoop["Service"];
});

/**
 * Gives FactoryLoop and Attention. Needs FactoryPaths, FactoryProcess, FactorySessions,
 * FactoryWatchedRepos, FactoryEvents, FactoryGate and FileSystem; what index.test.ts builds with a
 * test FactoryPaths, a fake FactoryProcess, a stub FactorySessions, a fixed list of watched
 * projects, a FactoryEvents it feeds by hand and a gate that never runs.
 */
export const factoryRuntime = (options: RuntimeOptions = {}) =>
  Layer.effect(FactoryLoop, startFactory(options)).pipe(
    Layer.provideMerge(AttentionService.layer()),
  );

export const FactoryRuntime = factoryRuntime();

/** The factory's root layer. server.ts merges it into the runtime; nothing else imports it. */
export const FactoryLayer = FactoryRuntime.pipe(
  Layer.provideMerge(PipelineRuns.layer),
  Layer.provideMerge(Paths.layer),
  Layer.provideMerge(ServerExitService.layer),
  Layer.provide(Gate.layer),
  Layer.provide(Process.layer),
  Layer.provide(T3Sessions.layerLive),
  Layer.provide(WatchedRepos.layer.pipe(Layer.provide(Paths.layer))),
  Layer.provide(Events.layerLive),
);
