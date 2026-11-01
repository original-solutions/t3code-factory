import type { EnvironmentId } from "@t3tools/contracts";
import { memo } from "react";

import { FactoryLoading } from "./FactoryNotices";
import { parseRunId } from "./format";
import { bucketOf, countBuckets, matchesQuery, type RunBucketFilter } from "./runLedger";
import { useRunStop } from "./RunActionBar";
import { runLinkKey, type QueueOrigin } from "./runQueue";
import { RunsTable } from "./RunsTable";
import { refreshFactoryStatus, useFactoryRunsOf } from "./useFactoryData";

export interface ListedEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

/**
 * The Factory page's runs list, reading the runs itself. Its props stay the same while the page's
 * status poll changes nothing they hold, so a poll every few seconds leaves the rows alone; their
 * ages move on with the runs read.
 */
export const FactoryRunsSection = memo(function FactoryRunsSection({
  environments,
  all,
  environment,
  repo,
  bucket,
  query,
  origin,
  returnFocus,
  showEnvironment,
  threads,
  onBucket,
  onQuery,
  onClearFilters,
  onShowAll,
  onShowRecent,
  onNote,
}: {
  /** The environments whose status answered, in the page's order. */
  environments: ReadonlyArray<ListedEnvironment>;
  all: boolean;
  environment: EnvironmentId | null;
  repo: string | null;
  bucket: RunBucketFilter | null;
  query: string;
  origin: QueueOrigin;
  returnFocus: string | undefined;
  showEnvironment: boolean;
  /** The session thread of each unfinished run the status names, by `runLinkKey`. */
  threads: ReadonlyMap<string, string>;
  onBucket: (bucket: RunBucketFilter | null) => void;
  onQuery: (query: string) => void;
  onClearFilters: () => void;
  onShowAll: () => void;
  onShowRecent: () => void;
  onNote: (note: string) => void;
}) {
  const runsOf = useFactoryRunsOf(
    environments.map(({ environmentId }) => environmentId),
    all,
  );
  const stopOf = useRunStop(({ environmentId, label, message }) => {
    onNote(`${label}: ${message}`);
    refreshFactoryStatus(environmentId);
    runsOf[environments.findIndex((entry) => entry.environmentId === environmentId)]?.refresh();
  });
  const nowMs = Math.max(0, ...runsOf.map(({ readAt }) => readAt));
  const shown = environments.flatMap(({ environmentId, label }, i) =>
    environment === null || environmentId === environment ? [{ label, read: runsOf[i]! }] : [],
  );
  const listed = environments.some((_, i) => (runsOf[i]?.data?.runs.length ?? 0) > 0);
  const scoped = shown.flatMap(({ label, read }, i) =>
    (read.data?.runs ?? []).flatMap((run) => {
      const parsed = parseRunId(run.id);
      const runRepo = parsed ? `${parsed.owner}/${parsed.repo}` : null;
      if (repo !== null && runRepo?.toLowerCase() !== repo.toLowerCase()) return [];
      return [{ environmentId: environments[i]!.environmentId, label, run }];
    }),
  );
  const searched = scoped.filter(({ label, run }) => matchesQuery(run, label, query));
  const runs = searched.filter(({ run }) => bucket === null || bucketOf(run) === bucket);
  const runsListed = shown.some(({ read }) => read.data !== null);
  const runsPending = shown.some(({ read }) => read.status === "loading");

  if ((!runsListed || runs.length === 0) && runsPending) {
    return <FactoryLoading label="Loading runs" />;
  }
  if (!runsListed) return null;
  return (
    <RunsTable
      nowMs={nowMs}
      bucket={bucket}
      counts={countBuckets(searched.map(({ run }) => run))}
      onBucket={onBucket}
      onClearFilters={runs.length === 0 && listed ? onClearFilters : undefined}
      onQuery={onQuery}
      origin={origin}
      query={query}
      returnFocus={returnFocus}
      onShowAll={onShowAll}
      onShowRecent={onShowRecent}
      partial={!all}
      runs={runs}
      showEnvironment={showEnvironment}
      stopOf={stopOf}
      threadOf={(environmentId, runId) => threads.get(runLinkKey(environmentId, runId)) ?? null}
    />
  );
});
