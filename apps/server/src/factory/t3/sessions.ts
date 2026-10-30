import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { isTemporaryWorktreeBranch } from "@t3tools/shared/git";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { sourceControlDefinitions } from "../../sourceControl/sourceControlDefinitions.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import { resolveWorktreesDirectory } from "../../worktreesDirectory.ts";
import { isCommitId } from "../text.ts";

/**
 * Agent sessions as the factory sees them: softfac's `Sessions` trait
 * (`src/t3.rs`) over T3's services, called in-process instead of over the
 * wire. Everything above this file uses these types, never T3's.
 */

/** Where a run is in its life, as T3 Code names it. */
export const RUN_STATUSES = [
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** The model a thread runs on, as T3 Code names it. */
export interface Model {
  /** The configured provider instance, e.g. `claudeAgent`. */
  readonly instanceId: string;
  /** The model id, e.g. `claude-sonnet-5-5`. */
  readonly model: string;
  /** The provider options the selection carries (a reasoning effort, say), when it has any. */
  readonly options?: ModelSelection["options"];
}

/** The T3 project of a watched repo, as `findProject` answers it. */
export interface FactoryProject {
  readonly id: string;
  /**
   * The model a session on this project runs on: the project's default model, else the default
   * in T3's settings, the same choice a person gets in a new thread on the project. Null when
   * neither names one; the factory then launches nothing.
   */
  readonly model: Model | null;
}

/** Everything `launch` needs. */
export interface LaunchRequest {
  /**
   * Names this command. Sent again after a failure, the same id lets T3 tell a
   * retry from a new launch, so callers derive it from what they are launching
   * (issue and attempt).
   */
  readonly commandId: string;
  /** A T3 project id, from `findProject`. */
  readonly projectId: string;
  readonly title: string;
  /** The ref the thread's worktree starts from. */
  readonly baseRef: string;
  /**
   * Fetch `origin` first and start from `baseRef`'s tip there, not from the
   * clone's local ref: for a resume from a branch an earlier session pushed.
   */
  readonly startFromOrigin: boolean;
  /** The first message, which starts the first run. */
  readonly message: string;
  readonly model: Model;
  /**
   * The pull request the thread continues, linked to the thread at launch. Absent for a plain
   * start and for a resume from an earlier run that left no pull request.
   */
  readonly pullRequestUrl?: string;
}

/** What a worktree has checked out (`worktreeCheckout`). */
export interface Checkout {
  readonly head: string;
  readonly branch: string | null;
}

/** What `launch` returns. */
export interface Launched {
  readonly threadId: string;
  /** `null` until T3 Code has prepared the worktree. */
  readonly worktreePath: string | null;
  /** `null` until T3 Code has prepared the worktree. */
  readonly branch: string | null;
}

/** Where a thread works and whether it is archived. */
export interface Thread {
  /** `null` until T3 Code has prepared the worktree. */
  readonly worktreePath: string | null;
  /** `null` until T3 Code has prepared the worktree. */
  readonly branch: string | null;
  readonly archived: boolean;
}

/** What `status` reports about a thread. */
export interface ThreadStatus extends Thread {
  /**
   * The run with the highest ordinal, if the thread has any run yet. A
   * cancelled run that never started is left out, unless every run is one.
   */
  readonly run: RunStatus | null;
  /** The `ordinal` of that same run; `null` when the thread has no run. */
  readonly runOrdinal: number | null;
  /**
   * When that same run began, as epoch milliseconds: its start, else when it was requested if it
   * was cancelled; `null` when it never began, or the thread has no run.
   */
  readonly runStartedAt: number | null;
  /** When that same run ended, as epoch milliseconds; `null` while it runs, or when the thread has no run. */
  readonly runCompletedAt: number | null;
  /** The text of the last assistant message of that same run; `null` when the run has none. */
  readonly lastAssistantMessage: string | null;
}

/**
 * Whether `branch` is the temporary `t3/<hex>` branch T3 made the worktree at `worktreePath`
 * on. T3 can rename the thread's branch after launch while the session pushes the one it
 * started on. T3 names the folder after that branch (`/` written `-`), and its record of the
 * folder cannot be changed by the session, unlike the checked-out branch.
 */
export const isLaunchBranch = (branch: string, worktreePath: string | null): boolean =>
  worktreePath !== null &&
  isTemporaryWorktreeBranch(branch) &&
  branch.replaceAll("/", "-") === worktreePath.split(/[\\/]/).pop();

/**
 * The temporary `t3/<hex>` branch T3 made the worktree at `worktreePath` on, read back from the
 * folder name (the inverse of `isLaunchBranch`); null when the folder is not named after one.
 */
export const launchBranchOf = (worktreePath: string | null): string | null => {
  const folder = worktreePath?.split(/[\\/]/).pop();
  if (folder === undefined) return null;
  const branch = folder.replace(/^t3-/, "t3/");
  return isLaunchBranch(branch, worktreePath) ? branch : null;
};

export class ThreadNotFoundError extends Schema.TaggedError<ThreadNotFoundError>()(
  "FactoryThreadNotFoundError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return `T3 does not know thread ${this.threadId}.`;
  }
}

/**
 * T3 refused the message. It keeps that answer for the command id, so sending
 * the same id again fails the same way; only a new id sends the message again.
 */
export class MessageRejectedError extends Schema.TaggedError<MessageRejectedError>()(
  "FactoryMessageRejectedError",
  { threadId: Schema.String, commandId: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `T3 refused message ${this.commandId} to thread ${this.threadId}.`;
  }
}

export class SessionsError extends Schema.TaggedError<SessionsError>()("FactorySessionsError", {
  operation: Schema.Literals([
    "find-project",
    "launch",
    "status",
    "thread",
    "send",
    "archive",
    "remove-worktree",
    "worktree-head",
    "broken-worktrees",
    "running-threads",
    "live-branches",
    "worktrees-directory",
    "last-activity",
  ]),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Factory sessions ${this.operation} failed.`;
  }
}

/** A live thread on a worktree that is gone, or is no longer a git checkout. */
export interface ThreadOnBrokenWorktree {
  readonly threadId: string;
  readonly worktreePath: string;
  /**
   * Every thread on the path, archived ones and this one included: an archived session keeps
   * its path, so the thread a run launched is among them.
   */
  readonly threadsOnPath: ReadonlyArray<string>;
}

/** The fields `status` and `thread` read from a thread projection. */
export interface ThreadSnapshot {
  readonly thread: ThreadFields;
  readonly runs: ReadonlyArray<{
    /** What each of the run's messages carries as its `runId`. */
    readonly id: string;
    readonly ordinal: number;
    readonly status: RunStatus;
    readonly requestedAt?: unknown;
    /** Absent for a run that never started. */
    readonly startedAt?: unknown;
    /** Absent for a run that has not ended. */
    readonly completedAt?: unknown;
  }>;
  readonly messages: ReadonlyArray<{
    readonly role: string;
    readonly text: string;
    /** The `id` of the run the message belongs to. */
    readonly runId: string | null;
  }>;
}

export interface ThreadFields {
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly archivedAt: unknown;
}

const threadOf = (thread: ThreadFields): Thread => ({
  worktreePath: thread.worktreePath,
  branch: thread.branch,
  archived: thread.archivedAt !== null && thread.archivedAt !== undefined,
});

/** The turn items a session's agent makes, unlike the messages and notices sent into its thread. */
const AGENT_ITEM_TYPES = [
  "assistant_message",
  "reasoning",
  "proposed_plan",
  "todo_list",
  "file_change",
  "command_execution",
  "file_search",
  "web_search",
  "dynamic_tool",
  "subagent",
] satisfies ReadonlyArray<OrchestrationV2TurnItem["type"]>;

/** A message queued behind a working run and cancelled before it started. */
const isCancelledUnstarted = (run: ThreadSnapshot["runs"][number]) =>
  run.status === "cancelled" && (run.startedAt === null || run.startedAt === undefined);

const highestOrdinal = <Run extends ThreadSnapshot["runs"][number]>(runs: ReadonlyArray<Run>) =>
  runs.reduce<Run | undefined>(
    (best, run) => (best === undefined || run.ordinal >= best.ordinal ? run : best),
    undefined,
  );

/**
 * The thread's run: the highest ordinal. A cancelled run that never started is
 * not the thread's run; when every run is one, the highest ordinal among them
 * decides.
 */
export const latestRun = <Run extends ThreadSnapshot["runs"][number]>(
  runs: ReadonlyArray<Run>,
): Run | undefined =>
  highestOrdinal(runs.filter((run) => !isCancelledUnstarted(run))) ?? highestOrdinal(runs);

/**
 * A time as T3 records it, an ISO string or a `DateTime` (`epochMilliseconds`), as epoch
 * milliseconds; `null` for a missing one, and for anything else.
 */
const msOf = (value: unknown): number | null => {
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "epochMilliseconds" in value &&
    typeof value.epochMilliseconds === "number"
  ) {
    return value.epochMilliseconds;
  }
  return null;
};

export const threadStatusOf = (snapshot: ThreadSnapshot): ThreadStatus => {
  const latest = latestRun(snapshot.runs);
  // Only the reported run's own message: a run that ended quietly must not be
  // read as ending with an older run's result line. A message with no run
  // reference is no run's.
  const lastAssistantMessage =
    latest === undefined
      ? null
      : (snapshot.messages.findLast(
          (message) => message.role === "assistant" && message.runId === latest.id,
        )?.text ?? null);
  return {
    run: latest?.status ?? null,
    runOrdinal: latest?.ordinal ?? null,
    // Not `workStartedAt`: a wake run copies that from an earlier run, so it can predate a restart
    // the run itself came after. Only a cancel can be a shutdown's doing before the run starts.
    runStartedAt:
      latest === undefined
        ? null
        : msOf(latest.startedAt ?? (latest.status === "cancelled" ? latest.requestedAt : null)),
    runCompletedAt: latest === undefined ? null : msOf(latest.completedAt),
    lastAssistantMessage,
    ...threadOf(snapshot.thread),
  };
};

export class FactorySessions extends Context.Service<
  FactorySessions,
  {
    /** The live T3 project whose workspace root is exactly `workspaceRoot`, with its model. */
    readonly findProject: (
      workspaceRoot: string,
    ) => Effect.Effect<FactoryProject | null, SessionsError>;
    /**
     * Starts a thread in its own worktree and runs `message` in it. The
     * worktree is prepared asynchronously, so the answer may not carry a
     * branch or path yet; `status` will. The same `commandId` again is the
     * same launch: T3 answers with the thread it made and starts nothing.
     */
    readonly launch: (request: LaunchRequest) => Effect.Effect<Launched, SessionsError>;
    /** The status of the thread's run, the last assistant message and where the thread works. */
    readonly status: (
      threadId: string,
    ) => Effect.Effect<ThreadStatus, ThreadNotFoundError | SessionsError>;
    /**
     * Where the thread works and whether it is archived. Only the thread's own
     * fields are read, so this answers for a thread whose runs or messages
     * `status` cannot read: the stop path uses it, so a session can always be
     * stopped.
     */
    readonly thread: (
      threadId: string,
    ) => Effect.Effect<Thread, ThreadNotFoundError | SessionsError>;
    /**
     * Sends a follow-up message into the thread; T3 decides delivery (start, steer or queue).
     * `commandId` names it like a launch's: resent after a failure, T3 keeps one message, and a
     * refused one stays refused under its id (`MessageRejectedError`). With `model`, the run it
     * starts, and the thread from then on, run on that model.
     */
    readonly send: (
      threadId: string,
      commandId: string,
      text: string,
      model?: Model,
    ) => Effect.Effect<void, ThreadNotFoundError | MessageRejectedError | SessionsError>;
    /**
     * Archives the thread, which stops its active run. Succeeds when the
     * thread ends archived or gone: one that already was archived, and one T3
     * does not know, change nothing. T3 does not make archiving idempotent, so
     * every attempt sends a command id of its own.
     */
    readonly archive: (threadId: string) => Effect.Effect<void, SessionsError>;
    /**
     * Removes a thread's worktree with git and keeps its branch. Live threads still on it (a
     * subagent sharing the checkout) are archived first, failing as `archive` before git runs; a
     * later failure is `remove-worktree`. A worktree already gone is removed; `path` is absolute.
     * A folder git just unlisted is emptied over about 10 s; any other leftover fails for a person.
     */
    readonly removeWorktree: (path: string) => Effect.Effect<void, SessionsError>;
    /**
     * What the worktree at absolute `path` has checked out: its HEAD commit, and the branch HEAD
     * is on (null when detached). Null when `path` has no `.git`: no worktree is there. A read that
     * fails, or a HEAD that is not a full commit id, is `worktree-head`.
     */
    readonly worktreeCheckout: (path: string) => Effect.Effect<Checkout | null, SessionsError>;
    /**
     * The unarchived threads whose worktree is gone or has no `.git`: T3's
     * pull request lookup and settlement run git there and fail every sweep.
     * A thread `archive` archived since this server started is left out, so
     * one a person unarchives stays theirs until a restart.
     */
    readonly brokenWorktrees: Effect.Effect<ReadonlyArray<ThreadOnBrokenWorktree>, SessionsError>;
    /**
     * How many unarchived threads, a person's or the factory's, have an agent at work: a run
     * preparing, starting or running. A run waiting on a person does not count.
     */
    readonly runningThreads: Effect.Effect<number, SessionsError>;
    /** The branches of the threads that are neither archived nor deleted, a person's or the factory's. */
    readonly liveBranches: Effect.Effect<ReadonlySet<string>, SessionsError>;
    /**
     * When the thread's agent last did anything (a message, reasoning, tool call or subagent), as
     * epoch milliseconds; null when it has done nothing. What is sent into the thread is not counted.
     */
    readonly lastActivity: (threadId: string) => Effect.Effect<number | null, SessionsError>;
    /**
     * The folder T3 makes a new thread's worktree under now: the one Settings → Storage names,
     * else `defaultDir`. Null for a setting T3 cannot make a worktree under.
     */
    readonly worktreesDirectory: (
      defaultDir: string,
    ) => Effect.Effect<string | null, SessionsError>;
  }
>()("t3/factory/t3/sessions/FactorySessions") {}

const isThreadNotFound = Schema.is(ProjectionStore.ProjectionStoreThreadNotFoundError);
const isRefused = Schema.is(
  Schema.Union([
    Orchestrator.OrchestratorCommandRejectedError,
    Orchestrator.OrchestratorCommandPreviouslyRejectedError,
  ]),
);

const mapReadError =
  (operation: "status" | "thread", threadId: string) =>
  (cause: ProjectionStore.ProjectionStoreV2Error) =>
    isThreadNotFound(cause)
      ? new ThreadNotFoundError({ threadId })
      : new SessionsError({ operation, cause });

// Ids are T3's branded non-blank strings. A blank one is a caller's mistake
// and fails as the declared error, never as a thrown schema defect.
const decodeCommandId = Schema.decodeUnknownEffect(CommandId);
const decodeProjectId = Schema.decodeUnknownEffect(ProjectId);
const decodeMessageId = Schema.decodeUnknownEffect(MessageId);
const decodeInstanceId = Schema.decodeUnknownEffect(ProviderInstanceId);
const decodeThreadId = Schema.decodeUnknownEffect(ThreadId);

/** A blank thread id names no thread. */
const requireThreadId = (threadId: string) =>
  decodeThreadId(threadId).pipe(Effect.mapError(() => new ThreadNotFoundError({ threadId })));

/** git's message when it removed what it could and left a directory it could not empty. */
const leftNotEmpty = (stderr: string) =>
  stderr.split("\n").some((line) => line.trimEnd().endsWith(": Directory not empty"));

/**
 * After git left a directory it could not empty, the factory deletes it three
 * times at most, 3 s apart from the first wait on: about 10 s for a process
 * still writing into it to stop.
 */
const LEFTOVER_REMOVE_ATTEMPTS = { schedule: Schedule.spaced("3 seconds"), times: 2 };

/** `git worktree remove` of a big `node_modules` can take a while. */
const REMOVE_WORKTREE_TIMEOUT_MS = 10 * 60 * 1000;
const WORKTREE_HEAD_TIMEOUT_MS = 30 * 1000;

const make = Effect.gen(function* () {
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const management = yield* ThreadManagement.ThreadManagementService;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sql = yield* SqlClient.SqlClient;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const settings = yield* ServerSettings.ServerSettingsService;

  const findProject: FactorySessions["Service"]["findProject"] = Effect.fn("Sessions.findProject")(
    function* (workspaceRoot) {
      const row = yield* projects.findActiveByWorkspaceRoot(workspaceRoot);
      if (Option.isNone(row)) return null;
      // T3's own resolver, as a new thread uses it (`serverRuntimeStartup.ts`): a project
      // override stored in the settings wins over the row, a folded install ignores the row,
      // and a model whose provider instance is disabled for the project is skipped.
      const { projectId } = row.value;
      const model = resolveProjectSettings(yield* settings.getSettings, projectId, row.value)
        .settings.defaultModelSelection;
      return { id: projectId as string, model };
    },
    Effect.mapError((cause) => new SessionsError({ operation: "find-project", cause })),
  );

  /**
   * Never fails: the thread exists and the launch is recorded either way, so a link that cannot
   * be made is logged and dropped. The command id derives from the launch's, so a launch sent
   * again does not link twice.
   */
  const linkPullRequest = Effect.fn("Sessions.linkPullRequest")(
    function* (launchCommandId: string, threadId: ThreadId, url: string) {
      const parsed = sourceControlDefinitions.parseChangeRequestUrl(url)?.link;
      if (parsed === undefined) {
        return yield* Effect.logWarning("factory could not read the pull request URL to link", {
          threadId,
          pullRequestUrl: url,
        });
      }
      const commandId = yield* decodeCommandId(`${launchCommandId}:pull-request-link`);
      yield* management.dispatch({
        type: "thread.pull-request.link",
        commandId,
        threadId,
        host: parsed.host,
        repository: parsed.repository,
        number: parsed.number,
        url,
        source: "agent",
      });
    },
    (effect, _launchCommandId, threadId, url) =>
      Effect.catchCause(effect, (cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause as Cause.Cause<never>)
          : Effect.logWarning("factory could not link the pull request to the launched thread", {
              threadId,
              pullRequestUrl: url,
              cause: Cause.pretty(cause),
            }),
      ),
  );

  const launch: FactorySessions["Service"]["launch"] = Effect.fn("Sessions.launch")(
    function* (request) {
      const commandId = yield* decodeCommandId(request.commandId);
      const projectId = yield* decodeProjectId(request.projectId);
      const instanceId = yield* decodeInstanceId(request.model.instanceId);
      const result = yield* launches.launch({
        commandId,
        projectId,
        title: request.title,
        modelSelection: {
          instanceId,
          model: request.model.model,
          ...(request.model.options !== undefined && { options: request.model.options }),
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: {
          type: "worktree",
          baseRef: request.baseRef,
          startFromOrigin: request.startFromOrigin,
        },
        initialMessage: { text: request.message, attachments: [] },
        createdBy: "user",
        creationSource: "server",
      });
      if (request.pullRequestUrl !== undefined) {
        yield* linkPullRequest(request.commandId, result.threadId, request.pullRequestUrl);
      }
      return {
        threadId: result.threadId as string,
        worktreePath: result.projection.thread.worktreePath,
        branch: result.projection.thread.branch,
      };
    },
    Effect.mapError((cause) => new SessionsError({ operation: "launch", cause })),
  );

  // The factory polls this per session, so it reads only the rows
  // `threadStatusOf` uses, not the whole projection of a long thread.
  const status: FactorySessions["Service"]["status"] = (threadId) =>
    requireThreadId(threadId).pipe(
      Effect.flatMap((id) =>
        projections
          .getThreadRecords(id, ["runs", "messages"], { messageRoles: ["assistant"] })
          .pipe(Effect.map(threadStatusOf), Effect.mapError(mapReadError("status", threadId))),
      ),
    );

  const thread: FactorySessions["Service"]["thread"] = (threadId) =>
    requireThreadId(threadId).pipe(
      Effect.flatMap((id) =>
        projections
          .getThread(id)
          .pipe(Effect.map(threadOf), Effect.mapError(mapReadError("thread", threadId))),
      ),
    );

  // Delivery is T3's to decide (`deliveryIntent: "auto"`); the dispatch mode is
  // required by the schema and ignored when the intent is set.
  const send: FactorySessions["Service"]["send"] = Effect.fn("Sessions.send")(
    function* (threadId, commandId, text, model) {
      const id = yield* requireThreadId(threadId);
      return yield* Effect.gen(function* () {
        const command = yield* decodeCommandId(commandId);
        const messageId = yield* decodeMessageId(`message:${commandId}`);
        const modelSelection =
          model === undefined
            ? undefined
            : {
                instanceId: yield* decodeInstanceId(model.instanceId),
                model: model.model,
                ...(model.options !== undefined && { options: model.options }),
              };
        yield* management.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "server",
          commandId: command,
          threadId: id,
          messageId,
          text,
          attachments: [],
          ...(modelSelection !== undefined && { modelSelection }),
          deliveryIntent: "auto",
          dispatchMode: { type: "start_immediately" },
        });
      }).pipe(
        Effect.mapError((cause) =>
          isRefused(cause)
            ? new MessageRejectedError({ threadId, commandId, cause })
            : new SessionsError({ operation: "send", cause }),
        ),
      );
    },
  );

  // T3 remembers a rejected command id for good, so each attempt needs its own.
  const archiveCommandId = (id: ThreadId) =>
    crypto
      .randomUUIDv4()
      .pipe(Effect.flatMap((uuid) => decodeCommandId(`factory-archive:${id}:${uuid}`)));

  const archiveState = (id: ThreadId) =>
    projections.getThread(id).pipe(
      Effect.match({
        onSuccess: (found) =>
          threadOf(found).archived ? ("archived" as const) : ("live" as const),
        onFailure: (cause) =>
          isThreadNotFound(cause) ? ("unknown" as const) : ("unreadable" as const),
      }),
    );

  // The threads `archive` was asked for and left archived in this process: `brokenWorktrees`
  // leaves them out.
  const archivedHere = new Set<string>();

  // A thread that cannot be read is archived anyway, so it is never left
  // running because its snapshot failed. When that fails, the thread is read
  // once more: a lost answer or a race can leave it archived all the same.
  const archive: FactorySessions["Service"]["archive"] = Effect.fn("Sessions.archive")(
    function* (threadId) {
      const id = yield* Effect.option(decodeThreadId(threadId));
      if (Option.isNone(id)) return;
      const before = yield* archiveState(id.value);
      if (before === "archived") archivedHere.add(id.value);
      if (before === "archived" || before === "unknown") return;
      const commandId = yield* archiveCommandId(id.value).pipe(
        Effect.mapError((cause) => new SessionsError({ operation: "archive", cause })),
      );
      yield* management
        .dispatch({ type: "thread.archive", commandId, threadId: id.value })
        .pipe(
          Effect.catch((cause) =>
            archiveState(id.value).pipe(
              Effect.flatMap((after) =>
                after === "archived" || after === "unknown"
                  ? Effect.void
                  : Effect.fail(new SessionsError({ operation: "archive", cause })),
              ),
            ),
          ),
        );
      archivedHere.add(id.value);
    },
  );

  const removeWorktreeFailed = (cause: unknown) =>
    new SessionsError({ operation: "remove-worktree", cause });

  // git matches a bare name by suffix against every worktree, so a relative
  // path could remove another thread's worktree. Run from the worktree itself:
  // git removes it from there, and a clone's path is not needed.
  const removeWorktree: FactorySessions["Service"]["removeWorktree"] = Effect.fn(
    "Sessions.removeWorktree",
  )(function* (worktreePath) {
    if (!path.isAbsolute(worktreePath)) {
      return yield* removeWorktreeFailed(`the worktree path is not absolute: ${worktreePath}`);
    }
    const bound = yield* projections
      .getThreadWorktreePaths()
      .pipe(Effect.mapError((cause) => new SessionsError({ operation: "archive", cause })));
    const onWorktree = bound.filter((thread) => thread.worktreePath === worktreePath);
    yield* Effect.forEach(onWorktree, (thread) => archive(thread.threadId), { discard: true });
    if (onWorktree.length > 0) {
      yield* Effect.logInfo("factory archived the threads still on a worktree it removes", {
        worktreePath,
        threadIds: onWorktree.map((thread) => thread.threadId),
      });
    }
    const attempt = yield* git
      .execute({
        operation: "factory.sessions.removeWorktree",
        cwd: worktreePath,
        args: ["worktree", "remove", "--force", "--", worktreePath],
        env: { LC_ALL: "C" },
        allowNonZeroExit: true,
        timeoutMs: REMOVE_WORKTREE_TIMEOUT_MS,
      })
      .pipe(Effect.result);
    if (attempt._tag === "Success" && attempt.success.exitCode === 0) return;
    const exists = yield* fs.exists(worktreePath).pipe(Effect.mapError(removeWorktreeFailed));
    if (!exists) return;
    if (attempt._tag === "Failure") return yield* removeWorktreeFailed(attempt.failure);
    if (!leftNotEmpty(attempt.success.stderr)) {
      return yield* removeWorktreeFailed(
        `git did not remove ${worktreePath}, which is still on disk: ${attempt.success.stderr.trim()}`,
      );
    }
    // git took the worktree off the clone's list and could not empty the
    // directory (a process still writing into it): wait, then finish it.
    yield* Effect.sleep("3 seconds");
    yield* fs
      .remove(worktreePath, { recursive: true })
      .pipe(Effect.retry(LEFTOVER_REMOVE_ATTEMPTS), Effect.mapError(removeWorktreeFailed));
  });

  const worktreeCheckout: FactorySessions["Service"]["worktreeCheckout"] = Effect.fn(
    "Sessions.worktreeCheckout",
  )(function* (worktreePath) {
    const failed = (cause: unknown) => new SessionsError({ operation: "worktree-head", cause });
    if (!path.isAbsolute(worktreePath)) {
      return yield* failed(`the worktree path is not absolute: ${worktreePath}`);
    }
    const there = yield* fs.exists(path.join(worktreePath, ".git")).pipe(Effect.mapError(failed));
    if (!there) return null;
    const run = (args: ReadonlyArray<string>) =>
      git
        .execute({
          operation: "factory.sessions.worktreeCheckout",
          cwd: worktreePath,
          args: [...args],
          env: { LC_ALL: "C" },
          allowNonZeroExit: true,
          timeoutMs: WORKTREE_HEAD_TIMEOUT_MS,
        })
        .pipe(Effect.mapError(failed));
    const rev = yield* run(["rev-parse", "--verify", "HEAD"]);
    const head = rev.stdout.trim();
    if (rev.exitCode !== 0 || !isCommitId(head)) {
      return yield* failed(`git rev-parse HEAD in ${worktreePath}: ${rev.stderr.trim()}`);
    }
    // `symbolic-ref --quiet` exits 1, printing nothing, when HEAD is detached.
    const ref = yield* run(["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (ref.exitCode === 1 && ref.stdout.trim() === "") return { head, branch: null };
    const branch = ref.stdout.trim();
    if (ref.exitCode !== 0 || branch === "") {
      return yield* failed(`git symbolic-ref HEAD in ${worktreePath}: ${ref.stderr.trim()}`);
    }
    return { head, branch };
  });

  // A path whose `.git` cannot be checked (a permission error) is not called broken.
  const brokenWorktrees: FactorySessions["Service"]["brokenWorktrees"] = Effect.gen(function* () {
    const live = (yield* projections.getThreadWorktreePaths()).filter(
      (thread) => !archivedHere.has(thread.threadId),
    );
    const broken = yield* Effect.filter(live, (thread) =>
      fs.exists(path.join(thread.worktreePath, ".git")).pipe(
        Effect.map((checkout) => !checkout),
        Effect.orElseSucceed(() => false),
      ),
    );
    if (broken.length === 0) return [];
    const all = yield* projections.getThreadWorktreePaths({ includeArchived: true });
    return broken.map((thread) => ({
      threadId: thread.threadId as string,
      worktreePath: thread.worktreePath,
      threadsOnPath: all
        .filter((other) => other.worktreePath === thread.worktreePath)
        .map((other) => other.threadId as string),
    }));
  }).pipe(Effect.mapError((cause) => new SessionsError({ operation: "broken-worktrees", cause })));

  // The shell snapshot's `activity_run_status` (ProjectionStore `selectShellThreadRows`) without
  // the snapshot: a thread's latest run among the unfinished statuses decides. The runs table
  // drives it, so a thread's payload is read only when it has an unfinished run, and the read
  // runs on the reader worker, off the event loop.
  const runningThreads: FactorySessions["Service"]["runningThreads"] = sql<{
    readonly count: number;
  }>`
    SELECT COUNT(*) AS count
    FROM (
      SELECT
        r.thread_id,
        r.status,
        ROW_NUMBER() OVER (PARTITION BY r.thread_id ORDER BY r.ordinal DESC, r.run_id DESC) AS rank
      FROM orchestration_v2_projection_runs r
      WHERE r.status IN ('preparing', 'starting', 'running', 'waiting')
    ) latest
    JOIN orchestration_v2_projection_threads t ON t.thread_id = latest.thread_id
    WHERE latest.rank = 1
      AND latest.status IN ('preparing', 'starting', 'running')
      AND t.deleted_at IS NULL
      AND json_extract(t.payload_json, '$.archivedAt') IS NULL
  `.pipe(
    Effect.map((rows) => rows[0]?.count ?? 0),
    NodeSqliteClient.readOnly,
    Effect.mapError((cause) => new SessionsError({ operation: "running-threads", cause })),
  );

  const liveBranches: FactorySessions["Service"]["liveBranches"] = sql<{
    readonly branch: string;
  }>`
    SELECT DISTINCT json_extract(payload_json, '$.branch') AS branch
    FROM orchestration_v2_projection_threads
    WHERE deleted_at IS NULL
      AND json_extract(payload_json, '$.archivedAt') IS NULL
      AND json_extract(payload_json, '$.branch') IS NOT NULL
  `.pipe(
    Effect.map((rows) => new Set(rows.map((row) => row.branch))),
    NodeSqliteClient.readOnly,
    Effect.mapError((cause) => new SessionsError({ operation: "live-branches", cause })),
  );

  // The thread's newest agent event in the shared event log (`OrchestrationEventStore`). Pinned to
  // the stream index as `latestAgentSequence` is: the planner otherwise walks every newer V2 event.
  const lastActivity: FactorySessions["Service"]["lastActivity"] = (threadId) =>
    sql<{ readonly occurred_at: string }>`
      SELECT occurred_at
      FROM orchestration_events INDEXED BY idx_orchestration_events_agent_stream_sequence
      WHERE aggregate_kind = 'thread'
        AND stream_id = ${threadId}
        AND application_event_version = 2
        AND (
          event_type = 'subagent.updated'
          OR (
            event_type = 'turn-item.updated'
            AND json_extract(payload_json, '$.type') IN ${sql.in(AGENT_ITEM_TYPES)}
          )
        )
      ORDER BY sequence DESC
      LIMIT 1
    `.pipe(
      Effect.map((rows) => msOf(rows[0]?.occurred_at)),
      NodeSqliteClient.readOnly,
      Effect.mapError((cause) => new SessionsError({ operation: "last-activity", cause })),
    );

  const worktreesDirectory: FactorySessions["Service"]["worktreesDirectory"] = Effect.fn(
    "Sessions.worktreesDirectory",
  )(
    function* (defaultDir) {
      const { worktreesDirectory: setting } = yield* settings.getSettings;
      return resolveWorktreesDirectory(setting, defaultDir, path, yield* HostProcess.HomeDirectory);
    },
    Effect.mapError((cause) => new SessionsError({ operation: "worktrees-directory", cause })),
  );

  return FactorySessions.of({
    findProject,
    launch,
    status,
    thread,
    send,
    archive,
    removeWorktree,
    worktreeCheckout,
    brokenWorktrees,
    runningThreads,
    liveBranches,
    lastActivity,
    worktreesDirectory,
  });
});

export const layer = Layer.effect(FactorySessions, make);

/**
 * `layer` with the projection store provided: `server.ts` has everything else in scope where
 * the factory is merged in, but upstream provides the projection store to each worker that
 * reads it. Same layer `server.ts` provides elsewhere, memoized with it.
 */
export const layerLive = layer.pipe(Layer.provide(ProjectionStore.layer));
