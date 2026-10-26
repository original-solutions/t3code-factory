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
export const POLL_MS = 30_000;

/**
 * A tick within this of `POLL_MS` since the last read started still reads: the timer that fires a
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
  readonly refresh: () => void;
}

type Loaded<T> = Omit<FactoryResource<T>, "refresh">;

type Resource = "status" | "runs" | "runs:all" | `run:${string}`;

const LOADING: Loaded<never> = { status: "loading", data: null, error: null, readAt: 0 };

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

const read = (key: string, store: Store): void => {
  const n = ++store.issued;
  store.inFlight = true;
  store.startedAt = Date.now();
  const settle = (next: Loaded<unknown>) => {
    if (stores.get(key) !== store || n !== store.issued) return;
    store.inFlight = false;
    store.state = next;
    store.listeners.forEach((listener) => listener());
  };
  load(store).then(
    (data) => settle({ status: "ready", data, error: null, readAt: Date.now() }),
    (cause: unknown) =>
      settle({
        status: "error",
        data: store.state.data,
        error: cause instanceof Error ? cause : new Error(String(cause)),
        readAt: Date.now(),
      }),
  );
};

/** A read the reader asked for: now, superseding one in flight. */
const refresh = (key: string): void => {
  const store = stores.get(key);
  if (store !== undefined) read(key, store);
};

/**
 * A poll tick: not while a read is in flight, nor within a period (less slack) of the last start,
 * and not after a 404, which says the server has no factory or no such run.
 */
const tick = (key: string): void => {
  const store = stores.get(key);
  if (store === undefined || store.inFlight) return;
  if (store.state.error instanceof FactoryApiError && store.state.error.status === 404) return;
  if (Date.now() - store.startedAt < POLL_MS - TICK_SLACK_MS) return;
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
): Array<FactoryResource<T>> {
  const keys = environmentIds.map((id) => keyOf(id, resource));
  const last = useRef<ReadonlyArray<Loaded<unknown>>>([]);
  const states = useSyncExternalStore(
    (listener: () => void) => {
      const unsubscribes = environmentIds.map((id) => subscribe(id, resource, listener));
      return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
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
  useLiveRefresh(() => keys.forEach(tick), {
    key: `factory:all:${resource}`,
    intervalMs: POLL_MS,
    enabled: keys.length > 0 && resource !== "runs:all",
  });
  return keys.map((key, i) => ({
    ...(states[i] as Loaded<T>),
    refresh: () => refresh(key),
  }));
}

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
function useFactoryCandidates(): {
  readonly candidates: ReadonlyArray<EnvironmentId>;
  readonly statuses: ReadonlyArray<FactoryResource<FactoryStatus>>;
} {
  const primary = usePrimaryEnvironmentId();
  const connected = useConnectedEnvironmentIds();
  const candidates =
    primary === null ? connected : [primary, ...connected.filter((id) => id !== primary)];
  return { candidates, statuses: useFactoryResources<FactoryStatus>(candidates, "status") };
}

/**
 * The environments whose factory the pages show, in order: the primary, then the other connected
 * environments, each with its label and status, without those that have no factory.
 */
export function useFactoryEnvironments(): ReadonlyArray<FactoryEnvironment> {
  const { candidates, statuses } = useFactoryCandidates();
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
