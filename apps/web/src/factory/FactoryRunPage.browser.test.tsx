import { createElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act } from "../../test/render";
import { __setFactoryApiForTests, FactoryApiError, type FactoryApi } from "./api";
import type { FactoryResource } from "./useFactoryData";
import { render, renderAt } from "./testing";

const state = vi.hoisted(() => ({ run: null as unknown, environmentId: "env-1" as string }));

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
}));
vi.mock("./useFactoryData", () => ({
  useFactoryRun: () => state.run,
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
  ...overrides,
});

const runPage = () =>
  createElement(FactoryRunPage, { environmentId: state.environmentId as never, runId: RUN_ID });
const mount = () => render(runPage());

function setup(): Disposable {
  state.environmentId = "env-1";
  state.run = resource({ data: detail() });
  return { [Symbol.dispose]: () => __setFactoryApiForTests() };
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

  it("shows an empty ledger without a thread or a gate", async () => {
    using _state = setup();
    state.run = resource({ data: detail([]) });
    await using page = await mount();
    expect(page.text()).toContain("no thread yet");
    expect(page.text()).toContain("No gate has run");
    expect(page.text()).toContain("No ledger entries");
    expect(page.button("Stop")!.disabled).toBe(true);
  });

  it("shows the run, its state and step, its thread link, gate output and ledger", async () => {
    using _state = setup();
    await using page = await mount();
    const text = page.text();
    expect(text).toContain(RUN_ID);
    expect(text).toContain("building");
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
    expect(text).toContain("26311");
    expect(text).toContain("session_launched");
    expect(text).toContain("thread-9");
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

  it("renders the relaunch message as plain text", async () => {
    using _state = setup();
    await using page = await mount();
    const pre = page.all("pre")[0]!;
    expect(pre.textContent).toBe("<b>tests failed</b> fix them");
    expect(pre.children).toHaveLength(0);
    expect(page.all("b")).toHaveLength(0);
  });

  it("notes a dropped last line and skipped lines", async () => {
    using _state = setup();
    state.run = resource({ data: detail(BUILDING, { truncated: true, skipped: 4 }) });
    await using page = await mount();
    const text = page.text();
    expect(text).toContain("The last line of the ledger was unreadable and was dropped.");
    expect(text).not.toContain("older entries");
    expect(text).toContain("4 unreadable lines skipped");
  });

  it("stops a building run, shows the answer and refreshes", async () => {
    using _state = setup();
    const refresh = vi.fn();
    state.run = resource({ data: detail(), refresh });
    const stopRun = vi.fn(async () => ({
      stopped: "o__r__1__1",
      already: false,
      message: "stop requested: the issue goes to factory:stuck",
    }));
    __setFactoryApiForTests(api({ stopRun }));
    await using page = await mount();
    expect(page.button("Stop")!.disabled).toBeFalsy();
    await page.click(page.button("Stop")!);
    expect(stopRun).toHaveBeenCalledWith("env-1", RUN_ID);
    expect(page.text()).toContain("stop requested");
    expect(refresh).toHaveBeenCalled();
  });

  it("disables Stop while a stop request is in flight, and enables it again after", async () => {
    using _state = setup();
    let resolve!: (value: Awaited<ReturnType<FactoryApi["stopRun"]>>) => void;
    const stopRun = vi.fn(
      () => new Promise<Awaited<ReturnType<FactoryApi["stopRun"]>>>((r) => (resolve = r)),
    );
    __setFactoryApiForTests(api({ stopRun }));
    await using page = await mount();
    await page.click(page.button("Stop")!);
    expect(page.button("Stop")!.disabled).toBe(true);
    await act(async () =>
      resolve({ stopped: "o__r__1__1", already: false, message: "stop requested" }),
    );
    expect(page.button("Stop")!.disabled).toBeFalsy();
  });

  it("shows the message of a run that is not building", async () => {
    using _state = setup();
    __setFactoryApiForTests(
      api({
        stopRun: async () => {
          throw new FactoryApiError(409, "not_building", "run is not building");
        },
      }),
    );
    await using page = await mount();
    await page.click(page.button("Stop")!);
    expect(page.text()).toContain("run is not building");
  });

  it("shows a stuck run's whole reason as text, and links its issue and pull request", async () => {
    using _state = setup();
    const reason = `the session stopped and said it was stuck <b>disk</b> ${"x".repeat(400)}`;
    state.run = resource({
      data: detail([
        ...BUILDING,
        entry("pr_opened", {
          pr: 31,
          url: "https://github.com/original-solutions/t3code-factory/pull/31",
        }),
        entry("stuck", { reason }),
        entry("state_changed", { from: "building", to: "stuck" }),
        entry("finished", { outcome: "stuck", pr_url: null }),
      ]),
    });
    await using page = await mount();
    const why = page.all("section").find((s) => s.textContent?.startsWith("Why it is stuck"));
    expect(why?.querySelector("p")?.textContent).toBe(reason);
    expect(page.all("b")).toHaveLength(0);
    const hrefs = page.all("a").map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("https://github.com/original-solutions/t3code-factory/issues/20");
    expect(hrefs).toContain("https://github.com/original-solutions/t3code-factory/pull/31");
  });

  it("shows the questions a needs-info run posted on its issue", async () => {
    using _state = setup();
    state.run = resource({
      data: detail([
        ...BUILDING,
        entry("questions_posted", { questions: "Which page should the link go on?" }),
        entry("state_changed", { from: "building", to: "needs-info" }),
      ]),
    });
    await using page = await mount();
    const why = page
      .all("section")
      .find((s) => s.textContent?.startsWith("Questions on the issue"));
    expect(why?.textContent).toContain("Which page should the link go on?");
  });

  it("shows how a finished run's pull request ended, and its step as finished", async () => {
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
    expect(page.all('[data-slot="badge"]')[0]?.textContent).toBe("closed");
    expect(page.text()).toContain("Step: finished");
    expect(page.text()).not.toContain("Step: pr-watching");
  });

  it("disables Stop for a run that is not building or is finished", async () => {
    using _state = setup();
    state.run = resource({
      data: detail([...BUILDING, entry("state_changed", { from: "building", to: "pr-open" })]),
    });
    await using prOpen = await mount();
    expect(prOpen.button("Stop")!.disabled).toBe(true);
    state.run = resource({ data: detail([...BUILDING, entry("finished", { outcome: "stuck" })]) });
    await using finished = await mount();
    expect(finished.button("Stop")!.disabled).toBe(true);
  });
});

describe.each([375, 1280])("FactoryRunPage at %i px", (width) => {
  const narrow = width < 640;
  const mountAt = () => renderAt(width, runPage());

  it(narrow ? "lists the gate commands and ledger, not tables" : "keeps the tables", async () => {
    using _state = setup();
    await using page = await mountAt();
    expect(page.all("table")).toHaveLength(narrow ? 0 : 2);
    const lists = page.all("ul").filter((ul) => ul.getAttribute("data-layout") === "list");
    expect(lists).toHaveLength(narrow ? 2 : 0);
    const text = page.text();
    for (const part of ["pnpm lint", "pnpm test", "412", "26311", "session_launched", "thread-9"]) {
      expect(text).toContain(part);
    }
    await page.unmount();
  });
});

describe("FactoryRunPage lists at 375 px", () => {
  it("makes a list item of each gate command and each ledger entry", async () => {
    using _state = setup();
    await using page = await renderAt(375, runPage());
    const items = page.all("li");
    // 2 gate commands, then one item per ledger entry.
    expect(items).toHaveLength(2 + BUILDING.length);
    expect(items[0]!.querySelectorAll("*").length).toBeGreaterThan(0);
    await page.unmount();
  });
});

describe.each([
  [639, true],
  [640, false],
])("FactoryRunPage at the 640 px breakpoint, %i px", (width, narrow) => {
  it(narrow ? "lists just below 640" : "keeps the tables from 640", async () => {
    using _state = setup();
    await using page = await renderAt(width, runPage());
    expect(page.all("table")).toHaveLength(narrow ? 0 : 2);
    const lists = page.all("ul").filter((ul) => ul.getAttribute("data-layout") === "list");
    expect(lists).toHaveLength(narrow ? 2 : 0);
    await page.unmount();
  });
});
