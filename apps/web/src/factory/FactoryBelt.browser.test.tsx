import type { EnvironmentId } from "@t3tools/contracts";
import { createElement, type ComponentProps, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page as browser, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { act, fakeTimers } from "../../test/render";
import { __setFactoryApiForTests, FactoryApiError, type FactoryApi } from "./api";
import type { FactoryRunRow, FactoryStatus } from "./api";
import { render } from "./testing";
import type { FactoryEnvironment, FactoryResource } from "./useFactoryData";

// The real belt over props, with real layout: the stylesheet is loaded and the viewport is set, so
// what wraps, scrolls and stacks is what the browser makes of it. Only the router's Link is
// replaced, by an anchor that keeps its classes and says where it leads.
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({
    to,
    params,
    search,
    children,
    ...rest
  }: {
    to: string;
    params?: Record<string, string>;
    search?: Record<string, string>;
    children?: ReactNode;
  }) =>
    createElement(
      "a",
      {
        ...rest,
        "data-to": to,
        "data-params": JSON.stringify(params ?? {}),
        "data-search": JSON.stringify(search ?? {}),
      },
      children,
    ),
}));

import { FactoryBelt } from "./FactoryBelt";

type Belt = ComponentProps<typeof FactoryBelt>;

const DESKTOP = "env-desktop" as EnvironmentId;
const STUDIO = "env-studio" as EnvironmentId;

/** A local time, so the day the belt calls today is the viewer's whatever zone the test runs in. */
const at = (hour: number, minute = 0, dayOffset = 0) =>
  new Date(2026, 9, 27 + dayOffset, hour, minute).getTime();
const iso = (ms: number) => new Date(ms).toISOString();
const NOW = at(15);

const resource = <T,>(overrides: Partial<FactoryResource<T>>): FactoryResource<T> => ({
  status: "ready",
  data: null,
  error: null,
  readAt: NOW,
  refresh: vi.fn(),
  ...overrides,
});

type StatusRun = FactoryStatus["runs"][number];
const statusRun = (issue: number, overrides: Partial<StatusRun> = {}): StatusRun => ({
  id: runId(issue),
  state: "building",
  last_event: "step_changed",
  title: `Title of ${issue}`,
  user: null,
  for_ms: 3_600_000,
  pr_url: null,
  thread_id: null,
  unreadable: false,
  ...overrides,
});

const statusData = (
  runs: ReadonlyArray<StatusRun> = [],
  overrides: Partial<FactoryStatus> = {},
): FactoryStatus => ({
  state: "running",
  reason: null,
  paused_by_hand: null,
  runs,
  attention: [],
  slots: { used: 1, max: 2 },
  passes: { at: iso(NOW - 12_000), poll_seconds: 60, running: false },
  problems: [],
  ...overrides,
});

function runId(issue: number, attempt = 1) {
  return `acme__widgets__${issue}__${attempt}`;
}

const recentRow = (issue: number, overrides: Partial<FactoryRunRow> = {}): FactoryRunRow => ({
  id: runId(issue),
  started_ts: iso(at(10)),
  state: "building",
  last_event: "step_changed",
  step: "launch-sending",
  status: "running",
  pr_url: null,
  finished: false,
  total_ms: null,
  unreadable: false,
  title: `Title of ${issue}`,
  reason: null,
  ...overrides,
});

const doneRow = (issue: number, end: "merged" | "closed", finishedAt: number): FactoryRunRow =>
  recentRow(issue, {
    state: "pr-open",
    finished: true,
    status: "finished",
    pr_end: end,
    started_ts: iso(finishedAt - 3_600_000),
    total_ms: 3_600_000,
  });

const environment = (
  environmentId: EnvironmentId,
  label: string,
  runs: ReadonlyArray<StatusRun> = [],
  status: Partial<FactoryStatus> = {},
): FactoryEnvironment => ({
  environmentId,
  label,
  status: resource({ data: statusData(runs, status) }),
});

const recentOf = (
  ...entries: ReadonlyArray<readonly [EnvironmentId, ReadonlyArray<FactoryRunRow>]>
): Belt["recent"] =>
  new Map(entries.map(([id, runs]) => [id, resource({ data: { runs } })] as const));

const props = (overrides: Partial<Belt> = {}): Belt => {
  const desktop = environment(DESKTOP, "Desktop");
  return {
    environments: [desktop],
    recent: recentOf([DESKTOP, []]),
    busy: new Set(),
    nowMs: NOW,
    onTogglePause: vi.fn(),
    attention: [],
    showEnvironment: false,
    onDismiss: vi.fn(),
    ...overrides,
  };
};

type Page = Awaited<ReturnType<typeof render>>;

const station = (page: Page, name: string) =>
  page.all("button[data-station]").find((post) => post.dataset.station === name)!;
const lane = (page: Page, name: string) =>
  page.all("[data-lane]").find((node) => node.dataset.lane === name)!;
const readout = (page: Page) => page.all("section[data-readout]")[0];
const tilesOf = (node: Element) => Array.from(node.querySelectorAll("a"));
const countOf = (post: Element) => post.querySelector("[data-part=count]")?.textContent;
const paramsOf = (link: Element) =>
  JSON.parse(link.getAttribute("data-params")!) as Record<string, string>;
const runLinksIn = (node: Element) =>
  Array.from(node.querySelectorAll("a")).filter(
    (a) => a.getAttribute("data-to") === "/factory/$environmentId/$runId",
  );
const rowsOf = (page: Page) => Array.from(readout(page)?.querySelectorAll("tbody tr") ?? []);
const stat = (page: Page, label: string) => {
  const term = page.all("dt").find((dt) => dt.textContent === label)!;
  return term.nextElementSibling?.textContent;
};
/** Opens a post's readout, unless it is the one open: picking that one would fold it. */
const openStation = async (page: Page, name: string) => {
  if (readout(page)?.dataset.station !== name) await page.click(station(page, name));
};
const claimsSwitch = (page: Page) => page.all('[role="switch"]')[0]!;
const clock = (ms: number) =>
  `${String(new Date(ms).getHours()).padStart(2, "0")}:${String(new Date(ms).getMinutes()).padStart(2, "0")}`;

const api = (overrides: Partial<FactoryApi>): FactoryApi => ({
  status: vi.fn(),
  runs: vi.fn(),
  run: vi.fn(),
  stopRun: vi.fn(),
  pauseClaims: vi.fn(),
  resumeClaims: vi.fn(),
  dismissAttention: vi.fn(),
  snoozeDeploy: vi.fn(),
  deployNow: vi.fn(),
  ...overrides,
});

async function setup(width = 1440): Promise<Disposable> {
  vi.setSystemTime(NOW);
  await browser.viewport(width, 900);
  return {
    [Symbol.dispose]() {
      __setFactoryApiForTests();
      vi.useRealTimers();
    },
  };
}

/** Desktop: one run per station and two on PR open; Studio: one on PR open and one in Building. */
const twoEnvironments = (): Belt => {
  const desktop = environment(DESKTOP, "Desktop", [
    statusRun(1, { state: "triage", last_event: "claimed", for_ms: 20_000 }),
    statusRun(2, { for_ms: 2_400_000 }),
    statusRun(3, { last_event: "gate_command", for_ms: 840_000 }),
    statusRun(4, { state: "pr-open", for_ms: 3_600_000 }),
    statusRun(5, { state: "pr-open", for_ms: 18_000_000 }),
  ]);
  const studio = environment(STUDIO, "Studio", [
    statusRun(6, { state: "pr-open", for_ms: 7_200_000 }),
    statusRun(7, { for_ms: 600_000 }),
  ]);
  return props({
    environments: [desktop, studio],
    showEnvironment: true,
    recent: recentOf(
      [
        DESKTOP,
        [
          recentRow(1, { started_ts: iso(at(14, 40)), step: null, state: "triage" }),
          recentRow(2, { started_ts: iso(at(12)) }),
          recentRow(3, { started_ts: iso(at(13)), step: "gate-sending" }),
          recentRow(4, {
            started_ts: iso(at(11)),
            step: null,
            state: "pr-open",
            pr_url: "https://github.com/acme/widgets/pull/40",
          }),
          recentRow(5, { started_ts: iso(at(9)), state: "pr-open" }),
          doneRow(10, "merged", at(13, 30)),
          doneRow(11, "closed", at(12, 30)),
          doneRow(12, "merged", at(11, 30)),
          doneRow(13, "merged", at(10, 30)),
          // Finished yesterday: not today's.
          doneRow(14, "merged", at(10, 0, -1)),
        ],
      ],
      [
        STUDIO,
        [
          recentRow(6, { started_ts: iso(at(8)), state: "pr-open" }),
          recentRow(7, { started_ts: iso(at(14, 30)) }),
        ],
      ],
    ),
  });
};

describe("the belt's posts and tiles", () => {
  it("names five posts with their labels and counts the runs of every environment", async () => {
    using _state = await setup();
    await using page = await render(createElement(FactoryBelt, twoEnvironments()));
    expect(
      ["claimed", "building", "gate", "pr", "done"].map((name) => [
        name,
        countOf(station(page, name)),
      ]),
    ).toEqual([
      ["claimed", "1"],
      ["building", "2"],
      ["gate", "1"],
      ["pr", "3"],
      ["done", "4"],
    ]);
    const text = (name: string) => station(page, name).textContent ?? "";
    expect(text("claimed")).toContain("Claimed");
    expect(text("claimed")).toContain("factory:triage");
    expect(text("building")).toContain("Building");
    expect(text("building")).toContain("factory:building");
    expect(text("gate")).toContain("Gate");
    expect(text("gate")).toContain("gate-sending");
    expect(text("pr")).toContain("PR open");
    expect(text("pr")).toContain("factory:pr-open");
    expect(text("done")).toContain("Done");
    expect(text("done")).toContain("pr_end: merged · closed");
  });

  it("shows each run as a tile with its issue, environment and elapsed time, and no title", async () => {
    using _state = await setup();
    await using page = await render(createElement(FactoryBelt, twoEnvironments()));
    const tile = tilesOf(lane(page, "gate"))[0]!;
    expect(tile.textContent).toContain("#3");
    expect(tile.textContent).toContain("14m");
    expect(tile.textContent).not.toContain("Title of 3");
    expect(tile.getAttribute("data-to")).toBe("/factory/$environmentId/$runId");
    expect(paramsOf(tile)).toEqual({ environmentId: DESKTOP, runId: runId(3) });
    // Newest start first, across environments.
    expect(tilesOf(lane(page, "pr")).map((a) => a.textContent?.slice(0, 2))).toEqual([
      "#4",
      "#5",
      "#6",
    ]);
  });

  it("draws the selected environment's tiles solid and the others hollow, and follows the pick", async () => {
    using _state = await setup();
    await using page = await render(createElement(FactoryBelt, twoEnvironments()));
    const style = (issue: number) => {
      const tile = tilesOf(lane(page, "pr")).find((a) => a.textContent?.startsWith(`#${issue}`))!;
      const css = getComputedStyle(tile);
      return { border: css.borderLeftStyle, background: css.backgroundColor };
    };
    expect(style(4).border).toBe("solid");
    expect(style(4).background).not.toBe("rgba(0, 0, 0, 0)");
    expect(style(6).border).toBe("dashed");
    expect(style(6).background).toBe("rgba(0, 0, 0, 0)");
    await page.click(page.all("button").find((b) => b.textContent?.startsWith("Studio"))!);
    expect(style(6).border).toBe("solid");
    expect(style(4).border).toBe("dashed");
  });

  it("lists the environments in a segmented control with their slots, the first picked", async () => {
    using _state = await setup();
    const belt = twoEnvironments();
    await using page = await render(createElement(FactoryBelt, belt));
    const choices = page.all('[aria-label="Environments"] button');
    expect(choices.map((choice) => choice.textContent)).toEqual([
      expect.stringContaining("Desktop"),
      expect.stringContaining("Studio"),
    ]);
    expect(choices[0]!.textContent).toContain("1/2");
    expect(choices.map((choice) => choice.getAttribute("aria-pressed"))).toEqual(["true", "false"]);
    await page.click(choices[1]!);
    expect(
      page
        .all('[aria-label="Environments"] button')
        .map((choice) => choice.getAttribute("aria-pressed")),
    ).toEqual(["false", "true"]);
  });

  it("makes the Done post's lane a bin: the count, merged and closed, and the latest three", async () => {
    using _state = await setup();
    await using page = await render(createElement(FactoryBelt, twoEnvironments()));
    const bin = lane(page, "done");
    expect(bin.textContent).toContain("4");
    expect(bin.textContent).toContain("3 merged · 1 closed");
    expect(bin.textContent).toContain("#10 · #11 · #12");
    expect(tilesOf(bin)).toHaveLength(0);
  });

  it("counts a run done today by when it finished, not when it began", async () => {
    using _state = await setup();
    const desktop = environment(DESKTOP, "Desktop");
    await using page = await render(
      createElement(
        FactoryBelt,
        props({
          environments: [desktop],
          recent: recentOf([
            DESKTOP,
            [
              // Began yesterday evening, finished after midnight: today's.
              {
                ...doneRow(1, "merged", at(1, 0)),
                started_ts: iso(at(23, 0, -1)),
                total_ms: 2 * 3_600_000,
              },
              // Finished yesterday.
              doneRow(2, "merged", at(22, 0, -1)),
            ],
          ]),
        }),
      ),
    );
    expect(countOf(station(page, "done"))).toBe("1");
    expect(lane(page, "done").textContent).toContain("1 merged · 0 closed");
  });
});

describe("the readout", () => {
  it("opens under the rail when a post is picked, folds when it is picked again", async () => {
    using _state = await setup();
    await using page = await render(createElement(FactoryBelt, twoEnvironments()));
    await page.click(station(page, "gate"));
    expect(readout(page)!.getAttribute("aria-label")).toBe("Gate readout");
    expect(station(page, "gate").getAttribute("aria-expanded")).toBe("true");
    expect(station(page, "pr").getAttribute("aria-expanded")).toBe("false");
    expect(page.all("section[data-readout]")).toHaveLength(1);
    expect(rowsOf(page)).toHaveLength(1);
    await page.click(station(page, "pr"));
    expect(readout(page)!.getAttribute("aria-label")).toBe("PR open readout");
    expect(rowsOf(page)).toHaveLength(3);
    await page.click(station(page, "pr"));
    expect(readout(page)).toBeUndefined();
    expect(station(page, "pr").getAttribute("aria-expanded")).toBe("false");
  });

  it("opens on the station of the newest run once data has arrived, and then only on a pick", async () => {
    using _state = await setup();
    const loading = props({
      ...twoEnvironments(),
      recent: new Map([
        [DESKTOP, resource({ status: "loading" })],
        [STUDIO, resource({ status: "loading" })],
      ]),
    });
    await using page = await render(createElement(FactoryBelt, loading));
    expect(readout(page)).toBeUndefined();
    await page.rerender(createElement(FactoryBelt, twoEnvironments()));
    // The newest start is #1's, at 14:40: Claimed.
    expect(readout(page)!.getAttribute("aria-label")).toBe("Claimed readout");
    // A newer run on another station does not move the panel.
    const next = twoEnvironments();
    await page.rerender(
      createElement(FactoryBelt, {
        ...next,
        recent: recentOf(
          [DESKTOP, [recentRow(1, { started_ts: iso(at(14, 55)), state: "pr-open" })]],
          [STUDIO, []],
        ),
      }),
    );
    expect(readout(page)!.getAttribute("aria-label")).toBe("Claimed readout");
    await page.click(station(page, "building"));
    expect(readout(page)!.getAttribute("aria-label")).toBe("Building readout");
  });

  it("opens on Claimed when there is no run at all", async () => {
    using _state = await setup();
    await using page = await render(createElement(FactoryBelt, props()));
    expect(readout(page)!.getAttribute("aria-label")).toBe("Claimed readout");
    expect(readout(page)!.textContent).toContain("Nothing at Claimed");
  });

  it("lists a station's runs with issue, title, environment, step, elapsed and pull request", async () => {
    using _state = await setup();
    await using page = await render(createElement(FactoryBelt, twoEnvironments()));
    await page.click(station(page, "pr"));
    const [first] = rowsOf(page);
    // What shows: the narrow belt's stacked line under the title is hidden here.
    const cells = Array.from(first!.querySelectorAll("td")).map((cell) => cell.innerText.trim());
    expect(cells.slice(0, 5)).toEqual(["#4", "Title of 4", "Desktop", "pr-open", "1h"]);
    expect(Array.from(first!.querySelectorAll("a")).map((a) => a.getAttribute("href"))).toContain(
      "https://github.com/acme/widgets/pull/40",
    );
    await page.click(station(page, "building"));
    const steps = rowsOf(page).map((row) => row.querySelectorAll("td")[3]!.textContent);
    expect(steps).toEqual(["launch-sending", "launch-sending"]);
  });

  it("shows the issue number alone for a run with no title", async () => {
    using _state = await setup();
    const desktop = environment(DESKTOP, "Desktop", [statusRun(8, { title: null })]);
    await using page = await render(
      createElement(
        FactoryBelt,
        props({ environments: [desktop], recent: recentOf([DESKTOP, []]) }),
      ),
    );
    await openStation(page, "building");
    const cells = Array.from(rowsOf(page)[0]!.querySelectorAll("td")).map((c) =>
      c.innerText.trim(),
    );
    expect(cells.slice(0, 2)).toEqual(["#8", "#8"]);
  });

  it("lists today's done runs, newest finish first", async () => {
    using _state = await setup();
    await using page = await render(createElement(FactoryBelt, twoEnvironments()));
    await page.click(station(page, "done"));
    expect(rowsOf(page).map((row) => row.querySelector("td")!.textContent)).toEqual([
      "#10",
      "#11",
      "#12",
      "#13",
    ]);
  });

  it("opens the run page from a tile and from a row", async () => {
    using _state = await setup();
    await using page = await render(createElement(FactoryBelt, twoEnvironments()));
    await page.click(station(page, "pr"));
    const tile = tilesOf(lane(page, "pr")).find((a) => a.textContent?.startsWith("#6"))!;
    expect(tile.getAttribute("data-to")).toBe("/factory/$environmentId/$runId");
    expect(paramsOf(tile)).toEqual({ environmentId: STUDIO, runId: runId(6) });
    const row = rowsOf(page).find((r) => r.textContent?.includes("Title of 6"))!;
    row.scrollIntoView();
    const [link] = runLinksIn(row);
    expect(link!.getAttribute("data-to")).toBe("/factory/$environmentId/$runId");
    expect(paramsOf(link!)).toEqual({ environmentId: STUDIO, runId: runId(6) });
    // The link stretches over the whole row, so a click anywhere in it opens the run.
    const box = row.getBoundingClientRect();
    expect(document.elementFromPoint(box.left + box.width / 3, box.top + box.height / 2)).toBe(
      link,
    );
  });
});

describe("stopping a run from the readout", () => {
  it("enables Stop exactly for a building run, as the run page does", async () => {
    using _state = await setup();
    await using page = await render(createElement(FactoryBelt, twoEnvironments()));
    const stops = async (name: string) => {
      await openStation(page, name);
      return rowsOf(page).map(
        (row) =>
          !Array.from(row.querySelectorAll("button")).find((b) => b.textContent === "Stop")!
            .disabled,
      );
    };
    expect(await stops("claimed")).toEqual([false]);
    expect(await stops("building")).toEqual([true, true]);
    expect(await stops("gate")).toEqual([true]);
    expect(await stops("pr")).toEqual([false, false, false]);
    expect(await stops("done")).toEqual([false, false, false, false]);
  });

  it("calls stopRun for that run, shows the answer, and reads the environment's status again", async () => {
    using _state = await setup();
    const belt = twoEnvironments();
    const stopRun = vi.fn(async () => ({
      stopped: runId(7),
      already: false,
      message: "stopping #7",
    }));
    __setFactoryApiForTests(api({ stopRun }));
    await using page = await render(createElement(FactoryBelt, belt));
    await page.click(station(page, "building"));
    const row = rowsOf(page).find((r) => r.textContent?.includes("Studio"))!;
    await page.click(
      Array.from(row.querySelectorAll("button")).find((b) => b.textContent === "Stop")!,
    );
    expect(stopRun).toHaveBeenCalledWith(STUDIO, runId(7));
    const note = page.all('[role="status"]').find((p) => p.textContent === "#7: stopping #7");
    expect(note).toBeDefined();
    expect(belt.environments[1]!.status.refresh).toHaveBeenCalled();
    expect(belt.environments[0]!.status.refresh).not.toHaveBeenCalled();
  });

  it("disables the Stop of the run being stopped and no other", async () => {
    using _state = await setup();
    __setFactoryApiForTests(api({ stopRun: () => new Promise(() => {}) }));
    await using page = await render(createElement(FactoryBelt, twoEnvironments()));
    await page.click(station(page, "building"));
    const stops = () =>
      rowsOf(page).map(
        (row) =>
          Array.from(row.querySelectorAll("button")).find((b) => b.textContent === "Stop")!
            .disabled,
      );
    expect(stops()).toEqual([false, false]);
    await page.click(
      Array.from(rowsOf(page)[0]!.querySelectorAll("button")).find(
        (b) => b.textContent === "Stop",
      )!,
    );
    expect(stops()).toEqual([true, false]);
  });

  it("shows the message of a stop that fails, naming the run", async () => {
    using _state = await setup();
    __setFactoryApiForTests(
      api({
        stopRun: async () => {
          throw new FactoryApiError(403, null, "Missing permission orchestration:operate");
        },
      }),
    );
    await using page = await render(createElement(FactoryBelt, twoEnvironments()));
    await page.click(station(page, "building"));
    const row = rowsOf(page).find((r) => r.textContent?.includes("Title of 2"))!;
    await page.click(
      Array.from(row.querySelectorAll("button")).find((b) => b.textContent === "Stop")!,
    );
    const note = page.all('[role="status"]').find((p) => p.textContent?.includes("Missing"));
    expect(note?.textContent).toBe("#2: Missing permission orchestration:operate");
  });

  it("names the run in the note of every stop, so a later answer does not leave an earlier failure unattributed", async () => {
    using _state = await setup();
    __setFactoryApiForTests(
      api({
        stopRun: async (_environmentId, id) => {
          if (id === runId(2)) throw new Error("timed out");
          return { stopped: id, already: false, message: "stop requested" };
        },
      }),
    );
    await using page = await render(createElement(FactoryBelt, twoEnvironments()));
    await page.click(station(page, "building"));
    const stopOf = async (title: string) => {
      const row = rowsOf(page).find((r) => r.textContent?.includes(title))!;
      await page.click(
        Array.from(row.querySelectorAll("button")).find((b) => b.textContent === "Stop")!,
      );
    };
    const notes = () =>
      page
        .all('[role="status"]')
        .map((p) => p.textContent)
        .filter((text) => text?.startsWith("#"));
    await stopOf("Title of 2");
    expect(notes()).toEqual(["#2: timed out"]);
    await stopOf("Title of 7");
    expect(notes()).toEqual(["#7: stop requested"]);
  });
});

describe("the control bar", () => {
  it("shows the claims switch for the selected environment and asks to toggle that one", async () => {
    using _state = await setup();
    const belt = twoEnvironments();
    await using page = await render(createElement(FactoryBelt, belt));
    expect(page.all('[role="switch"]')).toHaveLength(1);
    expect(claimsSwitch(page).getAttribute("aria-label")).toBe("Claims on Desktop");
    expect(claimsSwitch(page).getAttribute("aria-checked")).toBe("true");
    expect(page.all('section[aria-label="Controls"]')[0]!.textContent).toContain("Running");
    await page.click(claimsSwitch(page));
    expect(belt.onTogglePause).toHaveBeenCalledTimes(1);
    expect(belt.onTogglePause).toHaveBeenLastCalledWith(belt.environments[0]);
    await page.click(page.all("button").find((b) => b.textContent?.startsWith("Studio"))!);
    expect(claimsSwitch(page).getAttribute("aria-label")).toBe("Claims on Studio");
    await page.click(claimsSwitch(page));
    expect(belt.onTogglePause).toHaveBeenLastCalledWith(belt.environments[1]);
  });

  it("reads paused: the switch off, the rail dim and the Claimed post saying since when", async () => {
    using _state = await setup();
    const since = at(11, 2);
    const desktop = environment(DESKTOP, "Desktop", [statusRun(4, { state: "pr-open" })], {
      paused_by_hand: { since: iso(since), for_ms: NOW - since },
    });
    await using page = await render(
      createElement(
        FactoryBelt,
        props({ environments: [desktop], recent: recentOf([DESKTOP, []]) }),
      ),
    );
    expect(claimsSwitch(page).getAttribute("aria-checked")).toBe("false");
    expect(page.all('section[aria-label="Controls"]')[0]!.textContent).toContain("Paused");
    expect(station(page, "claimed").textContent).toContain(
      `claims paused by hand since ${clock(since)}`,
    );
    expect(Number(getComputedStyle(lane(page, "pr")).opacity)).toBeLessThan(1);
    expect(Number(getComputedStyle(station(page, "pr")).opacity)).toBeLessThan(1);
    expect(Number(getComputedStyle(station(page, "building")).opacity)).toBeLessThan(1);
    // The Claimed post carries the pause note, so it stays readable.
    expect(Number(getComputedStyle(station(page, "claimed")).opacity)).toBe(1);
    expect(station(page, "claimed").textContent).not.toContain("factory:triage");
  });

  it("does not dim the rail while claims are running", async () => {
    using _state = await setup();
    await using page = await render(createElement(FactoryBelt, twoEnvironments()));
    expect(Number(getComputedStyle(lane(page, "pr")).opacity)).toBe(1);
    expect(station(page, "claimed").textContent).not.toContain("claims paused");
  });

  it("disables the switch while that environment's call is in flight, and only that one's", async () => {
    using _state = await setup();
    const belt = { ...twoEnvironments(), busy: new Set([STUDIO]) };
    await using page = await render(createElement(FactoryBelt, belt));
    expect(claimsSwitch(page).hasAttribute("data-disabled")).toBe(false);
    await page.click(page.all("button").find((b) => b.textContent?.startsWith("Studio"))!);
    expect(claimsSwitch(page).hasAttribute("data-disabled")).toBe(true);
  });

  it("counts down to the next pass once a second, and says when one is running", async () => {
    using _state = await setup();
    using _timers = fakeTimers();
    vi.setSystemTime(NOW);
    await using page = await render(createElement(FactoryBelt, twoEnvironments()));
    const controls = () => page.all('section[aria-label="Controls"]')[0]!.textContent;
    expect(controls()).toContain("next pass in 48s");
    await act(async () => void (await vi.advanceTimersByTimeAsync(1_000)));
    expect(controls()).toContain("next pass in 47s");
    await act(async () => void (await vi.advanceTimersByTimeAsync(10_000)));
    expect(controls()).toContain("next pass in 37s");
    await act(async () => void (await vi.advanceTimersByTimeAsync(60_000)));
    expect(controls()).toContain("next pass in 0s");
    const running = environment(DESKTOP, "Desktop", [], {
      passes: { at: iso(NOW), poll_seconds: 60, running: true },
    });
    await page.rerender(createElement(FactoryBelt, props({ environments: [running] })));
    expect(controls()).toContain("pass running");
    expect(controls()).not.toContain("next pass in");
  });

  it("ticks from a single one-second timer", async () => {
    using _state = await setup();
    using _timers = fakeTimers();
    vi.setSystemTime(NOW);
    await using _page = await render(createElement(FactoryBelt, twoEnvironments()));
    expect(vi.getTimerCount()).toBe(1);
  });

  it("shows the selected environment's slots, and the runs today, merged today and stuck", async () => {
    using _state = await setup();
    const belt = twoEnvironments();
    const stuck = recentRow(20, { state: "stuck", finished: true, started_ts: iso(at(6, 0, -2)) });
    belt.recent = recentOf(
      [DESKTOP, [...belt.recent.get(DESKTOP)!.data!.runs, stuck]],
      [STUDIO, belt.recent.get(STUDIO)!.data!.runs],
    );
    // Studio has its own slots, so the bar can only be showing the selected environment's.
    const studio = belt.environments[1]!;
    belt.environments = [
      belt.environments[0]!,
      {
        ...studio,
        status: resource({ data: { ...studio.status.data!, slots: { used: 0, max: 3 } } }),
      },
    ];
    await using page = await render(createElement(FactoryBelt, belt));
    expect(stat(page, "Slots")).toBe("1/2");
    // Started today: #1 #2 #3 #4 #5 #6 #7 and the four done runs of today (#14 began yesterday).
    expect(stat(page, "Runs today")).toBe("11");
    expect(stat(page, "Merged today")).toBe("3");
    expect(stat(page, "Stuck")).toBe("1");
    await page.click(page.all("button").find((b) => b.textContent?.startsWith("Studio"))!);
    expect(stat(page, "Slots")).toBe("0/3");
    await page.click(page.all("button").find((b) => b.textContent?.startsWith("Desktop"))!);
    expect(stat(page, "Slots")).toBe("1/2");
  });
});

describe("a waiting update", () => {
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  const since = at(14, 10);
  const deployBy = at(16, 10);
  const waiting = (
    pending: Partial<NonNullable<FactoryStatus["deploy_pending"]>> = {},
  ): NonNullable<FactoryStatus["deploy_pending"]> => ({
    commit: SHA,
    since: iso(since),
    waited_ms: NOW - since,
    deploy_by: iso(deployBy),
    snoozed_until: null,
    ...pending,
  });
  const withUpdate = (
    runs: ReadonlyArray<StatusRun>,
    status: Partial<FactoryStatus> = {},
    id: EnvironmentId = DESKTOP,
    label = "Desktop",
  ) => environment(id, label, runs, { deploy_pending: waiting(), ...status });
  const banner = (page: Page) =>
    page.all('[data-slot="alert"]').find((node) => node.closest("[data-factory-update]"));
  const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]');
  const dialogButton = (label: string) =>
    Array.from(dialog()?.querySelectorAll("button") ?? []).find((b) => b.textContent === label);

  it("says which build waits, until when claims hold, and that runs in progress finish first", async () => {
    using _state = await setup();
    const desktop = withUpdate([statusRun(2), statusRun(4, { state: "pr-open" })]);
    await using page = await render(createElement(FactoryBelt, props({ environments: [desktop] })));
    expect(banner(page)?.textContent).toBe(
      "Update waiting." +
        `Build 0123456 is ready to install. The factory claims no new work until it installs, at ${clock(deployBy)} at the latest, or sooner once the runs in progress finish.` +
        "Snooze 1 hourUpdate now",
    );
    expect(station(page, "claimed").textContent).toContain(
      `claims held for update since ${clock(since)}`,
    );
  });

  it("leaves out the runs clause with none in progress, and names no sha it does not have", async () => {
    using _state = await setup();
    // A run on PR open, needs info or stuck is not in progress; an unreadable one is.
    const desktop = withUpdate(
      [
        statusRun(4, { state: "pr-open" }),
        statusRun(5, { state: "needs-info" }),
        statusRun(6, { state: "stuck" }),
      ],
      { deploy_pending: waiting({ commit: null }) },
    );
    await using page = await render(createElement(FactoryBelt, props({ environments: [desktop] })));
    expect(banner(page)?.textContent).toContain(
      `A new build is ready to install. The factory claims no new work until it installs, at ${clock(deployBy)} at the latest.Snooze`,
    );
  });

  it("gives a hand pause the Claimed post over the update hold", async () => {
    using _state = await setup();
    const paused = at(11, 2);
    const desktop = withUpdate([], { paused_by_hand: { since: iso(paused), for_ms: 0 } });
    await using page = await render(createElement(FactoryBelt, props({ environments: [desktop] })));
    expect(station(page, "claimed").textContent).toContain(
      `claims paused by hand since ${clock(paused)}`,
    );
    expect(station(page, "claimed").textContent).not.toContain("held for update");
  });

  it("says until when a snoozed update waits, and holds no claims", async () => {
    using _state = await setup();
    const until = at(16, 0);
    const desktop = withUpdate([statusRun(2)], {
      deploy_pending: waiting({ deploy_by: null, snoozed_until: iso(until) }),
    });
    await using page = await render(createElement(FactoryBelt, props({ environments: [desktop] })));
    expect(banner(page)?.textContent).toBe(
      `Update snoozed until ${clock(until)}.` +
        "Build 0123456 is waiting. The factory claims work as normal until then." +
        "Snooze 1 hourUpdate now",
    );
    expect(station(page, "claimed").textContent).not.toContain("held for update");
  });

  it("shows no banner while nothing waits", async () => {
    using _state = await setup();
    await using page = await render(createElement(FactoryBelt, twoEnvironments()));
    expect(banner(page)).toBeUndefined();
  });

  it("snoozes the selected environment's update, disabling both its buttons and no other's, then reads status again", async () => {
    using _state = await setup();
    let finish!: () => void;
    const snoozeDeploy = vi.fn(
      () =>
        new Promise<{ snoozed_until: string }>((resolve) => {
          finish = () => resolve({ snoozed_until: iso(at(16, 0)) });
        }),
    );
    __setFactoryApiForTests(api({ snoozeDeploy }));
    const belt = props({
      environments: [withUpdate([]), withUpdate([], {}, STUDIO, "Studio")],
      recent: recentOf([DESKTOP, []], [STUDIO, []]),
    });
    await using page = await render(createElement(FactoryBelt, belt));
    await page.click(page.button("Snooze 1 hour")!);
    expect(snoozeDeploy).toHaveBeenCalledWith(DESKTOP, SHA);
    expect(page.button("Snooze 1 hour")!.disabled).toBe(true);
    expect(page.button("Update now")!.disabled).toBe(true);
    await page.click(page.all("button").find((b) => b.textContent?.startsWith("Studio"))!);
    expect(page.button("Snooze 1 hour")!.disabled).toBe(false);
    expect(page.button("Update now")!.disabled).toBe(false);
    await page.click(page.all("button").find((b) => b.textContent?.startsWith("Desktop"))!);
    await act(async () => finish());
    expect(page.button("Snooze 1 hour")!.disabled).toBe(false);
    expect(belt.environments[0]!.status.refresh).toHaveBeenCalled();
    expect(belt.environments[1]!.status.refresh).not.toHaveBeenCalled();
  });

  it("shows the message of a snooze the server refuses", async () => {
    using _state = await setup();
    __setFactoryApiForTests(
      api({
        snoozeDeploy: async () => {
          throw new FactoryApiError(409, "snooze_limit", "this build has been snoozed 3 times");
        },
      }),
    );
    await using page = await render(
      createElement(FactoryBelt, props({ environments: [withUpdate([])] })),
    );
    await page.click(page.button("Snooze 1 hour")!);
    const note = page
      .all('[role="status"]')
      .find((p) => p.textContent === "this build has been snoozed 3 times");
    expect(note).toBeDefined();
  });

  it("asks before Update now interrupts runs and threads, naming each run", async () => {
    using _state = await setup();
    const deployNow = vi.fn(async () => ({ commit: SHA, kicked: true, message: "installing" }));
    __setFactoryApiForTests(api({ deployNow }));
    const desktop = withUpdate(
      [
        statusRun(2, { title: "Make the belt faster" }),
        statusRun(3, { title: null }),
        statusRun(4, { state: "pr-open", title: "Already on PR" }),
        statusRun(5, { state: null, title: "Fresh claim" }),
      ],
      { threads: { running: 2 } },
    );
    await using page = await render(createElement(FactoryBelt, props({ environments: [desktop] })));
    await page.click(page.button("Update now")!);
    await expect.poll(() => dialog()).not.toBeNull();
    expect(deployNow).not.toHaveBeenCalled();
    const text = dialog()!.textContent;
    expect(text).toContain("Make the belt faster");
    expect(text).toContain(runId(3));
    expect(text).toContain("Fresh claim");
    expect(text).not.toContain("Already on PR");
    expect(text).toContain(
      "2 threads with an agent at work will be interrupted; you continue them in T3.",
    );
    await act(async () => dialogButton("Update now")!.click());
    expect(deployNow).toHaveBeenCalledWith(DESKTOP, SHA);
    await expect
      .poll(() => banner(page)?.textContent)
      .toBe("Updating. The server restarts once the build is installed.");
  });

  it("asks before Update now when only threads are at work", async () => {
    using _state = await setup();
    const deployNow = vi.fn();
    __setFactoryApiForTests(api({ deployNow }));
    const desktop = withUpdate([], { threads: { running: 1 } });
    await using page = await render(createElement(FactoryBelt, props({ environments: [desktop] })));
    await page.click(page.button("Update now")!);
    await expect.poll(() => dialog()).not.toBeNull();
    expect(dialog()!.textContent).toContain(
      "1 thread with an agent at work will be interrupted; you continue them in T3.",
    );
    await act(async () => dialogButton("Cancel")!.click());
    await expect.poll(() => dialog()).toBeNull();
    expect(deployNow).not.toHaveBeenCalled();
    expect(banner(page)?.textContent).toContain("Update waiting.");
  });

  it("asks before Update now interrupts a running factory pass", async () => {
    using _state = await setup();
    const deployNow = vi.fn();
    __setFactoryApiForTests(api({ deployNow }));
    const desktop = withUpdate([], {
      threads: { running: 0 },
      passes: { at: iso(NOW), poll_seconds: 60, running: true },
    });
    await using page = await render(createElement(FactoryBelt, props({ environments: [desktop] })));
    await page.click(page.button("Update now")!);
    await expect.poll(() => dialog()).not.toBeNull();
    expect(dialog()!.textContent).toContain("The factory pass running now will be interrupted.");
    expect(deployNow).not.toHaveBeenCalled();
  });

  it("posts Update now with no dialog when nothing is in progress, and says when the update starts", async () => {
    using _state = await setup();
    const deployNow = vi.fn(async () => ({ commit: SHA, kicked: false, message: "next tick" }));
    __setFactoryApiForTests(api({ deployNow }));
    const belt = props({
      environments: [withUpdate([statusRun(4, { state: "pr-open" })], { threads: { running: 0 } })],
    });
    await using page = await render(createElement(FactoryBelt, belt));
    await page.click(page.button("Update now")!);
    expect(dialog()).toBeNull();
    expect(deployNow).toHaveBeenCalledWith(DESKTOP, SHA);
    expect(banner(page)?.textContent).toBe("Updating within 10 minutes.");
    // The banner says updating until the build is no longer waiting.
    await page.rerender(
      createElement(FactoryBelt, {
        ...belt,
        environments: [withUpdate([], { deploy_pending: null })],
      }),
    );
    await expect.poll(() => banner(page)).toBeUndefined();
  });

  it("drops the updating note once the server answers again after going away", async () => {
    using _state = await setup();
    __setFactoryApiForTests(
      api({ deployNow: async () => ({ commit: SHA, kicked: true, message: "installing" }) }),
    );
    const desktop = withUpdate([]);
    const belt = props({ environments: [desktop] });
    await using page = await render(createElement(FactoryBelt, belt));
    await page.click(page.button("Update now")!);
    expect(banner(page)?.textContent).toContain("Updating.");
    const gone = {
      ...desktop,
      status: { ...desktop.status, status: "error" as const, error: new Error("gone") },
    };
    await page.rerender(createElement(FactoryBelt, { ...belt, environments: [gone] }));
    await expect.poll(() => banner(page)?.textContent).toContain("Updating.");
    await page.rerender(createElement(FactoryBelt, { ...belt, environments: [withUpdate([])] }));
    await expect.poll(() => banner(page)?.textContent).toContain("Update waiting.");
  });

  it("asks before Update now when T3 cannot say whether threads are at work", async () => {
    using _state = await setup();
    const deployNow = vi.fn();
    __setFactoryApiForTests(api({ deployNow }));
    const desktop = withUpdate([], { threads: { running: null } });
    await using page = await render(createElement(FactoryBelt, props({ environments: [desktop] })));
    await page.click(page.button("Update now")!);
    await expect.poll(() => dialog()).not.toBeNull();
    expect(dialog()!.textContent).toContain(
      "T3 could not say whether an agent is at work in a thread; any that is will be interrupted.",
    );
    expect(deployNow).not.toHaveBeenCalled();
  });

  it("asks before Update now interrupts an unreadable run, whatever state it last showed", async () => {
    using _state = await setup();
    const deployNow = vi.fn();
    __setFactoryApiForTests(api({ deployNow }));
    const desktop = withUpdate(
      [statusRun(7, { state: "pr-open", unreadable: true, title: "Torn ledger" })],
      { threads: { running: 0 } },
    );
    await using page = await render(createElement(FactoryBelt, props({ environments: [desktop] })));
    await page.click(page.button("Update now")!);
    await expect.poll(() => dialog()).not.toBeNull();
    expect(dialog()!.textContent).toContain("Torn ledger");
    expect(deployNow).not.toHaveBeenCalled();
  });

  it("does not open the dialog again for a later build", async () => {
    using _state = await setup();
    const belt = props({ environments: [withUpdate([statusRun(2)])] });
    await using page = await render(createElement(FactoryBelt, belt));
    await page.click(page.button("Update now")!);
    await expect.poll(() => dialog()).not.toBeNull();
    await page.rerender(
      createElement(FactoryBelt, {
        ...belt,
        environments: [withUpdate([statusRun(2)], { deploy_pending: null })],
      }),
    );
    const next = waiting({ commit: "fedcba9876543210", since: iso(at(14, 50)) });
    await page.rerender(
      createElement(FactoryBelt, {
        ...belt,
        environments: [withUpdate([statusRun(2)], { deploy_pending: next })],
      }),
    );
    await expect.poll(() => banner(page)?.textContent).toContain("Build fedcba9");
    expect(dialog()).toBeNull();
  });

  it("closes an open dialog when a different build replaces the one it asked about", async () => {
    using _state = await setup();
    const belt = props({ environments: [withUpdate([statusRun(2)])] });
    await using page = await render(createElement(FactoryBelt, belt));
    await page.click(page.button("Update now")!);
    await expect.poll(() => dialog()).not.toBeNull();
    const next = waiting({ commit: "fedcba9876543210", since: iso(at(14, 50)) });
    await page.rerender(
      createElement(FactoryBelt, {
        ...belt,
        environments: [withUpdate([statusRun(2)], { deploy_pending: next })],
      }),
    );
    await expect.poll(() => banner(page)?.textContent).toContain("Build fedcba9");
    await expect.poll(() => dialog()).toBeNull();
  });

  it("disables both buttons while an Update now post is in flight", async () => {
    using _state = await setup();
    __setFactoryApiForTests(api({ deployNow: () => new Promise(() => {}) }));
    await using page = await render(
      createElement(FactoryBelt, props({ environments: [withUpdate([])] })),
    );
    await page.click(page.button("Update now")!);
    expect(page.button("Snooze 1 hour")!.disabled).toBe(true);
    expect(page.button("Update now")!.disabled).toBe(true);
  });

  it("drops the updating note once a different build is waiting", async () => {
    using _state = await setup();
    __setFactoryApiForTests(
      api({ deployNow: async () => ({ commit: SHA, kicked: false, message: "next tick" }) }),
    );
    const belt = props({ environments: [withUpdate([])] });
    await using page = await render(createElement(FactoryBelt, belt));
    await page.click(page.button("Update now")!);
    expect(banner(page)?.textContent).toBe("Updating within 10 minutes.");
    // Main moved on before autodeploy's tick, so it dropped the request and waits on the new build.
    await page.rerender(
      createElement(FactoryBelt, {
        ...belt,
        environments: [withUpdate([], { deploy_pending: waiting({ commit: "fedcba9876543210" }) })],
      }),
    );
    await expect.poll(() => banner(page)?.textContent).toContain("Update waiting.Build fedcba9");
  });

  it("says only that claims hold until the install when no install time is known", async () => {
    using _state = await setup();
    const desktop = withUpdate([statusRun(2)], { deploy_pending: waiting({ deploy_by: null }) });
    await using page = await render(createElement(FactoryBelt, props({ environments: [desktop] })));
    expect(banner(page)?.textContent).toContain(
      "The factory claims no new work until it installs.Snooze",
    );
  });

  it("shows the message of an Update now the server refuses", async () => {
    using _state = await setup();
    __setFactoryApiForTests(
      api({
        deployNow: async () => {
          throw new FactoryApiError(403, null, "Missing permission environment:maintain");
        },
      }),
    );
    const belt = props({
      environments: [withUpdate([]), withUpdate([], {}, STUDIO, "Studio")],
    });
    await using page = await render(createElement(FactoryBelt, belt));
    await page.click(page.button("Update now")!);
    const note = () =>
      page
        .all('[role="status"]')
        .find((p) => p.textContent === "Missing permission environment:maintain");
    expect(note()).toBeDefined();
    expect(banner(page)?.textContent).toContain("Update waiting.");
    // The refusal was Desktop's: Studio does not show it, and Desktop does again once picked.
    await page.click(page.all("button").find((b) => b.textContent?.startsWith("Studio"))!);
    expect(note()).toBeUndefined();
    await page.click(page.all("button").find((b) => b.textContent?.startsWith("Desktop"))!);
    expect(note()).toBeDefined();
  });
});

describe("Attention, Needs info and Stuck", () => {
  const stuckRun = (issue: number, reason: string | null, title: string | null) =>
    recentRow(issue, { state: "stuck", finished: true, reason, title });
  const infoRun = (issue: number, reason: string | null, title: string | null) =>
    recentRow(issue, { state: "needs-info", finished: true, reason, title });

  it("lists each bin's issues with a link, the title or the number alone, the environment and the reason", async () => {
    using _state = await setup();
    const belt = twoEnvironments();
    belt.recent = recentOf(
      [
        DESKTOP,
        [
          stuckRun(30, "cannot push the sync branch", "Sync"),
          stuckRun(31, null, null),
          infoRun(32, "Which branch should this target?", "Threads"),
        ],
      ],
      [STUDIO, [stuckRun(33, "gate failed", null)]],
    );
    await using page = await render(createElement(FactoryBelt, belt));
    const bin = (name: string) =>
      page.all("section").find((section) => section.getAttribute("aria-label") === name)!;
    const stuck = bin("Stuck");
    expect(stuck.textContent).toContain("Sync");
    expect(stuck.textContent).toContain("cannot push the sync branch");
    expect(stuck.textContent).toContain("#31");
    expect(stuck.textContent).toContain("#33");
    expect(stuck.textContent).toContain("gate failed");
    expect(stuck.textContent).toContain("Studio");
    expect(stuck.textContent).not.toContain("Title of 31");
    expect(runLinksIn(stuck).map(paramsOf)).toEqual(
      expect.arrayContaining([
        { environmentId: DESKTOP, runId: runId(30) },
        { environmentId: STUDIO, runId: runId(33) },
      ]),
    );
    const info = bin("Needs info");
    expect(info.textContent).toContain("Threads");
    expect(info.textContent).toContain("Which branch should this target?");
    expect(info.textContent).not.toContain("Sync");
    // The reason is plain text, clamped to two lines.
    const reason = Array.from(info.querySelectorAll("p")).find((p) =>
      p.textContent?.includes("Which branch"),
    )!;
    expect(getComputedStyle(reason).webkitLineClamp).toBe("2");
  });

  it("says so when a bin is empty", async () => {
    using _state = await setup();
    await using page = await render(createElement(FactoryBelt, twoEnvironments()));
    const text = (name: string) =>
      page.all("section").find((section) => section.getAttribute("aria-label") === name)!
        .textContent;
    expect(text("Needs info")).toContain("Nothing needs info");
    expect(text("Stuck")).toContain("Nothing is stuck");
  });

  it("leaves a bin once a newer attempt of its issue exists", async () => {
    using _state = await setup();
    const belt = twoEnvironments();
    belt.recent = recentOf(
      [
        DESKTOP,
        [
          { ...stuckRun(30, "old", null), id: runId(30, 1) },
          { ...recentRow(30), id: runId(30, 2) },
        ],
      ],
      [STUDIO, []],
    );
    await using page = await render(createElement(FactoryBelt, belt));
    const stuck = page.all("section").find((s) => s.getAttribute("aria-label") === "Stuck")!;
    expect(stuck.textContent).toContain("Nothing is stuck");
  });

  it("keeps the Attention panel, saying so, when nothing needs a person", async () => {
    using _state = await setup();
    await using page = await render(createElement(FactoryBelt, twoEnvironments()));
    const attention = page
      .all("section")
      .find((section) => section.getAttribute("aria-label") === "Needs attention")!;
    expect(attention.textContent).toContain("Nothing needs a person.");
    expect(page.button("Dismiss all")).toBeUndefined();
    const tops = ["Needs attention", "Needs info", "Stuck"].map(
      (name) =>
        page
          .all("section")
          .find((s) => s.getAttribute("aria-label") === name)!
          .getBoundingClientRect().top,
    );
    expect(new Set(tops).size).toBe(1);
  });

  it("puts the attention section first, beside the bins", async () => {
    using _state = await setup();
    const belt = twoEnvironments();
    belt.attention = [
      {
        environmentId: DESKTOP,
        label: "Desktop",
        item: {
          id: "config",
          kind: "config",
          repo: null,
          issue: null,
          run: null,
          message: "the machine config failed to load",
          first_seen: iso(NOW - 3_600_000),
        },
      },
    ];
    await using page = await render(createElement(FactoryBelt, belt));
    const names = page
      .all("section")
      .map((section) => section.getAttribute("aria-label"))
      .filter((name) => ["Needs attention", "Needs info", "Stuck"].includes(name ?? ""));
    expect(names).toEqual(["Needs attention", "Needs info", "Stuck"]);
    const tops = ["Needs attention", "Needs info", "Stuck"].map(
      (name) =>
        page
          .all("section")
          .find((s) => s.getAttribute("aria-label") === name)!
          .getBoundingClientRect().top,
    );
    expect(new Set(tops).size).toBe(1);
  });
});

describe("what the belt does not know yet", () => {
  const unknown = (status: "loading" | "error"): Belt["environments"][number] => ({
    environmentId: DESKTOP,
    label: "Desktop",
    status: resource<FactoryStatus>({
      status,
      error: status === "error" ? new Error("down") : null,
    }),
  });

  it.each(["loading", "error"] as const)(
    "does not call an environment Running, or switch it on, while its status is %s",
    async (status) => {
      using _state = await setup();
      await using page = await render(
        createElement(FactoryBelt, props({ environments: [unknown(status)], recent: new Map() })),
      );
      expect(page.all('section[aria-label="Controls"]')[0]!.textContent).not.toContain("Running");
      expect(claimsSwitch(page).getAttribute("aria-checked")).toBe("false");
      expect(claimsSwitch(page).hasAttribute("data-disabled")).toBe(true);
    },
  );

  it.each(["loading"] as const)(
    "shows no counts, and no empty bins, while an answered environment's recent runs are %s",
    async (status) => {
      using _state = await setup();
      const belt = twoEnvironments();
      belt.recent = new Map([
        [
          DESKTOP,
          resource({
            data: {
              runs: [
                recentRow(30, { state: "stuck", finished: true, reason: "gate failed" }),
                recentRow(31, { state: "needs-info", finished: true, reason: "which branch?" }),
              ],
            },
          }),
        ],
        [
          STUDIO,
          resource<{ runs: ReadonlyArray<FactoryRunRow> }>({
            status,
          }),
        ],
      ]);
      // The rail opens once everything has answered and stays; Studio's list then reads again.
      await using page = await render(createElement(FactoryBelt, twoEnvironments()));
      await page.rerender(createElement(FactoryBelt, belt));
      for (const label of ["Runs today", "Merged today", "Stuck"]) {
        expect(stat(page, label)).toBe("-");
      }
      const text = (name: string) =>
        page.all("section").find((section) => section.getAttribute("aria-label") === name)!
          .textContent;
      expect(text("Needs info")).not.toContain("Nothing needs info");
      expect(text("Stuck")).not.toContain("Nothing is stuck");
      // Desktop's list has answered with two stuck runs, but a partial count is not the count.
      for (const name of ["Needs info", "Stuck"]) {
        const header = page
          .all("section")
          .find((section) => section.getAttribute("aria-label") === name)!
          .querySelector("h2")!.nextElementSibling!;
        expect(header.textContent).toBe("-");
      }
      expect(countOf(station(page, "done"))).toBe("-");
      expect(lane(page, "done").textContent).not.toContain("merged");
    },
  );
});

describe("a recent runs list that failed before its first answer", () => {
  it("adds nothing, and does not hold the other environment's bins and counters back", async () => {
    using _state = await setup();
    const belt = twoEnvironments();
    belt.recent = new Map([
      [
        DESKTOP,
        resource({
          data: {
            runs: [recentRow(30, { state: "stuck", finished: true, reason: "gate failed" })],
          },
        }),
      ],
      [
        STUDIO,
        resource<{ runs: ReadonlyArray<FactoryRunRow> }>({
          status: "error",
          error: new Error("down"),
        }),
      ],
    ]);
    await using page = await render(createElement(FactoryBelt, belt));
    expect(stat(page, "Stuck")).toBe("1");
    expect(stat(page, "Runs today")).toMatch(/^\d+$/);
    expect(countOf(station(page, "done"))).toBe("0");
    expect(page.all('[role="status"]').filter((n) => n.getAttribute("aria-label"))).toEqual([]);
    const stuck = page
      .all("section")
      .find((section) => section.getAttribute("aria-label") === "Stuck")!;
    expect(stuck.textContent).toContain("#30");
    expect(stuck.textContent).toContain("gate failed");
  });
});

describe("a recent runs list that failed on refresh", () => {
  it("still counts: numbers, the bins' runs and no skeleton, since it keeps its data", async () => {
    using _state = await setup();
    const belt = twoEnvironments();
    belt.recent = new Map([
      [DESKTOP, resource({ data: { runs: [recentRow(30, { state: "stuck", finished: true })] } })],
      [
        STUDIO,
        resource({
          status: "error",
          error: new Error("timed out"),
          data: { runs: [recentRow(33, { state: "stuck", finished: true })] },
        }),
      ],
    ]);
    await using page = await render(createElement(FactoryBelt, belt));
    expect(stat(page, "Stuck")).toBe("2");
    expect(stat(page, "Runs today")).toMatch(/^\d+$/);
    expect(countOf(station(page, "done"))).toBe("0");
    expect(page.all('[role="status"]').filter((n) => n.getAttribute("aria-label"))).toEqual([]);
    const stuck = page
      .all("section")
      .find((section) => section.getAttribute("aria-label") === "Stuck")!;
    expect(stuck.textContent).toContain("#30");
    expect(stuck.textContent).toContain("#33");
  });
});

describe("the rail keeps its pick", () => {
  it("stays on the open post when a second environment answers for the first time", async () => {
    using _state = await setup();
    const full = twoEnvironments();
    const waiting = {
      ...full.environments[1]!,
      status: resource<FactoryStatus>({ status: "loading" }),
    };
    await using page = await render(
      createElement(FactoryBelt, {
        ...full,
        environments: [full.environments[0]!, waiting],
        recent: new Map([[DESKTOP, full.recent.get(DESKTOP)!]]),
      }),
    );
    await page.click(station(page, "gate"));
    expect(readout(page)!.getAttribute("aria-label")).toBe("Gate readout");
    // Studio answers, and its recent runs are still loading.
    await page.rerender(
      createElement(FactoryBelt, {
        ...full,
        recent: new Map([
          [DESKTOP, full.recent.get(DESKTOP)!],
          [STUDIO, resource<{ runs: ReadonlyArray<FactoryRunRow> }>({ status: "loading" })],
        ]),
      }),
    );
    expect(readout(page)!.getAttribute("aria-label")).toBe("Gate readout");
    await page.rerender(createElement(FactoryBelt, full));
    expect(readout(page)!.getAttribute("aria-label")).toBe("Gate readout");
  });

  it("keeps a stop's answer when its readout is folded before the call ends", async () => {
    using _state = await setup();
    let resolve!: (value: { stopped: string; already: boolean; message: string }) => void;
    __setFactoryApiForTests(
      api({
        stopRun: () =>
          new Promise((r) => {
            resolve = r;
          }),
      }),
    );
    await using page = await render(createElement(FactoryBelt, twoEnvironments()));
    await page.click(station(page, "building"));
    await page.click(
      Array.from(
        rowsOf(page)
          .find((r) => r.textContent?.includes("Title of 2"))!
          .querySelectorAll("button"),
      ).find((b) => b.textContent === "Stop")!,
    );
    await page.click(station(page, "building"));
    expect(readout(page)).toBeUndefined();
    await act(async () => resolve({ stopped: runId(2), already: false, message: "stopping #2" }));
    expect(page.all('[role="status"]').some((p) => p.textContent === "#2: stopping #2")).toBe(true);
  });
});

describe("the belt's layout", () => {
  const prRuns = (count: number) =>
    Array.from({ length: count }, (_, i) =>
      statusRun(100 + i, { state: "pr-open", for_ms: (i + 1) * 3_600_000 }),
    );

  const crowded = (count: number) =>
    props({
      environments: [environment(DESKTOP, "Desktop", prRuns(count))],
      recent: recentOf([
        DESKTOP,
        prRuns(count).map((run, i) =>
          recentRow(100 + i, { state: "pr-open", started_ts: iso(at(14) - i * 60_000) }),
        ),
      ]),
    });

  it("keeps 12 runs on PR open on one row at 1440 px, with a +N tile that lists the rest", async () => {
    using _state = await setup(1440);
    await using page = await render(createElement(FactoryBelt, crowded(12)));
    const prLane = lane(page, "pr");
    await expect.poll(() => prLane.querySelector("button")).not.toBeNull();
    const more = prLane.querySelector("button")!;
    const tiles = tilesOf(prLane);
    const shown = tiles.length;
    expect(shown).toBeGreaterThan(3);
    expect(more.textContent).toContain(`+${12 - shown}`);
    expect(new Set([...tiles, more].map((tile) => (tile as HTMLElement).offsetTop)).size).toBe(1);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
      document.documentElement.clientWidth,
    );
    const lanes = page.all("[data-lane]");
    expect(lanes.every((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    await userEvent.hover(more);
    await expect.poll(() => document.body.textContent).toContain(`#${100 + 11}`);
    expect(document.body.textContent).toContain(`#${100 + shown}`);
  });

  it("opens that post's readout from its +N tile", async () => {
    using _state = await setup(1440);
    await using page = await render(createElement(FactoryBelt, crowded(12)));
    await page.click(station(page, "claimed"));
    expect(readout(page)!.getAttribute("aria-label")).toBe("Claimed readout");
    const prLane = lane(page, "pr");
    await expect.poll(() => prLane.querySelector("button")).not.toBeNull();
    await page.click(prLane.querySelector("button")!);
    expect(readout(page)!.getAttribute("aria-label")).toBe("PR open readout");
    expect(rowsOf(page)).toHaveLength(12);
  });

  it("fits a lane to its width: no +N when every run has a slot", async () => {
    using _state = await setup(1440);
    await using page = await render(createElement(FactoryBelt, crowded(3)));
    await expect.poll(() => tilesOf(lane(page, "pr")).length).toBe(3);
    expect(lane(page, "pr").querySelector("button")).toBeNull();
  });

  it("puts the posts side by side on a wide belt, and the readout under the rail with its notch under the post", async () => {
    using _state = await setup(1440);
    await using page = await render(createElement(FactoryBelt, twoEnvironments()));
    const posts = ["claimed", "building", "gate", "pr", "done"].map((name) => station(page, name));
    expect(new Set(posts.map((post) => post.offsetTop)).size).toBe(1);
    const lefts = posts.map((post) => post.getBoundingClientRect().left);
    expect(lefts).toEqual([...lefts].sort((a, b) => a - b));
    await page.click(station(page, "gate"));
    const panel = readout(page)!;
    const lowest = Math.max(
      ...page.all("[data-lane]").map((node) => node.getBoundingClientRect().bottom),
    );
    expect(panel.getBoundingClientRect().top).toBeGreaterThanOrEqual(lowest);
    const notch = panel.querySelector("[data-part=notch]")!.getBoundingClientRect();
    const post = station(page, "gate").getBoundingClientRect();
    expect(notch.left + notch.width / 2).toBeGreaterThan(post.left);
    expect(notch.left + notch.width / 2).toBeLessThan(post.right);
    await page.click(station(page, "pr"));
    const pr = station(page, "pr").getBoundingClientRect();
    const moved = readout(page)!.querySelector("[data-part=notch]")!.getBoundingClientRect();
    expect(moved.left + moved.width / 2).toBeGreaterThan(pr.left);
    expect(moved.left + moved.width / 2).toBeLessThan(pr.right);
  });

  it("stacks the posts at 390 px, each with its own tile row, and opens the readout under the tapped post", async () => {
    using _state = await setup(390);
    await using page = await render(createElement(FactoryBelt, twoEnvironments()));
    const names = ["claimed", "building", "gate", "pr", "done"];
    const tops = names.map((name) => station(page, name).getBoundingClientRect().top);
    expect(tops).toEqual([...tops].sort((a, b) => a - b));
    expect(new Set(tops).size).toBe(5);
    const lefts = names.map((name) => Math.round(station(page, name).getBoundingClientRect().left));
    expect(new Set(lefts).size).toBe(1);
    for (const name of names) {
      const post = station(page, name);
      expect(lane(page, name).getBoundingClientRect().top).toBeGreaterThanOrEqual(
        post.getBoundingClientRect().bottom - 1,
      );
    }
    await page.click(station(page, "gate"));
    const post = station(page, "gate");
    const tapped = lane(page, "gate");
    expect(post.nextElementSibling).toBe(tapped);
    expect(tapped.nextElementSibling).toBe(readout(page));
    expect(station(page, "pr").getBoundingClientRect().top).toBeGreaterThan(
      readout(page)!.getBoundingClientRect().bottom - 1,
    );
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
      document.documentElement.clientWidth,
    );
  });

  it("has no horizontal scroll at 390 px with 12 runs on PR open and the readout open", async () => {
    using _state = await setup(390);
    await using page = await render(createElement(FactoryBelt, crowded(12)));
    await page.click(station(page, "pr"));
    await expect.poll(() => lane(page, "pr").querySelector("button")).not.toBeNull();
    const tiles = [...tilesOf(lane(page, "pr")), lane(page, "pr").querySelector("button")!];
    expect(new Set(tiles.map((tile) => (tile as HTMLElement).offsetTop)).size).toBe(1);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
      document.documentElement.clientWidth,
    );
  });

  it("keeps the environment, step and pull request link of a readout row at 390 px", async () => {
    using _state = await setup(390);
    await using page = await render(createElement(FactoryBelt, twoEnvironments()));
    await page.click(station(page, "pr"));
    const row = rowsOf(page)[0]!;
    const shown = (node: Element) => node.getClientRects().length > 0;
    const link = Array.from(row.querySelectorAll("a")).find(
      (a) => a.getAttribute("href") === "https://github.com/acme/widgets/pull/40" && shown(a),
    );
    expect(link).toBeDefined();
    const visibleText = (text: string) =>
      Array.from(row.querySelectorAll("*")).some(
        (node) => shown(node) && node.textContent === text,
      );
    expect(visibleText("Desktop")).toBe(true);
    expect(visibleText("pr-open")).toBe(true);
    // The row's run link stretches over the row; the pull request link sits above it, so a tap on it
    // opens the pull request.
    link!.scrollIntoView();
    const box = link!.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    expect(hit === link || link!.contains(hit)).toBe(true);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
      document.documentElement.clientWidth,
    );
  });
});

describe("the belt in both themes", () => {
  type Rgba = readonly [number, number, number, number];
  /** Any CSS colour the browser computed, as sRGB, by painting it. */
  const rgbaOf = (css: string): Rgba => {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    context.fillStyle = css;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
    return [r!, g!, b!, a! / 255];
  };
  const over = (top: Rgba, below: Rgba): Rgba => [
    top[0] * top[3] + below[0] * (1 - top[3]),
    top[1] * top[3] + below[1] * (1 - top[3]),
    top[2] * top[3] + below[2] * (1 - top[3]),
    1,
  ];
  /** What an element's background really is: its own layer and its ancestors' until one is opaque. */
  const backgroundOf = (element: Element): Rgba => {
    const layers: Array<Rgba> = [];
    for (let node: Element | null = element; node !== null; node = node.parentElement) {
      const layer = rgbaOf(getComputedStyle(node).backgroundColor);
      if (layer[3] > 0) layers.push(layer);
      if (layer[3] === 1) break;
    }
    return layers.reduceRight<Rgba>((below, layer) => over(layer, below), [255, 255, 255, 1]);
  };
  const luminance = ([r, g, b]: Rgba) => {
    const [lr, lg, lb] = [r, g, b].map((channel) => {
      const c = channel / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * lr! + 0.7152 * lg! + 0.0722 * lb!;
  };
  /** WCAG contrast of an element's text on the background it sits on. */
  const contrastOf = (element: Element) => {
    const background = backgroundOf(element);
    const text = over(rgbaOf(getComputedStyle(element).color), background);
    const [high, low] = [luminance(text), luminance(background)].toSorted((a, b) => b - a);
    return (high! + 0.05) / (low! + 0.05);
  };
  const withText = (root: Element, text: string | RegExp) =>
    Array.from(root.querySelectorAll("*")).find(
      (node) =>
        node.getClientRects().length > 0 &&
        node.children.length === 0 &&
        (typeof text === "string" ? node.textContent === text : text.test(node.textContent ?? "")),
    )!;
  const stationVar = (page: Page, name: string) =>
    getComputedStyle(station(page, name)).getPropertyValue("--factory-station").trim();

  async function inBothThemes(check: (theme: "light" | "dark") => void | Promise<void>) {
    const root = document.documentElement;
    try {
      root.classList.remove("dark");
      await check("light");
      root.classList.add("dark");
      await check("dark");
    } finally {
      root.classList.remove("dark");
    }
  }

  it("changes the station colours with the theme", async () => {
    using _state = await setup();
    await using page = await render(createElement(FactoryBelt, twoEnvironments()));
    const seen = new Map<string, Array<string>>();
    await inBothThemes(async (theme) => {
      for (const name of ["claimed", "building", "gate", "pr", "done"]) {
        const values = seen.get(name) ?? [];
        // A theme change may still be transitioning the colour when it is first read.
        await expect
          .poll(() => stationVar(page, name))
          .not.toBe(theme === "light" ? "" : values[0]);
        values.push(stationVar(page, name));
        seen.set(name, values);
      }
    });
    for (const [name, [light, dark]] of seen) {
      expect(light, name).not.toBe("");
      expect(dark, name).not.toBe(light);
    }
  });

  it("paints Done, Stuck and Needs info in the theme's status colours", async () => {
    using _state = await setup();
    await using page = await render(createElement(FactoryBelt, twoEnvironments()));
    const of = (name: string) =>
      page.all("[data-station]").find((node) => node.dataset.station === name)!;
    const root = document.documentElement;
    try {
      root.dataset.themeId = "probe";
      root.style.setProperty("--app-theme-error-foreground", "rgb(10, 20, 30)");
      root.style.setProperty("--app-theme-warning-foreground", "rgb(40, 50, 60)");
      await expect
        .poll(() => rgbaOf(getComputedStyle(of("stuck")).getPropertyValue("--factory-station")))
        .toEqual([10, 20, 30, 1]);
      expect(rgbaOf(getComputedStyle(of("info")).getPropertyValue("--factory-station"))).toEqual([
        40, 50, 60, 1,
      ]);
      await inBothThemes(() => {
        expect(rgbaOf(stationVar(page, "done"))).toEqual(
          rgbaOf(getComputedStyle(root).getPropertyValue("--success-foreground")),
        );
      });
    } finally {
      delete root.dataset.themeId;
      root.style.removeProperty("--app-theme-error-foreground");
      root.style.removeProperty("--app-theme-warning-foreground");
    }
  });

  it("keeps the text of posts, tiles and readout rows at 4.5:1 in light and dark", async () => {
    using _state = await setup();
    await using page = await render(createElement(FactoryBelt, twoEnvironments()));
    await page.click(station(page, "gate"));
    const texts = () => [
      withText(station(page, "gate"), "Gate"),
      withText(station(page, "gate"), "gate-sending"),
      withText(station(page, "gate"), "checks before the pull request"),
      withText(tilesOf(lane(page, "gate"))[0]!, "#3"),
      withText(tilesOf(lane(page, "gate"))[0]!, "14m"),
      withText(readout(page)!, "Title of 3"),
      withText(readout(page)!, "gate-sending"),
    ];
    await inBothThemes(async () => {
      await expect.poll(() => Math.min(...texts().map(contrastOf))).toBeGreaterThanOrEqual(4.5);
    });
  });

  it("keeps the pause note at 4.5:1 in light and dark", async () => {
    using _state = await setup();
    const since = at(11, 2);
    const belt = twoEnvironments();
    const desktop = belt.environments[0]!;
    belt.environments = [
      {
        ...desktop,
        status: resource({
          data: {
            ...desktop.status.data!,
            paused_by_hand: { since: iso(since), for_ms: NOW - since },
          },
        }),
      },
      belt.environments[1]!,
    ];
    await using page = await render(createElement(FactoryBelt, belt));
    const note = () => withText(station(page, "claimed"), /^claims paused by hand since/);
    await inBothThemes(async () => {
      await expect.poll(() => contrastOf(note())).toBeGreaterThanOrEqual(4.5);
    });
  });
});

describe("tile motion", () => {
  const ghostsOf = (page: Page) => page.all(".factory-ghost");
  const post = (page: Page, name: string) =>
    page.all("[data-post]").find((node) => node.dataset.post === name)!;
  const binCount = (page: Page, name: string) =>
    page
      .all("section[data-bin]")
      .find((node) => node.dataset.bin === name)
      ?.querySelector(":scope > div > span.font-mono")?.textContent;
  /** The belt with one environment, whose runs the status and the recent list say. */
  const world = (runs: ReadonlyArray<StatusRun>, rows: ReadonlyArray<FactoryRunRow> = []): Belt =>
    props({
      environments: [environment(DESKTOP, "Desktop", runs)],
      recent: recentOf([DESKTOP, rows]),
    });
  const gateRun = (issue: number) => statusRun(issue, { last_event: "gate_command" });
  const near = (actual: number, expected: number) =>
    expect(Math.abs(actual - expected)).toBeLessThan(2);
  /** A ghost's laid-out box in the page, before its transition moves it: the layer's, and its offsets. */
  const boxOf = (ghost: Element) => {
    const element = ghost as HTMLElement;
    const layer = element.offsetParent!.getBoundingClientRect();
    return {
      left: layer.left + element.offsetLeft,
      top: layer.top + element.offsetTop,
      width: element.offsetWidth,
      height: element.offsetHeight,
    };
  };
  /** The keyframes of the transition of one property of a ghost: where it starts, where it ends. */
  const keyframesOf = (ghost: Element, property: string) => {
    const flight = ghost
      .getAnimations()
      .find((animation) => (animation as CSSTransition).transitionProperty === property)!;
    return (flight.effect as KeyframeEffect).getKeyframes();
  };
  /** Where a ghost's flight starts in the page: its box, displaced by the first transform. */
  const startOf = (ghost: Element) => {
    const start = new DOMMatrixReadOnly(String(keyframesOf(ghost, "transform")[0]!.transform));
    const box = boxOf(ghost);
    return { left: box.left + start.m41, top: box.top + start.m42 };
  };
  const flashOf = (node: Element) =>
    node
      .getAnimations()
      .find((animation) => (animation as CSSAnimation).animationName === "factory-post-flash");
  const land = (ghost: Element) =>
    act(() => {
      ghost.dispatchEvent(
        new TransitionEvent("transitionend", { propertyName: "transform", bubbles: true }),
      );
    });
  const endFlash = (node: Element, animationName: string) =>
    act(() => {
      node.dispatchEvent(new AnimationEvent("animationend", { animationName, bubbles: true }));
    });
  /** Makes `(prefers-reduced-motion: reduce)` match until disposed, other queries as they were. */
  const reduceMotion = (): Disposable => {
    const own = window.matchMedia;
    window.matchMedia = (query) =>
      query.includes("prefers-reduced-motion")
        ? ({
            matches: true,
            media: query,
            addEventListener: () => {},
            removeEventListener: () => {},
          } as unknown as MediaQueryList)
        : own(query);
    return { [Symbol.dispose]: () => void (window.matchMedia = own) };
  };

  it("animates nothing on the first load", async () => {
    using _state = await setup();
    const loading = (environmentId: EnvironmentId, label: string) => ({
      environmentId,
      label,
      status: resource<FactoryStatus>({ status: "loading" }),
    });
    await using page = await render(
      createElement(
        FactoryBelt,
        props({
          environments: [loading(DESKTOP, "Desktop"), loading(STUDIO, "Studio")],
          showEnvironment: true,
          recent: new Map([
            [DESKTOP, resource({ status: "loading" })],
            [STUDIO, resource({ status: "loading" })],
          ]),
        }),
      ),
    );
    expect(page.all("[data-tile]")).toEqual([]);
    await page.rerender(createElement(FactoryBelt, twoEnvironments()));
    expect(page.all("[data-tile]").length).toBeGreaterThan(0);
    expect(ghostsOf(page)).toEqual([]);
    expect(page.all(".factory-tile-enter, .factory-tile-glow, .factory-post-flash")).toEqual([]);
  });

  it("animates nothing when a poll leaves every run where it was", async () => {
    using _state = await setup();
    await using page = await render(
      createElement(FactoryBelt, world([statusRun(2)], [recentRow(2)])),
    );
    await page.rerender(createElement(FactoryBelt, world([statusRun(2)], [recentRow(2)])));
    expect(ghostsOf(page)).toEqual([]);
    expect(page.all(".factory-tile-enter, .factory-tile-glow, .factory-post-flash")).toEqual([]);
  });

  it("slides a run that moved to its new post, then flashes the post and glows the tile", async () => {
    using _state = await setup();
    await using page = await render(
      createElement(FactoryBelt, world([statusRun(2)], [recentRow(2)])),
    );
    await page.rerender(createElement(FactoryBelt, world([gateRun(2)], [recentRow(2)])));
    const [ghost] = ghostsOf(page);
    expect(ghostsOf(page)).toHaveLength(1);
    const tile = tilesOf(lane(page, "gate"))[0]!;
    expect(tile.style.visibility).toBe("hidden");
    expect(tilesOf(lane(page, "building"))).toEqual([]);
    expect(post(page, "gate").classList.contains("factory-post-flash")).toBe(false);
    // It flies over the belt on a transform transition, not on layout.
    expect(getComputedStyle(ghost!).position).toBe("absolute");
    const flight = ghost!
      .getAnimations()
      .find((animation) => (animation as CSSTransition).transitionProperty === "transform")!;
    expect(flight.effect!.getTiming()).toMatchObject({
      duration: 750,
      easing: "cubic-bezier(0.2, 0.7, 0.2, 1)",
    });

    // It flies to the tile that is hidden until it lands.
    const destination = tile.getBoundingClientRect();
    const box = boxOf(ghost!);
    near(box.left, destination.left);
    near(box.top, destination.top);
    near(box.width, destination.width);
    near(box.height, destination.height);

    await land(ghost!);
    expect(ghostsOf(page)).toEqual([]);
    expect(tile.style.visibility).toBe("");
    expect(tile.classList.contains("factory-tile-glow")).toBe(true);
    expect(post(page, "gate").classList.contains("factory-post-flash")).toBe(true);
    const flash = flashOf(post(page, "gate"))!;
    expect(flash.effect!.getTiming().duration).toBe(300);
    // It presses the post in a little, and back.
    const pressed = new DOMMatrixReadOnly(
      String((flash.effect as KeyframeEffect).getKeyframes()[0]!.transform),
    );
    expect(pressed.d).toBeCloseTo(0.96, 2);

    // The animations end on the elements that play them, and a child's ending is not theirs.
    await endFlash(tile.firstElementChild!, "x");
    expect(tile.classList.contains("factory-tile-glow")).toBe(true);
    await endFlash(post(page, "gate"), "factory-post-flash");
    expect(post(page, "gate").classList.contains("factory-post-flash")).toBe(false);
    await endFlash(tile, "factory-tile-glow");
    expect(tile.classList.contains("factory-tile-glow")).toBe(false);
  });

  it("flies each of two runs that left one lane in the same poll from where it stood", async () => {
    using _state = await setup();
    const rows = [
      recentRow(2, { started_ts: iso(at(12)) }),
      recentRow(3, { started_ts: iso(at(11)) }),
    ];
    await using page = await render(
      createElement(FactoryBelt, world([statusRun(2), statusRun(3)], rows)),
    );
    const stood = new Map(
      tilesOf(lane(page, "building")).map((tile) => [
        tile.textContent,
        tile.getBoundingClientRect(),
      ]),
    );
    expect(stood.size).toBe(2);
    await page.rerender(createElement(FactoryBelt, world([gateRun(2), gateRun(3)], rows)));
    const ghosts = ghostsOf(page);
    expect(ghosts).toHaveLength(2);
    for (const ghost of ghosts) {
      // Where a ghost starts: its laid-out box in the layer, displaced by the transition's first
      // transform. Neither moves while it flies.
      const flight = ghost
        .getAnimations()
        .find((animation) => (animation as CSSTransition).transitionProperty === "transform")!;
      const [first] = (flight.effect as KeyframeEffect).getKeyframes();
      const start = new DOMMatrixReadOnly(String(first!.transform));
      const layer = ghost.offsetParent!.getBoundingClientRect();
      const from = stood.get(ghost.textContent)!;
      // Offsets are whole pixels; a tile measured late would be a whole tile off.
      expect(Math.abs(layer.left + ghost.offsetLeft + start.m41 - from.left)).toBeLessThan(2);
      expect(Math.abs(layer.top + ghost.offsetTop + start.m42 - from.top)).toBeLessThan(2);
    }
  });

  it("holds Done's count until the run that finished has slid into it", async () => {
    using _state = await setup();
    const open = statusRun(4, { state: "pr-open" });
    await using page = await render(
      createElement(
        FactoryBelt,
        world([open], [recentRow(4, { state: "pr-open", pr_url: "https://x/pull/4" })]),
      ),
    );
    expect(countOf(station(page, "done"))).toBe("0");
    await page.rerender(createElement(FactoryBelt, world([], [doneRow(4, "merged", at(14))])));
    const [ghost] = ghostsOf(page);
    expect(ghostsOf(page)).toHaveLength(1);
    expect(countOf(station(page, "done"))).toBe("0");
    expect(lane(page, "done").textContent).toContain("0 merged · 0 closed");
    // It ends centred on the Done bin, shrunk and faded out.
    const bin = page.all('[data-bin="done"]')[0]!.getBoundingClientRect();
    const box = boxOf(ghost!);
    near(box.left + box.width / 2, bin.left + bin.width / 2);
    near(box.top + box.height / 2, bin.top + bin.height / 2);
    const end = new DOMMatrixReadOnly(String(keyframesOf(ghost!, "transform").at(-1)!.transform));
    expect([end.a, end.d].map((scale) => Math.round(scale * 100) / 100)).toEqual([0.55, 0.55]);
    expect(String(keyframesOf(ghost!, "opacity").at(-1)!.opacity)).toBe("0");

    await land(ghost!);
    expect(ghostsOf(page)).toEqual([]);
    expect(countOf(station(page, "done"))).toBe("1");
    expect(lane(page, "done").textContent).toContain("1 merged · 0 closed");
    expect(post(page, "done").classList.contains("factory-post-flash")).toBe(true);
    const flash = flashOf(post(page, "done"))!;
    expect(flash.effect!.getTiming().duration).toBe(300);
  });

  it("holds the Stuck bin's count until the run that got stuck has slid into it", async () => {
    using _state = await setup();
    await using page = await render(
      createElement(FactoryBelt, world([statusRun(4)], [recentRow(4)])),
    );
    expect(binCount(page, "stuck")).toBe("0");
    await page.rerender(
      createElement(
        FactoryBelt,
        world(
          [],
          [recentRow(4, { state: "stuck", finished: true, status: "finished", reason: "no luck" })],
        ),
      ),
    );
    const [ghost] = ghostsOf(page);
    expect(ghostsOf(page)).toHaveLength(1);
    expect(binCount(page, "stuck")).toBe("0");
    expect(page.all("section[data-bin=stuck] a")).toEqual([]);

    await land(ghost!);
    expect(ghostsOf(page)).toEqual([]);
    expect(binCount(page, "stuck")).toBe("1");
    expect(page.all("section[data-bin=stuck] a")).toHaveLength(1);
  });

  it("fades a new run in at its post without sliding it", async () => {
    using _state = await setup();
    await using page = await render(
      createElement(FactoryBelt, world([statusRun(2)], [recentRow(2)])),
    );
    await page.rerender(
      createElement(
        FactoryBelt,
        world(
          [statusRun(2), statusRun(9, { state: "triage", last_event: "claimed" })],
          [recentRow(2), recentRow(9, { state: "triage", step: null })],
        ),
      ),
    );
    expect(ghostsOf(page)).toEqual([]);
    const [fresh] = tilesOf(lane(page, "claimed"));
    expect(fresh!.classList.contains("factory-tile-enter")).toBe(true);
    expect(tilesOf(lane(page, "building"))[0]!.classList.contains("factory-tile-enter")).toBe(
      false,
    );
    await endFlash(fresh!, "factory-tile-enter");
    expect(fresh!.classList.contains("factory-tile-enter")).toBe(false);
  });

  describe("a run the status read drops before the recent runs list has a bin for it", () => {
    const openRow = recentRow(4, { state: "pr-open", pr_url: "https://x/pull/4" });
    const onRail = () => world([statusRun(4, { state: "pr-open" })], [openRow]);
    const settledRow = (bin: "done" | "stuck") =>
      bin === "done"
        ? doneRow(4, "merged", at(14))
        : recentRow(4, { state: "stuck", finished: true, status: "finished", reason: "no luck" });
    const countIn = (page: Page, bin: "done" | "stuck") =>
      bin === "done" ? countOf(station(page, "done")) : binCount(page, "stuck");

    it.each(["done", "stuck"] as const)(
      "draws nothing where it stood, then flies it from there to %s when a bin lists it",
      async (bin) => {
        using _state = await setup();
        await using page = await render(createElement(FactoryBelt, onRail()));
        const stood = tilesOf(lane(page, "pr"))[0]!.getBoundingClientRect();

        const dropped = world([], [openRow]);
        await page.rerender(createElement(FactoryBelt, dropped));
        expect(ghostsOf(page)).toEqual([]);
        expect(tilesOf(lane(page, "pr"))).toEqual([]);
        expect(countIn(page, bin)).toBe("0");

        const settled = world([], [settledRow(bin)]);
        await page.rerender(createElement(FactoryBelt, settled));
        const [flying] = ghostsOf(page);
        expect(ghostsOf(page)).toHaveLength(1);
        // It flies from the place the tile stood, and the count holds until it lands.
        near(startOf(flying!).left, stood.left);
        near(startOf(flying!).top, stood.top);
        expect(countIn(page, bin)).toBe("0");
        // It ends centred on the bin, shrunk and faded out.
        const target = page.all(`[data-bin="${bin}"]`)[0]!.getBoundingClientRect();
        const box = boxOf(flying!);
        near(box.left + box.width / 2, target.left + target.width / 2);
        near(box.top + box.height / 2, target.top + target.height / 2);
        const end = new DOMMatrixReadOnly(
          String(keyframesOf(flying!, "transform").at(-1)!.transform),
        );
        expect([end.a, end.d].map((scale) => Math.round(scale * 100) / 100)).toEqual([0.55, 0.55]);
        expect(String(keyframesOf(flying!, "opacity").at(-1)!.opacity)).toBe("0");
        // The belt reads no list itself: the data store does.
        expect(dropped.recent.get(DESKTOP)!.refresh).not.toHaveBeenCalled();
        expect(settled.recent.get(DESKTOP)!.refresh).not.toHaveBeenCalled();

        await land(flying!);
        expect(ghostsOf(page)).toEqual([]);
        expect(countIn(page, bin)).toBe("1");
        if (bin === "done") {
          expect(post(page, "done").classList.contains("factory-post-flash")).toBe(true);
        } else {
          expect(page.all(".factory-post-flash")).toEqual([]);
        }
      },
    );

    it("flies from where the tile stood on the belt, though the belt moved before the bin knew", async () => {
      using _state = await setup();
      await using page = await render(createElement(FactoryBelt, onRail()));
      page.container.style.paddingTop = "20px";
      const stood = tilesOf(lane(page, "pr"))[0]!.getBoundingClientRect();
      await page.rerender(createElement(FactoryBelt, world([], [openRow])));
      // Something above the belt grows (or the page scrolls) while the bin's read is out.
      page.container.style.paddingTop = "60px";
      await page.rerender(createElement(FactoryBelt, world([], [settledRow("done")])));
      const [flying] = ghostsOf(page);
      near(startOf(flying!).left, stood.left);
      near(startOf(flying!).top, stood.top + 40);
    });

    it("does not cover the tile that closed up into the place of the one that went", async () => {
      using _state = await setup();
      const rows = [
        recentRow(4, { state: "pr-open", started_ts: iso(at(12)) }),
        recentRow(5, { state: "pr-open", started_ts: iso(at(9)) }),
      ];
      await using page = await render(
        createElement(
          FactoryBelt,
          world([statusRun(4, { state: "pr-open" }), statusRun(5, { state: "pr-open" })], rows),
        ),
      );
      const [first, second] = tilesOf(lane(page, "pr"));
      const stood = first!.getBoundingClientRect();
      expect(second!.getBoundingClientRect().left).toBeGreaterThan(stood.left);

      await page.rerender(
        createElement(FactoryBelt, world([statusRun(5, { state: "pr-open" })], rows)),
      );
      expect(ghostsOf(page)).toEqual([]);
      const [closedUp] = tilesOf(lane(page, "pr"));
      expect(closedUp!.textContent).toBe(second!.textContent);
      expect(closedUp!.style.visibility).toBe("");
      // What a click at the place of the departed tile reaches is the tile that took its place.
      const hit = document.elementFromPoint(stood.left + stood.width / 2, stood.top + 8);
      expect(hit?.closest("a")).toBe(closedUp);
    });

    it("lands at once a run that a bin lists after its place has been forgotten for five seconds", async () => {
      using _state = await setup();
      await using page = await render(createElement(FactoryBelt, onRail()));
      await page.rerender(createElement(FactoryBelt, world([], [openRow])));
      vi.setSystemTime(NOW + 5_001);
      await page.rerender(createElement(FactoryBelt, world([], [settledRow("done")])));
      expect(ghostsOf(page)).toEqual([]);
      expect(countOf(station(page, "done"))).toBe("1");
    });

    it("still flies a run that a bin lists just inside the five seconds", async () => {
      using _state = await setup();
      await using page = await render(createElement(FactoryBelt, onRail()));
      await page.rerender(createElement(FactoryBelt, world([], [openRow])));
      vi.setSystemTime(NOW + 5_000);
      await page.rerender(createElement(FactoryBelt, world([], [settledRow("done")])));
      expect(ghostsOf(page)).toHaveLength(1);
      expect(countOf(station(page, "done"))).toBe("0");
    });

    it("lands at once a run that a bin lists with no place ever remembered", async () => {
      using _state = await setup();
      await using page = await render(createElement(FactoryBelt, world([], [])));
      await page.rerender(createElement(FactoryBelt, world([], [doneRow(9, "merged", at(14))])));
      expect(ghostsOf(page)).toEqual([]);
      expect(countOf(station(page, "done"))).toBe("1");
    });

    it("fades in a run that drops off and comes back to its post, with no slide or flash", async () => {
      using _state = await setup();
      await using page = await render(
        createElement(FactoryBelt, world([statusRun(2)], [recentRow(2)])),
      );
      await page.rerender(createElement(FactoryBelt, world([], [recentRow(2)])));
      await page.rerender(createElement(FactoryBelt, world([statusRun(2)], [recentRow(2)])));
      expect(ghostsOf(page)).toEqual([]);
      const tile = tilesOf(lane(page, "building"))[0]!;
      expect(tile.style.visibility).toBe("");
      expect(tile.classList.contains("factory-tile-enter")).toBe(true);
      expect(post(page, "building").classList.contains("factory-post-flash")).toBe(false);
    });

    it("keeps a run whose bin is known first on its lane, then flies it when the status drops it", async () => {
      using _state = await setup();
      await using page = await render(createElement(FactoryBelt, onRail()));
      const open = statusRun(4, { state: "pr-open" });
      await page.rerender(
        createElement(FactoryBelt, world([open], [doneRow(4, "merged", at(14))])),
      );
      expect(tilesOf(lane(page, "pr"))).toHaveLength(1);
      expect(countOf(station(page, "done"))).toBe("0");
      expect(ghostsOf(page)).toEqual([]);

      await page.rerender(createElement(FactoryBelt, world([], [doneRow(4, "merged", at(14))])));
      const [ghost] = ghostsOf(page);
      expect(ghostsOf(page)).toHaveLength(1);
      expect(tilesOf(lane(page, "pr"))).toEqual([]);
      expect(countOf(station(page, "done"))).toBe("0");
      await land(ghost!);
      expect(ghostsOf(page)).toEqual([]);
      expect(countOf(station(page, "done"))).toBe("1");
      expect(post(page, "done").classList.contains("factory-post-flash")).toBe(true);
    });
  });

  describe("a bin's count when the ghost's transition does not end", () => {
    it("lands a run folded into a lane's +N tile at once, as it has no tile to fly", async () => {
      using _state = await setup(1440);
      const runs = Array.from({ length: 12 }, (_, i) =>
        statusRun(100 + i, { state: "pr-open", for_ms: (i + 1) * 3_600_000 }),
      );
      const rows = runs.map((_, i) =>
        recentRow(100 + i, { state: "pr-open", started_ts: iso(at(14) - i * 60_000) }),
      );
      await using page = await render(createElement(FactoryBelt, world(runs, rows)));
      await expect.poll(() => lane(page, "pr").querySelector("button")).not.toBeNull();
      // The oldest start is the last of the lane, and so is folded.
      expect(tilesOf(lane(page, "pr")).length).toBeLessThan(12);
      expect(binCount(page, "stuck")).toBe("0");
      await page.rerender(
        createElement(
          FactoryBelt,
          world(runs.slice(0, 11), [
            ...rows.slice(0, 11),
            recentRow(111, {
              state: "stuck",
              finished: true,
              status: "finished",
              started_ts: rows[11]!.started_ts,
            }),
          ]),
        ),
      );
      expect(binCount(page, "stuck")).toBe("1");
      expect(ghostsOf(page)).toEqual([]);
    });

    it("lands a run when the transition of its ghost is cancelled", async () => {
      using _state = await setup();
      await using page = await render(
        createElement(
          FactoryBelt,
          world([statusRun(4, { state: "pr-open" })], [recentRow(4, { state: "pr-open" })]),
        ),
      );
      await page.rerender(createElement(FactoryBelt, world([], [doneRow(4, "merged", at(14))])));
      const [ghost] = ghostsOf(page);
      expect(ghostsOf(page)).toHaveLength(1);
      expect(countOf(station(page, "done"))).toBe("0");
      await act(async () => {
        ghost!.dispatchEvent(
          new TransitionEvent("transitioncancel", { propertyName: "transform", bubbles: true }),
        );
      });
      expect(ghostsOf(page)).toEqual([]);
      expect(countOf(station(page, "done"))).toBe("1");
    });

    it("lands a run when its ghost's transition has not ended a little after the slide should have", async () => {
      using _state = await setup();
      using _timers = fakeTimers();
      vi.setSystemTime(NOW);
      await using page = await render(
        createElement(
          FactoryBelt,
          world([statusRun(4, { state: "pr-open" })], [recentRow(4, { state: "pr-open" })]),
        ),
      );
      await page.rerender(createElement(FactoryBelt, world([], [doneRow(4, "merged", at(14))])));
      expect(ghostsOf(page)).toHaveLength(1);
      await act(async () => void (await vi.advanceTimersByTimeAsync(999)));
      expect(ghostsOf(page)).toHaveLength(1);
      expect(countOf(station(page, "done"))).toBe("0");
      await act(async () => void (await vi.advanceTimersByTimeAsync(1)));
      expect(ghostsOf(page)).toEqual([]);
      expect(countOf(station(page, "done"))).toBe("1");
    });
  });

  describe("with reduced motion", () => {
    it("moves a tile with no ghost, no flash and no glow", async () => {
      using _state = await setup();
      await using page = await render(
        createElement(FactoryBelt, world([statusRun(2)], [recentRow(2)])),
      );
      using _motion = reduceMotion();
      await page.rerender(createElement(FactoryBelt, world([gateRun(2)], [recentRow(2)])));
      expect(ghostsOf(page)).toEqual([]);
      const tile = tilesOf(lane(page, "gate"))[0]!;
      expect(tile.style.visibility).toBe("");
      expect(page.all(".factory-tile-enter, .factory-tile-glow, .factory-post-flash")).toEqual([]);
    });

    it("changes a bin's count at once, and fades a new run in with nothing", async () => {
      using _state = await setup();
      await using page = await render(
        createElement(FactoryBelt, world([statusRun(4)], [recentRow(4)])),
      );
      using _motion = reduceMotion();
      await page.rerender(
        createElement(
          FactoryBelt,
          world(
            [statusRun(9)],
            [recentRow(4, { state: "stuck", finished: true, status: "finished" }), recentRow(9)],
          ),
        ),
      );
      expect(binCount(page, "stuck")).toBe("1");
      expect(ghostsOf(page)).toEqual([]);
      expect(page.all(".factory-tile-enter")).toEqual([]);
    });
  });
});
