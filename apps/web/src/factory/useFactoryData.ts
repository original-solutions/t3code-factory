import type { EnvironmentId } from "@t3tools/contracts";
import { useRef, useSyncExternalStore } from "react";

import { useLiveRefresh } from "~/hooks/useLiveRefresh";
import {
  useConnectedEnvironmentIds,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "~/state/environments";

import {
  FactoryApiError,
  factoryApi,
  type FactoryRunDetail,
  type FactoryRunRow,
  type FactoryStatus,
} from "./api";

/** How often an open page or badge reads again, while the window shows and the reader is about. */
const POLL_MS = 30_000;

/** How often the Factory page reads status while it is open and the window shows. */
export const STATUS_POLL_MS = 5_000;

/**
 * A tick within this of its period since the last read started still reads: the timer that fires a
 * millisecond early would otherwise skip every other poll. Two readers' timers out of step by more
 * than this still cost one read per period, since only the first past the gap reads.
 */
const TICK_SLACK_MS = 1_000;

export interface FactoryResource<T> {
  readonly status: "loading" | "error" | "ready";
  readonly data: T | null;
  readonly error: Error | null;
  /** When the latest answer landed (0 before any): the pages' age labels move on with a poll. */
  readonly readAt: number;
  /** When the data shown landed (0 before any): a failed read keeps both. */
  readonly dataAt: number;
  readonly refresh: () => void;
}

type Loaded<T> = Omit<FactoryResource<T>, "refresh">;

type Resource = "status" | "runs" | "runs:all" | `run:${string}`;

const LOADING: Loaded<never> = { status: "loading", data: null, error: null, readAt: 0, dataAt: 0 };

interface Store {
  readonly environmentId: EnvironmentId;
  readonly resource: Resource;
  state: Loaded<unknown>;
  /** The number of the latest read; an answer is applied only while its read is still the latest. */
  issued: number;
  inFlight: boolean;
  /** When the latest read started, so two readers' timers on one key cost one read per POLL_MS. */
  startedAt: number;
  readonly listeners: Set<() => void>;
}

/**
 * One store per environment and resource while anyone reads it, so every reader sees one answer.
 * A poll tick joins a read in flight; a requested refresh supersedes it. The last reader's drop
 * waits a microtask: React tears down old subscriptions before building new ones in one flush,
 * and an earlier drop would lose the store's data to a refetch.
 */
const stores = new Map<string, Store>();

const keyOf = (environmentId: EnvironmentId, resource: Resource): string =>
  `${environmentId} ${resource}`;

const load = ({ environmentId, resource }: Store): Promise<unknown> =>
  resource === "status"
    ? factoryApi.status(environmentId)
    : resource === "runs" || resource === "runs:all"
      ? factoryApi.runs(environmentId, { all: resource === "runs:all" })
      : factoryApi.run(environmentId, resource.slice("run:".length));

/** Whether `next` lacks a run that `previous` had: it finished, or the factory forgot it. */
const droppedRun = (previous: FactoryStatus, next: FactoryStatus): boolean => {
  const ids = new Set(next.runs.map((run) => run.id));
  return previous.runs.some((run) => !ids.has(run.id));
};

const read = (key: string, store: Store): void => {
  const n = ++store.issued;
  store.inFlight = true;
  store.startedAt = Date.now();
  const settle = (next: Loaded<unknown>) => {
    if (stores.get(key) !== store || n !== store.issued) return;
    const previous = store.state.data as FactoryStatus | null;
    store.inFlight = false;
    store.state = next;
    store.listeners.forEach((listener) => listener());
    // A run the status no longer lists has finished, and the recent runs list has the news before
    // its next poll would: read it now, so a bin learns of it within seconds, not half a minute.
    if (
      store.resource === "status" &&
      next.status === "ready" &&
      previous !== null &&
      droppedRun(previous, next.data as FactoryStatus)
    ) {
      refresh(keyOf(store.environmentId, "runs"));
    }
  };
  load(store).then(
    (data) => {
      const now = Date.now();
      settle({ status: "ready", data, error: null, readAt: now, dataAt: now });
    },
    (cause: unknown) =>
      settle({
        status: "error",
        data: store.state.data,
        error: cause instanceof Error ? cause : new Error(String(cause)),
        readAt: Date.now(),
        dataAt: store.state.dataAt,
      }),
  );
};

/** A read the reader asked for: now, superseding one in flight. */
const refresh = (key: string): void => {
  const store = stores.get(key);
  if (store !== undefined) read(key, store);
};

/**
 * A poll tick of a reader whose period is `periodMs`: not while a read is in flight, nor within a
 * period (less slack) of the last start, and not after a 404, which says the server has no factory
 * or no such run. A slow reader's tick shortly after a fast reader's read is thus no second read.
 */
const tick = (key: string, periodMs: number = POLL_MS): void => {
  const store = stores.get(key);
  if (store === undefined || store.inFlight) return;
  if (store.state.error instanceof FactoryApiError && store.state.error.status === 404) return;
  if (Date.now() - store.startedAt < periodMs - TICK_SLACK_MS) return;
  read(key, store);
};

const subscribe = (
  environmentId: EnvironmentId,
  resource: Resource,
  listener: () => void,
): (() => void) => {
  const key = keyOf(environmentId, resource);
  let store = stores.get(key);
  if (store === undefined) {
    store = {
      environmentId,
      resource,
      state: LOADING,
      issued: 0,
      inFlight: false,
      startedAt: 0,
      listeners: new Set(),
    };
    stores.set(key, store);
    read(key, store);
  }
  const added = store;
  added.listeners.add(listener);
  return () => {
    added.listeners.delete(listener);
    queueMicrotask(() => {
      if (added.listeners.size === 0 && stores.get(key) === added) stores.delete(key);
    });
  };
};

const snapshot = (key: string): Loaded<unknown> => stores.get(key)?.state ?? LOADING;

/** For tests: drop every store, so the next reader starts over. */
export function __resetFactoryStoresForTests(): void {
  stores.clear();
}

const noUnsubscribe = () => {};

/**
 * The resource of one environment: read when its first reader mounts, then every `POLL_MS` while
 * the window shows, on return to the window, and no more after a 404. Readers of one key share a
 * store whose `tick` makes their timers one read. The full runs list is read once, never polled:
 * every run ever made, every half minute, is the cost the recent window avoids.
 */
export function useFactoryResource<T>(
  environmentId: EnvironmentId | null,
  resource: Resource,
): FactoryResource<T> {
  const key = environmentId === null ? null : keyOf(environmentId, resource);
  const state = useSyncExternalStore(
    (listener: () => void) =>
      environmentId === null ? noUnsubscribe : subscribe(environmentId, resource, listener),
    () => (key === null ? LOADING : snapshot(key)) as Loaded<T>,
  );
  const tickNow = () => {
    if (key !== null) tick(key);
  };
  const refreshNow = () => {
    if (key !== null) refresh(key);
  };
  useLiveRefresh(tickNow, {
    key: `factory:${environmentId}:${resource}`,
    intervalMs: POLL_MS,
    enabled: key !== null && resource !== "runs:all",
  });
  return { ...state, refresh: refreshNow };
}

export const useFactoryRun = (
  environmentId: EnvironmentId | null,
  id: string,
): FactoryResource<FactoryRunDetail> =>
  useFactoryResource<FactoryRunDetail>(environmentId, `run:${id}`);

/**
 * The same resource of several environments, in the order of `environmentIds`. One subscription
 * covers them all, so the set may change between renders. The snapshot is the previous array
 * while every store's state is the same object, so `useSyncExternalStore` does not rerender.
 * Readers of one key share the store with `useFactoryResource`.
 */
function useFactoryResources<T>(
  environmentIds: ReadonlyArray<EnvironmentId>,
  resource: Resource,
  options: { readonly pollMs?: number } = {},
): Array<FactoryResource<T>> {
  const keys = environmentIds.map((id) => keyOf(id, resource));
  const last = useRef<ReadonlyArray<Loaded<unknown>>>([]);
  const states = useSyncExternalStore(
    (listener: () => void) => {
      const unsubscribes = environmentIds.map((id) => subscribe(id, resource, listener));
      const stopPolling =
        options.pollMs === undefined ? noUnsubscribe : pollWhileVisible(keys, options.pollMs);
      return () => {
        stopPolling();
        unsubscribes.forEach((unsubscribe) => unsubscribe());
      };
    },
    () => {
      const next = keys.map(snapshot);
      const previous = last.current;
      if (previous.length === next.length && previous.every((state, i) => state === next[i])) {
        return previous;
      }
      last.current = next;
      return next;
    },
  );
  useLiveRefresh(() => keys.forEach((key) => tick(key)), {
    key: `factory:all:${resource}`,
    intervalMs: POLL_MS,
    enabled: keys.length > 0 && resource !== "runs:all",
  });
  return keys.map((key, i) => ({
    ...(states[i] as Loaded<T>),
    refresh: () => refresh(key),
  }));
}

/**
 * Reads `keys` every `periodMs` while the window shows and on coming back to it, until the returned
 * function runs. `tick` skips a read made less than a period ago, so this and the 30 second
 * readers of the same keys cost one read per period together.
 */
const startPolling = (keys: ReadonlyArray<string>, periodMs: number): (() => void) => {
  const readAll = () => keys.forEach((key) => tick(key, periodMs));
  const visible = () => document.visibilityState === "visible";
  let timer: ReturnType<typeof setInterval> | undefined;
  const arm = () => {
    clearInterval(timer);
    timer = visible() ? setInterval(readAll, periodMs) : undefined;
  };
  const onVisibilityChange = () => {
    if (visible()) readAll();
    arm();
  };
  arm();
  document.addEventListener("visibilitychange", onVisibilityChange);
  return () => {
    clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
};

const pollers = new Map<string, { users: number; readonly stop: () => void }>();

/**
 * One timer per period and set of keys while anyone polls it. A subscribe closure that changes on
 * a render makes React drop and add its subscription in one flush; the last drop waits a microtask,
 * as the stores' does, so that flush keeps the timer instead of restarting its period.
 */
const pollWhileVisible = (keys: ReadonlyArray<string>, periodMs: number): (() => void) => {
  const id = `${periodMs} ${keys.join("|")}`;
  let poller = pollers.get(id);
  if (poller === undefined) {
    poller = { users: 0, stop: startPolling(keys, periodMs) };
    pollers.set(id, poller);
  }
  const added = poller;
  added.users++;
  return () => {
    added.users--;
    queueMicrotask(() => {
      if (added.users === 0 && pollers.get(id) === added) {
        pollers.delete(id);
        added.stop();
      }
    });
  };
};

/** The runs list of each environment: the recent window, polled; or every run with `all`, read once. */
export const useFactoryRunsOf = (
  environmentIds: ReadonlyArray<EnvironmentId>,
  all: boolean,
): Array<FactoryResource<{ readonly runs: ReadonlyArray<FactoryRunRow> }>> =>
  useFactoryResources(environmentIds, all ? "runs:all" : "runs");

/** An environment's name for people: the label it was saved under, else its id. */
const labelOf = (
  presentationById: ReturnType<typeof useEnvironments>["presentationById"],
  environmentId: EnvironmentId,
): string => presentationById.get(environmentId)?.entry.target.label ?? environmentId;

export function useFactoryEnvironmentLabel(environmentId: EnvironmentId): string {
  return labelOf(useEnvironments().presentationById, environmentId);
}

export interface FactoryEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly status: FactoryResource<FactoryStatus>;
}

const isNotFound = (error: Error | null): boolean =>
  error instanceof FactoryApiError && error.status === 404;

/**
 * Every candidate environment's status: the primary first, then the other connected ones. Read and
 * polled through the same stores the pages' own hooks use. An environment still loading or failed
 * stays; an upstream server without a factory (404) is left out here, and only here.
 */
function useFactoryCandidates(statusPollMs?: number): {
  readonly candidates: ReadonlyArray<EnvironmentId>;
  readonly statuses: ReadonlyArray<FactoryResource<FactoryStatus>>;
} {
  const primary = usePrimaryEnvironmentId();
  const connected = useConnectedEnvironmentIds();
  const candidates =
    primary === null ? connected : [primary, ...connected.filter((id) => id !== primary)];
  return {
    candidates,
    statuses: useFactoryResources<FactoryStatus>(
      candidates,
      "status",
      statusPollMs === undefined ? {} : { pollMs: statusPollMs },
    ),
  };
}

/**
 * The environments whose factory the pages show, in order: the primary, then the other connected
 * environments, each with its label and status, without those that have no factory. With
 * `statusPollMs` the statuses are also read that often while the window shows (the Factory page
 * reads `STATUS_POLL_MS`); without it they poll every `POLL_MS` like the other readers.
 */
export function useFactoryEnvironments({
  statusPollMs,
}: { readonly statusPollMs?: number } = {}): ReadonlyArray<FactoryEnvironment> {
  const { candidates, statuses } = useFactoryCandidates(statusPollMs);
  const { presentationById } = useEnvironments();
  return candidates.flatMap((environmentId, i) => {
    const status = statuses[i]!;
    if (isNotFound(status.error)) return [];
    return [{ environmentId, label: labelOf(presentationById, environmentId), status }];
  });
}

/**
 * False only once every candidate's status answered 404: no server here has a factory (an upstream
 * build), so the sidebar hides the item instead of leading to a page that cannot load. True before
 * every candidate has answered, and with no candidate.
 */
export function useFactorySupported(): boolean {
  const { statuses } = useFactoryCandidates();
  return statuses.length === 0 || !statuses.every((status) => isNotFound(status.error));
}

/** The open attention items over every listed environment, for the sidebar badge: 0 before any answer. */
export function useFactoryAttentionCount(): number {
  // From the candidates, not `useFactoryEnvironments`: the badge needs no labels, so it does not
  // read the environments' presentations.
  const { statuses } = useFactoryCandidates();
  return statuses.reduce(
    (sum, status) => sum + (isNotFound(status.error) ? 0 : (status.data?.attention.length ?? 0)),
    0,
  );
}
