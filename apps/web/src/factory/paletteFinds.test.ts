import { describe, expect, it } from "vite-plus/test";

import {
  buildNestedSearchItems,
  filterCommandPaletteGroups,
  type CommandPaletteGroup,
} from "~/components/CommandPalette.logic";

import type { FactoryRunRow, FactoryStatus } from "./api";
import { factoryPaletteItem } from "./FactoryPaletteItems";
import { paletteFinds, type PaletteSource } from "./paletteFinds";

// Wednesday 2026-10-28, noon local.
const NOW = new Date(2026, 9, 28, 12).getTime();
const daysAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

const row = (id: string, over: Partial<FactoryRunRow> = {}): FactoryRunRow => ({
  id,
  started_ts: daysAgo(0),
  state: "building",
  last_event: null,
  step: null,
  status: "",
  pr_url: null,
  title: null,
  reason: null,
  finished: false,
  total_ms: null,
  unreadable: false,
  ...over,
});

const status = (runs: FactoryStatus["runs"]): FactoryStatus => ({
  state: "running",
  reason: null,
  paused_by_hand: null,
  runs,
  attention: [],
  slots: { used: runs.length, max: 2 },
  passes: { at: null, poll_seconds: 60, running: false },
  problems: [],
});

const RUNS = [
  row("acme__people-hub__294__1", {
    title: "feat: sign in with PKCE",
    state: "pr-open",
    pr_end: "merged",
    finished: true,
    started_ts: daysAgo(8),
  }),
  row("acme__people-hub__301__2", {
    title: "fix: the roster sorts by surname",
    state: "stuck",
    finished: true,
    started_ts: daysAgo(9),
    reason: "the gate failed (lint)\n\noxlint found 3 errors",
  }),
  row("acme__watchalong__158__1", { title: "feat: a watch party", started_ts: daysAgo(1) }),
];

const sources = (runs = RUNS, live: FactoryStatus | null = null): PaletteSource[] => [
  { environmentId: "env-1", label: "Studio", runs, status: live },
];

const noop = async () => {};
const submenu = (finds = paletteFinds(sources(), NOW)) =>
  factoryPaletteItem(finds, false, { openRun: noop, openFactory: noop, openSettings: noop });

/** The palette's own root search, with the Factory submenu among its actions. */
const rootSearch = (query: string) => {
  const item = submenu();
  const rootGroups: CommandPaletteGroup[] = [{ value: "actions", label: "Actions", items: [item] }];
  return filterCommandPaletteGroups({
    activeGroups: rootGroups,
    query,
    isInSubmenu: false,
    allOptions: { rootGroups, nestedItems: buildNestedSearchItems([item], query) },
    projectSearchItems: [],
    threadSearchItems: [],
    now: NOW,
  });
};

const inSubmenu = (query: string) =>
  filterCommandPaletteGroups({
    activeGroups: submenu().groups,
    query,
    isInSubmenu: true,
    projectSearchItems: [],
    threadSearchItems: [],
    now: NOW,
  });

const titles = (groups: ReadonlyArray<CommandPaletteGroup>) =>
  groups.flatMap((group) => group.items.map((item) => item.title));

describe("the palette's Factory finds", () => {
  it("finds a run from the root search by issue number or a title word", () => {
    expect(titles(rootSearch("294"))).toContain("Factory: people-hub #294 feat: sign in with PKCE");
    expect(titles(rootSearch("pkce"))).toContain(
      "Factory: people-hub #294 feat: sign in with PKCE",
    );
    expect(titles(rootSearch("watchalong"))).toContain("Factory: watchalong");
  });

  it("finds a run in the submenu by why it stopped, its state and when it ran", () => {
    expect(titles(inSubmenu("lint"))[0]).toBe("people-hub #301 fix: the roster sorts by surname");
    expect(titles(inSubmenu("merged"))).toContain("people-hub #294 feat: sign in with PKCE");
    expect(titles(inSubmenu("last week"))).toEqual(
      expect.arrayContaining([
        "people-hub #294 feat: sign in with PKCE",
        "people-hub #301 fix: the roster sorts by surname",
      ]),
    );
    expect(titles(inSubmenu("last week"))).not.toContain("watchalong #158 feat: a watch party");
  });

  it("lists runs newest first, says how each ended, and tallies each repo", () => {
    const finds = paletteFinds(sources(), NOW);
    expect(finds.runs.map((run) => [run.title, run.description])).toEqual([
      ["watchalong #158 feat: a watch party", "Building · Yesterday"],
      ["people-hub #294 feat: sign in with PKCE", expect.stringMatching(/^Merged · /)],
      [
        "people-hub #301 fix: the roster sorts by surname",
        expect.stringMatching(/^Stuck · attempt 2 · .+ · The gate failed$/),
      ],
    ]);
    expect(finds.repos.map((repo) => [repo.repo, repo.description])).toEqual([
      ["acme/people-hub", "acme · 2 runs · 1 needs a person"],
      ["acme/watchalong", "acme · 1 run"],
    ]);
  });

  it("takes a run's state from the live status, and adds a run only the status knows", () => {
    const live = status([
      {
        id: "acme__watchalong__158__1",
        state: "pr-open",
        title: "feat: a watch party",
        user: null,
        for_ms: 86_400_000,
        pr_url: "https://github.com/acme/watchalong/pull/9",
        thread_id: null,
        unreadable: false,
      },
      {
        id: "acme__watchalong__160__1",
        state: "triage",
        title: "feat: claimed a minute ago",
        user: null,
        for_ms: 60_000,
        pr_url: null,
        thread_id: null,
        unreadable: false,
      },
    ]);
    const finds = paletteFinds(sources(RUNS, live), NOW);
    expect(finds.runs.slice(0, 2).map((run) => [run.title, run.description])).toEqual([
      ["watchalong #160 feat: claimed a minute ago", "Claimed · Today"],
      ["watchalong #158 feat: a watch party", "PR open · Yesterday"],
    ]);
    expect(finds.runs[1]!.searchTerms).toContain("PR #9");
  });
});
