import { Link } from "@tanstack/react-router";

import { useMediaQuery } from "~/hooks/useMediaQuery";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Empty, EmptyHeader, EmptyTitle } from "~/components/ui/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";

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
            {parsed ? `${parsed.owner}/${parsed.repo}` : run.id}
          </span>
          {stateBadge(run)}
        </span>
        <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
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

/**
 * The runs the server listed: by default every unfinished run and the finished ones of the last
 * week (`partial`), kept fresh by the poll, or every run the factory ever made, read once.
 */
export function RunsTable({
  runs,
  showEnvironment,
  nowMs,
  partial,
  onShowAll,
  onShowRecent,
  onClearFilters,
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
}) {
  const cards = useMediaQuery("max-sm");
  const sorted = [...runs].sort(newestFirst);
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
    );
  }
  if (cards) {
    return (
      <>
        <ul className="flex flex-col gap-2" data-layout="cards">
          {sorted.map((entry) => (
            <RunCard
              entry={entry}
              key={`${entry.environmentId} ${entry.run.id}`}
              nowMs={nowMs}
              showEnvironment={showEnvironment}
            />
          ))}
        </ul>
        {showAll}
      </>
    );
  }
  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Repo</TableHead>
            {showEnvironment ? <TableHead>Environment</TableHead> : null}
            <TableHead>Issue</TableHead>
            <TableHead>State</TableHead>
            <TableHead>Step</TableHead>
            <TableHead>Age</TableHead>
            <TableHead>Pull request</TableHead>
            <TableHead>Run</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map(({ environmentId, label, run }) => {
            const parsed = parseRunId(run.id);
            const issue = parsed ? issueRef(`${parsed.owner}/${parsed.repo}`, parsed.issue) : null;
            const pr = prRef(run.pr_url);
            return (
              <TableRow key={`${environmentId} ${run.id}`}>
                <TableCell>{parsed ? `${parsed.owner}/${parsed.repo}` : "-"}</TableCell>
                {showEnvironment ? <TableCell>{label}</TableCell> : null}
                <TableCell>{issue ? <Ref {...issue} /> : "-"}</TableCell>
                <TableCell>{stateBadge(run)}</TableCell>
                <TableCell>{run.step ?? run.last_event ?? "-"}</TableCell>
                <TableCell>{formatAge(startedMs(run), nowMs)}</TableCell>
                <TableCell>{pr ? <Ref {...pr} /> : "-"}</TableCell>
                <TableCell>
                  <Link
                    className="font-mono text-xs underline-offset-2 hover:underline"
                    params={{ environmentId, runId: run.id }}
                    to="/factory/$environmentId/$runId"
                  >
                    {run.id}
                  </Link>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {showAll}
    </>
  );
}
