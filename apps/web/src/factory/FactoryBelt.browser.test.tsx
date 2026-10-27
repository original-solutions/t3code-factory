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
