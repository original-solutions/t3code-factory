import { createElement, useEffect, type ReactElement } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render, type Screen } from "../../test/render";
import {
  __setFactoryApiForTests,
  FactoryApiError,
  type FactoryApi,
  type FactoryRunRow,
  type FactoryStatus,
} from "./api";
import {
  __resetFactoryStoresForTests,
  readFactoryRunAhead,
  useFactoryAttentionCount,
  useFactoryEnvironmentLabel,
  useFactoryEnvironments,
  useFactoryEveryRunKept,
  useFactoryResource,
  useFactoryRun,
  useFactoryRunsOf,
  useFactorySupported,
  type FactoryResource,
} from "./useFactoryData";
import { setDocumentVisible } from "./testing";

// Which environments exist is the catalog's business; a test sets who is primary and connected.
const environments = vi.hoisted(() => ({
  primary: "env-1" as string | null,
  connected: [] as Array<string>,
  labels: new Map<string, string>(),
  // Whether the list of connected ids is a new array on every call, as a derived one would be.
  freshIds: false,
}));
vi.mock("~/state/environments", () => ({
  usePrimaryEnvironmentId: () => environments.primary,
  useConnectedEnvironmentIds: () =>
    environments.freshIds ? [...environments.connected] : environments.connected,
  useEnvironments: () => ({
    presentationById: new Map(
      [...environments.labels].map(([id, label]) => [id, { entry: { target: { label } } }]),
    ),
  }),
}));

const ENV_1 = "env-1" as EnvironmentId;
const ENV_2 = "env-2" as EnvironmentId;
const ENV_3 = "env-3" as EnvironmentId;

// One key's reader: the store behaves the same whichever key reads it, and these keep its tests
// short.
const useFactoryStatus = (environmentId: EnvironmentId | null) =>
  useFactoryResource<FactoryStatus>(environmentId, "status");
const useFactoryRuns = (environmentId: EnvironmentId | null, all = false) =>
  useFactoryResource<{ readonly runs: ReadonlyArray<FactoryRunRow> }>(
    environmentId,
    all ? "runs:all" : "runs",
  );

const status = (attention: number, state: "running" | "idle" = "running") => ({
  state,
  reason: null,
  paused_by_hand: null,
  runs: [],
  attention: Array.from({ length: attention }, (_, i) => ({
    id: `a${i}`,
    kind: "stuck",
    repo: "o/r",
    issue: i,
    run: null,
    message: "m",
    first_seen: "2026-10-04T10:00:00.000Z",
  })),
  slots: { used: 0, max: 1 },
  passes: { at: null, poll_seconds: null, running: false },
  problems: [],
});

const api = (overrides: Partial<FactoryApi>): FactoryApi => ({
  status: vi.fn(async () => status(0)),
  runs: vi.fn(async () => ({ runs: [] })),
  run: vi.fn(async (_env: EnvironmentId, id: string) => ({
    id,
    entries: [],
    truncated: false,
    skipped: 0,
  })),
  stopRun: vi.fn(),
  pauseClaims: vi.fn(),
  resumeClaims: vi.fn(),
  dismissAttention: vi.fn(),
  runGitHub: vi.fn(),
  queue: vi.fn(),
  snoozeDeploy: vi.fn(),
  deployNow: vi.fn(),
  ...overrides,
});

const notFound = async () => {
  throw new FactoryApiError(404, null, "Not found");
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

// What a test mounted; its `setup()` unmounts what is left when the test ends.
let mounted: Array<Screen> = [];
const unmountAll = async () => {
  const screens = mounted;
  mounted = [];
  for (const screen of screens) await screen[Symbol.asyncDispose]();
};

/** Renders `element` into a fresh container of the document. */
const mountElement = async (element: ReactElement) => {
  const screen = await render(element, { router: false });
  mounted.push(screen);
  return screen;
};

/** Renders a component that reads `useHook` and keeps what it returned last. */
const mount = async <T>(useHook: () => T) => {
  const latest = { current: undefined as T };
  const Probe = () => {
    const value = useHook();
    useEffect(() => {
      latest.current = value;
    });
    return null;
  };
  await mountElement(createElement(Probe));
  return latest;
};

const settle = (ms = 0) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

// The live-refresh policy reads the document's visibility, which a test sets.
const show = (visible: boolean) =>
  act(async () => {
    setDocumentVisible(visible);
    document.dispatchEvent(new Event("visibilitychange"));
  });

// The policy remembers when each key was last read, across tests, so every test starts a day
// after the one before it: a stale stamp would otherwise swallow the first tick.
let day = Date.parse("2026-10-17T00:00:00.000Z");

function setup(): AsyncDisposable {
  const stack = new AsyncDisposableStack();
  stack.use(fakeTimers());
  day += 86_400_000;
  vi.setSystemTime(day);
  stack.use(setDocumentVisible(true));
  environments.primary = ENV_1;
  environments.connected = [];
  environments.freshIds = false;
  environments.labels = new Map();
  stack.defer(() => {
    __setFactoryApiForTests();
    __resetFactoryStoresForTests();
  });
  stack.defer(unmountAll);
  return stack;
}

describe("useFactoryStatus", () => {
  it("is loading, then ready with the fetched status", async () => {
    await using _state = setup();
    const pending = deferred<ReturnType<typeof status>>();
    __setFactoryApiForTests(api({ status: () => pending.promise }));
    const result = await mount(() => useFactoryStatus(ENV_1));
    expect(result.current.status).toBe("loading");
    expect(result.current.data).toBeNull();
    await act(async () => pending.resolve(status(2)));
    expect(result.current.status).toBe("ready");
    expect(result.current.data?.attention).toHaveLength(2);
  });

  it("is an error with the thrown error when the fetch fails", async () => {
    await using _state = setup();
    __setFactoryApiForTests(
      api({
        status: async () => {
          throw new FactoryApiError(403, null, "forbidden");
        },
      }),
    );
    const result = await mount(() => useFactoryStatus(ENV_1));
    expect(result.current.status).toBe("error");
    expect(result.current.error?.message).toBe("forbidden");
  });

  it("keeps the last data when a later fetch fails", async () => {
    await using _state = setup();
    let fail = false;
    __setFactoryApiForTests(
      api({
        status: async () => {
          if (fail) throw new Error("down");
          return status(2);
        },
      }),
    );
    const result = await mount(() => useFactoryStatus(ENV_1));
    fail = true;
    await settle(30_000);
    expect(result.current.status).toBe("error");
    expect(result.current.data?.attention).toHaveLength(2);
  });

  it("stamps when each answer landed, failed or not, and when its data did", async () => {
    await using _state = setup();
    let fail = false;
    __setFactoryApiForTests(
      api({
        status: async () => {
          if (fail) throw new Error("down");
          return status(0);
        },
      }),
    );
    const result = await mount(() => useFactoryStatus(ENV_1));
    expect(result.current.readAt).toBe(day);
    await settle(10_000);
    expect(result.current.readAt).toBe(day);
    fail = true;
    await settle(20_000);
    expect(result.current.readAt).toBe(day + 30_000);
    expect(result.current.dataAt).toBe(day);
  });

  it("fetches again every 30 seconds and on refresh, and not in between", async () => {
    await using _state = setup();
    const fetchStatus = vi.fn(async () => status(0));
    __setFactoryApiForTests(api({ status: fetchStatus }));
    const result = await mount(() => useFactoryStatus(ENV_1));
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    await settle(29_000);
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    await settle(1_000);
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    await act(async () => result.current.refresh());
    expect(fetchStatus).toHaveBeenCalledTimes(3);
  });

  it("stops polling when unmounted, and ignores an answer that arrives after", async () => {
    await using _state = setup();
    const pending = deferred<ReturnType<typeof status>>();
    const fetchStatus = vi.fn(() => pending.promise);
    __setFactoryApiForTests(api({ status: fetchStatus }));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await mount(() => useFactoryStatus(ENV_1));
    await unmountAll();
    await act(async () => pending.resolve(status(1)));
    await settle(120_000);
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(errors.mock.calls).toEqual([]);
    errors.mockRestore();
  });

  it("keeps the answer once its last reader is gone: the next reader shows it at once and reads again", async () => {
    await using _state = setup();
    const fetchStatus = vi
      .fn<FactoryApi["status"]>()
      .mockResolvedValueOnce(status(2))
      .mockResolvedValue(status(3));
    __setFactoryApiForTests(api({ status: fetchStatus }));
    const first = await mount(() => useFactoryStatus(ENV_1));
    expect(first.current.data?.attention).toHaveLength(2);
    await unmountAll();
    // The drop waits a microtask (see `subscribe`), so an unmount that is not followed by a
    // resubscribe in the same flush must still let its reader go.
    await settle(6_000);
    const seen: Array<number | undefined> = [];
    await mount(() => {
      const read = useFactoryStatus(ENV_1);
      seen.push(read.data?.attention.length);
      return read;
    });
    expect(seen[0]).toBe(2);
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    await settle();
    expect(seen.at(-1)).toBe(3);
  });

  it("does not read again for a reader back within 5 seconds", async () => {
    await using _state = setup();
    const fetchStatus = vi.fn(async () => status(2));
    __setFactoryApiForTests(api({ status: fetchStatus }));
    await mount(() => useFactoryStatus(ENV_1));
    await unmountAll();
    await settle(2_000);
    const again = await mount(() => useFactoryStatus(ENV_1));
    expect(again.current.status).toBe("ready");
    expect(fetchStatus).toHaveBeenCalledTimes(1);
  });

  it("reads every run for the palette again only once the list it keeps is 10 minutes old", async () => {
    await using _state = setup();
    const fetchRuns = vi.fn<FactoryApi["runs"]>(async () => ({ runs: [] }));
    __setFactoryApiForTests(api({ runs: fetchRuns }));
    await mount(() => useFactoryEveryRunKept([ENV_1]));
    expect(fetchRuns).toHaveBeenLastCalledWith(ENV_1, { all: true });
    await unmountAll();
    await settle(6 * 60_000);
    const again = await mount(() => useFactoryEveryRunKept([ENV_1]));
    expect(again.current[0]?.status).toBe("ready");
    expect(fetchRuns).toHaveBeenCalledTimes(1);
    await unmountAll();
    await settle(5 * 60_000);
    await mount(() => useFactoryEveryRunKept([ENV_1]));
    expect(fetchRuns).toHaveBeenCalledTimes(2);
  });

  it("starts over for a reader back after 10 minutes, and drops a store that never answered", async () => {
    await using _state = setup();
    const fetchStatus = vi.fn(async () => status(2));
    __setFactoryApiForTests(api({ status: fetchStatus }));
    await mount(() => useFactoryStatus(ENV_1));
    await unmountAll();
    await settle(10 * 60_000 + 1_000);
    const seen: Array<string> = [];
    await mount(() => {
      const read = useFactoryStatus(ENV_1);
      seen.push(read.status);
      return read;
    });
    expect(seen[0]).toBe("loading");
    expect(fetchStatus).toHaveBeenCalledTimes(2);

    const pending = deferred<ReturnType<typeof status>>();
    const fetchRun = vi.fn(() =>
      pending.promise.then(() => ({ id: "r", entries: [], truncated: false, skipped: 0 })),
    );
    __setFactoryApiForTests(api({ status: fetchStatus, run: fetchRun }));
    await mount(() => useFactoryRun(ENV_1, "r"));
    await unmountAll();
    await settle();
    await mount(() => useFactoryRun(ENV_1, "r"));
    expect(fetchRun).toHaveBeenCalledTimes(2);
  });
});

describe("reading a run ahead of its page", () => {
  it("reads it once, and its page then opens ready without reading again", async () => {
    await using _state = setup();
    const fetchRun = vi.fn(async (_env: EnvironmentId, id: string) => ({
      id,
      entries: [],
      truncated: false,
      skipped: 7,
    }));
    __setFactoryApiForTests(api({ run: fetchRun }));
    readFactoryRunAhead(ENV_1, "o__r__1__1");
    readFactoryRunAhead(ENV_1, "o__r__1__1");
    await settle();
    expect(fetchRun).toHaveBeenCalledTimes(1);
    const seen: Array<string> = [];
    await mount(() => {
      const read = useFactoryRun(ENV_1, "o__r__1__1");
      seen.push(read.status);
      return read;
    });
    expect(seen[0]).toBe("ready");
    expect(fetchRun).toHaveBeenCalledTimes(1);
  });

  it("keeps at most 32 answers no page reads, the longest unread going first", async () => {
    await using _state = setup();
    const fetchRun = vi.fn(async (_env: EnvironmentId, id: string) => ({
      id,
      entries: [],
      truncated: false,
      skipped: 0,
    }));
    __setFactoryApiForTests(api({ run: fetchRun }));
    for (let i = 0; i <= 32; i++) {
      readFactoryRunAhead(ENV_1, `o__r__${i}__1`);
      await settle(10);
    }
    await mount(() => useFactoryRun(ENV_1, "o__r__32__1"));
    await mount(() => useFactoryRun(ENV_1, "o__r__0__1"));
    expect(fetchRun).toHaveBeenCalledTimes(34);
  });
});

describe("the poll follows the window", () => {
  it("does not tick while the window is hidden, and reads on coming back to it", async () => {
    await using _state = setup();
    const fetchStatus = vi.fn(async () => status(0));
    __setFactoryApiForTests(api({ status: fetchStatus }));
    await mount(() => useFactoryStatus(ENV_1));
    await show(false);
    await settle(90_000);
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    await show(true);
    expect(fetchStatus).toHaveBeenCalledTimes(2);
  });

  it("a tick during a slow answer joins it instead of starting another read", async () => {
    await using _state = setup();
    const pending = deferred<ReturnType<typeof status>>();
    const fetchStatus = vi.fn(() => pending.promise);
    __setFactoryApiForTests(api({ status: fetchStatus }));
    const result = await mount(() => useFactoryStatus(ENV_1));
    await settle(30_000);
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(status(3)));
    expect(result.current.data?.attention).toHaveLength(3);
    await settle(30_000);
    expect(fetchStatus).toHaveBeenCalledTimes(2);
  });

  it("a refresh during a slow answer reads again, and the answer in flight is dropped", async () => {
    await using _state = setup();
    const before = deferred<ReturnType<typeof status>>();
    const after = deferred<ReturnType<typeof status>>();
    const calls = [before, after];
    const fetchStatus = vi.fn(() => calls.shift()!.promise);
    __setFactoryApiForTests(api({ status: fetchStatus }));
    const result = await mount(() => useFactoryStatus(ENV_1));
    await act(async () => result.current.refresh());
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    await act(async () => before.resolve(status(1)));
    expect(result.current.status).toBe("loading");
    await act(async () => after.resolve(status(5)));
    expect(result.current.data?.attention).toHaveLength(5);
  });

  it("reads no more after a 404, which says the server has no factory", async () => {
    await using _state = setup();
    const fetchStatus = vi.fn(notFound);
    __setFactoryApiForTests(api({ status: fetchStatus }));
    const result = await mount(() => useFactoryStatus(ENV_1));
    expect(result.current.status).toBe("error");
    await settle(90_000);
    await show(false);
    await show(true);
    expect(fetchStatus).toHaveBeenCalledTimes(1);
  });
});

describe("useFactoryStatus shared by several readers", () => {
  it("polls once for two readers, on mount and on every tick", async () => {
    await using _state = setup();
    const fetchStatus = vi.fn(async () => status(0));
    __setFactoryApiForTests(api({ status: fetchStatus }));
    await mount(() => useFactoryStatus(ENV_1));
    await mount(() => useFactoryStatus(ENV_1));
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    await settle(30_000);
    expect(fetchStatus).toHaveBeenCalledTimes(2);
  });

  it("still reads when the timer fires a few milliseconds before 30 seconds have passed", async () => {
    await using _state = setup();
    const fetchStatus = vi.fn(async () => status(0));
    __setFactoryApiForTests(api({ status: fetchStatus }));
    const result = await mount(() => useFactoryStatus(ENV_1));
    await settle(10);
    // The wall clock falls 5 ms behind the timer, so the tick sees 29 995 ms since the last start.
    vi.setSystemTime(day + 5);
    await act(async () => result.current.refresh());
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    await settle(29_990);
    expect(fetchStatus).toHaveBeenCalledTimes(3);
  });

  it("reads once per 30 seconds for two readers whose timers are out of step", async () => {
    await using _state = setup();
    const fetchStatus = vi.fn(async () => status(0));
    __setFactoryApiForTests(api({ status: fetchStatus }));
    await mount(() => useFactoryStatus(ENV_1));
    await settle(15_000);
    await mount(useFactoryAttentionCount);
    await settle(15_000);
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    await settle(15_000);
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    await settle(15_000);
    expect(fetchStatus).toHaveBeenCalledTimes(3);
    await settle(15_000);
    expect(fetchStatus).toHaveBeenCalledTimes(3);
  });

  it("shows a refresh from one reader to the other", async () => {
    await using _state = setup();
    let attention = 0;
    __setFactoryApiForTests(api({ status: async () => status(attention) }));
    const page = await mount(() => useFactoryStatus(ENV_1));
    const badge = await mount(useFactoryAttentionCount);
    expect(badge.current).toBe(0);
    attention = 2;
    await act(async () => page.current.refresh());
    expect(badge.current).toBe(2);
  });

  it("stops every timer once both readers are gone", async () => {
    await using _state = setup();
    __setFactoryApiForTests(api({}));
    await mount(() => useFactoryStatus(ENV_1));
    await mount(() => useFactoryStatus(ENV_1));
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await unmountAll();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("useFactoryRuns and useFactoryRun", () => {
  it("fetch the run list and one run's ledger", async () => {
    await using _state = setup();
    const run = vi.fn(async (_env: EnvironmentId, id: string) => ({
      id,
      entries: [],
      truncated: true,
      skipped: 3,
    }));
    __setFactoryApiForTests(
      api({
        runs: async () => ({
          runs: [
            {
              id: "o__r__1__1",
              started_ts: null,
              state: "building",
              last_event: "claimed",
              step: null,
              status: "running",
              pr_url: null,
              finished: false,
              total_ms: null,
              unreadable: false,
            },
          ],
        }),
        run,
      }),
    );
    const runs = await mount(() => useFactoryRuns(ENV_1));
    expect(runs.current.data?.runs.map((r) => r.id)).toEqual(["o__r__1__1"]);
    const one = await mount(() => useFactoryRun(ENV_1, "o__r__1__1"));
    expect(run).toHaveBeenCalledWith(ENV_1, "o__r__1__1");
    expect((one.current as FactoryResource<{ skipped: number }>).data?.skipped).toBe(3);
  });

  it("asks the server for every run only with all, and reads that list once, not on the poll", async () => {
    await using _state = setup();
    const fetchRuns = vi.fn<FactoryApi["runs"]>(async () => ({ runs: [] }));
    __setFactoryApiForTests(api({ runs: fetchRuns }));
    await mount(() => useFactoryRuns(ENV_1));
    expect(fetchRuns).toHaveBeenLastCalledWith(ENV_1, { all: false });
    await mount(() => useFactoryRuns(ENV_1, true));
    expect(fetchRuns).toHaveBeenLastCalledWith(ENV_1, { all: true });
    expect(fetchRuns).toHaveBeenCalledTimes(2);
    await settle(90_000);
    expect(fetchRuns).toHaveBeenCalledTimes(5);
    expect(fetchRuns.mock.calls.slice(2).every(([, options]) => options.all === false)).toBe(true);
  });

  it("reads a run no more after a 404", async () => {
    await using _state = setup();
    const run = vi.fn(notFound);
    __setFactoryApiForTests(api({ run }));
    const one = await mount(() => useFactoryRun(ENV_1, "o__r__9__1"));
    expect((one.current.error as FactoryApiError).status).toBe(404);
    await settle(90_000);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("useFactoryAttentionCount", () => {
  it("is 0 while loading", async () => {
    await using _state = setup();
    __setFactoryApiForTests(api({ status: () => new Promise(() => {}) }));
    const count = await mount(useFactoryAttentionCount);
    expect(count.current).toBe(0);
  });

  it("is the number of open attention items once the status is ready", async () => {
    await using _state = setup();
    __setFactoryApiForTests(api({ status: async () => status(3) }));
    const count = await mount(useFactoryAttentionCount);
    expect(count.current).toBe(3);
  });

  it("is 0 when the first read fails, such as on a server without the factory", async () => {
    await using _state = setup();
    __setFactoryApiForTests(api({ status: notFound }));
    const count = await mount(useFactoryAttentionCount);
    expect(count.current).toBe(0);
  });

  it("keeps the last count when a later fetch fails", async () => {
    await using _state = setup();
    let fail = false;
    __setFactoryApiForTests(
      api({
        status: async () => {
          if (fail) throw new Error("down");
          return status(2);
        },
      }),
    );
    const count = await mount(useFactoryAttentionCount);
    expect(count.current).toBe(2);
    fail = true;
    await settle(30_000);
    expect(count.current).toBe(2);
  });
});

describe("useFactorySupported", () => {
  it("is true before any answer and once the status is ready", async () => {
    await using _state = setup();
    const pending = deferred<ReturnType<typeof status>>();
    __setFactoryApiForTests(api({ status: () => pending.promise }));
    const supported = await mount(useFactorySupported);
    expect(supported.current).toBe(true);
    await act(async () => pending.resolve(status(0)));
    expect(supported.current).toBe(true);
  });

  it("is false once the status answered 404, and true on any other failure", async () => {
    await using _state = setup();
    __setFactoryApiForTests(api({ status: notFound }));
    const supported = await mount(useFactorySupported);
    expect(supported.current).toBe(false);
    await unmountAll();
    __resetFactoryStoresForTests();
    __setFactoryApiForTests(
      api({
        status: async () => {
          throw new FactoryApiError(503, null, "down");
        },
      }),
    );
    const down = await mount(useFactorySupported);
    expect(down.current).toBe(true);
  });
});

describe("the stores are per environment", () => {
  it("keeps one status per environment, each read from its own environment", async () => {
    await using _state = setup();
    const fetchStatus = vi.fn(async (env: EnvironmentId) => status(env === ENV_1 ? 1 : 4));
    __setFactoryApiForTests(api({ status: fetchStatus }));
    const first = await mount(() => useFactoryStatus(ENV_1));
    const second = await mount(() => useFactoryStatus(ENV_2));
    expect(fetchStatus.mock.calls).toEqual([[ENV_1], [ENV_2]]);
    expect(first.current.data?.attention).toHaveLength(1);
    expect(second.current.data?.attention).toHaveLength(4);
  });

  it("reads nothing and stays loading without an environment", async () => {
    await using _state = setup();
    const fetchStatus = vi.fn(async () => status(0));
    const fetchRuns = vi.fn<FactoryApi["runs"]>(async () => ({ runs: [] }));
    __setFactoryApiForTests(api({ status: fetchStatus, runs: fetchRuns }));
    const statusResult = await mount(() => useFactoryStatus(null));
    const runsResult = await mount(() => useFactoryRuns(null));
    const runResult = await mount(() => useFactoryRun(null, "o__r__1__1"));
    await settle(90_000);
    for (const result of [statusResult, runsResult, runResult]) {
      expect(result.current.status).toBe("loading");
      expect(result.current.data).toBeNull();
      await act(() => result.current.refresh());
    }
    expect(fetchStatus).not.toHaveBeenCalled();
    expect(fetchRuns).not.toHaveBeenCalled();
  });
});

describe("useFactoryEnvironments", () => {
  const ids = (list: ReadonlyArray<{ readonly environmentId: EnvironmentId }>) =>
    list.map((entry) => entry.environmentId);

  it("lists the primary, then the other connected environments, with their labels", async () => {
    await using _state = setup();
    environments.connected = [ENV_2, ENV_1, ENV_3];
    environments.labels = new Map([
      [ENV_1, "Desktop"],
      [ENV_2, "Studio"],
    ]);
    __setFactoryApiForTests(api({}));
    const list = await mount(useFactoryEnvironments);
    expect(ids(list.current)).toEqual([ENV_1, ENV_2, ENV_3]);
    // An environment with no presentation is labelled by its id.
    expect(list.current.map((entry) => entry.label)).toEqual(["Desktop", "Studio", "env-3"]);
    expect(list.current.every((entry) => entry.status.data !== null)).toBe(true);
  });

  it("lists the primary even before the catalog lists it as connected", async () => {
    await using _state = setup();
    environments.connected = [ENV_2];
    const fetchStatus = vi.fn(async (_env: EnvironmentId) => status(0));
    __setFactoryApiForTests(api({ status: fetchStatus }));
    const list = await mount(useFactoryEnvironments);
    expect(ids(list.current)).toEqual([ENV_1, ENV_2]);
    expect(fetchStatus.mock.calls.map(([env]) => env as string).sort()).toEqual([ENV_1, ENV_2]);
  });

  it("lists only the connected environments without a primary", async () => {
    await using _state = setup();
    environments.primary = null;
    environments.connected = [ENV_2];
    __setFactoryApiForTests(api({}));
    const list = await mount(useFactoryEnvironments);
    expect(ids(list.current)).toEqual([ENV_2]);
  });

  it("is empty without any candidate", async () => {
    await using _state = setup();
    environments.primary = null;
    const list = await mount(useFactoryEnvironments);
    expect(list.current).toEqual([]);
  });

  it("leaves out an environment whose status answered 404, and reads it once", async () => {
    await using _state = setup();
    environments.connected = [ENV_1, ENV_2];
    const fetchStatus = vi.fn(async (env: EnvironmentId) => {
      if (env === ENV_1) return notFound();
      return status(0, "running");
    });
    __setFactoryApiForTests(api({ status: fetchStatus }));
    const list = await mount(useFactoryEnvironments);
    expect(ids(list.current)).toEqual([ENV_2]);
    await settle(90_000);
    await show(false);
    await show(true);
    expect(fetchStatus.mock.calls.filter(([env]) => env === ENV_1)).toHaveLength(1);
    expect(fetchStatus.mock.calls.filter(([env]) => env === ENV_2).length).toBeGreaterThan(1);
  });

  it("keeps an environment that is loading or failed, without holding the others back", async () => {
    await using _state = setup();
    environments.connected = [ENV_1, ENV_2, ENV_3];
    __setFactoryApiForTests(
      api({
        status: async (env) => {
          if (env === ENV_1) return new Promise<never>(() => {});
          if (env === ENV_2) throw new Error("down");
          return status(0);
        },
      }),
    );
    const list = await mount(useFactoryEnvironments);
    expect(ids(list.current)).toEqual([ENV_1, ENV_2, ENV_3]);
    expect(list.current.map((entry) => entry.status.status)).toEqual(["loading", "error", "ready"]);
  });

  it("refreshes the status of the environment it belongs to", async () => {
    await using _state = setup();
    environments.connected = [ENV_1, ENV_2];
    const fetchStatus = vi.fn(async (_env: EnvironmentId) => status(0));
    __setFactoryApiForTests(api({ status: fetchStatus }));
    const list = await mount(useFactoryEnvironments);
    fetchStatus.mockClear();
    await act(async () => list.current[1]!.status.refresh());
    expect(fetchStatus.mock.calls).toEqual([[ENV_2]]);
  });

  it("polls every environment on the live-refresh policy", async () => {
    await using _state = setup();
    environments.connected = [ENV_1, ENV_2];
    const fetchStatus = vi.fn(async (_env: EnvironmentId) => status(0));
    __setFactoryApiForTests(api({ status: fetchStatus }));
    await mount(useFactoryEnvironments);
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    await settle(30_000);
    expect(fetchStatus).toHaveBeenCalledTimes(4);
  });

  it("reflects a later answer, and drops an environment that turns 404", async () => {
    await using _state = setup();
    environments.connected = [ENV_1, ENV_2];
    let attention = 0;
    let gone = false;
    __setFactoryApiForTests(
      api({
        status: async (env) => {
          if (env === ENV_2 && gone) return notFound();
          return status(env === ENV_1 ? attention : 0);
        },
      }),
    );
    const list = await mount(useFactoryEnvironments);
    expect(list.current[0]!.status.data?.attention).toHaveLength(0);
    attention = 2;
    await settle(30_000);
    expect(list.current[0]!.status.data?.attention).toHaveLength(2);
    gone = true;
    await settle(30_000);
    expect(ids(list.current)).toEqual([ENV_1]);
  });

  it("neither reads again nor re-renders without end when a third environment connects and leaves", async () => {
    await using _state = setup();
    environments.connected = [ENV_1, ENV_2];
    const fetchStatus = vi.fn(async (_env: EnvironmentId) => status(0));
    __setFactoryApiForTests(api({ status: fetchStatus }));
    let renders = 0;
    const Probe = () => {
      renders++;
      useFactoryEnvironments();
      return null;
    };
    const screen = await mountElement(createElement(Probe));
    environments.connected = [ENV_1, ENV_2, ENV_3];
    await screen.rerender(createElement(Probe));
    environments.connected = [ENV_1, ENV_2];
    await screen.rerender(createElement(Probe));
    const calls = (env: EnvironmentId) => fetchStatus.mock.calls.filter(([e]) => e === env).length;
    expect([calls(ENV_1), calls(ENV_2), calls(ENV_3)]).toEqual([1, 1, 1]);
    expect(renders).toBeLessThan(20);
  });
});

describe("useFactoryEnvironments with a status poll", () => {
  const FIVE_SECONDS = 5_000;
  const statusCalls = () => {
    const fetchStatus = vi.fn(async (_env: EnvironmentId) => status(0));
    __setFactoryApiForTests(api({ status: fetchStatus }));
    return fetchStatus;
  };

  it("reads every environment's status every 5 seconds, and not in between", async () => {
    await using _state = setup();
    environments.connected = [ENV_1, ENV_2];
    const fetchStatus = statusCalls();
    await mount(() => useFactoryEnvironments({ statusPollMs: FIVE_SECONDS }));
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    await settle(4_000);
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    await settle(1_000);
    expect(fetchStatus).toHaveBeenCalledTimes(4);
    await settle(5_000);
    expect(fetchStatus).toHaveBeenCalledTimes(6);
  });

  it("keeps the 30 seconds without the option", async () => {
    await using _state = setup();
    environments.connected = [ENV_1, ENV_2];
    const fetchStatus = statusCalls();
    await mount(() => useFactoryEnvironments());
    await settle(25_000);
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    await settle(5_000);
    expect(fetchStatus).toHaveBeenCalledTimes(4);
  });

  it("costs one read per 5 seconds with a 30 second reader of the same status beside it", async () => {
    await using _state = setup();
    const fetchStatus = statusCalls();
    await mount(() => useFactoryEnvironments({ statusPollMs: FIVE_SECONDS }));
    await mount(useFactoryAttentionCount);
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    await settle(30_000);
    // The first read, then one every 5 seconds; the badge's tick at 30 seconds joins the page's.
    expect(fetchStatus).toHaveBeenCalledTimes(7);
  });

  it("shows the faster reads to the readers that poll slowly", async () => {
    await using _state = setup();
    let attention = 0;
    __setFactoryApiForTests(api({ status: async () => status(attention) }));
    await mount(() => useFactoryEnvironments({ statusPollMs: FIVE_SECONDS }));
    const badge = await mount(useFactoryAttentionCount);
    expect(badge.current).toBe(0);
    attention = 3;
    await settle(5_000);
    expect(badge.current).toBe(3);
  });

  it("reads nothing while the window is hidden, and reads on coming back to it", async () => {
    await using _state = setup();
    const fetchStatus = statusCalls();
    await mount(() => useFactoryEnvironments({ statusPollMs: FIVE_SECONDS }));
    await show(false);
    await settle(20_000);
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    await show(true);
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    await settle(5_000);
    expect(fetchStatus).toHaveBeenCalledTimes(3);
  });

  it("does not read again on coming back before a period has passed", async () => {
    await using _state = setup();
    const fetchStatus = statusCalls();
    await mount(() => useFactoryEnvironments({ statusPollMs: FIVE_SECONDS }));
    await settle(5_000);
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    await show(false);
    await settle(1_000);
    await show(true);
    expect(fetchStatus).toHaveBeenCalledTimes(2);
  });

  it("keeps its 5 second period when an answer lands mid-period and the page renders again", async () => {
    await using _state = setup();
    environments.freshIds = true;
    // The answer lands at 3 seconds, so the page renders again between two ticks.
    const answer = deferred<ReturnType<typeof status>>();
    const fetchStatus = vi.fn((_env: EnvironmentId) => answer.promise);
    __setFactoryApiForTests(api({ status: fetchStatus }));
    await mount(() => useFactoryEnvironments({ statusPollMs: FIVE_SECONDS }));
    await settle(3_000);
    await act(async () => answer.resolve(status(0)));
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    await settle(2_000);
    expect(fetchStatus).toHaveBeenCalledTimes(2);
  });

  it("reads a status no more after a 404, and stops its timer with the reader", async () => {
    await using _state = setup();
    const fetchStatus = vi.fn(notFound);
    __setFactoryApiForTests(api({ status: fetchStatus }));
    await mount(() => useFactoryEnvironments({ statusPollMs: FIVE_SECONDS }));
    await settle(30_000);
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    await unmountAll();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("useFactoryRunsOf", () => {
  it("reads each environment's own runs, and a failure of one leaves the others", async () => {
    await using _state = setup();
    const fetchRuns = vi.fn<FactoryApi["runs"]>(async (env) => {
      if (env === ENV_1) throw new Error("down");
      return { runs: [{ id: `${env}-run` }] } as never;
    });
    __setFactoryApiForTests(api({ runs: fetchRuns }));
    const runs = await mount(() => useFactoryRunsOf([ENV_1, ENV_2], false));
    expect(runs.current.map((entry) => entry.status)).toEqual(["error", "ready"]);
    expect(runs.current[1]!.data?.runs).toEqual([{ id: "env-2-run" }]);
    expect(fetchRuns.mock.calls.map(([env, options]) => [env, options.all])).toEqual([
      [ENV_1, false],
      [ENV_2, false],
    ]);
  });

  it("polls the recent window but reads the full list once", async () => {
    await using _state = setup();
    const fetchRuns = vi.fn<FactoryApi["runs"]>(async () => ({ runs: [] }));
    __setFactoryApiForTests(api({ runs: fetchRuns }));
    await mount(() => useFactoryRunsOf([ENV_1, ENV_2], true));
    expect(fetchRuns).toHaveBeenCalledTimes(2);
    await settle(90_000);
    expect(fetchRuns).toHaveBeenCalledTimes(2);
    await unmountAll();
    __resetFactoryStoresForTests();
    fetchRuns.mockClear();
    await mount(() => useFactoryRunsOf([ENV_1, ENV_2], false));
    await settle(30_000);
    expect(fetchRuns).toHaveBeenCalledTimes(4);
  });

  it("refreshes the one environment it is asked to", async () => {
    await using _state = setup();
    const fetchRuns = vi.fn<FactoryApi["runs"]>(async () => ({ runs: [] }));
    __setFactoryApiForTests(api({ runs: fetchRuns }));
    const runs = await mount(() => useFactoryRunsOf([ENV_1, ENV_2], false));
    fetchRuns.mockClear();
    await act(async () => runs.current[1]!.refresh());
    expect(fetchRuns.mock.calls.map(([env]) => env)).toEqual([ENV_2]);
  });

  it("reads nothing without environments", async () => {
    await using _state = setup();
    const fetchRuns = vi.fn<FactoryApi["runs"]>(async () => ({ runs: [] }));
    __setFactoryApiForTests(api({ runs: fetchRuns }));
    const runs = await mount(() => useFactoryRunsOf([], false));
    expect(runs.current).toEqual([]);
    expect(fetchRuns).not.toHaveBeenCalled();
  });
});

describe("a status read that drops a run", () => {
  const withRuns = (...ids: Array<string>): FactoryStatus => ({
    ...status(0),
    runs: ids.map((id) => ({
      id,
      state: "building",
      last_event: "step_changed",
      title: null,
      user: null,
      for_ms: 1_000,
      pr_url: null,
      thread_id: null,
      unreadable: false,
    })),
  });

  /** Answers each status read with the next of `answers` (the last repeats), per environment. */
  const answering = (answers: Partial<Record<EnvironmentId, Array<FactoryStatus | Error>>>) => {
    const seen = new Map<EnvironmentId, number>();
    const fetchRuns = vi.fn<FactoryApi["runs"]>(async () => ({ runs: [] }));
    __setFactoryApiForTests(
      api({
        runs: fetchRuns,
        status: vi.fn(async (environmentId: EnvironmentId) => {
          const list = answers[environmentId]!;
          const n = seen.get(environmentId) ?? 0;
          seen.set(environmentId, n + 1);
          const next = list[Math.min(n, list.length - 1)]!;
          if (next instanceof Error) throw next;
          return next;
        }),
      }),
    );
    return fetchRuns;
  };

  it("reads that environment's recent runs again, once, and leaves the full list alone", async () => {
    await using _state = setup();
    const fetchRuns = answering({ [ENV_1]: [withRuns("a", "b"), withRuns("a")] });
    const latest = await mount(() => ({
      status: useFactoryStatus(ENV_1),
      recent: useFactoryRuns(ENV_1),
      all: useFactoryRuns(ENV_1, true),
    }));
    expect(fetchRuns.mock.calls).toEqual([
      [ENV_1, { all: false }],
      [ENV_1, { all: true }],
    ]);
    fetchRuns.mockClear();
    await act(async () => latest.current.status.refresh());
    expect(latest.current.status.data!.runs.map((run) => run.id)).toEqual(["a"]);
    expect(fetchRuns.mock.calls).toEqual([[ENV_1, { all: false }]]);
  });

  it("reads nothing more when a runs list, not the status, drops a run", async () => {
    await using _state = setup();
    const row = (id: string) => ({ id }) as FactoryRunRow;
    const answers = [[row("a"), row("b")], [row("a")]];
    let n = 0;
    const fetchRuns = vi.fn<FactoryApi["runs"]>(async () => ({
      runs: answers[Math.min(n++, answers.length - 1)]!,
    }));
    __setFactoryApiForTests(api({ runs: fetchRuns, status: vi.fn(async () => withRuns("x")) }));
    const latest = await mount(() => ({
      status: useFactoryStatus(ENV_1),
      recent: useFactoryRuns(ENV_1),
    }));
    expect(latest.current.recent.data!.runs).toHaveLength(2);
    fetchRuns.mockClear();
    await act(async () => latest.current.recent.refresh());
    expect(latest.current.recent.data!.runs).toHaveLength(1);
    expect(fetchRuns).toHaveBeenCalledTimes(1);
  });

  it("reads nothing when no run dropped out, on the first answer, or on a failed read", async () => {
    await using _state = setup();
    const fetchRuns = answering({
      [ENV_1]: [withRuns("a"), withRuns("a", "b"), withRuns("a", "b"), new Error("down")],
    });
    const latest = await mount(() => ({
      status: useFactoryStatus(ENV_1),
      recent: useFactoryRuns(ENV_1),
    }));
    expect(fetchRuns).toHaveBeenCalledTimes(1);
    fetchRuns.mockClear();
    // A run was added; then none changed; then the read fails and keeps the last data.
    for (let read = 0; read < 3; read++) await act(async () => latest.current.status.refresh());
    expect(latest.current.status.status).toBe("error");
    expect(fetchRuns).not.toHaveBeenCalled();
  });

  it("reads nothing for a run that dropped out of a read that then failed", async () => {
    await using _state = setup();
    const fetchRuns = answering({ [ENV_1]: [withRuns("a", "b"), new Error("down")] });
    const latest = await mount(() => ({
      status: useFactoryStatus(ENV_1),
      recent: useFactoryRuns(ENV_1),
    }));
    fetchRuns.mockClear();
    await act(async () => latest.current.status.refresh());
    expect(fetchRuns).not.toHaveBeenCalled();
  });

  it("reads only the list of the environment that lost the run", async () => {
    await using _state = setup();
    environments.connected = [ENV_2];
    const fetchRuns = answering({
      [ENV_1]: [withRuns("a", "b"), withRuns("a")],
      [ENV_2]: [withRuns("c", "d")],
    });
    const latest = await mount(() => {
      const [one, two] = useFactoryRunsOf([ENV_1, ENV_2], false);
      return {
        statuses: [useFactoryStatus(ENV_1), useFactoryStatus(ENV_2)],
        recent: [one!, two!],
      };
    });
    expect(fetchRuns.mock.calls.map(([env]) => env)).toEqual([ENV_1, ENV_2]);
    fetchRuns.mockClear();
    await act(async () => {
      latest.current.statuses[0]!.refresh();
      latest.current.statuses[1]!.refresh();
    });
    expect(fetchRuns.mock.calls.map(([env]) => env)).toEqual([ENV_1]);
  });
});

describe("the badge and the sidebar item across several environments", () => {
  it("sums the open attention items over every listed environment", async () => {
    await using _state = setup();
    environments.connected = [ENV_1, ENV_2, ENV_3];
    __setFactoryApiForTests(
      api({
        status: async (env) => {
          if (env === ENV_3) return notFound();
          return status(env === ENV_1 ? 2 : 3);
        },
      }),
    );
    const count = await mount(useFactoryAttentionCount);
    expect(count.current).toBe(5);
  });

  it("shares the status read with the pages' own hooks", async () => {
    await using _state = setup();
    environments.connected = [ENV_1, ENV_2];
    const fetchStatus = vi.fn(async (env: EnvironmentId) => status(env === ENV_2 ? 3 : 0));
    __setFactoryApiForTests(api({ status: fetchStatus }));
    await mount(useFactoryAttentionCount);
    await mount(useFactoryEnvironments);
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    await settle(30_000);
    expect(fetchStatus).toHaveBeenCalledTimes(4);
  });

  it("is supported while a candidate has not answered, and when one of them has a factory", async () => {
    await using _state = setup();
    environments.connected = [ENV_1, ENV_2];
    __setFactoryApiForTests(
      api({ status: (env) => (env === ENV_1 ? notFound() : new Promise(() => {})) }),
    );
    const pending = await mount(useFactorySupported);
    expect(pending.current).toBe(true);
    await unmountAll();
    __resetFactoryStoresForTests();
    __setFactoryApiForTests(
      api({ status: (env) => (env === ENV_1 ? notFound() : Promise.resolve(status(0))) }),
    );
    const some = await mount(useFactorySupported);
    expect(some.current).toBe(true);
  });

  it("is unsupported only once every candidate answered 404", async () => {
    await using _state = setup();
    environments.connected = [ENV_1, ENV_2];
    __setFactoryApiForTests(api({ status: notFound }));
    const supported = await mount(useFactorySupported);
    expect(supported.current).toBe(false);
  });

  it("is supported with no candidate at all", async () => {
    await using _state = setup();
    environments.primary = null;
    const supported = await mount(useFactorySupported);
    expect(supported.current).toBe(true);
  });
});

describe("useFactoryEnvironmentLabel", () => {
  it("is the environment's label, else its id", async () => {
    await using _state = setup();
    environments.labels = new Map([[ENV_1, "Desktop"]]);
    const label = await mount(() => [
      useFactoryEnvironmentLabel(ENV_1),
      useFactoryEnvironmentLabel(ENV_2),
    ]);
    expect(label.current).toEqual(["Desktop", "env-2"]);
  });
});
