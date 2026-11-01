import { createElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { userEvent } from "vite-plus/test/browser";

import { act, fakeTimers } from "../../test/render";
import { __setFactoryApiForTests, FactoryApiError, type FactoryApi } from "./api";
import { __resetStopDeskForTests, STOP_GRACE_MS } from "./stopDesk";
import type { FactoryResource } from "./useFactoryData";
import { render, renderAt } from "./testing";

const state = vi.hoisted(() => ({
  run: null as unknown,
  gitHub: null as unknown,
  environmentId: "env-1" as string,
  // The history state the run page was opened with, and where it navigated since.
  history: {} as Record<string, unknown>,
  navigations: [] as Array<Record<string, unknown>>,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({
    to,
    params,
    search,
    state: linkState,
    children,
  }: {
    to: string;
    params?: Record<string, string>;
    search?: Record<string, string>;
    state?: Record<string, unknown>;
    children?: ReactNode;
  }) =>
    createElement(
      "a",
      {
        "data-to": to,
        "data-params": JSON.stringify(params ?? {}),
        "data-search": JSON.stringify(search ?? {}),
        "data-state": JSON.stringify(linkState ?? {}),
      },
      children,
    ),
  useRouterState: ({ select }: { select: (s: { location: { state: unknown } }) => unknown }) =>
    select({ location: { state: state.history } }),
  useNavigate: () => (options: Record<string, unknown>) => {
    state.navigations.push(options);
    return Promise.resolve();
  },
}));
vi.mock("./useFactoryData", () => ({
  readFactoryRunAhead: () => {},
  useFactoryRun: () => state.run,
  useFactoryRunGitHub: () => state.gitHub,
  useFactoryEnvironmentLabel: (environmentId: string) =>
    environmentId === "env-2" ? "Mac Studio" : environmentId,
}));

import { FactoryRunPage } from "./FactoryRunPage";

const RUN_ID = "original-solutions__t3code-factory__20__1";
let tick = 0;
const entry = (event: string, data: unknown) => ({
  ts: `2026-10-17T10:00:${String(tick++).padStart(2, "0")}.000Z`,
  ms: tick,
  event,
  data,
  cause: { step: "start", reason: "x" },
});

const BUILDING = [
  entry("claimed", { machine: "m", github_user: "u" }),
  entry("state_changed", { from: "ready", to: "triage" }),
  entry("session_launched", { thread_id: "thread-9", worktree: "/w", branch: "b" }),
  entry("state_changed", { from: "triage", to: "building" }),
  entry("step_changed", { step: "gate-checking" }),
  entry("gate_command", { attempt: 1, command: "pnpm lint", exit_code: 0, duration_ms: 412 }),
  entry("gate_command", { attempt: 1, command: "pnpm test", exit_code: 2, duration_ms: 26_311 }),
  entry("regate_relaunching", {
    attempt: 1,
    branch: "b",
    message: "<b>tests failed</b> fix them",
  }),
];

const resource = <T,>(overrides: Partial<FactoryResource<T>>): FactoryResource<T> => ({
  status: "ready",
  data: null,
  error: null,
  readAt: 0,
  dataAt: 0,
  refresh: vi.fn(),
  ...overrides,
});

const detail = (entries = BUILDING, extra: Record<string, unknown> = {}) => ({
  id: RUN_ID,
  entries,
  truncated: false,
  skipped: 0,
  ...extra,
});

const api = (overrides: Partial<FactoryApi>): FactoryApi => ({
  status: vi.fn(),
  runs: vi.fn(),
  run: vi.fn(),
  stopRun: vi.fn(),
  pauseClaims: vi.fn(),
  resumeClaims: vi.fn(),
  dismissAttention: vi.fn(),
  restoreAttention: vi.fn(),
  runGitHub: vi.fn(),
  queue: vi.fn(),
  snoozeDeploy: vi.fn(),
  deployNow: vi.fn(),
  ...overrides,
});

const runPage = () =>
  createElement(FactoryRunPage, { environmentId: state.environmentId as never, runId: RUN_ID });
const mount = () => render(runPage());

type Page = Awaited<ReturnType<typeof render>>;
const showPart = (page: Page, tab: string) => page.click(page.all(`button[data-tab="${tab}"]`)[0]!);
const openLedger = (page: Page) => showPart(page, "ledger");
const shownPart = (page: Page) => page.all("[data-panel]")[0]?.dataset.panel;

function setup(): Disposable {
  state.environmentId = "env-1";
  state.run = resource({ data: detail() });
  state.gitHub = resource({ data: { id: RUN_ID, issue: null, pr: null } });
  state.history = {};
  state.navigations = [];
  return {
    [Symbol.dispose]: () => {
      __setFactoryApiForTests();
      __resetStopDeskForTests();
    },
  };
}

describe("FactoryRunPage", () => {
  it("shows a loading state", async () => {
    using _state = setup();
    state.run = resource({ status: "loading" });
    await using page = await mount();
    expect(page.all('[aria-label="Loading run"]')).not.toHaveLength(0);
    expect(page.text()).not.toContain("Ledger");
  });

  it("says there is no such run for a 404", async () => {
    using _state = setup();
    state.run = resource({
      status: "error",
      error: new FactoryApiError(404, "run_not_found", "no such run"),
    });
    await using page = await mount();
    expect(page.text()).toContain(`No run ${RUN_ID}`);
  });

  it("shows any other error with its message and retries", async () => {
    using _state = setup();
    const refresh = vi.fn();
    state.run = resource({
      status: "error",
      error: new FactoryApiError(500, "factory_error", "ledger exploded"),
      refresh,
    });
    await using page = await mount();
    expect(page.text()).toContain("ledger exploded");
    await page.click(page.button("Retry")!);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("keeps a run whose refresh failed under a notice saying it may be stale", async () => {
    using _state = setup();
    const refresh = vi.fn();
    state.run = resource({
      status: "error",
      data: detail(),
      dataAt: new Date(2026, 9, 27, 14, 5).getTime(),
      error: new FactoryApiError(0, "timeout", "no answer in 15 seconds"),
      refresh,
    });
    await using page = await mount();
    expect(page.text()).toContain("is not answering");
    expect(page.text()).toContain("Showing what it said at 14:05");
    expect(page.text()).toContain("gate-checking");
    await page.click(page.button("Retry")!);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("shows an empty ledger without a thread or a gate", async () => {
    using _state = setup();
    state.run = resource({ data: detail([]) });
    await using page = await mount();
    expect(page.all("a").some((a) => a.textContent === "Thread")).toBe(false);
    expect(page.all('button[data-tab="gate"]')).toHaveLength(0);
    expect(page.text()).toContain("Nothing has happened yet");
    await openLedger(page);
    expect(page.text()).toContain("No ledger entries");
    expect(page.button("Stop")).toBeUndefined();
  });

  it("shows the run, its state and step, its thread link, gate output and ledger", async () => {
    using _state = setup();
    await using page = await mount();
    const text = page.text();
    expect(text).toContain(RUN_ID);
    expect(text).toContain("Building");
    expect(text).toContain("gate-checking");
    const thread = page
      .all("a")
      .find((a) => a.getAttribute("data-to") === "/$environmentId/$threadId");
    expect(JSON.parse(thread!.getAttribute("data-params")!)).toEqual({
      environmentId: "env-1",
      threadId: "thread-9",
    });
    const back = page.all("a").find((a) => a.getAttribute("data-to") === "/factory");
    expect(back).toBeDefined();
    expect(text).toContain("pnpm lint");
    expect(text).toContain("pnpm test");
    expect(text).toContain("exit 2 · 26s");
    // A building run opens on its timeline; the gate and the raw ledger are a tap away.
    expect(shownPart(page)).toBe("timeline");
    expect(page.all('button[data-tab="ledger"]')[0]!.textContent).toBe("Ledger8");
    expect(text).not.toContain("session_launched");
    await showPart(page, "gate");
    expect(page.text()).toContain("Last gate output");
    await openLedger(page);
    expect(page.text()).toContain("session_launched");
    expect(page.text()).toContain("thread-9");
  });

  it("tells the run as a timeline, folding each gate run into one step", async () => {
    using _state = setup();
    await using page = await mount();
    const steps = page.all("li[data-tone]");
    expect(steps.map((li) => li.getAttribute("data-tone"))).toEqual([
      "claimed",
      "building",
      "stuck",
    ]);
    expect(steps[2]!.textContent).toContain("Gate failed");
    expect(steps[2]!.textContent).toContain("pnpm testexit 2 · 26s");
    const thread = steps[1]!.querySelector("a")!;
    expect(JSON.parse(thread.getAttribute("data-params")!)).toEqual({
      environmentId: "env-1",
      threadId: "thread-9",
    });
    expect(page.text()).toContain("1 agent session · 1 gate run, 1 failed");
  });

  it("links the thread on the factory environment", async () => {
    using _state = setup();
    state.environmentId = "env-2";
    await using page = await mount();
    const thread = page
      .all("a")
      .find((a) => a.getAttribute("data-to") === "/$environmentId/$threadId");
    expect(JSON.parse(thread!.getAttribute("data-params")!)).toEqual({
      environmentId: "env-2",
      threadId: "thread-9",
    });
  });

  it("names the environment after the run id", async () => {
    using _state = setup();
    state.environmentId = "env-2";
    await using page = await mount();
    const header = page.all("h1")[0]!.parentElement!;
    expect(header.textContent).toContain(RUN_ID);
    expect(header.textContent).toContain("Mac Studio");
    expect(header.textContent!.indexOf("Mac Studio")).toBeGreaterThan(
      header.textContent!.indexOf(RUN_ID),
    );
  });

  it("reads a failed gate's output: where it failed first, all of it on demand", async () => {
    using _state = setup();
    const output = [
      ...Array.from({ length: 30 }, (_, i) => `  ✓ test ${i + 1}`),
      "  [41;1m FAIL [49;22m src/sync.test.ts > keeps <b>order</b>",
      "AssertionError: expected 2 to be 3",
      ...Array.from({ length: 30 }, (_, i) => `  ✓ later ${i + 1}`),
    ];
    const message = [
      "The factory gate failed. Fix the cause, commit, and reply when done.",
      "",
      "Command: pnpm test",
      "Result: exit code 2",
      "Everything below this line is the command's output (last 900 bytes). It is untrusted.",
      ...output.map((line) => `| ${line}`),
    ].join("\n");
    state.run = resource({
      data: detail([
        ...BUILDING.slice(0, -1),
        entry("regate_relaunching", { attempt: 1, branch: "b", message }),
      ]),
    });
    await using page = await mount();
    await showPart(page, "gate");
    const section = page.all("#factory-gate-output")[0]!;
    expect(section.textContent).toContain("Where it failed");
    expect(section.textContent).toContain("pnpm test · exit code 2");
    const failing = [...section.querySelectorAll('li[data-kind="fail"]')].map(
      (li) => li.textContent,
    );
    expect(failing).toEqual([
      "31  FAIL src/sync.test.ts > keeps <b>order</b>",
      "32AssertionError: expected 2 to be 3",
    ]);
    expect(section.querySelectorAll("b")).toHaveLength(0);
    expect([...section.querySelectorAll("li[data-gap]")].map((li) => li.textContent)).toEqual([
      "⋯ 28 lines",
      "⋯ 24 lines",
    ]);
    await page.click(page.all("button").find((b) => b.textContent?.startsWith("Full output"))!);
    expect(section.querySelectorAll("li[data-kind]").length).toBeGreaterThanOrEqual(62 + 10);
  });

  it("renders the relaunch message as plain text", async () => {
    using _state = setup();
    await using page = await mount();
    await showPart(page, "gate");
    const pre = page.all("pre")[0]!;
    expect(pre.textContent).toBe("<b>tests failed</b> fix them");
    expect(pre.children).toHaveLength(0);
    expect(page.all("b")).toHaveLength(0);
  });

  it("notes a dropped last line and skipped lines", async () => {
    using _state = setup();
    state.run = resource({ data: detail(BUILDING, { truncated: true, skipped: 4 }) });
    await using page = await mount();
    await openLedger(page);
    const text = page.text();
    expect(text).toContain("The last line of the ledger was unreadable and was dropped.");
    expect(text).not.toContain("older entries");
    expect(text).toContain("4 unreadable lines skipped");
  });

  it("holds a Stop with Undo, and Undo keeps the run building", async () => {
    using _state = setup();
    const stopRun = vi.fn();
    __setFactoryApiForTests(api({ stopRun }));
    await using page = await mount();
    await page.click(page.button("Stop")!);
    expect(page.button("Stop")).toBeUndefined();
    await page.click(page.button("Undo stop")!);
    expect(page.button("Stop")!.disabled).toBeFalsy();
    expect(stopRun).not.toHaveBeenCalled();
  });

  it("sends the stop once its grace is over, and reads the run again", async () => {
    using _state = setup();
    const refresh = vi.fn();
    state.run = resource({ data: detail(), refresh });
    let resolve!: (value: Awaited<ReturnType<FactoryApi["stopRun"]>>) => void;
    const stopRun = vi.fn(
      () => new Promise<Awaited<ReturnType<FactoryApi["stopRun"]>>>((r) => (resolve = r)),
    );
    __setFactoryApiForTests(api({ stopRun }));
    await using page = await mount();
    using _timers = fakeTimers();
    await page.click(page.button("Stop")!);
    await act(() => vi.advanceTimersByTimeAsync(STOP_GRACE_MS));
    expect(stopRun).toHaveBeenCalledWith("env-1", RUN_ID);
    expect(page.button("Stopping")!.disabled).toBe(true);
    await act(async () =>
      resolve({ stopped: "o__r__1__1", already: false, message: "stop requested" }),
    );
    expect(refresh).toHaveBeenCalled();
  });

  it("puts a stuck run's fix, its place to start and the label to set back above the timeline", async () => {
    using _state = setup();
    const said = `<b>disk</b> ${"x".repeat(400)}`;
    state.run = resource({
      data: detail([
        ...BUILDING,
        entry("pr_opened", {
          pr: 31,
          url: "https://github.com/original-solutions/t3code-factory/pull/31",
        }),
        entry("stuck", { reason: `the session stopped and said it was stuck\n\n${said}` }),
        entry("state_changed", { from: "building", to: "stuck" }),
        entry("finished", { outcome: "stuck", pr_url: null }),
      ]),
    });
    await using page = await mount();
    const card = page.all('section[aria-label="Next step"]')[0]!;
    expect(card.querySelector("h2")?.textContent).toBe("The session stopped and said it was stuck");
    expect(card.textContent).toContain(said);
    expect(card.textContent).toContain("A new run continues PR #31 on its branch.");
    expect(page.all("b")).toHaveLength(0);
    const links = Array.from(card.querySelectorAll("a"));
    const thread = links.find((a) => a.textContent === "Open the session's thread");
    expect(JSON.parse(thread!.getAttribute("data-params")!)).toEqual({
      environmentId: "env-1",
      threadId: "thread-9",
    });
    expect(links.find((a) => a.textContent === "Open #20")?.getAttribute("href")).toBe(
      "https://github.com/original-solutions/t3code-factory/issues/20",
    );
    expect(card.compareDocumentPosition(page.all('section[aria-label="Timeline"]')[0]!)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    const hrefs = page.all("a").map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("https://github.com/original-solutions/t3code-factory/pull/31");
  });

  it("shows a needs-info run's questions with the way to answer them", async () => {
    using _state = setup();
    state.run = resource({
      data: detail([
        ...BUILDING,
        entry("questions_posted", { questions: "Which page should the link go on?" }),
        entry("state_changed", { from: "building", to: "needs-info" }),
      ]),
    });
    await using page = await mount();
    const card = page.all('section[aria-label="Next step"]')[0]!;
    expect(card.getAttribute("data-next-step")).toBe("needs-info");
    expect(card.textContent).toContain("Which page should the link go on?");
    const answer = Array.from(card.querySelectorAll("a")).find(
      (a) => a.textContent === "Answer on #20",
    );
    expect(answer?.getAttribute("href")).toBe(
      "https://github.com/original-solutions/t3code-factory/issues/20",
    );
  });

  it("gives each of a needs-info run's questions an answer box, keeps the drafts and copies the reply", async () => {
    using _state = setup();
    const draft = `factory.answers.env-1/${RUN_ID}`;
    using _draft = { [Symbol.dispose]: () => localStorage.removeItem(draft) };
    state.run = resource({
      data: detail([
        ...BUILDING,
        entry("questions_posted", {
          questions: "Stopped.\n\n**Questions**\n\n1. Which page?\n2. Which colour?",
        }),
        entry("state_changed", { from: "building", to: "needs-info" }),
      ]),
    });
    {
      await using page = await mount();
      const card = page.all('section[aria-label="Next step"]')[0]!;
      expect(card.textContent).toContain("Answer its 2 questions here");
      const copy = page.button("Copy the reply")!;
      expect(copy.disabled).toBe(true);
      await userEvent.type(page.all('[aria-label="Your answer to question 2"]')[0]!, "Blue");
      expect(card.textContent).toContain("1 of 2 answered");
    }
    await using page = await mount();
    const box = page.all('[aria-label="Your answer to question 2"]')[0] as HTMLTextAreaElement;
    expect(box.value).toBe("Blue");
    using writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    await page.click(page.button("Copy the reply")!);
    await vi.waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("> **2.** Which colour?\n\nBlue\n"),
    );
    expect(page.text()).toContain("Paste it into a comment on #20.");
  });

  it("shows how a finished run's pull request ended, with no step left to name", async () => {
    using _state = setup();
    state.run = resource({
      data: detail([
        ...BUILDING,
        entry("pr_opened", { pr: 31, url: "https://github.com/o/r/pull/31" }),
        entry("state_changed", { from: "building", to: "pr-open" }),
        entry("step_changed", { step: "pr-watching" }),
        entry("finished", { outcome: "pr-open", pr_end: "closed" }),
      ]),
    });
    await using page = await mount();
    expect(page.all('[data-slot="badge"]')[0]?.textContent).toBe("Closed");
    expect(page.text()).not.toContain("Step:");
    expect(shownPart(page)).toBe("github");
  });

  it("opens a run stuck on its gate on the gate output, and the fix's button comes back to it", async () => {
    using _state = setup();
    state.run = resource({
      data: detail([
        ...BUILDING,
        entry("stuck", { reason: "the gate failed after 3 attempts" }),
        entry("state_changed", { from: "building", to: "stuck" }),
        entry("finished", { outcome: "stuck" }),
      ]),
    });
    await using page = await mount();
    expect(shownPart(page)).toBe("gate");
    await showPart(page, "timeline");
    expect(page.all("#factory-gate-output")).toHaveLength(0);
    await page.click(page.button("Show the gate output")!);
    expect(shownPart(page)).toBe("gate");
    expect(page.all("#factory-gate-output")).toHaveLength(1);
  });

  it("shows Stop only while the run is building and not finished", async () => {
    using _state = setup();
    state.run = resource({
      data: detail([...BUILDING, entry("state_changed", { from: "building", to: "pr-open" })]),
    });
    await using prOpen = await mount();
    expect(prOpen.button("Stop")).toBeUndefined();
    state.run = resource({ data: detail([...BUILDING, entry("finished", { outcome: "stuck" })]) });
    await using finished = await mount();
    expect(finished.button("Stop")).toBeUndefined();
  });
});

describe.each([375, 1280])("FactoryRunPage at %i px", (width) => {
  const narrow = width < 640;
  const mountAt = () => renderAt(width, runPage());

  it(narrow ? "lists the ledger, not a table" : "keeps the ledger table", async () => {
    using _state = setup();
    await using page = await mountAt();
    for (const part of ["pnpm lint", "pnpm test", "0.4s", "exit 2 · 26s"]) {
      expect(page.text()).toContain(part);
    }
    await openLedger(page);
    expect(page.all("table")).toHaveLength(narrow ? 0 : 1);
    const lists = page.all("ul").filter((ul) => ul.getAttribute("data-layout") === "list");
    expect(lists).toHaveLength(narrow ? 1 : 0);
    for (const part of ["session_launched", "thread-9"]) {
      expect(page.text()).toContain(part);
    }
    await page.unmount();
  });
});

describe("FactoryRunPage lists at 375 px", () => {
  it("makes a list item of each ledger entry", async () => {
    using _state = setup();
    await using page = await renderAt(375, runPage());
    await openLedger(page);
    const items = page.all('ul[data-layout="list"] > li');
    expect(items).toHaveLength(BUILDING.length);
    expect(items[0]!.querySelectorAll("*").length).toBeGreaterThan(0);
    await page.unmount();
  });
});

describe.each([
  [639, true],
  [640, false],
])("FactoryRunPage at the 640 px breakpoint, %i px", (width, narrow) => {
  it(narrow ? "lists just below 640" : "keeps the table from 640", async () => {
    using _state = setup();
    await using page = await renderAt(width, runPage());
    await openLedger(page);
    expect(page.all("table")).toHaveLength(narrow ? 0 : 1);
    const lists = page.all("ul").filter((ul) => ul.getAttribute("data-layout") === "list");
    expect(lists).toHaveLength(narrow ? 1 : 0);
    await page.unmount();
  });
});

describe("FactoryRunPage opened from a list", () => {
  const queue = {
    search: { runs: "attention", repo: "original-solutions/t3code-factory" },
    query: "sync",
    runs: [
      { environmentId: "env-2", runId: "before__x__1__1", title: "The one before" },
      { environmentId: "env-1", runId: RUN_ID, title: "Sync fails checks" },
      { environmentId: "env-1", runId: "after__x__2__1", title: null },
    ],
  };
  const stepper = (page: Page) => page.all('[role="group"][aria-label="Runs list"]')[0];

  it("titles the page with the run's title and says where it sits in the list", async () => {
    using _state = setup();
    state.history = { factoryRunQueue: queue };
    await using page = await mount();
    expect(page.all("h1")[0]!.textContent).toBe("Sync fails checks");
    expect(stepper(page)?.textContent).toContain("2");
    expect(stepper(page)?.textContent).toContain("3");
    const back = page.all('a[data-to="/factory"]')[0]!;
    expect(JSON.parse(back.dataset.search!)).toEqual(queue.search);
    expect(JSON.parse(back.dataset.state!)).toEqual({
      factoryReturn: { query: "sync", focus: `env-1 ${RUN_ID}` },
    });
  });

  it("steps with j and k, replacing the entry and keeping the list, and goes back with Escape", async () => {
    using _state = setup();
    state.history = { factoryRunQueue: queue };
    await using _page = await mount();
    await userEvent.keyboard("j");
    await userEvent.keyboard("k");
    await userEvent.keyboard("{Escape}");
    expect(state.navigations).toEqual([
      {
        to: "/factory/$environmentId/$runId",
        params: { environmentId: "env-1", runId: "after__x__2__1" },
        state: { factoryRunQueue: queue },
        replace: true,
      },
      {
        to: "/factory/$environmentId/$runId",
        params: { environmentId: "env-2", runId: "before__x__1__1" },
        state: { factoryRunQueue: queue },
        replace: true,
      },
      {
        to: "/factory",
        search: queue.search,
        state: { factoryReturn: { query: "sync", focus: `env-1 ${RUN_ID}` } },
      },
    ]);
  });

  it("stops at the ends of the list", async () => {
    using _state = setup();
    state.history = { factoryRunQueue: { ...queue, runs: queue.runs.slice(1, 2) } };
    await using page = await mount();
    const button = (label: string) =>
      page.all("button").find((b) => b.getAttribute("aria-label") === label)!;
    expect(button("Previous run").disabled).toBe(true);
    expect(button("Next run").disabled).toBe(true);
    await userEvent.keyboard("jk");
    expect(state.navigations).toEqual([]);
  });

  it("has no stepper and goes back to the whole list when opened from no list", async () => {
    using _state = setup();
    await using page = await mount();
    expect(stepper(page)).toBeUndefined();
    expect(page.all("h1")[0]!.textContent).toBe(RUN_ID);
    await userEvent.keyboard("j{Escape}");
    expect(state.navigations).toEqual([{ to: "/factory", search: {}, state: {} }]);
  });

  it("reads the run's issue and pull request on the page: the ask, the files that changed most, the description", async () => {
    using _state = setup();
    state.run = resource({
      data: detail([
        ...BUILDING,
        entry("pr_opened", { pr: 31, url: "https://github.com/o/r/pull/31" }),
      ]),
    });
    state.gitHub = resource({
      data: {
        id: RUN_ID,
        issue: {
          kind: "ok",
          number: 20,
          title: "Sync keeps failing",
          body: "## Why\nThe **sync** drops rows.",
          body_cut: false,
          author: "tom",
          labels: ["factory:building", "bug"].filter((l) => !l.startsWith("factory:")),
          closed: false,
        },
        pr: {
          kind: "ok",
          number: 31,
          title: "fix: sync keeps rows",
          body: "",
          body_cut: false,
          state: "draft",
          additions: 40,
          deletions: 2,
          changed_files: 8,
          review_decision: "changes_requested",
          files: [
            { path: "src/a.ts", additions: 1, deletions: 0 },
            { path: "src/sync/rows.ts", additions: 30, deletions: 2 },
          ],
        },
      },
    });
    // The body renders through a lazy ChatMarkdown; load it first so its import never races the wait.
    await import("~/components/ChatMarkdown");
    await using page = await mount();
    await showPart(page, "github");
    const issue = page.all('[aria-label="The issue"]')[0]!;
    expect(issue.textContent).toContain("The ask · issue #20 by tom");
    expect(issue.textContent).toContain("Sync keeps failing");
    await vi.waitFor(() => expect(issue.querySelector("strong")?.textContent).toBe("sync"));
    const pr = page.all('[aria-label="The pull request"]')[0]!;
    expect(pr.textContent).toContain("Changes requested");
    expect(pr.textContent).toContain("across 8 files");
    const files = [...pr.querySelectorAll('[aria-label="Files that changed most"] li')].map(
      (li) => li.textContent,
    );
    expect(files).toEqual(["src/sync/rows.ts+30 −2", "src/a.ts+1 −0", "and 6 more files"]);
    expect(pr.textContent).toContain("The pull request has no description.");
  });

  it("says in one line when GitHub can't be read, and links out instead", async () => {
    using _state = setup();
    state.gitHub = resource({
      data: { id: RUN_ID, issue: { kind: "signed-out", message: "x" }, pr: null },
    });
    await using page = await mount();
    await showPart(page, "github");
    const card = page.all('[aria-label="GitHub"]')[0]!;
    expect(card.textContent).toContain("GitHub can't be read from env-1");
    expect(card.textContent).toContain("isn't signed in here");
    expect(card.querySelector("a")?.getAttribute("href")).toBe(
      "https://github.com/original-solutions/t3code-factory/issues/20",
    );
    expect(page.button("Try again")).toBeUndefined();
  });
});
