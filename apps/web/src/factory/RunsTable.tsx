import { Link } from "@tanstack/react-router";

import { useMediaQuery } from "~/hooks/useMediaQuery";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Empty, EmptyHeader, EmptyTitle } from "~/components/ui/empty";
import { Input } from "~/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";

import type { EnvironmentId } from "@t3tools/contracts";

import type { FactoryRunRow } from "./api";
import {
  formatAge,
  issueRef,
  labelForState,
  parseRunId,
  prRef,
  shownState,
  stateBadgeVariant,
} from "./format";
import { Ref } from "./Ref";
import { RUN_BUCKETS, groupByDay, type BucketCounts, type RunBucketFilter } from "./runLedger";

const startedMs = (run: FactoryRunRow) =>
  run.started_ts ? Date.parse(run.started_ts) : Number.NaN;

/** A run and the environment whose factory ran it. */
export interface EnvironmentRun {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly run: FactoryRunRow;
}

/** Newest first; a run with no readable start goes last. */
const newestFirst = (a: EnvironmentRun, b: EnvironmentRun) => {
  const x = startedMs(a.run);
  const y = startedMs(b.run);
  if (Number.isNaN(x) || Number.isNaN(y)) return Number.isNaN(x) ? (Number.isNaN(y) ? 0 : 1) : -1;
  return y - x;
};

const stateBadge = (run: FactoryRunRow) => {
  if (run.unreadable) return <Badge variant="error">unreadable</Badge>;
  const state = shownState(run.state, run.pr_end);
  return <Badge variant={stateBadgeVariant(state)}>{labelForState(state)}</Badge>;
};

/**
 * One run for a phone: a link to the run that is the card's main tap target, and below it, outside
 * that link so no anchor nests in another, the links to the issue and the pull request.
 */
function RunCard({
  entry: { environmentId, label, run },
  showEnvironment,
  nowMs,
}: {
  entry: EnvironmentRun;
  showEnvironment: boolean;
  nowMs: number;
}) {
  const parsed = parseRunId(run.id);
  const issue = parsed ? issueRef(`${parsed.owner}/${parsed.repo}`, parsed.issue) : null;
  const pr = prRef(run.pr_url);
  return (
    <li className="flex flex-col rounded-lg border bg-card text-sm">
      <Link
        className="flex min-h-11 flex-col gap-1 px-3 py-2"
        params={{ environmentId, runId: run.id }}
        to="/factory/$environmentId/$runId"
      >
        <span className="flex items-start justify-between gap-2">
          <span className="min-w-0 break-words font-medium">
            {run.title ?? (parsed ? `${parsed.owner}/${parsed.repo}` : run.id)}
          </span>
          {stateBadge(run)}
        </span>
        <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          {run.title && parsed ? (
            <span className="min-w-0 break-words">{`${parsed.owner}/${parsed.repo}`}</span>
          ) : null}
          <span className="min-w-0 break-words">{run.step ?? run.last_event ?? "-"}</span>
          <span>{formatAge(startedMs(run), nowMs)}</span>
          {showEnvironment ? <span className="min-w-0 break-words">{label}</span> : null}
        </span>
      </Link>
      {issue || pr ? (
        <span className="flex flex-wrap items-center gap-x-4 px-3 text-xs text-muted-foreground">
          {issue ? <Ref {...issue} touch /> : null}
          {pr ? <Ref {...pr} touch /> : null}
        </span>
      ) : null}
    </li>
  );
}

/** The ledger's filter row: a state chip per bucket with its count, and a search box. */
function LedgerToolbar({
  counts,
  bucket,
  onBucket,
  query,
  onQuery,
}: {
  counts: BucketCounts;
  bucket: RunBucketFilter | null;
  onBucket: (bucket: RunBucketFilter | null) => void;
  query: string;
  onQuery: (query: string) => void;
}) {
  // A chip with no runs is left out unless it is the one picked, so it can be unpicked.
  const chips = RUN_BUCKETS.filter(({ value }) => counts[value] > 0 || value === bucket);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
      <h2 className="text-sm font-medium">Runs</h2>
      <div className="min-w-0 max-w-full overflow-x-auto">
        <ToggleGroup
          aria-label="Run state"
          onValueChange={(next) => {
            const [value] = next;
            // Picking the picked chip again goes back to All.
            onBucket(value === undefined || value === "all" ? null : (value as RunBucketFilter));
          }}
          value={[bucket ?? "all"]}
        >
          <Toggle value="all">
            All <span className="font-mono text-muted-foreground">{counts.all}</span>
          </Toggle>
          {chips.map(({ value, label }) => (
            <Toggle key={value} value={value}>
              {label} <span className="font-mono text-muted-foreground">{counts[value]}</span>
            </Toggle>
          ))}
        </ToggleGroup>
      </div>
      <div className="w-full sm:ml-auto sm:w-64">
        <Input
          aria-label="Search runs"
          onChange={(event) => onQuery(event.currentTarget.value)}
          placeholder="Search title, repo or #issue"
          size="sm"
          type="search"
          value={query}
        />
      </div>
    </div>
  );
}

/**
 * The runs the server listed: by default every unfinished run and the finished ones of the last
 * week (`partial`), kept fresh by the poll, or every run the factory ever made, read once. Newest
 * first, under a heading for each day, with state chips and a search over what is listed.
 */
export function RunsTable({
  runs,
  showEnvironment,
  nowMs,
  partial,
  onShowAll,
  onShowRecent,
  onClearFilters,
  counts,
  bucket,
  onBucket,
  query,
  onQuery,
}: {
  runs: ReadonlyArray<EnvironmentRun>;
  /** Whether several environments are listed, so a run says which one it is from. */
  showEnvironment: boolean;
  nowMs: number;
  partial: boolean;
  onShowAll: () => void;
  onShowRecent: () => void;
  /** Set when the page's filters hid every run listed: the empty state says so and offers this. */
  onClearFilters?: (() => void) | undefined;
  /** Each chip's count among the runs the repo and environment filters keep. */
  counts: BucketCounts;
  bucket: RunBucketFilter | null;
  onBucket: (bucket: RunBucketFilter | null) => void;
  query: string;
  onQuery: (query: string) => void;
}) {
  const cards = useMediaQuery("max-sm");
  const sorted = [...runs].sort(newestFirst);
  const days = groupByDay(sorted, (entry) => startedMs(entry.run), nowMs);
  const toolbar =
    counts.all > 0 || query !== "" || bucket !== null ? (
      <LedgerToolbar
        bucket={bucket}
        counts={counts}
        onBucket={onBucket}
        onQuery={onQuery}
        query={query}
      />
    ) : null;
  const showAll = partial ? (
    <Button onClick={onShowAll} size="sm" variant="ghost">
      Show all runs
    </Button>
  ) : (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span>Every run, read once.</span>
      <Button onClick={onShowRecent} size="sm" variant="ghost">
        Show recent runs
      </Button>
    </div>
  );
  if (runs.length === 0) {
    return (
      <>
        {toolbar}
        <Empty size="compact">
          <EmptyHeader>
            <EmptyTitle>
              {onClearFilters
                ? "No runs match the filter"
                : partial
                  ? "No runs in the last week"
                  : "No runs yet"}
            </EmptyTitle>
          </EmptyHeader>
          {onClearFilters ? (
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button onClick={onClearFilters} size="sm" variant="outline">
                Clear filters
              </Button>
              {showAll}
            </div>
          ) : (
            showAll
          )}
        </Empty>
      </>
    );
  }
  if (cards) {
    return (
      <>
        {toolbar}
        <ul className="flex flex-col gap-2" data-layout="cards">
          {days.map(({ label, items }) => [
            <li
              className="pt-2 text-xs font-medium text-muted-foreground first:pt-0"
              key={`day ${label}`}
              role="presentation"
            >
              {label}
            </li>,
            ...items.map((entry) => (
              <RunCard
                entry={entry}
                key={`${entry.environmentId} ${entry.run.id}`}
                nowMs={nowMs}
                showEnvironment={showEnvironment}
              />
            )),
          ])}
        </ul>
        {showAll}
      </>
    );
  }
  const columns = showEnvironment ? 7 : 6;
  return (
    <>
      {toolbar}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Run</TableHead>
            {showEnvironment ? <TableHead>Environment</TableHead> : null}
            <TableHead>Issue</TableHead>
            <TableHead>State</TableHead>
            <TableHead>Step</TableHead>
            <TableHead>Age</TableHead>
            <TableHead>Pull request</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {days.map(({ label, items }) => [
            <TableRow data-day="" key={`day ${label}`}>
              <TableCell colSpan={columns}>
                <span className="block pt-2 text-xs font-medium text-muted-foreground">
                  {label}
                </span>
              </TableCell>
            </TableRow>,
            ...items.map(({ environmentId, label: environment, run }) => {
              const parsed = parseRunId(run.id);
              const repo = parsed ? `${parsed.owner}/${parsed.repo}` : null;
              const issue = parsed && repo ? issueRef(repo, parsed.issue) : null;
              const pr = prRef(run.pr_url);
              return (
                <TableRow key={`${environmentId} ${run.id}`}>
                  <TableCell className="max-w-0 w-full">
                    <Link
                      className="flex min-w-0 flex-col underline-offset-2 hover:underline"
                      params={{ environmentId, runId: run.id }}
                      to="/factory/$environmentId/$runId"
                    >
                      <span className="truncate font-medium">{run.title ?? repo ?? run.id}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {run.title && repo ? `${repo} · ` : ""}
                        <span className="font-mono">{run.id}</span>
                      </span>
                    </Link>
                  </TableCell>
                  {showEnvironment ? <TableCell>{environment}</TableCell> : null}
                  <TableCell>{issue ? <Ref {...issue} /> : "-"}</TableCell>
                  <TableCell>{stateBadge(run)}</TableCell>
                  <TableCell>{run.step ?? run.last_event ?? "-"}</TableCell>
                  <TableCell>{formatAge(startedMs(run), nowMs)}</TableCell>
                  <TableCell>{pr ? <Ref {...pr} /> : "-"}</TableCell>
                </TableRow>
              );
            }),
          ])}
        </TableBody>
      </Table>
      {showAll}
    </>
  );
}
