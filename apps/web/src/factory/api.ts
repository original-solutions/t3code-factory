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
  readonly runs: ReadonlyArray<{
    readonly id: string;
    readonly state: string | null;
    readonly user: string | null;
    readonly for_ms: number | null;
    readonly pr_url: string | null;
    readonly thread_id: string | null;
    readonly unreadable: boolean;
  }>;
  readonly attention: ReadonlyArray<FactoryAttentionItem>;
  readonly slots: { readonly used: number; readonly max: number | null };
  readonly passes: unknown;
  readonly problems: ReadonlyArray<unknown>;
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

export interface FactoryResumeResult {
  readonly paused: false;
  readonly already: boolean;
  readonly message: string;
}

/** A non-2xx answer, or a request that never got one (`status` 0). */
export class FactoryApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  /** The answer's parsed body, for callers that read more than the message (decode errors). */
  readonly body: unknown;
  constructor(status: number, code: string | null, message: string, body: unknown = null) {
    super(message);
    this.name = "FactoryApiError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export interface FactoryApi {
  readonly status: (environmentId: EnvironmentId) => Promise<FactoryStatus>;
  /** The recent window the server lists by default (`RECENT_FINISHED_MS`), or every run with `all`. */
  readonly runs: (
    environmentId: EnvironmentId,
    options: { readonly all: boolean },
  ) => Promise<{ readonly runs: ReadonlyArray<FactoryRunRow> }>;
  readonly run: (environmentId: EnvironmentId, id: string) => Promise<FactoryRunDetail>;
  readonly stopRun: (environmentId: EnvironmentId, id: string) => Promise<FactoryStopResult>;
  readonly pauseClaims: (environmentId: EnvironmentId) => Promise<FactoryPauseResult>;
  readonly resumeClaims: (environmentId: EnvironmentId) => Promise<FactoryResumeResult>;
  readonly dismissAttention: (
    environmentId: EnvironmentId,
    ids: ReadonlyArray<string>,
  ) => Promise<FactoryDismissResult>;
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
      null,
      error instanceof Error && error.message ? error.message : "The request failed.",
    );
  }
  const body = parseJson(result.text);
  if (result.status < 200 || result.status >= 300) {
    throw new FactoryApiError(
      result.status,
      textField(body, "code"),
      failureMessage(result.status, body),
      body,
    );
  }
  return body as T;
};

export const post = <T>(environmentId: EnvironmentId, path: string, body?: unknown) =>
  call<T>(environmentId, "POST", path, undefined, body);
export const get = <T>(
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
  stopRun: (environmentId, id) => post(environmentId, `${runPath(id)}/stop`),
  pauseClaims: (environmentId) => post(environmentId, "/api/factory/claims/pause"),
  resumeClaims: (environmentId) => post(environmentId, "/api/factory/claims/resume"),
  dismissAttention: (environmentId, ids) =>
    post(environmentId, "/api/factory/attention/dismiss", { ids }),
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
  stopRun: (environmentId, id) => (override ?? httpApi).stopRun(environmentId, id),
  pauseClaims: (environmentId) => (override ?? httpApi).pauseClaims(environmentId),
  resumeClaims: (environmentId) => (override ?? httpApi).resumeClaims(environmentId),
  dismissAttention: (environmentId, ids) =>
    (override ?? httpApi).dismissAttention(environmentId, ids),
};
