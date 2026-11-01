import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { ChartNoAxesColumnIcon, FactoryIcon, FolderGit2Icon, SettingsIcon } from "lucide-react";

import {
  ADDON_ICON_CLASS,
  ITEM_ICON_CLASS,
  type CommandPaletteActionItem,
  type CommandPaletteGroup,
  type CommandPaletteSubmenuItem,
} from "~/components/CommandPalette.logic";

import type { EnvironmentId } from "@t3tools/contracts";
import "./belt.css";
import { paletteFinds, type PaletteFinds, type RunFind } from "./paletteFinds";
import type { RunQueue } from "./runQueue";
import type { FactorySearch } from "./search";
import { useFactoryEveryRunKept, useFactoryPaletteEnvironments } from "./useFactoryData";

export interface PaletteOpeners {
  readonly openRun: (run: RunFind, queue: RunQueue) => Promise<void>;
  readonly openFactory: (search: FactorySearch) => Promise<void>;
  readonly openSettings: () => Promise<void>;
}

const RunIcon = ({ station }: { readonly station: RunFind["station"] }) =>
  station === null ? (
    <span aria-hidden className="flex size-4 items-center justify-center">
      <span className="size-2 rounded-xs bg-muted-foreground/50" />
    </span>
  ) : (
    <span aria-hidden className="flex size-4 items-center justify-center" data-station={station}>
      <span className="size-2 rounded-xs bg-(--factory-station)" />
    </span>
  );

/**
 * The palette's Factory submenu: its pages, every repo and every run on every machine. The palette
 * lists a submenu's rows in its root search under Suggestions by title, so `294`, `pkce` or a repo
 * name finds a run from anywhere; inside the submenu a run also matches its state, why it stopped,
 * its pull request and when it ran ("lint", "stuck last week").
 */
export function factoryPaletteItem(
  finds: PaletteFinds,
  loading: boolean,
  open: PaletteOpeners,
): CommandPaletteSubmenuItem {
  const queueOf = (repo: string): RunQueue => ({
    search: { repo },
    query: "",
    runs: finds.runs
      .filter((run) => run.repo === repo)
      .map(({ environmentId, runId, title }) => ({ environmentId, runId, title })),
  });
  const pages: CommandPaletteActionItem[] = [
    {
      kind: "action",
      value: "factory:page",
      title: "Factory page",
      description: "The belt, what needs you, and every run",
      searchTerms: ["Factory page", "belt", "runs", "stuck", "needs info"],
      icon: <FactoryIcon className={ITEM_ICON_CLASS} />,
      run: () => open.openFactory({}),
    },
    {
      kind: "action",
      value: "factory:trends",
      title: "Trends",
      description: "Eight weeks of runs, and why they got stuck",
      searchTerms: ["Trends", "weeks", "chart", "merged", "stuck"],
      icon: <ChartNoAxesColumnIcon className={ITEM_ICON_CLASS} />,
      run: () => open.openFactory({ view: "trends" }),
    },
    {
      kind: "action",
      value: "factory:settings",
      title: "Factory settings",
      description: "Watched repos and this machine's config",
      searchTerms: ["Factory settings", "watched repos", "config"],
      icon: <SettingsIcon className={ITEM_ICON_CLASS} />,
      run: () => open.openSettings(),
    },
  ];
  const repos = finds.repos.map((repo): CommandPaletteActionItem => ({
    kind: "action",
    value: `factory:repo:${repo.repo}`,
    title: repo.title,
    description: repo.description,
    searchTerms: repo.searchTerms,
    icon: <FolderGit2Icon className={ITEM_ICON_CLASS} />,
    run: () => open.openFactory({ repo: repo.repo }),
  }));
  const runs = finds.runs.map((run): CommandPaletteActionItem => ({
    kind: "action",
    value: `factory:run:${run.environmentId}:${run.runId}`,
    title: run.title,
    description: run.description,
    searchTerms: run.searchTerms,
    icon: <RunIcon station={run.station} />,
    run: () => open.openRun(run, queueOf(run.repo)),
  }));
  const groups: CommandPaletteGroup[] = [
    { value: "factory-pages", label: "Pages", items: pages },
    ...(repos.length > 0 ? [{ value: "factory-repos", label: "Repos", items: repos }] : []),
    ...(runs.length > 0 || loading
      ? [
          {
            value: "factory-runs",
            label: loading ? "Runs · reading every run…" : "Runs",
            items: runs,
          },
        ]
      : []),
  ];
  return {
    kind: "submenu",
    value: "factory:find",
    title: "Factory",
    description: "Find a run, issue or repo",
    searchTerms: ["factory", "find run", "issue", "repo", "stuck", "needs info", "belt"],
    icon: <FactoryIcon className={ITEM_ICON_CLASS} />,
    addonIcon: <FactoryIcon className={ADDON_ICON_CLASS} />,
    groups,
  };
}

/**
 * The Factory submenu for the command palette, or nothing when no machine here has a factory. It
 * reads every run while the palette is open, at most once in ten minutes per machine; the palette
 * mounts this only while it shows.
 */
export function useFactoryPaletteItems(): ReadonlyArray<CommandPaletteSubmenuItem> {
  const navigate = useNavigate();
  // The palette mounts on each open, so its day words are as of that open.
  const [nowMs] = useState(() => Date.now());
  const environments = useFactoryPaletteEnvironments();
  const ids: EnvironmentId[] = environments.map(({ environmentId }) => environmentId);
  const runsOf = useFactoryEveryRunKept(ids);
  if (environments.length === 0) return [];
  const finds = paletteFinds(
    environments.map(({ environmentId, label, status }, i) => ({
      environmentId,
      label,
      runs: runsOf[i]?.data?.runs ?? null,
      status: status.data,
    })),
    nowMs,
  );
  const loading = runsOf.some((runs) => runs.status === "loading");
  return [
    factoryPaletteItem(finds, loading, {
      openRun: async ({ environmentId, runId }, queue) => {
        await navigate({
          to: "/factory/$environmentId/$runId",
          params: { environmentId, runId },
          state: { factoryRunQueue: queue },
        });
      },
      openFactory: async (search) => {
        await navigate({ to: "/factory", search });
      },
      openSettings: async () => {
        await navigate({ to: "/settings/factory" });
      },
    }),
  ];
}
