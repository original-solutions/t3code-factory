import { createElement, useEffect } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../test/render";
import type { CommandPaletteSubmenuItem } from "~/components/CommandPalette.logic";
import { __setFactoryApiForTests, type FactoryApi, type FactoryRunRow } from "./api";
import { useFactoryPaletteItems } from "./FactoryPaletteItems";
import { __resetFactoryStoresForTests } from "./useFactoryData";

vi.mock("~/state/environments", () => ({
  usePrimaryEnvironmentId: () => "env-1",
  useConnectedEnvironmentIds: () => [],
  useEnvironments: () => ({ environments: [{ environmentId: "env-1", label: "Mac" }] }),
}));

const row = (id: string): FactoryRunRow => ({
  id,
  started_ts: "2026-10-28T02:00:00.000Z",
  state: "stuck",
  last_event: null,
  step: null,
  status: "",
  pr_url: null,
  title: "Fix login",
  reason: null,
  finished: true,
  total_ms: null,
  unreadable: false,
});

const api = (runs: FactoryApi["runs"]): FactoryApi => ({
  status: vi.fn(async () => ({
    state: "running" as const,
    reason: null,
    paused_by_hand: null,
    runs: [],
    attention: [],
    slots: { used: 0, max: 1 },
    passes: { at: null, poll_seconds: null, running: false },
    problems: [],
  })),
  runs,
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
});

const runTitles = (item: CommandPaletteSubmenuItem | undefined) =>
  item?.groups.find((group) => group.value === "factory-runs")?.items.map((run) => run.title);

describe("useFactoryPaletteItems", () => {
  it("shows the runs in a Factory submenu opened before every run was read", async () => {
    using _timers = fakeTimers();
    using _api = {
      [Symbol.dispose]: () => (__setFactoryApiForTests(), __resetFactoryStoresForTests()),
    };
    let landRuns!: (value: { runs: ReadonlyArray<FactoryRunRow> }) => void;
    __setFactoryApiForTests(api(() => new Promise((resolve) => (landRuns = resolve))));
    const latest: { current: CommandPaletteSubmenuItem | undefined } = { current: undefined };
    const Probe = () => {
      const [item] = useFactoryPaletteItems();
      useEffect(() => {
        latest.current = item;
      });
      return null;
    };
    await using _screen = await render(createElement(Probe));
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    // The palette keeps the submenu object it was handed when Factory was opened.
    const opened = latest.current;
    expect(runTitles(opened)).toEqual([]);
    await act(async () => landRuns({ runs: [row("acme__web__294__1")] }));
    expect(runTitles(opened)).toEqual(["web #294 Fix login"]);
  });
});
