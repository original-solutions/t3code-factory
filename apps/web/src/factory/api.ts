import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentSession } from "~/state/session";
import { textField, type PrEnd } from "./format";
import {
  DEFAULT_TIMEOUT_MS,
  FactoryHttpError,
  factoryRequest,
  failureMessage,
  failureParts,
  parseJson,
  timeoutMessage,
} from "./http";

/** The factory's HTTP API as the server serves it (`apps/server/src/factory/t3/http.ts`). */

export interface FactoryAttentionItem {
  readonly id: string;
  readonly kind: string;
  readonly repo: string | null;
  readonly issue: number | null;
  readonly run: string | null;
  readonly message: string;
  /** ISO time the item was first raised. */
  readonly first_seen: string;
}

export interface FactoryStatus {
  readonly state: "running" | "idle";
  readonly reason: string | null;
  readonly paused_by_hand: { readonly since: string; readonly for_ms: number } | null;
  /**
   * The build autodeploy has waiting, which holds claims back unless snoozed; null when none;
   * absent from older servers. `deploy_by` is when it installs over the runs in progress, null
   * while snoozed.
   */
  readonly deploy_pending?: {
    readonly commit: string | null;
    readonly since: string;
    readonly waited_ms: number;
    readonly deploy_by: string | null;
    readonly snoozed_until: string | null;
  } | null;
  readonly runs: ReadonlyArray<{
    readonly id: string;
    readonly state: string | null;
    /** The event of the run's last readable ledger line; null for none; absent from older servers. */
    readonly last_event?: string | null;
    /** The issue title its first launch recorded; null when it has none; absent from older servers. */
    readonly title?: string | null;
    readonly user: string | null;
    readonly for_ms: number | null;
    readonly pr_url: string | null;
    readonly thread_id: string | null;
    /** Its session reported a pull request and it waits for the gate; absent from older servers. */
    readonly pr_reported?: boolean;
    readonly unreadable: boolean;
  }>;
  readonly attention: ReadonlyArray<FactoryAttentionItem>;
  /** Items a person dismissed whose cause still holds; absent from older servers. */
  readonly dismissed?: ReadonlyArray<FactoryAttentionItem>;
  readonly slots: { readonly used: number; readonly max: number | null };
  /**
   * Threads with an agent at work, a person's or the factory's, which an update interrupts; null
   * when T3 could not say; absent from older servers.
   */
  readonly threads?: { readonly running: number | null };
  /** The pass loop, as far as the page reads it. */
  readonly passes: {
    /** When the last pass ended, or null before one. */
    readonly at: string | null;
    readonly poll_seconds: number | null;
    /** A pass is running now. */
    readonly running: boolean;
    /** The last pass is older than a few polls: the pass loop has stalled; absent from older servers. */
    readonly stale?: boolean;
  };
  readonly problems: ReadonlyArray<unknown>;
  /**
   * The disk, load and gates the pass holds claims on, read with this status; null while idle;
   * absent from older servers. `apps/server/src/factory/health.ts`.
   */
  readonly health?: FactoryHealth | null;
}

export interface FactoryHealth {
  readonly disk:
    | {
        readonly path: string;
        readonly free_bytes: number;
        readonly total_bytes: number;
        /** `min_free_gib` in bytes; null when the check is off. */
        readonly floor_bytes: number | null;
        readonly low: boolean;
      }
    | { readonly error: string };
  readonly load: {
    readonly one_minute: number;
    readonly cores: number;
    /** Null when the check is off. */
    readonly limit: number | null;
    readonly high: boolean;
  };
  readonly gates: {
    readonly running: number;
    readonly max: number;
    readonly oldest_ms: number | null;
  };
}

export interface FactoryRunRow {
  readonly id: string;
  readonly started_ts: string | null;
  readonly state: string | null;
  readonly last_event: string | null;
  readonly step: string | null;
  readonly status: string;
  readonly pr_url: string | null;
  /** How the pull request ended, for a run that finished on it; absent from older servers. */
  readonly pr_end?: PrEnd | null;
  /** The issue title its first launch recorded; absent from older servers, null before titles were. */
  readonly title?: string | null;
  /**
   * Why a stuck run is stuck, or the questions a needs-info run posted; absent from older servers,
   * null for any other state. Untrusted text: show it as text only.
   */
  readonly reason?: string | null;
  readonly finished: boolean;
  readonly total_ms: number | null;
  readonly unreadable: boolean;
}

export interface FactoryEntry {
  readonly ts: string;
  readonly ms: number;
  readonly event: string;
  readonly data: unknown;
  readonly cause: unknown;
}

export interface FactoryRunDetail {
  readonly id: string;
  readonly entries: ReadonlyArray<FactoryEntry>;
  readonly truncated: boolean;
  readonly skipped: number;
}

/** One part of a run's GitHub read: what GitHub said, or why it could not be asked. */
export type FactoryGitHubPart<T> =
  | ({ readonly kind: "ok" } & T)
  | { readonly kind: "signed-out"; readonly message: string }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "gone" };

/** A run's issue and pull request as the factory's `gh` reads them (`runGitHub.ts`). Untrusted text. */
export interface FactoryRunGitHub {
  readonly id: string;
  /** Null for an issue that is not on GitHub. */
  readonly issue: FactoryGitHubPart<{
    readonly number: number;
    readonly title: string;
    readonly body: string;
    readonly body_cut: boolean;
    readonly author: string | null;
    readonly labels: ReadonlyArray<string>;
    readonly closed: boolean;
  }> | null;
  /** Null while the run has opened no pull request. */
  readonly pr: FactoryGitHubPart<{
    readonly number: number;
    readonly title: string;
    readonly body: string;
    readonly body_cut: boolean;
    readonly state: "open" | "draft" | "merged" | "closed";
    readonly additions: number;
    readonly deletions: number;
    readonly changed_files: number;
    readonly review_decision: string | null;
    readonly files: ReadonlyArray<{
      readonly path: string;
      readonly additions: number;
      readonly deletions: number;
    }>;
  }> | null;
}

/** The ready issues the claim step held back, from the machine log (`readyQueue.ts` on the server). */
export interface FactoryReadyQueue {
  readonly last_pass_at: string | null;
  /** The newest pass's machine-wide skips: `paused`, `low-disk`, `high-load`, `deploy-pending`, `late`, … */
  readonly holds: ReadonlyArray<string>;
  /** When the newest pass that read the ready issues ended; `waiting` is as of then. */
  readonly checked_at: string | null;
  readonly waiting: ReadonlyArray<{
    readonly repo: string;
    readonly issue: string;
    readonly reason: string;
    readonly since: string;
    readonly passes: number;
    /** The server read only part of the log, so the wait began before `since`; absent on older servers. */
    readonly since_cut?: boolean;
  }>;
  readonly turned_away: ReadonlyArray<{
    readonly repo: string;
    readonly issue: string;
    readonly at: string;
  }>;
  readonly skipped_repos: ReadonlyArray<{ readonly repo: string; readonly reason: string }>;
}

export interface FactoryStopResult {
  readonly stopped: string;
  readonly already: boolean;
  readonly message: string;
}

export interface FactoryPauseResult {
  readonly paused: true;
  readonly already: boolean;
  readonly since: string;
  readonly message: string;
}

export interface FactoryDismissResult {
  /** The ids the server dismissed; an id that was not open is left out. */
  readonly dismissed: ReadonlyArray<string>;
}

export interface FactoryRestoreResult {
  /** The ids the server listed again; an id that was not dismissed is left out. */
  readonly restored: ReadonlyArray<string>;
}

export interface FactorySnoozeResult {
  /** ISO time the snooze ends. */
  readonly snoozed_until: string;
}

export interface FactoryDeployNowResult {
  /** The build asked for: the server answers 409, not 202, when no build is waiting. */
  readonly commit: string;
  /** Autodeploy started now; false when it starts on its next tick. */
  readonly kicked: boolean;
  readonly message: string;
}

export interface FactoryResumeResult {
  readonly paused: false;
  readonly already: boolean;
  readonly message: string;
}

/** A non-2xx answer, or a request that never got one (`status` 0). */
// @effect-diagnostics-next-line extendsNativeError:off - thrown and caught in plain Promise code, with no Effect runtime.
export class FactoryApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  /** The message without the fix it ends with, for a caller that has a better fix to give. */
  readonly reason: string;
  constructor(status: number, code: string | null, message: string, reason = message) {
    super(message);
    this.name = "FactoryApiError";
    this.status = status;
    this.code = code;
    this.reason = reason;
  }
}

/** The error for a non-2xx answer, from its parsed body. */
export const failureError = (status: number, body: unknown): FactoryApiError =>
  new FactoryApiError(
    status,
    textField(body, "code"),
    failureMessage(status, body),
    failureParts(status, body).reason,
  );

export interface FactoryApi {
  readonly status: (environmentId: EnvironmentId) => Promise<FactoryStatus>;
  /** The recent window the server lists by default (`RECENT_FINISHED_MS`), or every run with `all`. */
  readonly runs: (
    environmentId: EnvironmentId,
    options: { readonly all: boolean },
  ) => Promise<{ readonly runs: ReadonlyArray<FactoryRunRow> }>;
  readonly run: (environmentId: EnvironmentId, id: string) => Promise<FactoryRunDetail>;
  readonly runGitHub: (environmentId: EnvironmentId, id: string) => Promise<FactoryRunGitHub>;
  readonly queue: (environmentId: EnvironmentId) => Promise<FactoryReadyQueue>;
  readonly stopRun: (environmentId: EnvironmentId, id: string) => Promise<FactoryStopResult>;
  readonly pauseClaims: (environmentId: EnvironmentId) => Promise<FactoryPauseResult>;
  readonly resumeClaims: (environmentId: EnvironmentId) => Promise<FactoryResumeResult>;
  /** `commit` is the waiting build the page showed; the server refuses when another waits now. */
  readonly snoozeDeploy: (
    environmentId: EnvironmentId,
    commit: string | null,
  ) => Promise<FactorySnoozeResult>;
  readonly deployNow: (
    environmentId: EnvironmentId,
    commit: string | null,
  ) => Promise<FactoryDeployNowResult>;
  readonly dismissAttention: (
    environmentId: EnvironmentId,
    ids: ReadonlyArray<string>,
  ) => Promise<FactoryDismissResult>;
  readonly restoreAttention: (
    environmentId: EnvironmentId,
    ids: ReadonlyArray<string>,
  ) => Promise<FactoryRestoreResult>;
}

/**
 * How long one call may wait for its answer, the wait for a connection included. A server that
 * hangs then fails the call (status 0, code `timeout`) instead of pinning a page on loading and its
 * poll on a request that never ends.
 */
let timeoutMs = DEFAULT_TIMEOUT_MS;

/** For tests: how long a call waits; no argument restores the default. */
export const __setFactoryTimeoutForTests = (ms?: number): void => {
  timeoutMs = ms ?? DEFAULT_TIMEOUT_MS;
};

const connectionOverrideAtom = Atom.make<PreparedConnection | null | undefined>(undefined).pipe(
  Atom.keepAlive,
  Atom.withLabel("factory-connection-override"),
);

/** For tests: the connection every call uses (null: none yet); no argument restores the real one. */
export const __setFactoryConnectionForTests = (prepared?: PreparedConnection | null): void => {
  appAtomRegistry.set(connectionOverrideAtom, prepared);
};

/** One environment's prepared connection: the server that environment points at. */
const connectionAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): PreparedConnection | null => {
    const override = get(connectionOverrideAtom);
    if (override !== undefined) return override;
    return Option.getOrNull(get(environmentSession.preparedConnectionValueAtom(environmentId)));
  }).pipe(Atom.withLabel(`factory-connection:${environmentId}`)),
);

/** The connection now, or the first one that appears within `ms` (a call can precede startup). */
const connectionWithin = (
  environmentId: EnvironmentId,
  ms: number,
): Promise<PreparedConnection> => {
  const atom = connectionAtom(environmentId);
  const current = appAtomRegistry.get(atom);
  if (current !== null) return Promise.resolve(current);
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new FactoryApiError(0, "no_connection", "The factory has no server connection yet."));
    }, ms);
    unsubscribe = appAtomRegistry.subscribe(atom, (prepared) => {
      if (prepared === null) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(prepared);
    });
  });
};

const call = async <T>(
  environmentId: EnvironmentId,
  method: "GET" | "POST",
  path: string,
  searchParams?: Record<string, string>,
  requestBody?: unknown,
): Promise<T> => {
  // One deadline for the whole call: the request gets what the wait for a connection left.
  const deadline = Date.now() + timeoutMs;
  const timedOut = () => new FactoryApiError(0, "timeout", timeoutMessage(timeoutMs));
  let result;
  try {
    const prepared = await connectionWithin(environmentId, timeoutMs);
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw timedOut();
    result = await factoryRequest(prepared, {
      method,
      path,
      searchParams,
      body: requestBody,
      timeoutMs: remainingMs,
    });
  } catch (error) {
    if (error instanceof FactoryApiError) throw error;
    if (error instanceof FactoryHttpError && error.kind === "timeout") throw timedOut();
    throw new FactoryApiError(
      0,
      error instanceof FactoryHttpError ? error.kind : null,
      error instanceof Error && error.message ? error.message : "The request failed.",
    );
  }
  const body = parseJson(result.text);
  if (result.status < 200 || result.status >= 300) {
    throw failureError(result.status, body);
  }
  return body as T;
};

const post = <T>(environmentId: EnvironmentId, path: string, body?: unknown) =>
  call<T>(environmentId, "POST", path, undefined, body);
const get = <T>(
  environmentId: EnvironmentId,
  path: string,
  searchParams?: Record<string, string>,
) => call<T>(environmentId, "GET", path, searchParams);

const runPath = (id: string) => `/api/factory/runs/${encodeURIComponent(id)}`;

const httpApi: FactoryApi = {
  status: (environmentId) => get(environmentId, "/api/factory/status"),
  runs: (environmentId, { all }) =>
    get(environmentId, "/api/factory/runs", all ? { all: "1" } : undefined),
  run: (environmentId, id) => get(environmentId, runPath(id)),
  runGitHub: (environmentId, id) => get(environmentId, `${runPath(id)}/github`),
  queue: (environmentId) => get(environmentId, "/api/factory/queue"),
  stopRun: (environmentId, id) => post(environmentId, `${runPath(id)}/stop`),
  pauseClaims: (environmentId) => post(environmentId, "/api/factory/claims/pause"),
  resumeClaims: (environmentId) => post(environmentId, "/api/factory/claims/resume"),
  snoozeDeploy: (environmentId, commit) =>
    post(environmentId, "/api/factory/deploy/snooze", { commit }),
  deployNow: (environmentId, commit) => post(environmentId, "/api/factory/deploy/now", { commit }),
  dismissAttention: (environmentId, ids) =>
    post(environmentId, "/api/factory/attention/dismiss", { ids }),
  restoreAttention: (environmentId, ids) =>
    post(environmentId, "/api/factory/attention/restore", { ids }),
};

let override: FactoryApi | undefined;

/** Swaps the API for a test; no argument restores the HTTP one. */
export const __setFactoryApiForTests = (api?: FactoryApi): void => {
  override = api;
};

/** Delegates on every call, so a swap takes effect for hooks that already hold the object. */
export const factoryApi: FactoryApi = {
  status: (environmentId) => (override ?? httpApi).status(environmentId),
  runs: (environmentId, options) => (override ?? httpApi).runs(environmentId, options),
  run: (environmentId, id) => (override ?? httpApi).run(environmentId, id),
  runGitHub: (environmentId, id) => (override ?? httpApi).runGitHub(environmentId, id),
  queue: (environmentId) => (override ?? httpApi).queue(environmentId),
  stopRun: (environmentId, id) => (override ?? httpApi).stopRun(environmentId, id),
  pauseClaims: (environmentId) => (override ?? httpApi).pauseClaims(environmentId),
  resumeClaims: (environmentId) => (override ?? httpApi).resumeClaims(environmentId),
  snoozeDeploy: (environmentId, commit) =>
    (override ?? httpApi).snoozeDeploy(environmentId, commit),
  deployNow: (environmentId, commit) => (override ?? httpApi).deployNow(environmentId, commit),
  dismissAttention: (environmentId, ids) =>
    (override ?? httpApi).dismissAttention(environmentId, ids),
  restoreAttention: (environmentId, ids) =>
    (override ?? httpApi).restoreAttention(environmentId, ids),
};
