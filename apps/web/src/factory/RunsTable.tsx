import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { flushSync } from "react-dom";

import { useMediaQuery } from "~/hooks/useMediaQuery";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Empty, EmptyHeader, EmptyTitle } from "~/components/ui/empty";
import { Input } from "~/components/ui/input";
import { Kbd } from "~/components/ui/kbd";
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
import { issueOf, newestAttempts } from "./belt";
import { Ref } from "./Ref";
import { RunActions, type RunStop } from "./RunActionBar";
import { runActions, type RunActionKind } from "./runActions";
import {
  LEDGER_PAGE,
  RUN_BUCKETS,
  firstOfDays,
  groupByDay,
  type BucketCounts,
  type RunBucketFilter,
} from "./runLedger";
import { runLinkKey, runQueue, useFactoryKeys, type QueueOrigin, type RunQueue } from "./runQueue";

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
  queue,
  actionsOf,
}: {
  entry: EnvironmentRun;
  showEnvironment: boolean;
  nowMs: number;
  queue: RunQueue;
  actionsOf: RunActionsOf;
}) {
  const parsed = parseRunId(run.id);
  return (
    <li className="flex flex-col rounded-lg border bg-card text-sm">
      <Link
        className="flex min-h-11 flex-col gap-1 rounded-lg px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        data-run-link={runLinkKey(environmentId, run.id)}
        params={{ environmentId, runId: run.id }}
        state={{ factoryRunQueue: queue }}
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
      <span className="flex px-3 text-xs text-muted-foreground empty:hidden">
        {actionsOf(environmentId, run, { touch: true })}
      </span>
    </li>
  );
}

/** A run's actions as the list shows them, or null when none can work. */
type RunActionsOf = (
  environmentId: EnvironmentId,
  run: FactoryRunRow,
  options?: {
    readonly touch?: boolean;
    readonly omit?: ReadonlyArray<RunActionKind>;
    readonly className?: string;
  },
) => ReactNode;

/** The ledger's filter row: a state chip per bucket with its count, and a search box. */
function LedgerToolbar({
  counts,
  bucket,
  onBucket,
  query,
  onQuery,
  searchRef,
}: {
  counts: BucketCounts;
  bucket: RunBucketFilter | null;
  onBucket: (bucket: RunBucketFilter | null) => void;
  query: string;
  onQuery: (query: string) => void;
  searchRef: RefObject<HTMLInputElement | null>;
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
          aria-keyshortcuts="/"
          aria-label="Search runs"
          onChange={(event) => onQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            // Escape clears a search, then leaves the box so j and k step the runs again.
            if (query !== "") onQuery("");
            else event.currentTarget.blur();
          }}
          placeholder="Search title, repo or #issue"
          ref={searchRef}
          size="sm"
          type="search"
          value={query}
        />
      </div>
    </div>
  );
}

/** The keys the list answers to, said once above it where there is a keyboard. */
function KeyHints() {
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground pointer-coarse:hidden">
      <span>
        <Kbd>j</Kbd> <Kbd>k</Kbd> step through runs
      </span>
      <span>
        <Kbd>Enter</Kbd> open, where <Kbd>j</Kbd> <Kbd>k</Kbd> keep stepping and <Kbd>Esc</Kbd>{" "}
        comes back
      </span>
      <span>
        <Kbd>/</Kbd> search
      </span>
    </p>
  );
}

/** A day's heading; a day cut short by the page still says how many runs it holds. */
function DayHeading({ label, total }: { label: string; total: number }) {
  return (
    <>
      {label} <span className="font-normal">· {total}</span>
    </>
  );
}

/** The run links in `root`, in the order shown. */
const runLinks = (root: HTMLElement | null) =>
  Array.from(root?.querySelectorAll<HTMLElement>("[data-run-link]") ?? []);

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
  origin,
  returnFocus,
  threadOf,
  stopOf,
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
  /** The page's filters, carried to a run so it can step through this list and come back to it. */
  origin: QueueOrigin;
  /** The run a run page came back from (`runLinkKey`): it takes the focus once, on mount. */
  returnFocus?: string | undefined;
  /** The session thread the status report names for an unfinished run; null where it names none. */
  threadOf: (environmentId: EnvironmentId, runId: string) => string | null;
  /** How a row's Stop stops its run; a row shows Stop only when {@link runActions} offers it. */
  stopOf: (environmentId: EnvironmentId, runId: string, label: string) => RunStop;
}) {
  // Of each environment's runs listed, the newest attempt of each issue; an older attempt's next
  // step is already taken.
  const latest = new Set(
    [...new Set(runs.map(({ environmentId }) => environmentId))].flatMap((environmentId) =>
      newestAttempts(
        runs.filter((entry) => entry.environmentId === environmentId).map(({ run }) => run),
      ).map(({ id }) => runLinkKey(environmentId, id)),
    ),
  );
  const actionsOf: RunActionsOf = (environmentId, run, options = {}) => {
    const { touch = false, omit = [], className } = options;
    if (run.unreadable) return null;
    const actions = runActions({
      id: run.id,
      state: run.state,
      finished: run.finished,
      prUrl: run.pr_url,
      threadId: run.finished ? null : threadOf(environmentId, run.id),
      superseded: !latest.has(runLinkKey(environmentId, run.id)),
    }).filter((action) => !omit.includes(action.kind));
    const label = issueOf(run.id);
    return (
      <RunActions
        actions={actions}
        className={className}
        environmentId={environmentId}
        label={label}
        runId={run.id}
        stop={stopOf(environmentId, run.id, label)}
        touch={touch}
      />
    );
  };
  const cards = useMediaQuery("max-sm");
  // The page size grows with Show more and with j past the last run; a new filter starts over.
  const listKey = JSON.stringify([origin, partial]);
  const [paged, setPaged] = useState({ key: listKey, limit: LEDGER_PAGE });
  const limit = paged.key === listKey ? paged.limit : LEDGER_PAGE;
  const ledger = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const sorted = [...runs].sort(newestFirst);
  const queue = runQueue(
    origin,
    sorted.map(({ environmentId, run }) => ({
      environmentId,
      runId: run.id,
      title: run.title ?? null,
    })),
  );

  // A run page coming back to a run past the page renders down to it.
  const returnAt =
    returnFocus === undefined
      ? -1
      : sorted.findIndex((e) => runLinkKey(e.environmentId, e.run.id) === returnFocus);
  const shown = Math.max(limit, returnAt + 1);
  const { days, hidden } = firstOfDays(
    groupByDay(sorted, (entry) => startedMs(entry.run), nowMs),
    shown,
  );
  const showMore = () => setPaged({ key: listKey, limit: shown + LEDGER_PAGE });
  const more =
    hidden > 0 ? (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>
          Showing {sorted.length - hidden} of {sorted.length}
        </span>
        <Button onClick={showMore} size="sm" variant="outline">
          {`Show ${Math.min(hidden, LEDGER_PAGE)} more`}
        </Button>
      </div>
    ) : null;

  useFactoryKeys((key) => {
    if (key === "search") {
      searchRef.current?.focus();
      return searchRef.current !== null;
    }
    if (key === "back") return false;
    const links = runLinks(ledger.current);
    const at = links.indexOf(document.activeElement as HTMLElement);
    if (key === "next" && at !== -1 && at === links.length - 1 && hidden > 0) {
      flushSync(showMore);
      links.splice(0, links.length, ...runLinks(ledger.current));
    }
    const target = at === -1 ? links[0] : links[key === "next" ? at + 1 : at - 1];
    if (target === undefined) return false;
    target.focus();
    target.scrollIntoView({ block: "nearest" });
    return true;
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves DOM focus to the run left
  useEffect(() => {
    if (returnFocus === undefined) return;
    // The run may be in a bin above the list as well as in it; the list's own link wins.
    const target =
      runLinks(ledger.current).find((link) => link.dataset.runLink === returnFocus) ??
      runLinks(document.body).find((link) => link.dataset.runLink === returnFocus);
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: "center" });
  }, [returnFocus]);
  const toolbar =
    counts.all > 0 || query !== "" || bucket !== null ? (
      <LedgerToolbar
        bucket={bucket}
        counts={counts}
        onBucket={onBucket}
        onQuery={onQuery}
        query={query}
        searchRef={searchRef}
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
  const footer = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      {more}
      {showAll}
    </div>
  );
  if (runs.length === 0) {
    return (
      <div className="contents" data-ledger="" ref={ledger}>
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
      </div>
    );
  }
  if (cards) {
    return (
      <div className="contents" data-ledger="" ref={ledger}>
        {toolbar}
        <KeyHints />
        <ul className="flex flex-col gap-2" data-layout="cards">
          {days.map(({ label, items, total }) => [
            <li
              className="pt-2 text-xs font-medium text-muted-foreground first:pt-0"
              key={`day ${label}`}
              role="presentation"
            >
              <DayHeading label={label} total={total} />
            </li>,
            ...items.map((entry) => (
              <RunCard
                entry={entry}
                key={`${entry.environmentId} ${entry.run.id}`}
                nowMs={nowMs}
                queue={queue}
                showEnvironment={showEnvironment}
                actionsOf={actionsOf}
              />
            )),
          ])}
        </ul>
        {footer}
      </div>
    );
  }
  const columns = showEnvironment ? 8 : 7;
  return (
    <div className="contents" data-ledger="" ref={ledger}>
      {toolbar}
      <KeyHints />
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
            <TableHead>
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {days.map(({ label, items, total }) => [
            <TableRow data-day="" key={`day ${label}`}>
              <TableCell colSpan={columns}>
                <span className="block pt-2 text-xs font-medium text-muted-foreground">
                  <DayHeading label={label} total={total} />
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
                      className="-mx-1 flex min-w-0 flex-col rounded-sm px-1 underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                      data-run-link={runLinkKey(environmentId, run.id)}
                      params={{ environmentId, runId: run.id }}
                      state={{ factoryRunQueue: queue }}
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
                  <TableCell className="text-right">
                    {actionsOf(environmentId, run, {
                      omit: ["issue", "pr"],
                      className: "flex-nowrap",
                    })}
                  </TableCell>
                </TableRow>
              );
            }),
          ])}
        </TableBody>
      </Table>
      {footer}
    </div>
  );
}
