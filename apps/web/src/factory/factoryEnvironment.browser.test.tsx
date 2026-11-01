import { createElement, type ReactNode } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, fakeTimers } from "../../test/render";
import { __setFactoryApiForTests, FactoryApiError, type FactoryApi } from "./api";
import { __resetStopDeskForTests, STOP_GRACE_MS } from "./stopDesk";
import { render, setDocumentVisible } from "./testing";
import {
  __resetFactoryStoresForTests,
  useFactoryAttentionCount,
  useFactorySupported,
} from "./useFactoryData";

// The real hooks and pages over a fake API with one world per environment: which environments the
// pages read, show and call is the behavior under test.

const catalog = vi.hoisted(() => ({
  primary: null as string | null,
  connected: [] as string[],
  labels: new Map<string, string>(),
}));
vi.mock("~/state/environments", () => ({
  usePrimaryEnvironmentId: () => catalog.primary,
  useConnectedEnvironmentIds: () => catalog.connected,
  useEnvironments: () => ({
    presentationById: new Map(
      [...catalog.labels].map(([id, label]) => [id, { entry: { target: { label } } }]),
    ),
  }),
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({
    to,
    params,
    children,
  }: {
    to: string;
    params?: Record<string, string>;
    children?: ReactNode;
  }) =>
    createElement("a", { "data-to": to, "data-params": JSON.stringify(params ?? {}) }, children),
  // The page's filters read the URL; these tests open it unfiltered and never change them.
  useSearch: () => ({}),
  useNavigate: () => () => Promise.resolve(),
  // Opened directly: no list to step through, nothing to come back to.
  useRouterState: ({ select }: { select: (s: { location: { state: object } }) => unknown }) =>
    select({ location: { state: {} } }),
}));

import { FactoryNavIcon } from "./FactoryNavIcon";
import { FactoryPage } from "./FactoryPage";
import { FactoryRunPage } from "./FactoryRunPage";

const ENV_1 = "env-1" as EnvironmentId;
const ENV_2 = "env-2" as EnvironmentId;

const RUN_1 = "original-solutions__t3code-factory__20__1";
const RUN_2 = "acme__widgets__7__1";

const attentionItem = (
  id: string,
  message: string,
  firstSeen: string,
  run: string | null = null,
) => ({
  id,
  kind: "stuck",
  repo: null,
  issue: null,
  run,
  message,
  first_seen: firstSeen,
});

const statusBody = (
  state: "running" | "idle",
  extra: { reason?: string | null; attention?: unknown[]; paused?: boolean } = {},
) => ({
  state,
  reason: extra.reason ?? null,
  paused_by_hand: extra.paused ? { since: "2026-10-17T11:00:00.000Z", for_ms: 3_600_000 } : null,
  runs: [],
  attention: extra.attention ?? [],
  slots: { used: 0, max: 1 },
  passes: {},
  problems: [],
});
const runRow = (id: string, started: string) => ({
  id,
  started_ts: started,
  state: "building",
  last_event: "session_launched",
  step: "launch-sending",
  status: "running",
  pr_url: null,
  finished: false,
  total_ms: null,
  unreadable: false,
});
const runDetail = (id: string) => ({
  id,
  entries: [
    {
      ts: "2026-10-17T10:00:01.000Z",
      ms: 1,
      event: "session_launched",
      data: { thread_id: "thread-9", worktree: "/w", branch: "b" },
      cause: null,
    },
    {
      ts: "2026-10-17T10:00:02.000Z",
      ms: 2,
      event: "state_changed",
      data: { from: "triage", to: "building" },
      cause: null,
    },
  ],
  truncated: false,
  skipped: 0,
});

/** What each environment's server says. An environment with no world answers 404, as an upstream build does. */
const worlds = new Map<
  string,
  { status: unknown; runs: ReadonlyArray<ReturnType<typeof runRow>>; hang?: boolean }
>();
const calls = {
  pause: [] as string[],
  resume: [] as string[],
  dismiss: [] as Array<[string, ReadonlyArray<string>]>,
  stop: [] as Array<[string, string]>,
  runRead: [] as Array<[string, string]>,
  gitHubRead: [] as Array<[string, string]>,
  runs: [] as Array<[string, boolean]>,
};

const worldOf = (environmentId: string) => {
  const world = worlds.get(environmentId);
  if (world === undefined) throw new FactoryApiError(404, null, "Not found");
  return world;
};
const never = <T,>() => new Promise<T>(() => {});

const fakeApi: FactoryApi = {
  status: async (env) => {
    const world = worldOf(env);
    return world.hang ? never<never>() : (world.status as never);
  },
  runs: async (env, { all }) => {
    calls.runs.push([env, all]);
    return { runs: worldOf(env).runs } as never;
  },
  run: async (env, id) => {
    calls.runRead.push([env, id]);
    return runDetail(id) as never;
  },
  runGitHub: async (env, id) => {
    calls.gitHubRead.push([env, id]);
    return { id, issue: { kind: "signed-out", message: "not signed in" }, pr: null };
  },
  stopRun: async (env, id) => {
    calls.stop.push([env, id]);
    return { message: "stopping" } as never;
  },
  pauseClaims: async (env) => {
    calls.pause.push(env);
    return { paused: true, already: false, since: "2026-10-17T12:00:00.000Z", message: "paused" };
  },
  resumeClaims: async (env) => {
    calls.resume.push(env);
    return { paused: false, already: false, message: "resumed" };
  },
  dismissAttention: async (env, ids) => {
    calls.dismiss.push([env, ids]);
    return { dismissed: ids };
  },
  snoozeDeploy: async () => ({ snoozed_until: "2026-10-17T13:00:00.000Z" }),
  deployNow: async () => ({ commit: "abc", kicked: true, message: "installing" }),
};

const settle = async () => {
  for (let i = 0; i < 6; i++) await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
};

type Page = Awaited<ReturnType<typeof render>>;
const linksTo = (page: Page, to: string) =>
  page
    .all("a")
    .filter((a) => a.getAttribute("data-to") === to)
    .map((a) => JSON.parse(a.getAttribute("data-params")!) as Record<string, string>);

// What a test showed; its `setup()` unmounts what is left when the test ends.
let mounted: Page[] = [];
const show = async (element: Parameters<typeof render>[0]) => {
  const page = await render(element);
  mounted.push(page);
  await settle();
  return page;
};

/** The first claims switch on the page: with one environment, its only one. */
const claimsSwitch = (page: Page) => page.all('[role="switch"]')[0]!;
/** One machine's claims switch in the control bar's roster. */
const switchOf = (page: Page, label: string) =>
  page.all(`[role="switch"][aria-label="Claims on ${label}"]`)[0]!;
/** One machine's row in the roster, by environment. */
const machineRow = (page: Page, environmentId: string) =>
  page.all(`[data-machine="${environmentId}"]`)[0]!.textContent ?? "";
const isDisabled = (node: Element) => node.hasAttribute("data-disabled");
/** Picks a machine in the roster, which the rail and the update banner follow. */
const pick = (page: Page, label: string) =>
  page.click(page.all(`button[aria-label="Show ${label} on the belt"]`)[0]!);
const clock = (iso: string) => {
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
};

function setup(): AsyncDisposable {
  const stack = new AsyncDisposableStack();
  stack.use(fakeTimers());
  vi.setSystemTime(Date.parse("2026-10-17T12:00:00.000Z"));
  stack.use(setDocumentVisible(true));
  catalog.primary = ENV_1;
  catalog.connected = [ENV_1, ENV_2];
  catalog.labels = new Map([
    [ENV_1, "Desktop"],
    [ENV_2, "Studio"],
  ]);
  worlds.set(ENV_1, {
    status: statusBody("running"),
    runs: [runRow(RUN_1, "2026-10-17T10:00:00.000Z")],
  });
  worlds.set(ENV_2, {
    status: statusBody("running"),
    runs: [runRow(RUN_2, "2026-10-17T11:00:00.000Z")],
  });
  __setFactoryApiForTests(fakeApi);
  stack.defer(() => {
    __resetFactoryStoresForTests();
    __resetStopDeskForTests();
    __setFactoryApiForTests();
    worlds.clear();
    for (const list of Object.values(calls)) list.length = 0;
  });
  stack.defer(async () => {
    const pages = mounted;
    mounted = [];
    for (const page of pages) await page.unmount();
  });
  return stack;
}

describe("the Factory page shows every environment that runs a factory", () => {
  it("lists both factories' runs with their environments, each run linking to its own", async () => {
    await using _state = setup();
    const page = await show(createElement(FactoryPage));
    expect(page.text()).toContain("original-solutions/t3code-factory");
    expect(page.text()).toContain("acme/widgets");
    expect(page.text()).toContain("Environment");
    expect(page.text()).toContain("Desktop");
    expect(page.text()).toContain("Studio");
    expect(linksTo(page, "/factory/$environmentId/$runId")).toEqual(
      expect.arrayContaining([
        { environmentId: ENV_1, runId: RUN_1 },
        { environmentId: ENV_2, runId: RUN_2 },
      ]),
    );
    // Newest first across environments.
    expect(page.text().indexOf("acme/widgets")).toBeLessThan(
      page.text().indexOf("original-solutions/t3code-factory"),
    );
  });

  it("shows no Environment column when only one environment runs a factory", async () => {
    await using _state = setup();
    catalog.connected = [ENV_1];
    worlds.delete(ENV_2);
    const page = await show(createElement(FactoryPage));
    expect(page.text()).toContain("original-solutions/t3code-factory");
    expect(page.all("th").map((th) => th.textContent)).not.toContain("Environment");
  });

  it("reads every environment's full list once when asked for all runs", async () => {
    await using _state = setup();
    const page = await show(createElement(FactoryPage));
    await page.click(page.button("Show all runs")!);
    await settle();
    expect(
      calls.runs
        .filter(([, all]) => all)
        .map(([env]) => env)
        .sort(),
    ).toEqual([ENV_1, ENV_2]);
  });

  it("sums the open attention items of both environments on the badge", async () => {
    await using _state = setup();
    worlds.get(ENV_1)!.status = statusBody("running", {
      attention: [attentionItem("a", "one", "2026-10-17T10:00:00.000Z")],
    });
    worlds.get(ENV_2)!.status = statusBody("running", {
      attention: [
        attentionItem("b", "two", "2026-10-17T10:30:00.000Z"),
        attentionItem("c", "three", "2026-10-17T10:40:00.000Z"),
      ],
    });
    const Badge = () => createElement(FactoryNavIcon, { attention: useFactoryAttentionCount() });
    const badge = await show(createElement(Badge));
    expect(badge.text()).toBe("3");
  });

  it("shows a claims switch per machine and pauses only the one switched", async () => {
    await using _state = setup();
    const page = await show(createElement(FactoryPage));
    expect(page.all('[role="switch"]').map((node) => node.getAttribute("aria-label"))).toEqual([
      "Claims on Desktop",
      "Claims on Studio",
    ]);
    await page.click(switchOf(page, "Studio"));
    expect(calls.pause).toEqual([ENV_2]);
    expect(isDisabled(switchOf(page, "Desktop"))).toBe(false);
  });

  it("disables only the environment whose pause is in flight, and enables it again when that settles", async () => {
    await using _state = setup();
    let finish!: () => void;
    __setFactoryApiForTests({
      ...fakeApi,
      pauseClaims: (env) => {
        calls.pause.push(env);
        return new Promise((resolve) => {
          finish = () =>
            resolve({
              paused: true,
              already: false,
              since: "2026-10-17T12:00:00.000Z",
              message: "paused",
            });
        });
      },
    });
    const page = await show(createElement(FactoryPage));
    await page.click(switchOf(page, "Studio"));
    expect(calls.pause).toEqual([ENV_2]);
    expect(isDisabled(switchOf(page, "Studio"))).toBe(true);
    expect(isDisabled(switchOf(page, "Desktop"))).toBe(false);
    await act(async () => finish());
    await settle();
    expect(isDisabled(switchOf(page, "Studio"))).toBe(false);
  });

  it("says a machine is paused, and since when, without picking it, and resumes that one", async () => {
    await using _state = setup();
    worlds.get(ENV_2)!.status = statusBody("running", { paused: true });
    const page = await show(createElement(FactoryPage));
    expect(machineRow(page, ENV_2)).toContain("Paused");
    expect(machineRow(page, ENV_2)).toContain(`since ${clock("2026-10-17T11:00:00.000Z")}`);
    expect(machineRow(page, ENV_1)).toContain("Running");
    expect(page.text()).toContain("1 of 2 claiming");
    expect(switchOf(page, "Desktop").getAttribute("aria-checked")).toBe("true");
    expect(switchOf(page, "Studio").getAttribute("aria-checked")).toBe("false");
    // The rail's Claimed post follows the picked machine.
    expect(page.text()).not.toContain("claims paused by hand");
    await pick(page, "Studio");
    expect(page.text()).toContain(
      `claims paused by hand since ${clock("2026-10-17T11:00:00.000Z")}`,
    );
    await page.click(switchOf(page, "Studio"));
    expect(calls.resume).toEqual([ENV_2]);
    expect(calls.pause).toEqual([]);
  });

  it("dismisses an item on its own environment, and Dismiss all splits the ids by environment", async () => {
    await using _state = setup();
    worlds.get(ENV_1)!.status = statusBody("running", {
      attention: [
        attentionItem("a1", "first one", "2026-10-17T10:00:00.000Z"),
        attentionItem("a2", "second one", "2026-10-17T10:20:00.000Z"),
      ],
    });
    worlds.get(ENV_2)!.status = statusBody("running", {
      attention: [attentionItem("b1", "third one", "2026-10-17T10:10:00.000Z", RUN_2)],
    });
    const page = await show(createElement(FactoryPage));
    // Oldest first across environments.
    const text = page.text();
    expect(text.indexOf("first one")).toBeLessThan(text.indexOf("third one"));
    expect(text.indexOf("third one")).toBeLessThan(text.indexOf("second one"));
    // The run link of an item carries its environment.
    expect(linksTo(page, "/factory/$environmentId/$runId")).toContainEqual({
      environmentId: ENV_2,
      runId: RUN_2,
    });
    const itemOf = (message: string) =>
      page.all("li").find((li) => li.textContent?.includes(message))!;
    // With several environments each item says which one raised it.
    expect(itemOf("first one").textContent).toContain("Desktop");
    expect(itemOf("second one").textContent).toContain("Desktop");
    expect(itemOf("third one").textContent).toContain("Studio");
    expect(itemOf("third one").textContent).not.toContain("Desktop");
    const item = itemOf("third one");
    await page.click(
      Array.from(item.querySelectorAll("button")).find((b) => b.textContent === "Dismiss")!,
    );
    expect(calls.dismiss).toEqual([[ENV_2, ["b1"]]]);
    await page.click(page.button("Dismiss all")!);
    expect(calls.dismiss.slice(1)).toEqual([[ENV_1, ["a1", "a2"]]]);
  });

  it("shows no environment label on an attention item when only one environment runs a factory", async () => {
    await using _state = setup();
    catalog.connected = [ENV_1];
    worlds.delete(ENV_2);
    worlds.get(ENV_1)!.status = statusBody("running", {
      attention: [attentionItem("a1", "lonely one", "2026-10-17T10:00:00.000Z")],
    });
    const page = await show(createElement(FactoryPage));
    const item = page.all("li").find((li) => li.textContent?.includes("lonely one"))!;
    expect(item.textContent).not.toContain("Desktop");
  });

  it("dismisses one of two same-id, same-first_seen items on its own environment only", async () => {
    await using _state = setup();
    worlds.get(ENV_1)!.status = statusBody("running", {
      attention: [attentionItem("same", "on desktop", "2026-10-17T10:00:00.000Z")],
    });
    worlds.get(ENV_2)!.status = statusBody("running", {
      attention: [attentionItem("same", "on studio", "2026-10-17T10:00:00.000Z")],
    });
    const page = await show(createElement(FactoryPage));
    const item = page.all("li").find((li) => li.textContent?.includes("on desktop"))!;
    await page.click(
      Array.from(item.querySelectorAll("button")).find((b) => b.textContent === "Dismiss")!,
    );
    expect(calls.dismiss).toEqual([[ENV_1, ["same"]]]);
    expect(page.text()).not.toContain("on desktop");
    expect(page.text()).toContain("on studio");
  });

  it("splits Dismiss all by environment, one call each", async () => {
    await using _state = setup();
    worlds.get(ENV_1)!.status = statusBody("running", {
      attention: [attentionItem("same", "on desktop", "2026-10-17T10:00:00.000Z")],
    });
    worlds.get(ENV_2)!.status = statusBody("running", {
      attention: [attentionItem("same", "on studio", "2026-10-17T10:00:00.000Z")],
    });
    const page = await show(createElement(FactoryPage));
    expect(page.text()).toContain("on desktop");
    expect(page.text()).toContain("on studio");
    await page.click(page.button("Dismiss all")!);
    expect([...calls.dismiss].sort()).toEqual([
      [ENV_1, ["same"]],
      [ENV_2, ["same"]],
    ]);
    expect(page.text()).not.toContain("on desktop");
    expect(page.text()).not.toContain("on studio");
  });

  it("brings back only the items of the environment whose Dismiss all call failed, and reads every status again", async () => {
    await using _state = setup();
    worlds.get(ENV_1)!.status = statusBody("running", {
      attention: [
        attentionItem("a1", "first one", "2026-10-17T10:00:00.000Z"),
        attentionItem("a2", "second one", "2026-10-17T10:20:00.000Z"),
      ],
    });
    worlds.get(ENV_2)!.status = statusBody("running", {
      attention: [attentionItem("b1", "third one", "2026-10-17T10:10:00.000Z")],
    });
    const statusReads: string[] = [];
    __setFactoryApiForTests({
      ...fakeApi,
      status: async (env) => {
        statusReads.push(env);
        return fakeApi.status(env);
      },
      dismissAttention: async (env, ids) => {
        if (env === ENV_1) throw new FactoryApiError(500, null, "ledger locked");
        return fakeApi.dismissAttention(env, ids);
      },
    });
    const page = await show(createElement(FactoryPage));
    statusReads.length = 0;
    await page.click(page.button("Dismiss all")!);
    await settle();
    expect(page.text()).toContain("first one");
    expect(page.text()).toContain("second one");
    expect(page.text()).not.toContain("third one");
    expect(page.text()).toContain("ledger locked");
    expect([...statusReads].sort()).toEqual([ENV_1, ENV_2]);
  });

  it("shows every environment in the belt: the primary's idle reason, and the second's runs", async () => {
    await using _state = setup();
    worlds.set(ENV_1, { status: statusBody("idle", { reason: "no repos" }), runs: [] });
    const page = await show(createElement(FactoryPage));
    expect(machineRow(page, ENV_1)).toContain("Idle");
    expect(machineRow(page, ENV_1)).toContain("no repos");
    expect(machineRow(page, ENV_1)).not.toContain("Running");
    expect(machineRow(page, ENV_2)).toContain("Running");
    expect(page.text()).toContain("acme/widgets");
  });

  it("lists only the second environment when the primary has no factory", async () => {
    await using _state = setup();
    worlds.delete(ENV_1);
    const page = await show(createElement(FactoryPage));
    expect(page.text()).toContain("acme/widgets");
    expect(page.text()).toContain("Studio");
    expect(page.text()).not.toContain("Desktop");
    expect(page.all('[role="switch"]')).toHaveLength(1);
    expect(claimsSwitch(page).getAttribute("aria-label")).toBe("Claims on Studio");
    expect(page.all('[aria-label="Environments"] button')).toHaveLength(1);
  });

  it("shows the runs of the others while a candidate has not answered, and reads no runs of it yet", async () => {
    await using _state = setup();
    worlds.set(ENV_1, { status: statusBody("running"), runs: [], hang: true });
    const page = await show(createElement(FactoryPage));
    expect(page.text()).toContain("acme/widgets");
    expect(page.all('[role="status"][aria-label="Loading Desktop"]')).toHaveLength(1);
    expect(calls.runs.map(([env]) => env)).toEqual([ENV_2]);
    const links = linksTo(page, "/factory/$environmentId/$runId");
    expect(links).toContainEqual({ environmentId: ENV_2, runId: RUN_2 });
    expect(links.map(({ environmentId }) => environmentId)).not.toContain(ENV_1);
  });

  it("shows a status that failed on its first read as a notice in its row, and reads no runs for it", async () => {
    await using _state = setup();
    const statusReads: string[] = [];
    __setFactoryApiForTests({
      ...fakeApi,
      status: async (env) => {
        statusReads.push(env);
        if (env === ENV_1) throw new FactoryApiError(500, null, "state file locked");
        return fakeApi.status(env);
      },
    });
    const page = await show(createElement(FactoryPage));
    expect(page.text()).toContain("Desktop's factory failed to answer");
    expect(page.text()).toContain("state file locked");
    expect(page.text().split("Desktop's factory failed to answer")).toHaveLength(2);
    expect(page.text()).toContain("acme/widgets");
    expect(calls.runs.map(([env]) => env)).toEqual([ENV_2]);
    statusReads.length = 0;
    await page.click(page.all('button[aria-label="Retry Desktop"]')[0]!);
    await settle();
    expect(statusReads).toEqual([ENV_1]);
  });

  it("shows a status that failed on its first read where the belt lists the environments", async () => {
    await using _state = setup();
    __setFactoryApiForTests({
      ...fakeApi,
      status: async (env) => {
        if (env === ENV_1) throw new FactoryApiError(500, null, "state file locked");
        return fakeApi.status(env);
      },
    });
    const page = await show(createElement(FactoryPage));
    // The failed machine has no status to switch claims on; the other's is still there.
    expect(machineRow(page, ENV_1)).toContain("No answer");
    expect(isDisabled(switchOf(page, "Desktop"))).toBe(true);
    expect(isDisabled(switchOf(page, "Studio"))).toBe(false);
  });

  it("names the environment whose runs could not be read, and keeps the rest", async () => {
    await using _state = setup();
    const runs = fakeApi.runs;
    __setFactoryApiForTests({
      ...fakeApi,
      runs: async (env, options) => {
        if (env === ENV_1) throw new FactoryApiError(500, null, "ledger exploded");
        return runs(env, options);
      },
    });
    const page = await show(createElement(FactoryPage));
    expect(page.text()).toContain("Desktop's factory failed to answer");
    expect(page.text()).toContain("ledger exploded");
    expect(page.text()).toContain("acme/widgets");
    expect(page.button("Retry")).toBeDefined();
  });
});

describe("the Factory page reads status every 5 seconds", () => {
  const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
  const countingApi = (statusReads: string[]) => {
    __setFactoryApiForTests({
      ...fakeApi,
      status: async (env) => {
        statusReads.push(env);
        return fakeApi.status(env);
      },
    });
  };

  it("reads each environment's status every 5 seconds while the page is open and visible", async () => {
    await using _state = setup();
    const statusReads: string[] = [];
    countingApi(statusReads);
    await show(createElement(FactoryPage));
    statusReads.length = 0;
    await advance(4_000);
    expect(statusReads).toEqual([]);
    await advance(1_000);
    expect([...statusReads].sort()).toEqual([ENV_1, ENV_2]);
    await advance(5_000);
    expect(statusReads).toHaveLength(4);
  });

  it("reads nothing while the window is hidden, and again on coming back to it", async () => {
    await using _state = setup();
    const statusReads: string[] = [];
    countingApi(statusReads);
    await show(createElement(FactoryPage));
    statusReads.length = 0;
    await act(async () => {
      setDocumentVisible(false);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await advance(20_000);
    expect(statusReads).toEqual([]);
    await act(async () => {
      setDocumentVisible(true);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect([...statusReads].sort()).toEqual([ENV_1, ENV_2]);
  });

  it("leaves the recent runs list at 30 seconds", async () => {
    await using _state = setup();
    const statusReads: string[] = [];
    countingApi(statusReads);
    await show(createElement(FactoryPage));
    calls.runs.length = 0;
    await advance(25_000);
    expect(calls.runs).toEqual([]);
    await advance(5_000);
    expect(calls.runs.map(([env]) => env).sort()).toEqual([ENV_1, ENV_2]);
  });
});

describe("the sidebar item follows the environments", () => {
  const Probe = () => String(useFactorySupported());
  const supported = async () => (await show(createElement(Probe))).text() === "true";

  it("stays when the primary has no factory and the second runs one", async () => {
    await using _state = setup();
    worlds.delete(ENV_1);
    expect(await supported()).toBe(true);
  });

  it("is hidden when every candidate answered 404", async () => {
    await using _state = setup();
    worlds.clear();
    expect(await supported()).toBe(false);
  });

  it("stays while a candidate has not answered", async () => {
    await using _state = setup();
    worlds.delete(ENV_1);
    worlds.set(ENV_2, { status: statusBody("running"), runs: [], hang: true });
    expect(await supported()).toBe(true);
  });
});

describe("the run page follows its environment", () => {
  it("reads, stops and links the thread on the environment it is given, and names it", async () => {
    await using _state = setup();
    const page = await show(createElement(FactoryRunPage, { environmentId: ENV_2, runId: RUN_2 }));
    expect(calls.runRead.length).toBeGreaterThan(0);
    expect(calls.runRead.every(([env, id]) => env === ENV_2 && id === RUN_2)).toBe(true);
    // The header's thread link and the timeline's session link.
    expect(linksTo(page, "/$environmentId/$threadId")).toEqual([
      { environmentId: ENV_2, threadId: "thread-9" },
      { environmentId: ENV_2, threadId: "thread-9" },
    ]);
    // A building run opens on its timeline; GitHub is read only once its tab is opened.
    expect(calls.gitHubRead).toEqual([]);
    await page.click(page.all('button[data-tab="github"]')[0]!);
    await vi.waitFor(() => expect(page.text()).toContain("GitHub can't be read from Studio"));
    expect(calls.gitHubRead).toEqual([[ENV_2, RUN_2]]);
    await page.click(page.button("Stop")!);
    await act(() => vi.advanceTimersByTimeAsync(STOP_GRACE_MS));
    expect(calls.stop).toEqual([[ENV_2, RUN_2]]);
  });
});
