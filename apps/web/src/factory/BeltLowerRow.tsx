import type { EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";

import type { FactoryAttentionItem } from "./api";
import type { BeltRun } from "./belt";
import { BeltDot } from "./BeltDot";
import { formatAge, issueRef } from "./format";
import { Ref } from "./Ref";
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
    <section aria-label="Needs attention" className="flex min-w-0 flex-col gap-2">
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

/**
 * A bin of the runs whose newest attempt waits for a person: each issue as a link to its run, its
 * title (the number alone without one), its environment and the stored reason as plain text,
 * clamped to two lines. Until the lists it is made from have answered it shows a skeleton, not an
 * empty bin.
 */
function Bin({
  name,
  station,
  runs,
  empty,
  known,
  selectedId,
}: {
  name: string;
  station: "stuck" | "info";
  runs: ReadonlyArray<BeltRun>;
  empty: string;
  known: boolean;
  selectedId: EnvironmentId;
}) {
  return (
    <section
      aria-label={name}
      className="flex min-w-0 flex-col gap-2 rounded-lg border border-t-3 border-t-(--factory-station) bg-card px-3 py-2.5"
      data-station={station}
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
      ) : (
        <ul className="flex max-h-72 flex-col divide-y overflow-y-auto">
          {runs.map((run) => (
            <li className="flex flex-col gap-0.5 py-2 text-sm first:pt-0 last:pb-0" key={run.key}>
              <div className="flex flex-wrap items-baseline gap-x-2">
                <TouchLink
                  className="font-mono font-semibold"
                  render={
                    <Link
                      params={{ environmentId: run.environmentId, runId: run.id }}
                      to="/factory/$environmentId/$runId"
                    />
                  }
                >
                  {run.issue}
                </TouchLink>
                {run.title === null ? null : (
                  <span className="min-w-0 break-words">{run.title}</span>
                )}
              </div>
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <BeltDot selected={run.environmentId === selectedId} />
                {run.label}
              </span>
              {run.reason ? (
                <p className="line-clamp-2 break-words text-xs text-muted-foreground">
                  {run.reason}
                </p>
              ) : null}
            </li>
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
        selectedId={selectedId}
        station="info"
      />
      <Bin
        empty="Nothing is stuck."
        known={known}
        name="Stuck"
        runs={stuck}
        selectedId={selectedId}
        station="stuck"
      />
    </div>
  );
}
