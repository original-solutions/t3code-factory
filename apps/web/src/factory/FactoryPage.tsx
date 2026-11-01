import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate, useRouterState, useSearch } from "@tanstack/react-router";
import { useState } from "react";

import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";

import { factoryApi, type FactoryAttentionItem, type FactoryStatus } from "./api";
import { splitDismissed, stillTrue } from "./attentionCauses";
import type { EnvironmentAttention } from "./BeltLowerRow";
import { CatchUpCard } from "./CatchUpCard";
import { FactoryBelt } from "./FactoryBelt";
import { FactoryFrame } from "./FactoryFrame";
import { FactoryKeysButton, FactoryKeysDialog, FactorySkipLinks } from "./FactoryKeys";
import { FactoryError, FactoryLoading, FactoryReadFailure } from "./FactoryNotices";
import { FactoryQueue } from "./FactoryQueue";
import { FactoryScope } from "./FactoryScope";
import { FactoryTrends } from "./FactoryTrends";
import { messageOf, parseRunId } from "./format";
import { neverBuilt, type FirstRun } from "./firstRun";
import { machineLine } from "./machines";
import { TONE_DOT } from "./MachineRoster";
import { REPO_TONE, RepoBoard, repoHeadline } from "./RepoBoard";
import { repoBoard } from "./repoHealth";
import { FACTORY_SECTIONS, jumpToSection } from "./pageSections";
import type { RunBucketFilter } from "./runLedger";
import { runLinkKey, useFactoryKeys } from "./runQueue";
import { FactoryRunsSection, type ListedEnvironment } from "./FactoryRunsSection";
import type { FactorySearch } from "./search";
import {
  STATUS_POLL_MS,
  useFactoryEnvironments,
  useFactoryRunsOf,
  useFactorySupported,
  type FactoryEnvironment,
} from "./useFactoryData";

/**
 * An item as raised once, by one environment: an id the factory clears and raises again comes back
 * with a new `first_seen`, so a dismissal on this page never hides the new one, and two
 * environments may raise the same id.
 */
const attentionKey = ({ environmentId, item }: EnvironmentAttention) =>
  `${environmentId} ${item.id}@${item.first_seen}`;

const withEnvironment = (set: ReadonlySet<EnvironmentId>, id: EnvironmentId, member: boolean) => {
  const next = new Set(set);
  if (member) next.add(id);
  else next.delete(id);
  return next;
};

/**
 * `value`, or the one an earlier render returned while `key` is the same: a value rebuilt on every
 * status poll stays one object while what it holds has not changed.
 */
const useSameWhile = <T,>(value: T, key: string): T => {
  const [kept, setKept] = useState({ key, value });
  if (kept.key === key) return kept.value;
  setKept({ key, value });
  return value;
};

/** `search` with one filter set to `value`, or removed when `value` is null. */
const withFilter = (search: FactorySearch, key: keyof FactorySearch, value: string | null) => {
  const { [key]: _, ...rest } = search;
  return value === null ? rest : { ...rest, [key]: value };
};

export function FactoryPage() {
  const search = useSearch({ from: "/factory" });
  const navigate = useNavigate();
  const setSearch = (next: FactorySearch) =>
    void navigate({ to: "/factory", search: next, replace: true });
  // Status is read every few seconds while the page is open: the belt's countdown and tiles follow it.
  const environments = useFactoryEnvironments({ statusPollMs: STATUS_POLL_MS });
  const supported = useFactorySupported();
  // The recent window until the user asks for every run; the switch starts a fresh read.
  const [allRuns, setAllRuns] = useState(false);
  // Trends chart every run; the full list is read once and shared with the table's Show all.
  const trends = search.view === "trends";
  const queue = search.view === "queue";
  const [keysOpen, setKeysOpen] = useState(false);
  useFactoryKeys((key) => {
    if (key === "help") {
      setKeysOpen(true);
      return true;
    }
    const section = FACTORY_SECTIONS.find(({ id }) => id === key);
    return section !== undefined && jumpToSection(section.id);
  });
  // Runs are read once an environment's status has answered with data: a status still loading may
  // yet say 404 (an upstream server, left out above), and one that failed shows its error in the
  // belt's environment control, so neither should raise a second notice for its runs.
  const answered = environments.filter(({ status }) => status.data !== null);
  const answeredIds = answered.map(({ environmentId }) => environmentId);
  const runsOf = useFactoryRunsOf(answeredIds, allRuns || trends);
  const runsById = new Map(answered.map(({ environmentId }, i) => [environmentId, runsOf[i]]));
  // The belt reads the recent window whether or not the table asks for every run. With the window
  // showing, this is the table's own read.
  const recentOf = useFactoryRunsOf(trends ? [] : answeredIds, false);
  const recentById = new Map(answered.map(({ environmentId }, i) => [environmentId, recentOf[i]!]));
  // A machine whose recent window is empty may never have run anything: only then is every run read,
  // once, to tell a first run from a quiet week.
  const quiet =
    answered.length > 0 &&
    answered.every(
      ({ status }, i) => status.data?.runs.length === 0 && recentOf[i]?.data?.runs.length === 0,
    );
  const everOf = useFactoryRunsOf(quiet ? answeredIds : [], true);
  const firstRun: FirstRun =
    quiet && everOf.some(({ data }) => data === null)
      ? "checking"
      : neverBuilt(
          answered.map(({ status }, i) => ({
            active: status.data?.runs.length ?? 0,
            ever: everOf[i]?.data?.runs.length ?? null,
          })),
        );
  // The environments with a pause or resume in flight: one environment's control never disables another's.
  const [busy, setBusy] = useState<ReadonlySet<EnvironmentId>>(() => new Set());
  const [note, setNote] = useState<string | null>(null);
  // The attention items dismissed (true) or restored (false) on this page, moved before the
  // server's next status says so.
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  // Coming back from a run page: the search typed before, and the run to focus.
  const returned = useRouterState({ select: ({ location }) => location.state.factoryReturn });
  // Typed on this page only: the runs chip is in the URL, a half-typed search is not.
  const [query, setQuery] = useState(() => returned?.query ?? "");

  const togglePause = async ({ environmentId, status }: FactoryEnvironment) => {
    const paused = status.data?.paused_by_hand != null;
    setBusy((current) => withEnvironment(current, environmentId, true));
    // No try/finally: the React Compiler cannot compile one.
    const message = await (
      paused ? factoryApi.resumeClaims(environmentId) : factoryApi.pauseClaims(environmentId)
    ).then(
      (result) => result.message,
      (error: unknown) => messageOf(error),
    );
    if (message !== undefined) setNote(message);
    setBusy((current) => withEnvironment(current, environmentId, false));
    status.refresh();
  };

  const entriesOf = (pick: (status: FactoryStatus) => ReadonlyArray<FactoryAttentionItem>) =>
    environments.flatMap(({ environmentId, label, status }) =>
      (status.data ? pick(status.data) : []).map((item) => ({ environmentId, label, item })),
    );
  const byFirstSeen = (a: EnvironmentAttention, b: EnvironmentAttention) =>
    Date.parse(a.item.first_seen) - Date.parse(b.item.first_seen);
  const split = splitDismissed(
    entriesOf((data) => data.attention),
    entriesOf((data) => data.dismissed ?? []),
    overrides,
    attentionKey,
  );
  const allAttention = split.open.toSorted(byFirstSeen);
  const allDismissed = split.dismissed.toSorted(byFirstSeen);

  /** Dismisses (`hide`) or restores the entries, at once on the page and then on their servers. */
  const setDismissedOn = (entries: ReadonlyArray<EnvironmentAttention>, hide: boolean) => {
    const byEnvironment = new Map<EnvironmentId, Array<EnvironmentAttention>>();
    for (const entry of entries) {
      byEnvironment.set(entry.environmentId, [
        ...(byEnvironment.get(entry.environmentId) ?? []),
        entry,
      ]);
    }
    const change = (group: ReadonlyArray<EnvironmentAttention>, value: boolean | null) =>
      setOverrides((current) => {
        const next = new Map(current);
        for (const entry of group) {
          if (value === null) next.delete(attentionKey(entry));
          else next.set(attentionKey(entry), value);
        }
        return next;
      });
    for (const [environmentId, group] of byEnvironment) {
      change(group, hide);
      const ids = group.map(({ item }) => item.id);
      // Not through `togglePause`: a dismiss that ends must not clear the busy flag of a pause or
      // resume still in flight.
      (hide
        ? factoryApi.dismissAttention(environmentId, ids)
        : factoryApi.restoreAttention(environmentId, ids)
      )
        .catch((error: unknown) => {
          change(group, null);
          setNote(messageOf(error));
        })
        .finally(() =>
          environments
            .find((environment) => environment.environmentId === environmentId)
            ?.status.refresh(),
        );
    }
  };
  const dismiss = (entries: ReadonlyArray<EnvironmentAttention>) => setDismissedOn(entries, true);
  const restore = (entries: ReadonlyArray<EnvironmentAttention>) => setDismissedOn(entries, false);

  const nowMs = Math.max(
    0,
    ...environments.map(({ status }) => status.readAt),
    ...runsOf.map(({ readAt }) => readAt),
    ...recentOf.map(({ readAt }) => readAt),
  );
  const showEnvironment = environments.length > 1;
  // The status report names the thread of each unfinished run; the runs list does not.
  const threadEntries = environments.flatMap(({ environmentId, status }) =>
    (status.data?.runs ?? []).flatMap((run) =>
      run.thread_id ? [[runLinkKey(environmentId, run.id), run.thread_id] as const] : [],
    ),
  );
  const threads = useSameWhile(new Map(threadEntries), JSON.stringify(threadEntries));
  const listedEnvironments: ReadonlyArray<ListedEnvironment> = answered.map(
    ({ environmentId, label }) => ({ environmentId, label }),
  );
  const runsEnvironments = useSameWhile(listedEnvironments, JSON.stringify(listedEnvironments));
  const listedRuns = answered.flatMap(({ environmentId, label }, i) =>
    (runsOf[i]?.data?.runs ?? []).map((run) => {
      const parsed = parseRunId(run.id);
      return { environmentId, label, run, repo: parsed ? `${parsed.owner}/${parsed.repo}` : null };
    }),
  );

  // Every repo on the page, once each without regard to case, sorted the same way.
  const repos = [
    ...new Map(
      [...listedRuns.map(({ repo }) => repo), ...allAttention.map(({ item }) => item.repo)]
        .filter((repo): repo is string => !!repo)
        .map((repo) => [repo.toLowerCase(), repo]),
    ).values(),
  ].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  // A filter that names nothing on the page is "all".
  const environmentFilter =
    environments.find(({ environmentId }) => environmentId === search.environment)?.environmentId ??
    null;
  const repoFilter =
    repos.find((repo) => repo.toLowerCase() === search.repo?.toLowerCase()) ?? null;
  const inEnvironment = (id: EnvironmentId) =>
    environmentFilter === null || id === environmentFilter;
  const inRepo = (repo: string | null) =>
    repoFilter === null || repo?.toLowerCase() === repoFilter.toLowerCase();

  const shownEnvironments = environments.filter(({ environmentId }) =>
    inEnvironment(environmentId),
  );
  // An item with no repo is about the machine, not a repo, so a repo filter keeps it.
  const shownItem = ({ environmentId, item }: EnvironmentAttention) =>
    inEnvironment(environmentId) && (!item.repo || inRepo(item.repo));
  const attention = allAttention.filter(shownItem);
  const dismissedAttention = allDismissed.filter(shownItem);
  // The digest follows the page's filters; it reads the recent window, whatever the table shows.
  const caughtUpRecent = answered
    .filter(({ environmentId }) => inEnvironment(environmentId))
    .flatMap(({ environmentId, label }) => {
      const data = recentById.get(environmentId)?.data;
      if (!data) return [];
      const recent = data.runs.filter((run) => {
        const parsed = parseRunId(run.id);
        return inRepo(parsed ? `${parsed.owner}/${parsed.repo}` : null);
      });
      return [{ environmentId, label, recent }];
    });
  // The repos of the recent window, worst first; it follows the environment filter, not the repo one.
  const board = repoBoard(
    answered
      .filter(({ environmentId }) => inEnvironment(environmentId))
      .map(({ environmentId, status }) => ({
        active: status.data?.runs ?? [],
        recent: recentById.get(environmentId)?.data?.runs ?? [],
      })),
    nowMs,
  );
  const scopedRuns = listedRuns.filter(
    ({ environmentId, repo }) => inEnvironment(environmentId) && inRepo(repo),
  );
  // Only the shown environments' reads: a filtered-out read loading or listed says nothing here.
  const shownRunsOf = shownEnvironments.flatMap(({ environmentId }) => {
    const read = runsById.get(environmentId);
    return read ? [read] : [];
  });
  const runsListed = shownRunsOf.some(({ data }) => data !== null);
  const runsPending = shownRunsOf.some(({ status }) => status === "loading");
  // A failed read is a notice naming its environment while the rest of the page stays. The belt
  // shows every environment's status and recent window whatever the filter, so a failure of either
  // is named whatever the filter: the belt is stale or missing for that environment.
  const notices = environments.flatMap(({ environmentId, label, status }) => {
    const runsRead = inEnvironment(environmentId) ? runsById.get(environmentId) : undefined;
    const recentRead = recentById.get(environmentId);
    const failedRuns =
      runsRead?.status === "error" ? runsRead : recentRead?.status === "error" ? recentRead : null;
    const failed =
      failedRuns ?? (status.status === "error" && status.data !== null ? status : null);
    if (failed === null) return [];
    return [
      {
        environmentId,
        label,
        error: failed.error,
        dataAt: failed.dataAt,
        retry: () => {
          status.refresh();
          (failedRuns ?? runsRead)?.refresh();
        },
      },
    ];
  });

  // Trends do not read the recent window, so the board would know only the runs in flight there.
  const boardOf = new Map(
    trends ? [] : board.map((health) => [health.repo.toLowerCase(), health] as const),
  );
  // A filter that is on keeps its select, so it can be cleared.
  const scope = (
    <FactoryScope
      machine={environmentFilter}
      machines={
        environments.length > 1 || environmentFilter !== null
          ? environments.map(({ environmentId, label, status }) => {
              const line = machineLine(status);
              return {
                value: environmentId,
                label,
                toneClass: TONE_DOT[line.tone],
                note: line.word,
              };
            })
          : null
      }
      onClear={() => setSearch(withFilter(withFilter(search, "repo", null), "environment", null))}
      onMachine={(value) => setSearch(withFilter(search, "environment", value))}
      onRepo={(value) => setSearch(withFilter(search, "repo", value))}
      repo={repoFilter}
      repos={
        repos.length > 1 || repoFilter !== null
          ? repos.map((repo) => {
              const health = boardOf.get(repo.toLowerCase());
              return health
                ? {
                    value: repo,
                    label: repo,
                    tone: REPO_TONE[health.verdict],
                    note: repoHeadline(health),
                  }
                : { value: repo, label: repo };
            })
          : null
      }
    />
  );

  // Made before the branches below, so each keeps its identity across status polls and the runs
  // list, which they reach, is left alone by a poll.
  const origin = { search, query };
  const onRunsBucket = (value: RunBucketFilter | null) =>
    setSearch(withFilter(search, "runs", value));
  const clearAll = () => {
    setQuery("");
    setSearch({});
  };
  const showAllRuns = () => setAllRuns(true);
  const showRecentRuns = () => setAllRuns(false);

  let body;
  if (environments.length === 0) {
    body = supported ? (
      <FactoryLoading label="Loading factory" />
    ) : (
      <FactoryError
        message="None of the connected environments runs a factory."
        title="No factory"
      />
    );
  } else if (environments.every(({ status }) => status.status === "loading")) {
    body = <FactoryLoading label="Loading factory" />;
  } else if (queue) {
    body = (
      <>
        {scope}
        <FactoryQueue
          environments={shownEnvironments.flatMap(({ environmentId, label, status }) =>
            status.data === null
              ? []
              : [{ environmentId, label, attention: stillTrue(status.data) }],
          )}
          recent={
            new Map(
              answered.map(({ environmentId }) => [
                environmentId,
                recentById.get(environmentId)?.data?.runs ?? [],
              ]),
            )
          }
          repo={repoFilter}
          repos={repos}
          showEnvironment={showEnvironment}
        />
      </>
    );
  } else if (trends) {
    body = (
      <>
        {scope}
        {notices.map(({ environmentId, label, error, dataAt, retry }) => (
          <FactoryReadFailure
            dataAt={dataAt}
            error={error}
            key={environmentId}
            label={label}
            onRetry={retry}
            verb="refresh"
          />
        ))}
        {runsListed ? (
          <FactoryTrends nowMs={nowMs} origin={origin} runs={scopedRuns} />
        ) : runsPending ? (
          <FactoryLoading label="Loading every run" />
        ) : null}
      </>
    );
  } else {
    body = (
      <>
        <FactorySkipLinks onKeys={() => setKeysOpen(true)} />
        {scope}
        {/* Above the belt: what it shows may be stale, and below it the notice was out of sight. */}
        {notices.map(({ environmentId, label, error, dataAt, retry }) => (
          <FactoryReadFailure
            dataAt={dataAt}
            error={error}
            key={environmentId}
            label={label}
            onRetry={retry}
            verb="refresh"
          />
        ))}
        {board.length > 1 || repoFilter !== null ? (
          <RepoBoard
            nowMs={nowMs}
            onSelect={(repo) => setSearch(withFilter(search, "repo", repo))}
            repos={board}
            selected={repoFilter}
          />
        ) : null}
        <FactoryBelt
          attention={attention}
          busy={busy}
          dismissed={dismissedAttention}
          digest={
            firstRun ? null : (
              <CatchUpCard
                environments={caughtUpRecent}
                nowMs={nowMs}
                origin={origin}
                showEnvironment={showEnvironment}
              />
            )
          }
          firstRun={firstRun}
          environments={environments}
          nowMs={nowMs}
          onDismiss={dismiss}
          onRestore={restore}
          onTogglePause={(environment) => void togglePause(environment)}
          origin={origin}
          recent={recentById}
          repo={repoFilter}
          showEnvironment={showEnvironment}
        />
        {note ? (
          <p className="break-words text-sm text-muted-foreground" role="status">
            {note}
          </p>
        ) : null}
        {firstRun !== false ? null : (
          <FactoryRunsSection
            all={allRuns}
            bucket={search.runs ?? null}
            environment={environmentFilter}
            environments={runsEnvironments}
            onBucket={onRunsBucket}
            onClearFilters={clearAll}
            onQuery={setQuery}
            onShowAll={showAllRuns}
            onShowRecent={showRecentRuns}
            origin={origin}
            query={query}
            repo={repoFilter}
            returnFocus={returned?.focus}
            showEnvironment={showEnvironment}
            threads={threads}
          />
        )}
      </>
    );
  }

  return (
    <FactoryFrame
      header={
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <h1 className="shrink-0 text-sm font-medium">Factory</h1>
          <ToggleGroup
            aria-label="View"
            onValueChange={(next) => {
              const [value] = next;
              // Picking the picked view again keeps it.
              if (value !== undefined)
                setSearch(
                  withFilter(
                    search,
                    "view",
                    value === "trends" || value === "queue" ? value : null,
                  ),
                );
            }}
            value={[search.view ?? "live"]}
          >
            <Toggle value="live">Live</Toggle>
            <Toggle value="queue">Queue</Toggle>
            <Toggle value="trends">Trends</Toggle>
          </ToggleGroup>
          <div className="ml-auto">
            <FactoryKeysButton onOpen={() => setKeysOpen(true)} />
          </div>
        </div>
      }
    >
      {body}
      <FactoryKeysDialog onOpenChange={setKeysOpen} open={keysOpen} />
    </FactoryFrame>
  );
}
