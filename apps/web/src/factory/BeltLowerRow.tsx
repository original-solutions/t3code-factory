import type { EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import { Skeleton } from "~/components/ui/skeleton";
import { cn } from "~/lib/utils";

import type { FactoryAttentionItem } from "./api";
import type { BeltRun } from "./belt";
import { BeltDot } from "./BeltDot";
import { formatAge, issueRef, parseRunId } from "./format";
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
  return (
    <section
      aria-label="Needs attention"
      className={cn("flex min-w-0 flex-col gap-2 rounded-lg", JUMP_TARGET_CLASS)}
      {...jumpTarget("attention")}
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium">Needs attention</h2>
        {items.length === 0 ? null : (
          <Button onClick={() => onDismiss(items)} size="sm" variant="ghost">
            Dismiss all
          </Button>
        )}
      </div>
      {items.length === 0 ? (
        <p className="rounded-lg border bg-card px-3 py-2 text-sm text-muted-foreground">
          Nothing needs a person.
        </p>
      ) : null}
      <ul className="flex flex-col gap-2">
        {items.map((entry) => {
          const { environmentId, label, item } = entry;
          return (
            <li
              className="flex flex-col gap-1 rounded-lg border bg-card px-3 py-2 text-sm"
              key={`${environmentId} ${item.id}`}
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <Badge variant="warning">{item.kind}</Badge>
                {item.repo ? (
                  <span className="min-w-0 break-all font-mono text-xs">
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
                  <span className="min-w-0 break-words text-xs text-muted-foreground">{label}</span>
                ) : null}
                <span className="ml-auto text-xs text-muted-foreground">
                  {formatAge(Date.parse(item.first_seen), nowMs)}
                </span>
              </div>
              <p className="w-full break-words">{item.message}</p>
              <div className="flex items-center justify-between gap-3">
                <ItemLink environmentId={environmentId} item={item} />
                <div className="ml-auto">
                  <Button onClick={() => onDismiss([entry])} size="sm" variant="ghost">
                    Dismiss
                  </Button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
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
    <section
      aria-label={name}
      className={cn(
        "flex min-w-0 flex-col gap-2 rounded-lg border border-t-3 border-t-(--factory-station) bg-card px-3 py-2.5",
        JUMP_TARGET_CLASS,
      )}
      data-bin={station}
      data-station={station}
      {...jumpTarget(station)}
    >
      <div className="flex items-center gap-2">
        <span aria-hidden className="size-2.5 rounded-xs bg-(--factory-station)" />
        <h2 className="text-sm font-medium">{name}</h2>
        <span className="ml-auto font-mono text-lg font-semibold leading-none">
          {known ? runs.length : "-"}
        </span>
      </div>
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
    </section>
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
