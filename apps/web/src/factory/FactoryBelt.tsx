import type { EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useState, useSyncExternalStore } from "react";

import { Skeleton } from "~/components/ui/skeleton";
import { Switch } from "~/components/ui/switch";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";

import { factoryApi, type FactoryRunRow, type FactoryStatus } from "./api";
import { deriveBelt, nextPassText, type BeltRun, type Station } from "./belt";
import "./belt.css";
import { BeltDot } from "./BeltDot";
import { BeltLowerRow, type EnvironmentAttention } from "./BeltLowerRow";
import { BeltRail } from "./BeltRail";
import { FactoryReadFailure } from "./FactoryNotices";
import { messageOf } from "./format";
import { TouchLink } from "./TouchLink";
import type { FactoryEnvironment, FactoryResource } from "./useFactoryData";

const LABEL = "text-3xs font-semibold uppercase tracking-widest text-muted-foreground";

const slotsText = ({ used, max }: FactoryStatus["slots"]) =>
  max === null ? `${used}` : `${used}/${max}`;

const subscribeToSeconds = (onSecond: () => void) => {
  const timer = setInterval(onSecond, 1000);
  return () => clearInterval(timer);
};
const wholeSecond = () => Math.floor(Date.now() / 1000) * 1000;

/**
 * The seconds to the next pass, or that one is running: ticking once a second from this component's
 * own timer, so nothing else on the page renders each second. Nothing before the factory has said.
 */
function NextPass({ passes }: { passes: FactoryStatus["passes"] | undefined }) {
  const nowMs = useSyncExternalStore(subscribeToSeconds, wholeSecond);
  const text = nextPassText(passes, nowMs);
  if (text === null) return null;
  return (
    <div className="flex flex-col justify-center gap-1.5 border-l px-5 py-2.5">
      <span className={LABEL}>Pass loop</span>
      <b className="text-sm font-semibold">{text}</b>
    </div>
  );
}

/** A counter; `-` is one that is not known yet. */
function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex flex-col justify-center gap-1.5 border-l px-5 py-2.5">
      <dt className={LABEL}>{label}</dt>
      <dd className="font-mono text-2xl font-semibold leading-none">{value}</dd>
    </div>
  );
}

/**
 * The claims switch of the selected environment and its state, the pass line, the environment's
 * slots, and the counters over every environment (`-` while a recent runs list they come from has
 * not answered). The switch is on while claims run; an environment with no status says nothing
 * about its claims and cannot be switched.
 */
function ControlBar({
  selected,
  busy,
  counters,
  onTogglePause,
}: {
  selected: FactoryEnvironment;
  busy: boolean;
  counters: {
    readonly runsToday: number | string;
    readonly mergedToday: number | string;
    readonly stuck: number | string;
  };
  onTogglePause: (environment: FactoryEnvironment) => void;
}) {
  const report = selected.status.data;
  const paused = report?.paused_by_hand != null;
  return (
    <section
      aria-label="Controls"
      className="flex flex-wrap items-stretch rounded-lg border bg-card"
    >
      <div className="flex items-center gap-3 px-5 py-2.5">
        {/* The switch has no coarse-pointer hit area of its own; the label is the 44 px target. */}
        <label className="inline-flex items-center justify-center pointer-coarse:min-h-11 pointer-coarse:min-w-11">
          <Switch
            aria-label={`Claims on ${selected.label}`}
            checked={report !== null && !paused}
            disabled={report === null || busy}
            onCheckedChange={() => onTogglePause(selected)}
          />
        </label>
        <div className="flex flex-col gap-1">
          <span className={LABEL}>Claims</span>
          <b className="text-sm font-semibold">
            {report === null
              ? "-"
              : paused
                ? "Paused"
                : report.state === "idle"
                  ? "Idle"
                  : "Running"}
          </b>
        </div>
      </div>
      <NextPass passes={report?.passes} />
      <dl className="m-0 flex flex-wrap items-stretch">
        {report ? <Stat label="Slots" value={slotsText(report.slots)} /> : null}
        <Stat label="Runs today" value={counters.runsToday} />
        <Stat label="Merged today" value={counters.mergedToday} />
        <Stat label="Stuck" value={counters.stuck} />
      </dl>
    </section>
  );
}

/** What one environment has to say besides its place in the control: loading, failing or idle. */
function EnvironmentNote({
  environment: { environmentId, label, status },
}: {
  environment: FactoryEnvironment;
}) {
  const report = status.data;
  // Before any data there is no slot to show, so the read-failure notice stands in its place; once
  // data exists the page shows the same notice below the belt.
  if (report === null && status.status === "error") {
    return (
      <FactoryReadFailure
        label={label}
        message={messageOf(status.error)}
        onRetry={status.refresh}
        verb="read"
      />
    );
  }
  if (report === null) {
    return (
      <div className="flex items-center gap-3 text-sm">
        <span className="min-w-0 break-words font-medium">{label}</span>
        <Skeleton aria-label={`Loading ${label}`} className="h-5 w-24" role="status" />
      </div>
    );
  }
  // The factory idles only for want of a machine config that loads.
  if (report.state !== "idle") return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      <span className="min-w-0 break-words font-medium">{label}</span>
      <span className="min-w-0 break-words text-muted-foreground">
        {report.reason ? `Idle: ${report.reason}` : "Idle"}
      </span>
      <TouchLink render={<Link search={{ machine: environmentId }} to="/settings/factory" />}>
        Factory settings
      </TouchLink>
    </div>
  );
}

/** Every factory environment as a segmented control with its slots, and the notes that some need. */
function Environments({
  environments,
  selectedId,
  onSelect,
}: {
  environments: ReadonlyArray<FactoryEnvironment>;
  selectedId: EnvironmentId;
  onSelect: (environmentId: EnvironmentId) => void;
}) {
  const notes = environments.filter(
    ({ status }) => status.data === null || status.data.state === "idle",
  );
  return (
    <section aria-label="Factories" className="flex flex-col gap-2">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <span className={LABEL}>Environment</span>
        <div className="min-w-0 max-w-full overflow-x-auto">
          <ToggleGroup
            aria-label="Environments"
            onValueChange={(next) => {
              // Picking the picked one again would leave none picked.
              const [id] = next;
              if (id !== undefined) onSelect(id as EnvironmentId);
            }}
            value={[selectedId]}
          >
            {environments.map(({ environmentId, label, status }) => (
              <Toggle key={environmentId} value={environmentId}>
                <BeltDot selected={environmentId === selectedId} />
                {label}
                {status.data ? (
                  <span className="font-mono text-muted-foreground">
                    {slotsText(status.data.slots)} slots
                  </span>
                ) : null}
              </Toggle>
            ))}
          </ToggleGroup>
        </div>
      </div>
      {notes.map((environment) => (
        <EnvironmentNote environment={environment} key={environment.environmentId} />
      ))}
    </section>
  );
}

/**
 * The control station at the top of the Factory page: environments, control bar, the rail with the
 * picked post's readout, then Attention, Needs info and Stuck. The rail spans every environment
 * (the selected one's tiles solid), the control bar acts on the selected one, and the layout keys
 * off the belt's own width, as the app's sidebar takes some of the page's.
 */
export function FactoryBelt({
  environments,
  recent,
  busy,
  nowMs,
  onTogglePause,
  attention,
  showEnvironment,
  onDismiss,
}: {
  /** Every factory environment, the primary first. */
  environments: ReadonlyArray<FactoryEnvironment>;
  /** The recent runs list of each environment whose status answered. */
  recent: ReadonlyMap<
    EnvironmentId,
    FactoryResource<{ readonly runs: ReadonlyArray<FactoryRunRow> }>
  >;
  /** The environments with a pause or resume in flight. */
  busy: ReadonlySet<EnvironmentId>;
  nowMs: number;
  onTogglePause: (environment: FactoryEnvironment) => void;
  /** The attention items to show, after the page's dismissals and filters. */
  attention: ReadonlyArray<EnvironmentAttention>;
  showEnvironment: boolean;
  onDismiss: (items: ReadonlyArray<EnvironmentAttention>) => void;
}) {
  const [pickedId, setPickedId] = useState<EnvironmentId | null>(null);
  // The open post: undefined until the rail first has something to look at, then the user's.
  const [open, setOpen] = useState<Station | null | undefined>(undefined);
  // The runs with a stop in flight, and the answer of the latest stop, which names its run: they
  // outlive the readout.
  const [stopping, setStopping] = useState<ReadonlySet<string>>(() => new Set());
  const [stopNote, setStopNote] = useState<string | null>(null);
  // The environment picked, else the first (the primary): one that has gone is no longer picked.
  const selected =
    environments.find(({ environmentId }) => environmentId === pickedId) ?? environments[0];
  const belt = deriveBelt(
    environments.map(({ environmentId, label, status }) => ({
      environmentId,
      label,
      active: status.data?.runs ?? [],
      recent: recent.get(environmentId)?.data?.runs ?? [],
    })),
    nowMs,
  );
  // What the recent runs lists say (the counters, Done, the bins, and the rail's first pick) is known
  // once some status has answered and no answered environment's list is still loading. A list that
  // failed before its first answer adds nothing; the page names it. The rail's pick is made then,
  // once, and the rail stays after it, whatever an environment does later.
  const answered = environments.filter(({ status }) => status.data !== null);
  const known =
    answered.length > 0 &&
    answered.every(({ environmentId }) => recent.get(environmentId)?.status !== "loading");
  if (open === undefined && known) setOpen(belt.newest);
  if (selected === undefined) return null;

  const stop = async ({ key, environmentId, id, issue }: BeltRun) => {
    const mark = (member: boolean) =>
      setStopping((current) => {
        const next = new Set(current);
        if (member) next.add(key);
        else next.delete(key);
        return next;
      });
    mark(true);
    let answer: string;
    try {
      answer = (await factoryApi.stopRun(environmentId, id)).message;
    } catch (error) {
      answer = messageOf(error);
    }
    setStopNote(`${issue}: ${answer}`);
    mark(false);
    environments
      .find((environment) => environment.environmentId === environmentId)
      ?.status.refresh();
  };
  const since = selected.status.data?.paused_by_hand?.since;
  const pausedSince = since === undefined ? null : Date.parse(since);

  return (
    <div className="flex flex-col gap-4" data-factory-belt="">
      <section
        aria-label="Production belt"
        className="@container flex min-w-0 flex-col gap-4 rounded-lg border bg-card p-4"
      >
        <Environments
          environments={environments}
          onSelect={setPickedId}
          selectedId={selected.environmentId}
        />
        <ControlBar
          busy={busy.has(selected.environmentId)}
          counters={known ? belt.counters : { runsToday: "-", mergedToday: "-", stuck: "-" }}
          onTogglePause={onTogglePause}
          selected={selected}
        />
        {open !== undefined ? (
          <BeltRail
            belt={belt}
            known={known}
            nowMs={nowMs}
            onOpenChange={setOpen}
            onStop={(run) => void stop(run)}
            open={open}
            pausedSince={pausedSince !== null && !Number.isNaN(pausedSince) ? pausedSince : null}
            selectedId={selected.environmentId}
            stopping={stopping}
          />
        ) : (
          <Skeleton aria-label="Loading belt" className="h-40 w-full" role="status" />
        )}
        {stopNote ? (
          <p className="break-words text-sm text-muted-foreground" role="status">
            {stopNote}
          </p>
        ) : null}
      </section>
      <BeltLowerRow
        attention={attention}
        known={known}
        needsInfo={belt.info}
        nowMs={nowMs}
        onDismiss={onDismiss}
        selectedId={selected.environmentId}
        showEnvironment={showEnvironment}
        stuck={belt.stuck}
      />
    </div>
  );
}
