import type { EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useSyncExternalStore } from "react";

import { Badge } from "~/components/ui/badge";
import { Skeleton } from "~/components/ui/skeleton";
import { Switch } from "~/components/ui/switch";
import { cn } from "~/lib/utils";

import type { FactoryStatus } from "./api";
import { nextPassText } from "./belt";
import { BeltDot } from "./BeltDot";
import { machineLine, type MachineTone } from "./machines";
import { TouchLink } from "./TouchLink";
import type { FactoryEnvironment } from "./useFactoryData";

const LABEL = "text-3xs font-semibold uppercase tracking-widest text-muted-foreground";

export const TONE_DOT: Record<MachineTone, string> = {
  loading: "bg-muted-foreground/40",
  down: "bg-destructive",
  running: "bg-success",
  paused: "bg-warning",
  idle: "bg-muted-foreground",
  held: "bg-info",
};

const subscribeToSeconds = (onSecond: () => void) => {
  const timer = setInterval(onSecond, 1000);
  return () => clearInterval(timer);
};
const wholeSecond = () => Math.floor(Date.now() / 1000) * 1000;

/** The clock to the whole second, from a timer of this reader's own: only it renders each second. */
export function useSecond(): number {
  return useSyncExternalStore(subscribeToSeconds, wholeSecond);
}

/** Up to six slots as squares, filled while taken; more, or no limit, as text alone. */
function Slots({ slots: { used, max } }: { slots: FactoryStatus["slots"] }) {
  const text = max === null ? `${used} in flight` : `${used}/${max} slots`;
  return (
    <span className="flex items-center gap-1.5">
      {max !== null && max <= 6 ? (
        <span aria-hidden className="flex gap-0.5" data-station="building">
          {Array.from({ length: max }, (_, i) => (
            <span
              className={cn(
                "size-2 rounded-xs",
                i < used ? "bg-(--factory-station)" : "border border-muted-foreground/50",
              )}
              key={i}
            />
          ))}
        </span>
      ) : null}
      <span className="whitespace-nowrap font-mono">{text}</span>
    </span>
  );
}

function MachineRow({
  environment,
  selected,
  busy,
  nowMs,
  onSelect,
  onTogglePause,
}: {
  environment: FactoryEnvironment;
  selected: boolean;
  busy: boolean;
  nowMs: number;
  onSelect: () => void;
  onTogglePause: () => void;
}) {
  const { environmentId, label, status } = environment;
  const report = status.data;
  const line = machineLine(status);
  // A countdown from a read that has since failed would tick on a pass nobody can see.
  const pass = status.status === "error" ? null : nextPassText(report?.passes, nowMs);
  return (
    <li
      aria-current={selected ? "true" : undefined}
      className={cn(
        "flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-2",
        selected && "bg-accent/50",
      )}
      data-machine={environmentId}
    >
      {/* The switch has no coarse-pointer hit area of its own; the label is the 44 px target. */}
      <label className="inline-flex items-center justify-center pointer-coarse:min-h-11 pointer-coarse:min-w-11">
        <Switch
          aria-label={`Claims on ${label}`}
          checked={report !== null && report.paused_by_hand == null}
          disabled={report === null || busy}
          onCheckedChange={onTogglePause}
        />
      </label>
      <button
        aria-label={`Show ${label} on the belt`}
        aria-pressed={selected}
        className="flex min-w-0 items-center gap-2 rounded-sm text-left text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring pointer-coarse:min-h-11 sm:w-44"
        onClick={onSelect}
        type="button"
      >
        <BeltDot selected={selected} />
        <span className="min-w-0 truncate">{label}</span>
      </button>
      {line.tone === "loading" ? (
        <Skeleton aria-label={`Loading ${label}`} className="h-5 w-24" role="status" />
      ) : (
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
          <span aria-hidden className={cn("size-2 shrink-0 rounded-full", TONE_DOT[line.tone])} />
          <b className="font-semibold">{line.word}</b>
          {line.detail ? (
            <span className="min-w-0 break-words text-muted-foreground">{line.detail}</span>
          ) : null}
          {line.update && line.tone !== "held" ? (
            <Badge size="sm" variant="warning">
              Update waiting
            </Badge>
          ) : null}
          {line.tone === "idle" ? (
            <TouchLink render={<Link search={{ machine: environmentId }} to="/settings/factory" />}>
              Factory settings
            </TouchLink>
          ) : null}
        </span>
      )}
      {report ? (
        <span className="flex flex-wrap items-center gap-x-4 gap-y-0.5 text-xs text-muted-foreground max-sm:basis-full max-sm:pl-14 sm:ml-auto">
          <Slots slots={report.slots} />
          {pass ? <span className="whitespace-nowrap">{pass}</span> : null}
        </span>
      ) : null}
    </li>
  );
}

/**
 * Every machine's factory in one list: its own claims switch, what it is doing, its slots and its
 * next pass, so a paused or held machine shows without picking it. Picking one (its name) makes its
 * tiles solid on the rail and shows its update banner.
 */
export function MachineRoster({
  environments,
  selectedId,
  busy,
  onSelect,
  onTogglePause,
}: {
  environments: ReadonlyArray<FactoryEnvironment>;
  selectedId: EnvironmentId;
  busy: ReadonlySet<EnvironmentId>;
  onSelect: (environmentId: EnvironmentId) => void;
  onTogglePause: (environment: FactoryEnvironment) => void;
}) {
  const nowMs = useSecond();
  const claiming = environments.filter(({ status }) => machineLine(status).tone === "running");
  return (
    <div className="flex flex-col pt-2.5">
      <div className="flex flex-wrap items-baseline gap-x-2 px-5 pb-1">
        <span className={LABEL}>Machines</span>
        <span className="text-xs text-muted-foreground">
          {claiming.length === environments.length
            ? `all ${environments.length} claiming`
            : `${claiming.length} of ${environments.length} claiming`}
        </span>
      </div>
      <ul aria-label="Machines" className="flex flex-col divide-y">
        {environments.map((environment) => (
          <MachineRow
            busy={busy.has(environment.environmentId)}
            environment={environment}
            key={environment.environmentId}
            nowMs={nowMs}
            onSelect={() => onSelect(environment.environmentId)}
            onTogglePause={() => onTogglePause(environment)}
            selected={environment.environmentId === selectedId}
          />
        ))}
      </ul>
    </div>
  );
}
