import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useState } from "react";

import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";

import { factoryApi } from "./api";
import type { EnvironmentAttention } from "./BeltLowerRow";
import { FactoryBelt } from "./FactoryBelt";
import { FactoryFrame } from "./FactoryFrame";
import { FactoryError, FactoryLoading, FactoryReadFailure } from "./FactoryNotices";
import { messageOf, parseRunId } from "./format";
import { RunsTable } from "./RunsTable";
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

/** `search` with one filter set to `value`, or removed when `value` is null. */
const withFilter = (search: FactorySearch, key: keyof FactorySearch, value: string | null) => {
  const { [key]: _, ...rest } = search;
  return value === null ? rest : { ...rest, [key]: value };
};

/** One filter's select: "All …" first, then each option. */
function FilterSelect({
  label,
  all,
  options,
  value,
  onChange,
}: {
  label: string;
  all: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  value: string | null;
  onChange: (value: string | null) => void;
}) {
  const items = [{ value: null, label: all }, ...options];
  return (
    <div className="w-40 min-w-0">
      <Select items={items} onValueChange={onChange} value={value}>
        <SelectTrigger aria-label={label} size="sm">
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          {items.map((item) => (
            <SelectItem key={item.value ?? ""} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
}

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
  // Runs are read once an environment's status has answered with data: a status still loading may
  // yet say 404 (an upstream server, left out above), and one that failed shows its error in the
  // belt's environment control, so neither should raise a second notice for its runs.
  const answered = environments.filter(({ status }) => status.data !== null);
  const answeredIds = answered.map(({ environmentId }) => environmentId);
  const runsOf = useFactoryRunsOf(answeredIds, allRuns);
  const runsById = new Map(answered.map(({ environmentId }, i) => [environmentId, runsOf[i]]));
  // The belt reads the recent window whether or not the table asks for every run. With the window
  // showing, this is the table's own read.
  const recentOf = useFactoryRunsOf(answeredIds, false);
  const recentById = new Map(answered.map(({ environmentId }, i) => [environmentId, recentOf[i]!]));
  // The environments with a pause or resume in flight: one environment's control never disables another's.
  const [busy, setBusy] = useState<ReadonlySet<EnvironmentId>>(() => new Set());
  const [note, setNote] = useState<string | null>(null);
  // The attention items dismissed on this page, hidden before the server's next status says so.
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());

  const togglePause = async ({ environmentId, status }: FactoryEnvironment) => {
    const paused = status.data?.paused_by_hand != null;
    setBusy((current) => withEnvironment(current, environmentId, true));
    try {
      const { message } = await (paused
        ? factoryApi.resumeClaims(environmentId)
        : factoryApi.pauseClaims(environmentId));
      if (message !== undefined) setNote(message);
    } catch (error) {
      setNote(messageOf(error));
    } finally {
      setBusy((current) => withEnvironment(current, environmentId, false));
      status.refresh();
    }
  };

  const allAttention = environments
    .flatMap(({ environmentId, label, status }) =>
      (status.data?.attention ?? []).map((item) => ({ environmentId, label, item })),
    )
    .filter((entry) => !dismissed.has(attentionKey(entry)))
    .sort((a, b) => Date.parse(a.item.first_seen) - Date.parse(b.item.first_seen));

  const dismiss = (entries: ReadonlyArray<EnvironmentAttention>) => {
    const byEnvironment = new Map<EnvironmentId, Array<EnvironmentAttention>>();
    for (const entry of entries) {
      byEnvironment.set(entry.environmentId, [
        ...(byEnvironment.get(entry.environmentId) ?? []),
        entry,
      ]);
    }
    const change = (group: ReadonlyArray<EnvironmentAttention>, hide: boolean) =>
      setDismissed((current) => {
        const next = new Set(current);
        for (const entry of group) {
          if (hide) next.add(attentionKey(entry));
          else next.delete(attentionKey(entry));
        }
        return next;
      });
    for (const [environmentId, group] of byEnvironment) {
      change(group, true);
      // Not through `togglePause`: a dismiss that ends must not clear the busy flag of a pause or
      // resume still in flight.
      factoryApi
        .dismissAttention(
          environmentId,
          group.map(({ item }) => item.id),
        )
        .catch((error: unknown) => {
          change(group, false);
          setNote(messageOf(error));
        })
        .finally(() =>
          environments
            .find((environment) => environment.environmentId === environmentId)
            ?.status.refresh(),
        );
    }
  };

  const nowMs = Math.max(
    0,
    ...environments.map(({ status }) => status.readAt),
    ...runsOf.map(({ readAt }) => readAt),
    ...recentOf.map(({ readAt }) => readAt),
  );
  const showEnvironment = environments.length > 1;
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
  const attention = allAttention.filter(
    ({ environmentId, item }) => inEnvironment(environmentId) && (!item.repo || inRepo(item.repo)),
  );
  const runs = listedRuns.filter(
    ({ environmentId, repo }) => inEnvironment(environmentId) && inRepo(repo),
  );
  const filtersHideEveryRun = runs.length === 0 && listedRuns.length > 0;
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
        message: messageOf(failed.error),
        retry: () => {
          status.refresh();
          (failedRuns ?? runsRead)?.refresh();
        },
      },
    ];
  });

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
  } else {
    body = (
      <>
        <FactoryBelt
          attention={attention}
          busy={busy}
          environments={environments}
          nowMs={nowMs}
          onDismiss={dismiss}
          onTogglePause={(environment) => void togglePause(environment)}
          recent={recentById}
          showEnvironment={showEnvironment}
        />
        {notices.map(({ environmentId, label, message, retry }) => (
          <FactoryReadFailure
            key={environmentId}
            label={label}
            message={message}
            onRetry={retry}
            verb="refresh"
          />
        ))}
        {note ? (
          <p className="break-words text-sm text-muted-foreground" role="status">
            {note}
          </p>
        ) : null}
        {(!runsListed || runs.length === 0) && runsPending ? (
          <FactoryLoading label="Loading runs" />
        ) : runsListed ? (
          <RunsTable
            nowMs={nowMs}
            onClearFilters={filtersHideEveryRun ? () => setSearch({}) : undefined}
            onShowAll={() => setAllRuns(true)}
            onShowRecent={() => setAllRuns(false)}
            partial={!allRuns}
            runs={runs}
            showEnvironment={showEnvironment}
          />
        ) : null}
      </>
    );
  }

  return (
    <FactoryFrame
      header={
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <h1 className="min-w-0 truncate text-sm font-medium">Factory</h1>
          <div className="ml-auto flex min-w-0 items-center gap-2">
            {/* A filter that is on keeps its select, so it can be cleared. */}
            {environments.length > 1 || environmentFilter !== null ? (
              <FilterSelect
                all="All environments"
                label="Environment"
                onChange={(value) => setSearch(withFilter(search, "environment", value))}
                options={environments.map(({ environmentId, label }) => ({
                  value: environmentId,
                  label,
                }))}
                value={environmentFilter}
              />
            ) : null}
            {repos.length > 1 || repoFilter !== null ? (
              <FilterSelect
                all="All repos"
                label="Repo"
                onChange={(value) => setSearch(withFilter(search, "repo", value))}
                options={repos.map((repo) => ({ value: repo, label: repo }))}
                value={repoFilter}
              />
            ) : null}
          </div>
        </div>
      }
    >
      {body}
    </FactoryFrame>
  );
}
