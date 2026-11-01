import type { EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import { Skeleton } from "~/components/ui/skeleton";
import { cn } from "~/lib/utils";

import type { FactoryAttentionItem } from "./api";
import type { BeltRun } from "./belt";
import { BeltDot } from "./BeltDot";
import { FactoryCard, FactoryCardHeader } from "./FactoryCard";
import { foldSignedOut } from "./gitHubSignIn";
import { formatAge, issueRef, parseRunId, withoutRepoPrefix } from "./format";
import { JUMP_TARGET_CLASS, jumpTarget } from "./pageSections";
import { Ref } from "./Ref";
import { stuckCauses } from "./stuckCauses";
import { runLinkKey, runQueue, type QueueOrigin, type RunQueue } from "./runQueue";
import { TouchLink } from "./TouchLink";

/** An open attention item and the environment whose factory raised it. */
export interface EnvironmentAttention {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly item: FactoryAttentionItem;
}

/** Where an item leads: its run's page, the factory settings for the machine config, or nowhere. */
function ItemLink({
  environmentId,
  item,
}: {
  environmentId: EnvironmentId;
  item: FactoryAttentionItem;
}) {
  if (item.run !== null) {
    return (
      <TouchLink
        render={
          <Link params={{ environmentId, runId: item.run }} to="/factory/$environmentId/$runId" />
        }
      >
        View run
      </TouchLink>
    );
  }
  if (item.kind === "config") {
    return (
      <TouchLink render={<Link search={{ machine: environmentId }} to="/settings/factory" />}>
        Factory settings
      </TouchLink>
    );
  }
  return null;
}

/** Past this many characters an item's message folds to three lines until asked for the rest. */
const LONG_MESSAGE = 180;

/** One attention item: what raised it and where, its message, where it leads and its Dismiss. */
function AttentionItem({
  entry,
  showEnvironment,
  nowMs,
  onDismiss,
}: {
  entry: EnvironmentAttention;
  showEnvironment: boolean;
  nowMs: number;
  onDismiss: (items: ReadonlyArray<EnvironmentAttention>) => void;
}) {
  const { environmentId, label, item } = entry;
  const message = withoutRepoPrefix(item.message, item.repo);
  const long = message.length > LONG_MESSAGE;
  const [whole, setWhole] = useState(false);
  return (
    <li className="flex flex-col gap-1 py-2 text-sm first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span aria-hidden className="size-2 shrink-0 rounded-full bg-(--factory-info)" />
        <span className="font-medium">{item.kind}</span>
        {item.repo ? (
          <span className="min-w-0 break-all font-mono text-muted-foreground">
            {item.issue !== null ? (
              <Ref
                href={issueRef(item.repo, String(item.issue)).href}
                text={`${item.repo}#${item.issue}`}
              />
            ) : (
              item.repo
            )}
          </span>
        ) : null}
        {showEnvironment ? (
          <span className="min-w-0 break-words text-muted-foreground">{label}</span>
        ) : null}
        <span className="ml-auto text-muted-foreground">
          {formatAge(Date.parse(item.first_seen), nowMs)}
        </span>
      </div>
      <p className={cn("w-full break-words", long && !whole && "line-clamp-3")}>{message}</p>
      <div className="flex flex-wrap items-center gap-x-3">
        <ItemLink environmentId={environmentId} item={item} />
        {long ? (
          <Button aria-expanded={whole} onClick={() => setWhole(!whole)} size="xs" variant="ghost">
            {whole ? "Less" : "More"}
          </Button>
        ) : null}
        <Button className="ml-auto" onClick={() => onDismiss([entry])} size="xs" variant="ghost">
          Dismiss
        </Button>
      </div>
    </li>
  );
}

const repoNames = (repos: ReadonlyArray<string>) => {
  const shown = repos.slice(0, 3).map((repo) => repo.split("/").pop() ?? repo);
  return repos.length > 3 ? `${shown.join(", ")} and ${repos.length - 3} more` : shown.join(", ");
};

/**
 * One environment's signed-out gh: one item, since every repo read and the pass fail on it, with
 * the way to the sign-in command and one Dismiss for all of them.
 */
function SignedOutItem({
  entries,
  repos,
  firstSeen,
  showEnvironment,
  nowMs,
  onDismiss,
}: {
  entries: ReadonlyArray<EnvironmentAttention>;
  repos: ReadonlyArray<string>;
  firstSeen: string;
  showEnvironment: boolean;
  nowMs: number;
  onDismiss: (items: ReadonlyArray<EnvironmentAttention>) => void;
}) {
  const { environmentId, label } = entries[0]!;
  const [whole, setWhole] = useState(false);
  return (
    <li className="flex flex-col gap-1 py-2 text-sm first:pt-0 last:pb-0" data-signed-out="">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span aria-hidden className="size-2 shrink-0 rounded-full bg-(--factory-stuck)" />
        <span className="font-medium">GitHub sign-in</span>
        {showEnvironment ? (
          <span className="min-w-0 break-words text-muted-foreground">{label}</span>
        ) : null}
        <span className="ml-auto text-muted-foreground">
          {formatAge(Date.parse(firstSeen), nowMs)}
        </span>
      </div>
      <p className="w-full break-words">
        {repos.length === 0
          ? "The factory's gh is signed out, so its passes cannot read GitHub."
          : `The factory's gh is signed out, so it cannot read ${
              repos.length === 1
                ? repos[0]
                : `any of its ${repos.length} repos: ${repoNames(repos)}`
            }.`}{" "}
        No issue is claimed until it signs in.
      </p>
      {whole ? (
        <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
          {entries.map(({ item }) => (
            <li className="break-words" key={item.id}>
              {item.repo === null ? null : <span className="font-mono">{item.repo}: </span>}
              {withoutRepoPrefix(item.message, item.repo)}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-3">
        <TouchLink render={<Link search={{ machine: environmentId }} to="/settings/factory" />}>
          Sign in
        </TouchLink>
        <Button aria-expanded={whole} onClick={() => setWhole(!whole)} size="xs" variant="ghost">
          {whole ? "Hide what gh said" : `What gh said (${entries.length})`}
        </Button>
        <Button className="ml-auto" onClick={() => onDismiss(entries)} size="xs" variant="ghost">
          Dismiss
        </Button>
      </div>
    </li>
  );
}

/**
 * The open attention items in the order given, or a line saying none needs a person. With
 * `showEnvironment` each says which environment raised it. `onDismiss` gets the items to dismiss:
 * one, or every item shown for Dismiss all.
 */
function AttentionSection({
  items,
  showEnvironment,
  nowMs,
  onDismiss,
}: {
  items: ReadonlyArray<EnvironmentAttention>;
  showEnvironment: boolean;
  nowMs: number;
  onDismiss: (items: ReadonlyArray<EnvironmentAttention>) => void;
}) {
  const rows = foldSignedOut(items);
  return (
    <FactoryCard
      aria-label="Needs attention"
      className={JUMP_TARGET_CLASS}
      {...jumpTarget("attention")}
    >
      <FactoryCardHeader
        aside={
          <>
            {items.length === 0 ? null : (
              <Button onClick={() => onDismiss(items)} size="xs" variant="ghost">
                Dismiss all
              </Button>
            )}
            <span className="font-mono text-lg font-semibold leading-none">{rows.length}</span>
          </>
        }
        title="Needs attention"
      />
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing needs a person.</p>
      ) : (
        <ul className="flex max-h-96 flex-col divide-y overflow-y-auto">
          {rows.map((row) =>
            row.kind === "one" ? (
              <AttentionItem
                entry={row.entry}
                key={`${row.entry.environmentId} ${row.entry.item.id}`}
                nowMs={nowMs}
                onDismiss={onDismiss}
                showEnvironment={showEnvironment}
              />
            ) : (
              <SignedOutItem
                entries={row.entries}
                firstSeen={row.firstSeen}
                key={`${row.environmentId} signed-out`}
                nowMs={nowMs}
                onDismiss={onDismiss}
                repos={row.repos}
                showEnvironment={showEnvironment}
              />
            ),
          )}
        </ul>
      )}
    </FactoryCard>
  );
}

/** A bin's runs as a queue to step through, when the page said where to come back to. */
const binQueue = (origin: QueueOrigin | undefined, runs: ReadonlyArray<BeltRun>) =>
  origin === undefined
    ? undefined
    : runQueue(
        origin,
        runs.map((run) => ({ environmentId: run.environmentId, runId: run.id, title: run.title })),
      );

/** One run in a bin: its issue as a link to the run, the title, where and when, and the text below. */
function BinRun({
  run,
  text,
  selectedId,
  nowMs,
  queue,
}: {
  run: BeltRun;
  text: string | null;
  selectedId: EnvironmentId;
  nowMs: number;
  queue: RunQueue | undefined;
}) {
  const repo = parseRunId(run.id)?.repo;
  return (
    <li className="flex flex-col gap-0.5 py-2 text-sm first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <TouchLink
          className="font-mono font-semibold"
          render={
            <Link
              data-run-link={runLinkKey(run.environmentId, run.id)}
              params={{ environmentId: run.environmentId, runId: run.id }}
              state={queue ? { factoryRunQueue: queue } : {}}
              to="/factory/$environmentId/$runId"
            />
          }
        >
          {run.issue}
        </TouchLink>
        {run.title === null ? null : <span className="min-w-0 break-words">{run.title}</span>}
      </div>
      <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
        <BeltDot selected={run.environmentId === selectedId} />
        {run.label}
        {repo === undefined ? null : <span className="min-w-0 break-all font-mono">· {repo}</span>}
        {Number.isNaN(run.startedMs) ? null : (
          <span className="ml-auto">{formatAge(run.startedMs, nowMs)}</span>
        )}
      </span>
      {text ? (
        <p className="line-clamp-2 break-words text-xs text-muted-foreground">{text}</p>
      ) : null}
    </li>
  );
}

/**
 * Stuck runs by cause, each a fold with its count: the cause is said once on its fold, and each run
 * shows what is left of its reason. A lone cause starts open; folded runs stay mounted, so a find in
 * the page still reaches them.
 */
function StuckCauses({
  runs,
  selectedId,
  nowMs,
  origin,
}: {
  runs: ReadonlyArray<BeltRun>;
  selectedId: EnvironmentId;
  nowMs: number;
  origin: QueueOrigin | undefined;
}) {
  const causes = stuckCauses(runs);
  // Stepping from a stuck run goes cause by cause, as the folds read.
  const queue = binQueue(
    origin,
    causes.flatMap(({ entries }) => entries.map(({ run }) => run)),
  );
  return (
    <div className="flex max-h-96 flex-col divide-y overflow-y-auto">
      {causes.map(({ cause, entries }) => (
        <Collapsible data-cause={cause} defaultOpen={causes.length === 1} key={cause}>
          <CollapsibleTrigger className="group/cause flex min-h-9 w-full items-center gap-2 py-1.5 rounded-sm text-left text-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring pointer-coarse:min-h-11">
            <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-panel-open/cause:rotate-90" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="break-words font-medium">{cause}</span>
              <span className="truncate font-mono text-xs text-muted-foreground group-data-panel-open/cause:hidden">
                {entries.map(({ run }) => run.issue).join(" ")}
              </span>
            </span>
            <span className="shrink-0 font-mono text-xs text-muted-foreground">
              {entries.length}
            </span>
          </CollapsibleTrigger>
          <CollapsiblePanel animate={false} keepMounted>
            <ul className="mb-2 ml-1.5 flex flex-col divide-y border-l border-(--factory-station)/40 pl-3">
              {entries.map(({ run, detail }) => (
                <BinRun
                  key={run.key}
                  nowMs={nowMs}
                  queue={queue}
                  run={run}
                  selectedId={selectedId}
                  text={detail}
                />
              ))}
            </ul>
          </CollapsiblePanel>
        </Collapsible>
      ))}
    </div>
  );
}

/**
 * A bin of the runs whose newest attempt waits for a person: each issue as a link to its run, its
 * title (the number alone without one), its environment, repo and age, and the stored reason as
 * plain text, clamped to two lines. Stuck groups its runs by cause. Until the lists it is made from
 * have answered it shows a skeleton, not an empty bin.
 */
function Bin({
  name,
  station,
  runs,
  empty,
  known,
  selectedId,
  nowMs,
  origin,
}: {
  name: string;
  station: "stuck" | "info";
  runs: ReadonlyArray<BeltRun>;
  empty: string;
  known: boolean;
  selectedId: EnvironmentId;
  nowMs: number;
  origin: QueueOrigin | undefined;
}) {
  const queue = station === "info" ? binQueue(origin, runs) : undefined;
  return (
    <FactoryCard
      aria-label={name}
      className={JUMP_TARGET_CLASS}
      data-bin={station}
      data-station={station}
      rail
      {...jumpTarget(station)}
    >
      <FactoryCardHeader
        aside={
          <span className="font-mono text-lg font-semibold leading-none" data-part="count">
            {known ? runs.length : "-"}
          </span>
        }
        title={
          <>
            <span aria-hidden className="size-2.5 rounded-xs bg-(--factory-station)" />
            {name}
          </>
        }
      />
      {!known ? (
        <Skeleton aria-label={`Loading ${name}`} className="h-5 w-full" role="status" />
      ) : runs.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : station === "stuck" ? (
        <StuckCauses nowMs={nowMs} origin={origin} runs={runs} selectedId={selectedId} />
      ) : (
        <ul className="flex max-h-72 flex-col divide-y overflow-y-auto">
          {runs.map((run) => (
            <BinRun
              key={run.key}
              nowMs={nowMs}
              queue={queue}
              run={run}
              selectedId={selectedId}
              text={run.reason}
            />
          ))}
        </ul>
      )}
    </FactoryCard>
  );
}

/**
 * Under the belt: Attention, Needs info and Stuck, side by side while there is room for each and
 * stacked when there is not. Every bin keeps its place, empty or not.
 */
export function BeltLowerRow({
  attention,
  known,
  needsInfo,
  stuck,
  selectedId,
  showEnvironment,
  nowMs,
  onDismiss,
  origin,
}: {
  attention: ReadonlyArray<EnvironmentAttention>;
  /** Whether the recent runs lists the bins are made from have all answered. */
  known: boolean;
  needsInfo: ReadonlyArray<BeltRun>;
  stuck: ReadonlyArray<BeltRun>;
  selectedId: EnvironmentId;
  showEnvironment: boolean;
  nowMs: number;
  onDismiss: (items: ReadonlyArray<EnvironmentAttention>) => void;
  origin?: QueueOrigin | undefined;
}) {
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,18rem),1fr))] items-start gap-4">
      <AttentionSection
        items={attention}
        nowMs={nowMs}
        onDismiss={onDismiss}
        showEnvironment={showEnvironment}
      />
      <Bin
        empty="Nothing needs info."
        known={known}
        name="Needs info"
        runs={needsInfo}
        nowMs={nowMs}
        origin={origin}
        selectedId={selectedId}
        station="info"
      />
      <Bin
        empty="Nothing is stuck."
        known={known}
        name="Stuck"
        runs={stuck}
        nowMs={nowMs}
        origin={origin}
        selectedId={selectedId}
        station="stuck"
      />
    </div>
  );
}
