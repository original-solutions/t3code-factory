import type { EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronDownIcon, FlagIcon, InboxIcon, ShieldCheckIcon, WrenchIcon } from "lucide-react";
import { Fragment, useState, type ComponentType, type RefCallback } from "react";

import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import { useQuietThreadShells } from "~/state/entities";

import {
  fitLane,
  formatClock,
  STATION_META,
  STATIONS,
  type Belt,
  type BeltRun,
  type Station,
} from "./belt";
import { agentCensus, agentPulse, type AgentPulse } from "./agentPulse";
import { BeltDot } from "./BeltDot";
import { TileStrip } from "./TileStrip";
import { BeltReadout, READOUT_ID } from "./BeltReadout";
import { formatAge } from "./format";
import type { RunStop } from "./RunActionBar";

/** A tile is this wide and the gap between tiles this wide, in px: they set how many a lane fits. */
/** Why the selected environment claims nothing new, as the Claimed post says it. */
export type ClaimsHeldWhy =
  | "paused by hand"
  | "held for update"
  | "held for low disk"
  | "held for GitHub sign-in";

const TILE_PX = 60;
const TILE_GAP_PX = 6;

export const STATION_ICON: Readonly<Record<Station, ComponentType<{ className?: string }>>> = {
  claimed: InboxIcon,
  building: WrenchIcon,
  gate: ShieldCheckIcon,
  pr: PullRequestGlyph.pullRequest,
  done: FlagIcon,
};

const NOTE: Readonly<Record<Exclude<Station, "done">, string>> = {
  claimed: "session launching",
  building: "agent session at work",
  gate: "checks before the pull request",
  pr: "watched for review, newest first",
};

/**
 * Where each station sits on a wide belt: its own column, the post in the first row and the lane in
 * the second. Narrow, none of these apply and each post and its lane fill one row, in order.
 * Written out so that Tailwind sees every class.
 */
const PLACEMENT: Readonly<
  Record<Station, { readonly post: string; readonly lane: string; readonly column: string }>
> = {
  claimed: {
    post: "@3xl:col-start-1 @3xl:row-start-1",
    lane: "@3xl:col-start-1 @3xl:row-start-2",
    column: "@3xl:col-start-1",
  },
  building: {
    post: "@3xl:col-start-2 @3xl:row-start-1",
    lane: "@3xl:col-start-2 @3xl:row-start-2",
    column: "@3xl:col-start-2",
  },
  gate: {
    post: "@3xl:col-start-3 @3xl:row-start-1",
    lane: "@3xl:col-start-3 @3xl:row-start-2",
    column: "@3xl:col-start-3",
  },
  pr: {
    post: "@3xl:col-start-4 @3xl:row-start-1",
    lane: "@3xl:col-start-4 @3xl:row-start-2",
    column: "@3xl:col-start-4",
  },
  done: {
    post: "@3xl:col-start-5 @3xl:row-start-1",
    lane: "@3xl:col-start-5 @3xl:row-start-2",
    column: "@3xl:col-start-5",
  },
};

const elapsedOf = (forMs: number | null, nowMs: number) =>
  forMs === null ? "-" : formatAge(nowMs - forMs, nowMs);

/** A post: the station's name, label and run count; picking it opens or folds its readout. */
function Post({
  station,
  count,
  note,
  paused,
  open,
  census,
  onPick,
}: {
  station: Station;
  count: number | string;
  /** The line under the label. */
  note: string;
  /** What the agents of its runs are doing, in place of the note; null when none is here. */
  census: string | null;
  /** Claims are held, by hand, for an update or a low disk: the note says so instead. */
  paused: boolean;
  open: boolean;
  onPick: () => void;
}) {
  const { name, tag } = STATION_META[station];
  const Icon = STATION_ICON[station];
  return (
    <button
      aria-controls={open ? READOUT_ID : undefined}
      aria-expanded={open}
      className={cn(
        "relative flex min-w-0 flex-col justify-center gap-1 rounded-lg @3xl:justify-start border border-t-3 border-t-(--factory-station) bg-card px-2.5 py-2 @3xl:px-3 text-left outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        PLACEMENT[station].post,
        open && "border-(--factory-station) bg-accent/30",
      )}
      data-post={station}
      data-station={station}
      onClick={onPick}
      type="button"
    >
      <span className="flex items-center gap-2">
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate text-sm font-semibold">{name}</span>
        <span className="ml-auto font-mono text-xl font-semibold leading-none" data-part="count">
          {count}
        </span>
        <ChevronDownIcon
          aria-hidden
          className={cn("size-3.5 shrink-0 text-muted-foreground", open && "rotate-180")}
        />
      </span>
      {/* Narrow, a post shares its row with its lane, so only its name, count and a pause show. */}
      {paused ? null : (
        <span className="hidden font-mono text-3xs text-muted-foreground @3xl:block">{tag}</span>
      )}
      {/* The pause note is not a Badge: a Badge never wraps, and the note takes two lines here. */}
      {census !== null && !paused ? (
        <span
          className={cn(
            "hidden text-xs @3xl:block",
            census.includes("you") ? "font-semibold text-warning-foreground" : "text-foreground",
          )}
          data-part="census"
        >
          {census}
        </span>
      ) : note === "" ? null : (
        <span
          className={cn(
            "text-xs",
            paused
              ? "rounded-sm bg-warning/8 px-1.5 py-0.5 font-semibold text-warning-foreground dark:bg-warning/16"
              : "hidden text-muted-foreground @3xl:block",
          )}
        >
          {note}
        </span>
      )}
    </button>
  );
}

/**
 * One run on the rail: a link to its page showing the issue, its environment and its elapsed time.
 * `tileRef` lets the belt's motion find it by the run's key.
 */
function Tile({
  run,
  station,
  mine,
  nowMs,
  pulse,
  tileRef,
}: {
  run: BeltRun;
  station: Station;
  /** What the run's agent is doing, when its thread is in this client. */
  pulse: AgentPulse | null;
  /** Whether the run is in the environment picked in the belt: solid, else hollow. */
  mine: boolean;
  nowMs: number;
  tileRef: RefCallback<HTMLElement>;
}) {
  const elapsed = elapsedOf(run.forMs, nowMs);
  const needsPerson = pulse?.tone === "waiting";
  return (
    <Link
      aria-label={`${run.issue}, ${run.label}, ${elapsed}${pulse ? `, agent ${pulse.word}` : ""}`}
      className={cn(
        "relative flex h-12 w-[60px] shrink-0 flex-col justify-between overflow-hidden rounded-md border px-1.5 pt-2 pb-1 text-foreground outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        mine ? "bg-card" : "border-dashed bg-transparent",
        needsPerson && "border-(--factory-info) bg-warning/8 dark:bg-warning/16",
        pulse?.tone === "failed" && "border-(--factory-stuck)",
      )}
      data-agent-tone={pulse?.tone}
      data-station={station}
      data-tile={run.key}
      params={{ environmentId: run.environmentId, runId: run.id }}
      ref={tileRef}
      to="/factory/$environmentId/$runId"
    >
      <TileStrip pulse={pulse} />
      <span className="font-mono text-xs font-semibold leading-none">{run.issue}</span>
      <span className="flex items-center gap-1 font-mono text-3xs leading-none text-muted-foreground">
        <BeltDot selected={mine} tone={pulse?.tone} />
        <span className="min-w-0 truncate">{elapsed}</span>
      </span>
    </Link>
  );
}

/** The last place of a full lane: how many runs do not fit, and which, in its tooltip. */
function MoreTile({ hidden, onOpen }: { hidden: ReadonlyArray<BeltRun>; onOpen: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            aria-label={`${hidden.length} more runs`}
            className="flex h-12 w-[60px] shrink-0 flex-col items-center justify-center gap-0.5 rounded-md bg-foreground font-mono text-sm font-semibold leading-none text-background outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            onClick={onOpen}
            type="button"
          />
        }
      >
        <span>+{hidden.length}</span>
        <span className="font-sans text-3xs font-medium">more</span>
      </TooltipTrigger>
      <TooltipPopup side="top">{hidden.map((run) => run.issue).join(" · ")}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * The tiles under a post, as many as the lane's measured width holds. Before the first measure every
 * tile shows, and the lane clips rather than wraps or scrolls.
 */
function Lane({
  station,
  runs,
  selectedId,
  nowMs,
  dim,
  pulseOf,
  onOpen,
  tileRef,
}: {
  station: Station;
  runs: ReadonlyArray<BeltRun>;
  selectedId: EnvironmentId;
  nowMs: number;
  dim: boolean;
  pulseOf: (run: BeltRun) => AgentPulse | null;
  onOpen: () => void;
  tileRef: RefCallback<HTMLElement>;
}) {
  const [width, setWidth] = useState<number | null>(null);
  const slots =
    width === null
      ? Number.POSITIVE_INFINITY
      : Math.floor((width + TILE_GAP_PX) / (TILE_PX + TILE_GAP_PX));
  const { shown, hidden } = fitLane(runs.length, slots);
  return (
    <div
      className={cn(
        "flex min-h-16 min-w-0 items-center gap-1.5 overflow-hidden rounded-md border bg-muted/40 px-2.5 py-2",
        PLACEMENT[station].lane,
        dim && "opacity-60 grayscale",
      )}
      data-lane={station}
      data-station={station}
      ref={(node) =>
        node === null
          ? undefined
          : observeResize(node, (entries) => {
              const entry = entries[0];
              if (entry !== undefined) setWidth(entry.contentRect.width);
            })
      }
    >
      {runs.slice(0, shown).map((run) => (
        <Tile
          key={run.key}
          mine={run.environmentId === selectedId}
          nowMs={nowMs}
          pulse={pulseOf(run)}
          run={run}
          station={station}
          tileRef={tileRef}
        />
      ))}
      {hidden > 0 ? <MoreTile hidden={runs.slice(shown)} onOpen={onOpen} /> : null}
      {runs.length === 0 ? (
        <span className="rounded-md border border-dashed px-2 py-1.5 font-mono text-3xs text-muted-foreground">
          clear
        </span>
      ) : null}
    </div>
  );
}

/**
 * The Done post's lane: today's finished runs counted, how they ended, and the latest three; `-`
 * while the recent runs lists it comes from have not all answered.
 */
function DoneBin({ belt, known }: { belt: Belt; known: boolean }) {
  const { merged, closed, latest } = belt.done;
  return (
    <div
      className={cn(
        "flex min-h-16 min-w-0 items-center gap-3 overflow-hidden rounded-md border bg-card px-3 py-2",
        PLACEMENT.done.lane,
      )}
      data-bin="done"
      data-lane="done"
      data-station="done"
    >
      <span className="font-mono text-2xl font-semibold leading-none">
        {known ? merged + closed : "-"}
      </span>
      {known ? (
        <span className="min-w-0 text-2xs leading-snug text-muted-foreground">
          <b className="block font-semibold text-foreground">
            {merged} merged · {closed} closed
          </b>
          <span className="block truncate font-mono">
            {latest.length > 0 ? latest.join(" · ") : "none yet today"}
          </span>
        </span>
      ) : null}
    </div>
  );
}

const shellKey = (environmentId: string, threadId: string) => `${environmentId} ${threadId}`;

/**
 * What each run's agent is doing, from the threads this client already holds, held through
 * streaming ticks: no factory read.
 */
function usePulseOf(): (run: BeltRun) => AgentPulse | null {
  const shells = useQuietThreadShells();
  const byKey = new Map<string, EnvironmentThreadShell>();
  for (const shell of shells) byKey.set(shellKey(shell.environmentId, shell.id), shell);
  return (run) =>
    run.threadId === null || run.finished
      ? null
      : agentPulse(byKey.get(shellKey(run.environmentId, run.threadId)) ?? null);
}

/**
 * Five posts, a lane of tiles under each, and the readout of the picked post. Wide, they are a grid
 * of five columns; narrow, one row per post with its lane beside it, and the readout under the row. The open post is the caller's, so the rail can come and go without losing it.
 */
export function BeltRail({
  belt,
  known,
  selectedId,
  claimsHeld,
  nowMs,
  open,
  onOpenChange,
  stopOf,
  tileRef,
}: {
  belt: Belt;
  /** Whether the recent runs lists the Done post counts from have all answered. */
  known: boolean;
  selectedId: EnvironmentId;
  /** Why and since when the selected environment claims nothing new, or null while it claims. */
  claimsHeld: { readonly why: ClaimsHeldWhy; readonly since: number | null } | null;
  nowMs: number;
  open: Station | null;
  onOpenChange: (station: Station | null) => void;
  stopOf: (run: BeltRun) => RunStop;
  /** On every tile: how the belt's motion finds the element of a run. */
  tileRef: RefCallback<HTMLElement>;
}) {
  const paused = claimsHeld !== null;
  const pulseOf = usePulseOf();
  const noteOf = (station: Station) => {
    if (station === "claimed" && claimsHeld !== null) {
      return claimsHeld.since === null
        ? `claims ${claimsHeld.why}`
        : `claims ${claimsHeld.why} since ${formatClock(claimsHeld.since)}`;
    }
    // The Done bin says what finished.
    return station === "done" ? "" : NOTE[station];
  };
  return (
    <div className="grid grid-cols-[10rem_minmax(0,1fr)] gap-2 @3xl:grid-cols-(--factory-cols) @3xl:gap-y-0">
      {STATIONS.map((station) => (
        <Fragment key={station}>
          <Post
            count={station === "done" && !known ? "-" : belt.runs[station].length}
            census={station === "done" ? null : agentCensus(belt.runs[station].map(pulseOf))}
            note={noteOf(station)}
            onPick={() => onOpenChange(open === station ? null : station)}
            open={open === station}
            paused={station === "claimed" && paused}
            station={station}
          />
          {station === "done" ? (
            <DoneBin belt={belt} known={known} />
          ) : (
            <Lane
              // Held claims stop new runs, not the ones on the rail.
              dim={paused && station === "claimed"}
              nowMs={nowMs}
              onOpen={() => onOpenChange(station)}
              pulseOf={pulseOf}
              runs={belt.runs[station]}
              selectedId={selectedId}
              station={station}
              tileRef={tileRef}
            />
          )}
          {open === station ? (
            <BeltReadout
              column={PLACEMENT[station].column}
              nowMs={nowMs}
              runs={belt.runs[station]}
              selectedId={selectedId}
              station={station}
              stopOf={stopOf}
            />
          ) : null}
        </Fragment>
      ))}
    </div>
  );
}
