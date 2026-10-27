import { createElement, useSyncExternalStore, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page as browser, userEvent } from "vite-plus/test/browser";

import { act } from "../../test/render";
import { __setFactoryApiForTests, FactoryApiError, type FactoryApi } from "./api";
import type { FactoryResource } from "./useFactoryData";
import { render, renderAt } from "./testing";

const NOW = Date.parse("2026-10-17T12:00:00.000Z");

const state = vi.hoisted(() => ({
  status: null as unknown,
  runs: null as unknown,
  allRuns: null as unknown,
  // Environments beyond "env-2" (labelled "Mac Studio"), each with its own status and runs.
  listed: true,
  others: [] as Array<{ environmentId: string; label: string; status: unknown; runs: unknown }>,
  // The page's URL search, as the route validated it; `navigate` replaces it and re-renders.
  search: {} as Record<string, string>,
  listeners: new Set<() => void>(),
  navigations: [] as Array<{ to: string; search: Record<string, string>; replace?: boolean }>,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({
    to,
    params,
    search,
    children,
  }: {
    to: string;
    params?: Record<string, string>;
    search?: Record<string, string>;
    children?: ReactNode;
  }) =>
    createElement(
      "a",
      {
        "data-to": to,
        "data-params": JSON.stringify(params ?? {}),
        "data-search": JSON.stringify(search ?? {}),
      },
      children,
    ),
  useSearch: () =>
    useSyncExternalStore(
      (listener) => {
        state.listeners.add(listener);
        return () => state.listeners.delete(listener);
      },
      () => state.search,
    ),
  useNavigate:
    () => (options: { to: string; search: Record<string, string>; replace?: boolean }) => {
      state.navigations.push(options);
      state.search = options.search;
      for (const listener of state.listeners) listener();
      return Promise.resolve();
    },
}));
vi.mock("./useFactoryData", () => ({
  STATUS_POLL_MS: 5_000,
  useFactoryEnvironments: () =>
    state.listed
      ? [
          { environmentId: "env-2", label: "Mac Studio", status: state.status },
          ...state.others.map(({ environmentId, label, status }) => ({
            environmentId,
            label,
            status,
          })),
        ]
      : [],
  // Nothing listed means every candidate answered 404.
  useFactorySupported: () => state.listed,
  useFactoryRunsOf: (environmentIds: ReadonlyArray<string>, all: boolean) =>
    environmentIds.map((id) =>
      id === "env-2"
        ? all
          ? state.allRuns
          : state.runs
        : state.others.find((other) => other.environmentId === id)!.runs,
    ),
}));

import { FactoryPage } from "./FactoryPage";
import { validateFactorySearch } from "./search";

const resource = <T,>(overrides: Partial<FactoryResource<T>>): FactoryResource<T> => ({
  status: "ready",
  data: null,
  error: null,
  readAt: NOW,
  refresh: vi.fn(),
  ...overrides,
});

const statusData = (overrides: Record<string, unknown> = {}) => ({
  state: "running",
  reason: null,
  paused_by_hand: null,
  runs: [],
  attention: [],
  slots: { used: 1, max: 2 },
  passes: {},
  problems: [],
  ...overrides,
});

const RUN_ID = "original-solutions__t3code-factory__20__1";
const PR_URL = "https://github.com/original-solutions/t3code-factory/pull/30";
const runRow = (overrides: Record<string, unknown> = {}) => ({
  id: RUN_ID,
  started_ts: "2026-10-17T10:00:00.000Z",
  state: "building",
  last_event: "step_changed",
  step: "launch-sending",
  status: "running",
  pr_url: PR_URL,
  finished: false,
  total_ms: null,
  unreadable: false,
  ...overrides,
});

const api = (overrides: Partial<FactoryApi>): FactoryApi => ({
  status: vi.fn(),
  runs: vi.fn(),
  run: vi.fn(),
  stopRun: vi.fn(),
  pauseClaims: vi.fn(),
  resumeClaims: vi.fn(),
  dismissAttention: vi.fn(),
  ...overrides,
});

type Page = Awaited<ReturnType<typeof render>>;
/** The claims switch of the selected environment: the belt's one switch. */
const claimsSwitch = (page: Page) => page.all('[role="switch"]')[0]!;
const isDisabled = (node: Element) => node.hasAttribute("data-disabled");
const clock = (iso: string) => {
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
};
/** The environments the belt offers, in its segmented control. */
const environmentChoices = (page: Page) => page.all('[aria-label="Environments"] button');
/** The tables that are not the belt's readout: the runs table. */
const runsTables = (page: Page) =>
  page.all("table").filter((table) => table.closest("[data-readout]") === null);

// Ages are read from the clock; only Date is faked, so the page's own timers stay real.
function setup(): Disposable {
  vi.setSystemTime(NOW);
  state.status = resource({ data: statusData() });
  state.runs = resource({ data: { runs: [] } });
  state.allRuns = state.runs;
  state.others = [];
  state.listed = true;
  state.search = {};
  state.navigations = [];
  return {
    [Symbol.dispose]() {
      __setFactoryApiForTests();
      vi.useRealTimers();
    },
  };
}

describe("FactoryPage", () => {
  it("says there are no runs yet when the factory has none", async () => {
    using _state = setup();
    await using page = await render(createElement(FactoryPage));
    expect(page.text()).toContain("Factory");
    expect(page.text()).toContain("No runs in the last week");
    expect(page.text()).toContain("Nothing needs a person.");
    await page.click(page.button("Show all runs")!);
    expect(page.text()).toContain("No runs yet");
  });

  it("shows a loading state while either read is loading", async () => {
    using _state = setup();
    state.status = resource({ status: "loading" });
    await using page = await render(createElement(FactoryPage));
    expect(page.all('[aria-label="Loading factory"]')).not.toHaveLength(0);
    expect(page.text()).not.toContain("No runs");
  });

  it("shows the error and retries both reads", async () => {
    using _state = setup();
    const refreshStatus = vi.fn();
    const refreshRuns = vi.fn();
    state.status = resource({ status: "ready", data: statusData(), refresh: refreshStatus });
    state.runs = resource({
      status: "error",
      error: new FactoryApiError(403, null, "Missing permission orchestration:read"),
      refresh: refreshRuns,
    });
    await using page = await render(createElement(FactoryPage));
    expect(page.text()).toContain(
      "Could not refresh Mac Studio: Missing permission orchestration:read",
    );
    expect(page.text()).toContain("Running");
    await page.click(page.button("Retry")!);
    expect(refreshStatus).toHaveBeenCalledTimes(1);
    expect(refreshRuns).toHaveBeenCalledTimes(1);
  });

  it("keeps the page when a later poll fails, with the error as a notice and a Retry", async () => {
    using _state = setup();
    const refreshStatus = vi.fn();
    const refreshRuns = vi.fn();
    state.status = resource({ data: statusData(), refresh: refreshStatus });
    state.runs = resource({
      status: "error",
      data: { runs: [runRow()] },
      error: new Error("fetch failed"),
      refresh: refreshRuns,
    });
    await using page = await render(createElement(FactoryPage));
    expect(page.text()).toContain("original-solutions/t3code-factory");
    expect(page.text()).toContain("Could not refresh Mac Studio: fetch failed");
    expect(page.text()).not.toContain("Could not load the factory");
    await page.click(page.button("Retry")!);
    expect(refreshStatus).toHaveBeenCalledTimes(1);
    expect(refreshRuns).toHaveBeenCalledTimes(1);
  });

  it("lists the week the server sent, and every run once asked", async () => {
    using _state = setup();
    const old = runRow({
      id: "o__r__1__1",
      started_ts: "2026-09-01T10:00:00.000Z",
      finished: true,
    });
    state.runs = resource({ data: { runs: [runRow()] } });
    state.allRuns = resource({ data: { runs: [runRow(), old] } });
    await using page = await render(createElement(FactoryPage));
    const runLinks = () =>
      page.all("a").filter((a) => a.getAttribute("data-to") === "/factory/$environmentId/$runId");
    expect(runLinks()).toHaveLength(1);
    await page.click(page.button("Show all runs")!);
    expect(runLinks()).toHaveLength(2);
    expect(page.text()).toContain("o__r__1__1");
    expect(page.text()).toContain("Every run, read once.");
    expect(page.button("Show all runs")).toBeUndefined();
    await page.click(page.button("Show recent runs")!);
    expect(runLinks()).toHaveLength(1);
  });

  it("keeps a run stuck for more than a week out of the Stuck bin when every run is shown", async () => {
    using _state = setup();
    const old = runRow({
      id: "o__r__1__1",
      started_ts: "2026-09-01T10:00:00.000Z",
      finished: true,
      state: "stuck",
      reason: "gate failed long ago",
    });
    state.runs = resource({ data: { runs: [runRow()] } });
    state.allRuns = resource({ data: { runs: [runRow(), old] } });
    await using page = await render(createElement(FactoryPage));
    const stuck = () =>
      page.all("section").find((node) => node.getAttribute("aria-label") === "Stuck")!;
    expect(stuck().textContent).toContain("Nothing is stuck");
    await page.click(page.button("Show all runs")!);
    expect(page.text()).toContain("o__r__1__1");
    expect(stuck().textContent).toContain("Nothing is stuck");
    expect(stuck().textContent).not.toContain("gate failed long ago");
  });

  it("says when the week holds no runs and still offers every run", async () => {
    using _state = setup();
    await using page = await render(createElement(FactoryPage));
    expect(page.text()).toContain("No runs in the last week");
    expect(page.button("Show all runs")).toBeDefined();
  });

  it("lists the runs with repo, issue, state, step, age and pull request link", async () => {
    using _state = setup();
    state.runs = resource({
      data: {
        runs: [
          runRow({ id: "acme__old__3__1", started_ts: "2026-10-16T12:00:00.000Z", state: "stuck" }),
          runRow(),
        ],
      },
    });
    await using page = await render(createElement(FactoryPage));
    const text = page.text();
    expect(text).toContain("original-solutions/t3code-factory");
    expect(text).toContain("#20");
    expect(text).toContain("building");
    expect(text).toContain("launch-sending");
    expect(text).toContain("2h");
    const hrefs = page.all("a").map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("https://github.com/original-solutions/t3code-factory/issues/20");
    expect(hrefs).toContain(PR_URL);
    const link = page
      .all("a")
      .find(
        (a) =>
          a.getAttribute("data-to") === "/factory/$environmentId/$runId" &&
          a.getAttribute("data-params")!.includes(RUN_ID),
      );
    expect(link).toBeDefined();
  });

  it("links a pull request only when it is a github.com URL", async () => {
    using _state = setup();
    state.runs = resource({
      data: {
        runs: [
          runRow({ id: "acme__a__1__1", pr_url: "javascript:alert(1)" }),
          runRow({ id: "acme__b__2__1", pr_url: "https://evil.example/pull/9" }),
          runRow(),
        ],
      },
    });
    await using page = await render(createElement(FactoryPage));
    const hrefs = page.all("a").map((a) => a.getAttribute("href"));
    expect(hrefs).toContain(PR_URL);
    expect(hrefs).not.toContain("javascript:alert(1)");
    expect(hrefs).not.toContain("https://evil.example/pull/9");
    expect(page.text()).toContain("javascript:alert(1)");
  });

  it("lists the newest run first, and falls back to the last event without a step", async () => {
    using _state = setup();
    state.runs = resource({
      data: {
        runs: [
          runRow({
            id: "acme__old__3__1",
            started_ts: "2026-10-16T12:00:00.000Z",
            step: null,
            last_event: "claimed",
          }),
          runRow(),
        ],
      },
    });
    await using page = await render(createElement(FactoryPage));
    const text = page.text();
    expect(text.indexOf("original-solutions/t3code-factory")).toBeLessThan(
      text.indexOf("acme/old"),
    );
    expect(text).toContain("claimed");
  });

  it("shows merged or closed for a run that ended on its pull request, else its last state", async () => {
    using _state = setup();
    const ended = { state: "pr-open", finished: true, status: "finished", step: null };
    state.runs = resource({
      data: {
        runs: [
          runRow({ ...ended, id: "acme__merged__1__1", pr_end: "merged" }),
          runRow({ ...ended, id: "acme__closed__2__1", pr_end: "closed" }),
          // A server from before pr_end sends no such field.
          runRow({ ...ended, id: "acme__older__3__1" }),
        ],
      },
    });
    await using page = await render(createElement(FactoryPage));
    const badgeOf = (repo: string) =>
      page
        .all("tr")
        .find((row) => row.textContent?.includes(repo))
        ?.querySelector('[data-slot="badge"]')?.textContent;
    expect(badgeOf("acme/merged")).toBe("merged");
    expect(badgeOf("acme/closed")).toBe("closed");
    expect(badgeOf("acme/older")).toBe("pr-open");
  });

  it("marks an unreadable run", async () => {
    using _state = setup();
    state.runs = resource({
      data: { runs: [runRow({ unreadable: true, state: null, step: null, last_event: null })] },
    });
    await using page = await render(createElement(FactoryPage));
    expect(page.text()).toContain("unreadable");
  });

  it("shows the open attention items at the top", async () => {
    using _state = setup();
    state.status = resource({
      data: statusData({
        attention: [
          {
            id: "stuck:20",
            kind: "stuck",
            repo: "original-solutions/t3code-factory",
            issue: 20,
            run: RUN_ID,
            message: "run ended stuck: the gate failed",
            first_seen: "2026-10-17T11:00:00.000Z",
          },
        ],
      }),
    });
    state.runs = resource({ data: { runs: [runRow()] } });
    await using page = await render(createElement(FactoryPage));
    const text = page.text();
    expect(text).toContain("stuck");
    expect(text).toContain("original-solutions/t3code-factory#20");
    expect(text).toContain("run ended stuck: the gate failed");
    expect(text).toContain("1h");
    expect(text.indexOf("run ended stuck")).toBeLessThan(text.indexOf("launch-sending"));
    const issue = page
      .all("a")
      .find((a) => a.textContent === "original-solutions/t3code-factory#20");
    expect(issue?.getAttribute("href")).toBe(
      "https://github.com/original-solutions/t3code-factory/issues/20",
    );
  });

  it("shows an idle factory with its reason", async () => {
    using _state = setup();
    state.status = resource({
      data: statusData({ state: "idle", reason: "no factory config" }),
    });
    await using page = await render(createElement(FactoryPage));
    const text = page.text();
    expect(text).toContain("Mac Studio");
    expect(text).toContain("Idle: no factory config");
    const settings = page.all("a").find((a) => a.textContent === "Factory settings");
    expect(settings?.getAttribute("data-to")).toBe("/settings/factory");
    // Settings opens on the idle environment, not the primary one.
    expect(JSON.parse(settings!.getAttribute("data-search")!)).toEqual({ machine: "env-2" });
  });

  it("pauses claims, shows the answer and refreshes", async () => {
    using _state = setup();
    const refreshStatus = vi.fn();
    state.status = resource({ data: statusData(), refresh: refreshStatus });
    const pauseClaims = vi.fn(async () => ({
      paused: true as const,
      already: false,
      since: "2026-10-17T12:00:00.000Z",
      message: "claims paused",
    }));
    __setFactoryApiForTests(api({ pauseClaims }));
    await using page = await render(createElement(FactoryPage));
    expect(claimsSwitch(page).getAttribute("aria-label")).toBe("Claims on Mac Studio");
    expect(claimsSwitch(page).getAttribute("aria-checked")).toBe("true");
    await page.click(claimsSwitch(page));
    expect(pauseClaims).toHaveBeenCalledTimes(1);
    expect(pauseClaims).toHaveBeenCalledWith("env-2");
    expect(page.text()).toContain("claims paused");
    expect(refreshStatus).toHaveBeenCalled();
  });

  it("resumes claims when they are paused by hand, saying since when", async () => {
    using _state = setup();
    const since = "2026-10-17T11:00:00.000Z";
    state.status = resource({
      data: statusData({ paused_by_hand: { since, for_ms: 3_600_000 } }),
    });
    const resumeClaims = vi.fn(async () => ({
      paused: false as const,
      already: false,
      message: "claims resumed",
    }));
    __setFactoryApiForTests(api({ resumeClaims }));
    await using page = await render(createElement(FactoryPage));
    expect(page.text()).toContain(`claims paused by hand since ${clock(since)}`);
    expect(claimsSwitch(page).getAttribute("aria-checked")).toBe("false");
    await page.click(claimsSwitch(page));
    expect(resumeClaims).toHaveBeenCalledTimes(1);
    expect(resumeClaims).toHaveBeenCalledWith("env-2");
    expect(page.text()).toContain("claims resumed");
  });

  it("disables the claims switch while a pause is pending", async () => {
    using _state = setup();
    state.status = resource({ data: statusData() });
    let resolve!: (value: {
      paused: true;
      already: boolean;
      since: string;
      message: string;
    }) => void;
    const pauseClaims = vi.fn(
      () =>
        new Promise<{ paused: true; already: boolean; since: string; message: string }>(
          (r) => (resolve = r),
        ),
    );
    __setFactoryApiForTests(api({ pauseClaims }));
    await using page = await render(createElement(FactoryPage));
    expect(isDisabled(claimsSwitch(page))).toBe(false);
    await page.click(claimsSwitch(page));
    expect(isDisabled(claimsSwitch(page))).toBe(true);
    await act(async () =>
      resolve({ paused: true, already: false, since: "2026-10-17T12:00:00.000Z", message: "ok" }),
    );
    expect(isDisabled(claimsSwitch(page))).toBe(false);
  });

  it("disables the claims switch while a resume is pending", async () => {
    using _state = setup();
    state.status = resource({
      data: statusData({
        paused_by_hand: { since: "2026-10-17T11:00:00.000Z", for_ms: 3_600_000 },
      }),
    });
    let resolve!: (value: { paused: false; already: boolean; message: string }) => void;
    const resumeClaims = vi.fn(
      () => new Promise<{ paused: false; already: boolean; message: string }>((r) => (resolve = r)),
    );
    __setFactoryApiForTests(api({ resumeClaims }));
    await using page = await render(createElement(FactoryPage));
    expect(isDisabled(claimsSwitch(page))).toBe(false);
    await page.click(claimsSwitch(page));
    expect(isDisabled(claimsSwitch(page))).toBe(true);
    await act(async () => resolve({ paused: false, already: false, message: "ok" }));
    expect(isDisabled(claimsSwitch(page))).toBe(false);
  });

  it("shows the message of a control call that fails", async () => {
    using _state = setup();
    __setFactoryApiForTests(
      api({
        pauseClaims: async () => {
          throw new FactoryApiError(403, null, "Missing permission orchestration:operate");
        },
      }),
    );
    await using page = await render(createElement(FactoryPage));
    await page.click(claimsSwitch(page));
    expect(page.text()).toContain("Missing permission orchestration:operate");
  });
});

describe("FactoryPage environments", () => {
  it("says no factory runs when no connected environment has one", async () => {
    using _state = setup();
    state.listed = false;
    await using page = await render(createElement(FactoryPage));
    expect(page.text()).toContain("No factory");
    expect(page.all('[aria-label="Loading factory"]')).toHaveLength(0);
  });

  it("shows a loading row for an environment whose status is loading, and the others' runs", async () => {
    using _state = setup();
    state.runs = resource({ data: { runs: [runRow()] } });
    state.others = [
      {
        environmentId: "env-3",
        label: "Laptop",
        status: resource({ status: "loading" }),
        runs: resource({ status: "loading" }),
      },
    ];
    await using page = await render(createElement(FactoryPage));
    expect(page.text()).toContain("Laptop");
    expect(page.all('[aria-label="Loading Laptop"]')).toHaveLength(1);
    expect(page.text()).toContain("original-solutions/t3code-factory");
    expect(page.all('[aria-label="Loading factory"]')).toHaveLength(0);
  });

  it("puts the runs of every environment on one belt, each tile leading to its own environment", async () => {
    using _state = setup();
    const unfinished = (id: string, state: string) => ({
      id,
      state,
      last_event: "step_changed",
      title: null,
      user: null,
      for_ms: 60_000,
      pr_url: null,
      thread_id: null,
      unreadable: false,
    });
    state.status = resource({
      data: statusData({ runs: [unfinished(RUN_ID, "pr-open")] }),
    });
    state.others = [
      {
        environmentId: "env-3",
        label: "Laptop",
        status: resource({
          data: statusData({
            runs: [
              unfinished("acme__widgets__7__1", "pr-open"),
              unfinished("acme__w__8__1", "building"),
            ],
          }),
        }),
        runs: resource({ data: { runs: [] } }),
      },
    ];
    await using page = await render(createElement(FactoryPage));
    const post = (name: string) =>
      page.all("button[data-station]").find((button) => button.dataset.station === name)!;
    expect(post("pr").querySelector("[data-part=count]")?.textContent).toBe("2");
    expect(post("building").querySelector("[data-part=count]")?.textContent).toBe("1");
    const tiles = page
      .all("[data-lane=pr] a")
      .map((a) => JSON.parse(a.getAttribute("data-params")!) as Record<string, string>);
    expect(tiles).toEqual(
      expect.arrayContaining([
        { environmentId: "env-2", runId: RUN_ID },
        { environmentId: "env-3", runId: "acme__widgets__7__1" },
      ]),
    );
  });

  it("shows the error of a status that failed with no data, and retries only that status", async () => {
    using _state = setup();
    const refreshOther = vi.fn();
    const refreshOwn = vi.fn();
    state.status = resource({ data: statusData(), refresh: refreshOwn });
    state.others = [
      {
        environmentId: "env-3",
        label: "Laptop",
        status: resource({
          status: "error",
          error: new Error("connection refused"),
          refresh: refreshOther,
        }),
        runs: resource({ status: "loading" }),
      },
    ];
    await using page = await render(createElement(FactoryPage));
    expect(page.text()).toContain("connection refused");
    await page.click(page.button("Retry")!);
    expect(refreshOther).toHaveBeenCalledTimes(1);
    expect(refreshOwn).not.toHaveBeenCalled();
  });

  it("keeps a status that failed after a good read, with a notice naming its environment and a Retry for that status", async () => {
    using _state = setup();
    const refreshOther = vi.fn();
    const refreshOwn = vi.fn();
    state.status = resource({ data: statusData(), refresh: refreshOwn });
    state.runs = resource({ data: { runs: [runRow()] } });
    state.others = [
      {
        environmentId: "env-3",
        label: "Laptop",
        status: resource({
          status: "error",
          data: statusData({ state: "idle", reason: "no repos" }),
          error: new Error("timed out"),
          refresh: refreshOther,
        }),
        runs: resource({ data: { runs: [] } }),
      },
    ];
    await using page = await render(createElement(FactoryPage));
    expect(page.text()).toContain("Could not refresh Laptop: timed out");
    expect(page.text()).toContain("Idle: no repos");
    await page.click(page.button("Retry")!);
    expect(refreshOther).toHaveBeenCalledTimes(1);
    expect(refreshOwn).not.toHaveBeenCalled();
  });

  it("shows loading in place of the runs while no environment has listed its runs", async () => {
    using _state = setup();
    state.runs = resource({ status: "loading" });
    await using page = await render(createElement(FactoryPage));
    expect(page.all('[aria-label="Loading runs"]')).not.toHaveLength(0);
    expect(page.text()).not.toContain("No runs");
  });

  it("shows the Environment column and each run's label only with several environments", async () => {
    using _state = setup();
    state.runs = resource({ data: { runs: [runRow()] } });
    await using alone = await render(createElement(FactoryPage));
    expect(alone.all("th").map((th) => th.textContent)).not.toContain("Environment");
    await alone.unmount();
    state.others = [
      {
        environmentId: "env-3",
        label: "Laptop",
        status: resource({ data: statusData() }),
        runs: resource({ data: { runs: [runRow({ id: "acme__w__7__1" })] } }),
      },
    ];
    await using table = await render(createElement(FactoryPage));
    expect(table.all("th").map((th) => th.textContent)).toContain("Environment");
    await table.unmount();
    await using cards = await renderAt(375, createElement(FactoryPage));
    const card = cards.all("ul").find((ul) => ul.getAttribute("data-layout") === "cards")!;
    expect(card.textContent).toContain("Laptop");
    expect(card.textContent).toContain("Mac Studio");
  });
});

const ATTENTION = {
  id: "stuck:20",
  kind: "stuck",
  repo: "original-solutions/t3code-factory",
  issue: 20,
  run: RUN_ID,
  message: "run ended stuck: the gate failed",
  first_seen: "2026-10-17T11:00:00.000Z",
};

describe.each([375, 1280])("FactoryPage at %i px", (width) => {
  const narrow = width < 640;
  const populate = () => {
    state.status = resource({ data: statusData({ attention: [ATTENTION] }) });
    state.runs = resource({
      status: "error",
      error: new Error("fetch failed"),
      data: {
        runs: [runRow(), runRow({ id: "acme__old__3__1", started_ts: "2026-10-16T12:00:00.000Z" })],
      },
    });
  };

  it(narrow ? "lists the runs as cards, not a table" : "lists the runs in a table", async () => {
    using _state = setup();
    populate();
    await using page = await renderAt(width, createElement(FactoryPage));
    expect(runsTables(page)).toHaveLength(narrow ? 0 : 1);
    const cards = page.all("ul").filter((ul) => ul.getAttribute("data-layout") === "cards");
    expect(cards).toHaveLength(narrow ? 1 : 0);
    await page.unmount();
  });

  it("puts the attention items above the runs", async () => {
    using _state = setup();
    populate();
    await using page = await renderAt(width, createElement(FactoryPage));
    const text = page.text();
    expect(text.indexOf("run ended stuck")).toBeGreaterThan(-1);
    expect(text.indexOf("run ended stuck")).toBeLessThan(text.indexOf("launch-sending"));
    expect(text.indexOf("Could not refresh")).toBeGreaterThan(text.indexOf("run ended stuck"));
    expect(text.indexOf("Could not refresh")).toBeLessThan(text.indexOf("launch-sending"));
    await page.unmount();
  });

  it("shows a control's answer in the body, below the attention items", async () => {
    using _state = setup();
    populate();
    __setFactoryApiForTests(
      api({
        pauseClaims: async () => ({
          paused: true as const,
          already: false,
          since: "2026-10-17T12:00:00.000Z",
          message: "claims paused",
        }),
      }),
    );
    await using page = await renderAt(width, createElement(FactoryPage));
    await page.click(claimsSwitch(page));
    const text = page.text();
    expect(text.indexOf("claims paused")).toBeGreaterThan(text.indexOf("run ended stuck"));
    expect(text.indexOf("claims paused")).toBeLessThan(text.indexOf("launch-sending"));
    await page.unmount();
  });
});

describe("FactoryPage attention items at 375 px", () => {
  it("puts the message on its own full-width line after the badge, repo and age", async () => {
    using _state = setup();
    state.status = resource({ data: statusData({ attention: [ATTENTION] }) });
    state.runs = resource({ data: { runs: [runRow()] } });
    await using page = await renderAt(375, createElement(FactoryPage));
    const section = page
      .all("section")
      .find((node) => node.getAttribute("aria-label") === "Needs attention")!;
    const item = section.querySelectorAll("li")[0]!;
    const message = Array.from(item.querySelectorAll("*")).find((node) =>
      Array.from(node.childNodes).some(
        (child) => child.nodeType === Node.TEXT_NODE && child.textContent === ATTENTION.message,
      ),
    )!;
    expect(message.tagName).toBe("P");
    expect(message.className).toContain("w-full");
    expect(message.className).not.toContain("flex-1");
    const full = item.textContent ?? "";
    const order = ["stuck", ATTENTION.repo, "1h", ATTENTION.message].map((part) =>
      full.indexOf(part),
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    await page.unmount();
  });
});

describe("FactoryPage run cards at 375 px", () => {
  it("shows each run's repo, issue, state, step, age and pull request, and links to the run", async () => {
    using _state = setup();
    state.runs = resource({ data: { runs: [runRow()] } });
    await using page = await renderAt(375, createElement(FactoryPage));
    const link = page
      .all("a")
      .find(
        (a) =>
          a.getAttribute("data-to") === "/factory/$environmentId/$runId" &&
          a.getAttribute("data-params")!.includes(RUN_ID),
      );
    expect(link).toBeDefined();
    const text = link!.textContent ?? "";
    for (const part of ["original-solutions/t3code-factory", "building", "launch-sending", "2h"]) {
      expect(text).toContain(part);
    }
    // A card is one link: nothing inside it is another link.
    expect(link!.querySelectorAll("a")).toHaveLength(0);
    await page.unmount();
  });

  it("links the issue and the pull request outside the card's own link", async () => {
    using _state = setup();
    state.runs = resource({ data: { runs: [runRow()] } });
    await using page = await renderAt(375, createElement(FactoryPage));
    const hrefs = page
      .all("a")
      .map((a) => a.getAttribute("href"))
      .filter((href) => href !== null);
    expect(hrefs).toEqual([
      "https://github.com/original-solutions/t3code-factory/issues/20",
      PR_URL,
    ]);
    const card = page
      .all("a")
      .find((a) => a.getAttribute("data-to") === "/factory/$environmentId/$runId")!;
    expect(card.querySelectorAll("a")).toHaveLength(0);
    await page.unmount();
  });

  it("leaves a non-GitHub pull request URL as text on the card", async () => {
    using _state = setup();
    state.runs = resource({ data: { runs: [runRow({ pr_url: "https://example.com/pr/1" })] } });
    await using page = await renderAt(375, createElement(FactoryPage));
    expect(page.all("a").map((a) => a.getAttribute("href"))).not.toContain(
      "https://example.com/pr/1",
    );
    expect(page.text()).toContain("https://example.com/pr/1");
    await page.unmount();
  });

  it("keeps the newest first, the empty state and the Show all runs control", async () => {
    using _state = setup();
    state.runs = resource({
      data: {
        runs: [runRow({ id: "acme__old__3__1", started_ts: "2026-10-16T12:00:00.000Z" }), runRow()],
      },
    });
    await using page = await renderAt(375, createElement(FactoryPage));
    const text = page.text();
    expect(text.indexOf("original-solutions/t3code-factory")).toBeLessThan(
      text.indexOf("acme/old"),
    );
    expect(page.button("Show all runs")).toBeDefined();
    await page.unmount();
    state.runs = resource({ data: { runs: [] } });
    await using empty = await renderAt(375, createElement(FactoryPage));
    expect(empty.text()).toContain("No runs in the last week");
    expect(empty.button("Show all runs")).toBeDefined();
    await empty.unmount();
  });
});

describe.each([
  [639, true],
  [640, false],
])("FactoryPage at the 640 px breakpoint, %i px", (width, narrow) => {
  it(narrow ? "lists cards just below 640" : "lists the table from 640", async () => {
    using _state = setup();
    state.runs = resource({ data: { runs: [runRow()] } });
    await using page = await renderAt(width, createElement(FactoryPage));
    expect(runsTables(page)).toHaveLength(narrow ? 0 : 1);
    const cards = page.all("ul").filter((ul) => ul.getAttribute("data-layout") === "cards");
    expect(cards).toHaveLength(narrow ? 1 : 0);
    await page.unmount();
  });
});

describe("FactoryPage dismissing attention items", () => {
  const CONFIG = {
    id: "config",
    kind: "config",
    repo: null,
    issue: null,
    run: null,
    message: "the machine config does not load",
    first_seen: "2026-10-17T11:30:00.000Z",
  };
  const PASS = {
    id: "pass-errors",
    kind: "pass-errors",
    repo: null,
    issue: null,
    run: null,
    message: "the pass has failed 3 times in a row",
    first_seen: "2026-10-17T11:40:00.000Z",
  };
  const section = (page: Awaited<ReturnType<typeof render>>) =>
    page.all("section").find((node) => node.getAttribute("aria-label") === "Needs attention");
  // An element holds `text` when one of its own text nodes is exactly `text`.
  const holdsText = (root: Element, text: string) =>
    [root, ...root.querySelectorAll("*")].some((node) =>
      Array.from(node.childNodes).some(
        (child) => child.nodeType === Node.TEXT_NODE && child.textContent === text,
      ),
    );
  const itemOf = (page: Awaited<ReturnType<typeof render>>, message: string) =>
    Array.from(section(page)?.querySelectorAll("li") ?? []).find((li) => holdsText(li, message));
  const dismissIn = (item: HTMLElement) =>
    Array.from(item.querySelectorAll("button")).find((button) => holdsText(button, "Dismiss"))!;

  it("Dismiss removes that item at once and sends its id", async () => {
    using _state = setup();
    state.status = resource({ data: statusData({ attention: [ATTENTION, CONFIG] }) });
    let resolve!: (value: { dismissed: ReadonlyArray<string> }) => void;
    const dismissAttention = vi.fn(
      () => new Promise<{ dismissed: ReadonlyArray<string> }>((r) => (resolve = r)),
    );
    __setFactoryApiForTests(api({ dismissAttention }));
    await using page = await render(createElement(FactoryPage));
    await page.click(dismissIn(itemOf(page, ATTENTION.message)!));
    expect(dismissAttention).toHaveBeenCalledWith("env-2", [ATTENTION.id]);
    expect(page.text()).not.toContain(ATTENTION.message);
    expect(page.text()).toContain(CONFIG.message);
    await act(async () => resolve({ dismissed: [ATTENTION.id] }));
    expect(page.text()).not.toContain(ATTENTION.message);
  });

  it("Dismiss all sends exactly the ids shown, and the section goes", async () => {
    using _state = setup();
    state.status = resource({ data: statusData({ attention: [ATTENTION, CONFIG, PASS] }) });
    const dismissAttention = vi.fn(async (_environmentId: string, ids: ReadonlyArray<string>) => ({
      dismissed: ids,
    }));
    __setFactoryApiForTests(api({ dismissAttention }));
    await using page = await render(createElement(FactoryPage));
    await page.click(dismissIn(itemOf(page, CONFIG.message)!));
    await page.click(page.button("Dismiss all")!);
    expect(dismissAttention).toHaveBeenLastCalledWith("env-2", [ATTENTION.id, PASS.id]);
    expect(section(page)?.textContent).toContain("Nothing needs a person.");
    expect(page.button("Dismiss all")).toBeUndefined();
  });

  it("keeps the claims switch disabled when a dismiss finishes while the pause is pending", async () => {
    using _state = setup();
    state.status = resource({ data: statusData({ attention: [ATTENTION] }) });
    const pauseClaims = vi.fn(() => new Promise<never>(() => {}));
    const dismissAttention = vi.fn(async () => ({ dismissed: [ATTENTION.id] }));
    __setFactoryApiForTests(api({ pauseClaims, dismissAttention }));
    await using page = await render(createElement(FactoryPage));
    await page.click(claimsSwitch(page));
    await page.click(dismissIn(itemOf(page, ATTENTION.message)!));
    expect(dismissAttention).toHaveBeenCalled();
    expect(isDisabled(claimsSwitch(page))).toBe(true);
  });

  it("has no Dismiss all when nothing needs attention", async () => {
    using _state = setup();
    await using page = await render(createElement(FactoryPage));
    expect(page.button("Dismiss all")).toBeUndefined();
  });

  it("brings the item back and shows the error when the dismiss fails", async () => {
    using _state = setup();
    state.status = resource({ data: statusData({ attention: [ATTENTION] }) });
    __setFactoryApiForTests(
      api({
        dismissAttention: async () => {
          throw new FactoryApiError(403, null, "Missing permission orchestration:operate");
        },
      }),
    );
    await using page = await render(createElement(FactoryPage));
    await page.click(dismissIn(itemOf(page, ATTENTION.message)!));
    expect(page.text()).toContain(ATTENTION.message);
    expect(page.text()).toContain("Missing permission orchestration:operate");
  });

  it("shows an item again when the factory raises it anew after it was dismissed", async () => {
    using _state = setup();
    state.status = resource({ data: statusData({ attention: [CONFIG] }) });
    __setFactoryApiForTests(api({ dismissAttention: async () => ({ dismissed: [CONFIG.id] }) }));
    await using page = await render(createElement(FactoryPage));
    await page.click(dismissIn(itemOf(page, CONFIG.message)!));
    expect(page.text()).not.toContain(CONFIG.message);
    state.status = resource({
      data: statusData({ attention: [{ ...CONFIG, first_seen: "2026-10-17T11:59:00.000Z" }] }),
    });
    await page.rerender(createElement(FactoryPage));
    expect(page.text()).toContain(CONFIG.message);
  });

  it("links a run item to its run, a config item to the factory settings, and others nowhere", async () => {
    using _state = setup();
    state.status = resource({ data: statusData({ attention: [ATTENTION, CONFIG, PASS] }) });
    await using page = await render(createElement(FactoryPage));
    const linksIn = (message: string) => Array.from(itemOf(page, message)!.querySelectorAll("a"));
    const run = linksIn(ATTENTION.message).find((a) => a.hasAttribute("data-to"));
    expect(run!.getAttribute("data-to")).toBe("/factory/$environmentId/$runId");
    expect(JSON.parse(run!.getAttribute("data-params")!)).toEqual({
      environmentId: "env-2",
      runId: RUN_ID,
    });
    const [settings] = linksIn(CONFIG.message);
    expect(settings!.getAttribute("data-to")).toBe("/settings/factory");
    expect(JSON.parse(settings!.getAttribute("data-search")!)).toEqual({ machine: "env-2" });
    expect(linksIn(PASS.message)).toHaveLength(0);
    // Dismiss is its own control, never inside the link.
    for (const link of [run!, settings!]) {
      expect(link.querySelectorAll("button")).toHaveLength(0);
    }
  });
});

describe("FactoryPage filters", () => {
  const LAPTOP_RUN = "acme__widgets__7__1";
  const configItem = {
    ...ATTENTION,
    id: "config",
    kind: "config",
    repo: null,
    issue: null,
    run: null,
    message: "the machine config failed to load",
  };
  const laptopItem = {
    ...ATTENTION,
    id: "stuck:7",
    repo: "acme/widgets",
    issue: 7,
    run: LAPTOP_RUN,
    message: "laptop run ended stuck",
  };
  /** Mac Studio: a t3code-factory run and item; Laptop: an acme/widgets run and item, and a config item. */
  const twoEnvironments = () => {
    state.status = resource({ data: statusData({ attention: [ATTENTION] }) });
    state.runs = resource({ data: { runs: [runRow()] } });
    state.others = [
      {
        environmentId: "env-3",
        label: "Laptop",
        status: resource({ data: statusData({ attention: [laptopItem, configItem] }) }),
        runs: resource({ data: { runs: [runRow({ id: LAPTOP_RUN })] } }),
      },
    ];
  };
  // The runs table's links only; an attention item's View run links to the same route.
  const runLinks = (page: Awaited<ReturnType<typeof render>>) =>
    page
      .all("table a")
      .filter((a) => a.getAttribute("data-to") === "/factory/$environmentId/$runId")
      .map((a) => JSON.parse(a.getAttribute("data-params")!).runId as string);
  const pick = async (select: string, option: string) => {
    await userEvent.click(browser.getByRole("combobox", { name: select }));
    await userEvent.click(browser.getByRole("option", { name: option, exact: true }));
  };

  it("keeps a string search value and drops one that is not a string", () => {
    expect(validateFactorySearch({ environment: "env-3", repo: "acme/widgets" })).toEqual({
      environment: "env-3",
      repo: "acme/widgets",
    });
    expect(validateFactorySearch({ environment: 3, repo: ["acme/widgets"], other: "x" })).toEqual(
      {},
    );
  });

  it("picking an environment hides the other environment's rows, items and runs and writes it to the URL", async () => {
    using _state = setup();
    twoEnvironments();
    await using page = await render(createElement(FactoryPage));
    expect(runLinks(page)).toHaveLength(2);
    await pick("Environment", "Laptop");
    expect(state.navigations.at(-1)).toEqual({
      to: "/factory",
      search: { environment: "env-3" },
      replace: true,
    });
    // The belt shows every environment whatever the filter says; the filter narrows the items and runs.
    expect(environmentChoices(page)).toHaveLength(2);
    expect(runLinks(page)).toEqual([LAPTOP_RUN]);
    expect(page.text()).toContain("laptop run ended stuck");
    expect(page.text()).not.toContain("run ended stuck: the gate failed");
    await pick("Environment", "All environments");
    expect(state.navigations.at(-1)).toEqual({ to: "/factory", search: {}, replace: true });
    expect(runLinks(page)).toHaveLength(2);
  });

  it("picking a repo hides other repos' runs and items and keeps an item with no repo", async () => {
    using _state = setup();
    twoEnvironments();
    await using page = await render(createElement(FactoryPage));
    await pick("Repo", "acme/widgets");
    expect(state.navigations.at(-1)).toEqual({
      to: "/factory",
      search: { repo: "acme/widgets" },
      replace: true,
    });
    expect(runLinks(page)).toEqual([LAPTOP_RUN]);
    expect(page.text()).toContain("laptop run ended stuck");
    expect(page.text()).toContain("the machine config failed to load");
    expect(page.text()).not.toContain("run ended stuck: the gate failed");
    expect(environmentChoices(page)).toHaveLength(2);
  });

  it("lists the repos of the runs and items once each, sorted without regard to case", async () => {
    using _state = setup();
    twoEnvironments();
    state.runs = resource({
      data: { runs: [runRow(), runRow({ id: "Acme__Widgets__8__1" }), runRow({ id: "x" })] },
    });
    await using _page = await render(createElement(FactoryPage));
    await userEvent.click(browser.getByRole("combobox", { name: "Repo" }));
    const options = Array.from(document.querySelectorAll('[role="option"]')).map(
      (option) => option.textContent,
    );
    expect(options).toEqual(["All repos", "acme/widgets", "original-solutions/t3code-factory"]);
  });

  it("opens filtered from the URL, matching the repo without regard to case", async () => {
    using _state = setup();
    twoEnvironments();
    state.search = { repo: "ORIGINAL-SOLUTIONS/T3code-factory" };
    state.others[0]!.runs = resource({
      data: { runs: [runRow({ id: LAPTOP_RUN }), runRow({ id: "unparsed" })] },
    });
    await using page = await render(createElement(FactoryPage));
    expect(runLinks(page)).toEqual([RUN_ID]);
    expect(page.text()).toContain("run ended stuck: the gate failed");
    expect(page.text()).not.toContain("laptop run ended stuck");
  });

  it("shows a run whose id does not parse only with no repo filter", async () => {
    using _state = setup();
    twoEnvironments();
    state.runs = resource({ data: { runs: [runRow(), runRow({ id: "unparsed" })] } });
    await using page = await render(createElement(FactoryPage));
    expect(runLinks(page)).toContain("unparsed");
    await pick("Environment", "Mac Studio");
    expect(runLinks(page)).toContain("unparsed");
    await pick("Repo", "original-solutions/t3code-factory");
    expect(state.navigations.at(-1)?.search).toEqual({
      environment: "env-2",
      repo: "original-solutions/t3code-factory",
    });
    expect(runLinks(page)).toEqual([RUN_ID]);
  });

  it("matches a run's repo to the chosen one without regard to case", async () => {
    using _state = setup();
    twoEnvironments();
    state.runs = resource({ data: { runs: [runRow(), runRow({ id: "Acme__Widgets__8__1" })] } });
    await using page = await render(createElement(FactoryPage));
    await pick("Repo", "acme/widgets");
    expect(runLinks(page).toSorted()).toEqual(["Acme__Widgets__8__1", LAPTOP_RUN]);
  });

  it("leaves out a filtered-out environment's failure to list every run", async () => {
    using _state = setup();
    twoEnvironments();
    state.runs = resource({ data: { runs: [runRow()] } });
    state.allRuns = resource({
      status: "error",
      data: { runs: [runRow()] },
      error: new Error("fetch failed"),
    });
    state.search = { environment: "env-3" };
    await using page = await render(createElement(FactoryPage));
    await page.click(page.button("Show all runs")!);
    expect(page.text()).not.toContain("Could not refresh Mac Studio");
  });

  it("names a filtered-out environment whose status the belt still shows when it fails", async () => {
    using _state = setup();
    twoEnvironments();
    state.status = resource({
      status: "error",
      data: statusData(),
      error: new Error("fetch failed"),
    });
    state.search = { environment: "env-3" };
    await using page = await render(createElement(FactoryPage));
    expect(page.text()).toContain("Could not refresh Mac Studio: fetch failed");
  });

  it("names a filtered-out environment whose recent runs the belt still counts when they fail", async () => {
    using _state = setup();
    twoEnvironments();
    state.runs = resource({
      status: "error",
      data: { runs: [runRow()] },
      error: new Error("fetch failed"),
    });
    state.search = { environment: "env-3" };
    await using page = await render(createElement(FactoryPage));
    expect(page.text()).toContain("Could not refresh Mac Studio: fetch failed");
  });

  describe("when an environment's recent runs failed before their first answer", () => {
    const stuckRow = runRow({
      id: LAPTOP_RUN,
      state: "stuck",
      finished: true,
      reason: "gate failed",
    });
    const stat = (page: Awaited<ReturnType<typeof render>>, label: string) =>
      page.all("dt").find((dt) => dt.textContent === label)?.nextElementSibling?.textContent;
    const failing = () => {
      twoEnvironments();
      state.runs = resource({ status: "error", error: new Error("timed out") });
      state.others[0]!.runs = resource({ data: { runs: [stuckRow] } });
    };
    const expectBelt = (page: Awaited<ReturnType<typeof render>>) => {
      const stuck = page.all("section").find((s) => s.getAttribute("aria-label") === "Stuck")!;
      expect(stuck.textContent).toContain("gate failed");
      expect(page.all('[aria-label="Loading Stuck"]')).toHaveLength(0);
      expect(stat(page, "Stuck")).toBe("1");
      expect(page.text()).toContain("Could not refresh Mac Studio: timed out");
      expect(page.all('[aria-label="Retry Mac Studio"]')).toHaveLength(1);
    };

    it("names the failure and shows the other environment's stuck run", async () => {
      using _state = setup();
      failing();
      await using page = await render(createElement(FactoryPage));
      expectBelt(page);
    });

    it("names it with the environment filter on the healthy environment", async () => {
      using _state = setup();
      failing();
      state.search = { environment: "env-3" };
      await using page = await render(createElement(FactoryPage));
      expectBelt(page);
    });

    it("names it with every run picked", async () => {
      using _state = setup();
      failing();
      state.allRuns = resource({ data: { runs: [runRow()] } });
      await using page = await render(createElement(FactoryPage));
      await page.click(page.button("Show all runs")!);
      expectBelt(page);
    });

    it("retries that recent read, once", async () => {
      using _state = setup();
      failing();
      const refreshRecent = vi.fn();
      state.runs = resource({
        status: "error",
        error: new Error("timed out"),
        refresh: refreshRecent,
      });
      state.search = { environment: "env-3" };
      await using page = await render(createElement(FactoryPage));
      await page.click(page.button("Retry")!);
      expect(refreshRecent).toHaveBeenCalledTimes(1);
    });
  });

  it("says the runs are loading, not that none match, while the chosen environment's runs are read", async () => {
    using _state = setup();
    twoEnvironments();
    state.others[0]!.runs = resource({ status: "loading" });
    state.search = { environment: "env-3" };
    await using page = await render(createElement(FactoryPage));
    expect(page.all('[aria-label="Loading runs"]')).not.toHaveLength(0);
    expect(page.text()).not.toContain("No runs match the filter");
  });

  it("reads only the chosen environment's runs for loading and for no match", async () => {
    using _state = setup();
    twoEnvironments();
    state.others[0]!.runs = resource({ status: "error", error: new Error("timed out") });
    state.search = { environment: "env-3" };
    await using failed = await render(createElement(FactoryPage));
    expect(failed.text()).toContain("Could not refresh Laptop: timed out");
    expect(failed.text()).not.toContain("No runs match the filter");
    await failed.unmount();
    state.others[0]!.runs = resource({ data: { runs: [] } });
    state.runs = resource({ status: "loading" });
    await using empty = await render(createElement(FactoryPage));
    expect(empty.all('[aria-label="Loading runs"]')).toHaveLength(0);
    expect(empty.text()).toContain("No runs in the last week");
  });

  it("keeps the select of a filter that is on, so it can be cleared", async () => {
    using _state = setup();
    state.status = resource({ data: statusData({ attention: [ATTENTION] }) });
    state.runs = resource({ data: { runs: [runRow(), runRow({ id: "unparsed" })] } });
    state.search = { repo: "original-solutions/t3code-factory" };
    await using page = await render(createElement(FactoryPage));
    expect(runLinks(page)).toEqual([RUN_ID]);
    await pick("Repo", "All repos");
    expect(runLinks(page).toSorted()).toEqual([RUN_ID, "unparsed"].toSorted());
  });

  it("renders everything for an environment or repo that names nothing listed", async () => {
    using _state = setup();
    twoEnvironments();
    state.search = { environment: "env-9", repo: "nobody/nothing" };
    await using page = await render(createElement(FactoryPage));
    expect(environmentChoices(page)).toHaveLength(2);
    expect(runLinks(page)).toHaveLength(2);
    expect(page.text()).toContain("laptop run ended stuck");
    expect(page.text()).toContain("run ended stuck: the gate failed");
  });

  it("says no runs match when the filters hide every run, and Clear filters shows everything again", async () => {
    using _state = setup();
    twoEnvironments();
    state.search = { environment: "env-3", repo: "original-solutions/t3code-factory" };
    await using page = await render(createElement(FactoryPage));
    expect(runLinks(page)).toHaveLength(0);
    expect(page.text()).toContain("No runs match the filter");
    expect(page.button("Show all runs")).toBeDefined();
    await page.click(page.button("Clear filters")!);
    expect(state.navigations.at(-1)).toEqual({ to: "/factory", search: {}, replace: true });
    expect(runLinks(page)).toHaveLength(2);
    expect(page.text()).not.toContain("No runs match the filter");
    expect(page.button("Clear filters")).toBeUndefined();
  });

  it("has no Environment select with one environment and no Repo select with one repo", async () => {
    using _state = setup();
    state.status = resource({ data: statusData({ attention: [ATTENTION] }) });
    state.runs = resource({ data: { runs: [runRow(), runRow({ id: "unparsed" })] } });
    await using page = await render(createElement(FactoryPage));
    expect(page.all('[role="combobox"]')).toHaveLength(0);
    await page.unmount();
    twoEnvironments();
    state.others[0]!.status = resource({ data: statusData() });
    state.others[0]!.runs = resource({
      data: { runs: [runRow({ id: "original-solutions__t3code-factory__21__1" })] },
    });
    await using both = await render(createElement(FactoryPage));
    expect(
      both.all('[role="combobox"]').map((select) => select.getAttribute("aria-label")),
    ).toEqual(["Environment"]);
  });
});
