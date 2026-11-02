import type { EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useState, type CSSProperties, type ReactNode } from "react";

import { Skeleton } from "~/components/ui/skeleton";
import { Switch } from "~/components/ui/switch";
import { cn } from "~/lib/utils";

import { LEGACY_SESSION_PAIR_AGAIN } from "@t3tools/shared/legacySession";

import { factoryApi, FactoryApiError, type FactoryRunRow, type FactoryStatus } from "./api";
import { beltColumns, deriveBelt, nextPassText, type Station } from "./belt";
import "./belt.css";
import { BeltLowerRow, type EnvironmentAttention } from "./BeltLowerRow";
import { useBeltMotion } from "./beltMotion";
import { useBeltNews } from "./beltNews";
import { BeltChanges } from "./BeltChanges";
import { BeltRail, type ClaimsHeldWhy } from "./BeltRail";
import { machineHold } from "./machineHealth";
import { signedOutCause, stillTrue } from "./attentionCauses";
import { MachineHealthPanel } from "./MachineHealthPanel";
import { ControlFoldProvider, DIAL_CELL } from "./ControlFold";
import { MachineRoster, useSecond } from "./MachineRoster";
import type { QueueOrigin } from "./runQueue";
import { DeployBanner } from "./DeployBanner";
import { PAIR_AGAIN_TAIL } from "./http";
import { LegacySessionBanner } from "./LegacySessionBanner";
import { useLegacySessionNotices } from "./useLegacySessionNotices";
import { dayStrip, type DayStrip as Strip } from "./dayStrip";
import { TodayStrip } from "./TodayStrip";
import type { FirstRun } from "./firstRun";
import { FirstRunGuide } from "./FirstRunGuide";
import { FactoryReadFailure } from "./FactoryNotices";
import { messageOf } from "./format";
import { JUMP_TARGET_CLASS, jumpTarget } from "./pageSections";
import { repoOfRun } from "./repoHealth";
import { useRunStop } from "./RunActionBar";
import { TouchLink } from "./TouchLink";
import type { FactoryEnvironment, FactoryResource } from "./useFactoryData";

const LABEL = "text-xs text-muted-foreground";

const slotsText = ({ used, max }: FactoryStatus["slots"]) =>
  max === null ? `${used}` : `${used}/${max}`;

/** An accepted Update now: its build, what to say, and whether the server has since gone away. */
interface Updating {
  readonly commit: string;
  readonly message: string;
  readonly away: boolean;
}

/**
 * The updates still under way: one ends once its build no longer waits (installed, or dropped for a
 * newer one), or once its server answers again after a read failed, as the install restarts it.
 * The same map when nothing changed.
 */
const settleUpdating = (
  updating: ReadonlyMap<EnvironmentId, Updating>,
  environments: ReadonlyArray<FactoryEnvironment>,
): ReadonlyMap<EnvironmentId, Updating> => {
  let next: Map<EnvironmentId, Updating> | null = null;
  for (const [environmentId, entry] of updating) {
    const status = environments.find((e) => e.environmentId === environmentId)?.status;
    let settled: Updating | null = entry;
    if (status === undefined) settled = null;
    else if (status.status === "error") settled = entry.away ? entry : { ...entry, away: true };
    else {
      const pending = status.data?.deploy_pending;
      if (entry.away || pending == null || pending.commit !== entry.commit) settled = null;
    }
    if (settled === entry) continue;
    next ??= new Map(updating);
    if (settled === null) next.delete(environmentId);
    else next.set(environmentId, settled);
  }
  return next ?? updating;
};

const withMember = <T,>(set: ReadonlySet<T>, member: T, present: boolean): ReadonlySet<T> => {
  const next = new Set(set);
  if (present) next.add(member);
  else next.delete(member);
  return next;
};

const withEntry = <K, V>(map: ReadonlyMap<K, V>, key: K, value: V | null): ReadonlyMap<K, V> => {
  const next = new Map(map);
  if (value === null) next.delete(key);
  else next.set(key, value);
  return next;
};

/**
 * The seconds to the next pass, or that one is running: ticking once a second from this component's
 * own timer, so nothing else on the page renders each second. Nothing before the factory has said.
 */
function NextPass({ passes }: { passes: FactoryStatus["passes"] | undefined }) {
  const nowMs = useSecond();
  const text = nextPassText(passes, nowMs);
  if (text === null) return null;
  return <span className={LABEL}>{text}</span>;
}

/**
 * The roster of every machine when there are several, then one row of dials: the claims switch
 * and pass of the one environment, the machine's health and what happened since the viewer caught
 * up, each opening its detail below the row; then today's strip over every environment. A switch is on while claims run; an environment with no status says nothing
 * about its claims and cannot be switched.
 */
function ControlBar({
  environments,
  selected,
  busy,
  digest,
  strip,
  onSelect,
  onTogglePause,
}: {
  environments: ReadonlyArray<FactoryEnvironment>;
  selected: FactoryEnvironment;
  busy: ReadonlySet<EnvironmentId>;
  onSelect: (environmentId: EnvironmentId) => void;
  /** What happened since the viewer caught up, when the page has it to show. */
  digest: ReactNode;
  /** Today's runs on the clock, once the recent runs lists are known. */
  strip: Strip | null;
  onTogglePause: (environment: FactoryEnvironment) => void;
}) {
  const report = selected.status.data;
  const paused = report?.paused_by_hand != null;
  return (
    <section
      aria-label="Controls"
      className="flex flex-col overflow-hidden rounded-lg border bg-card"
    >
      {environments.length > 1 ? (
        <MachineRoster
          busy={busy}
          environments={environments}
          onSelect={onSelect}
          onTogglePause={onTogglePause}
          selectedId={selected.environmentId}
        />
      ) : null}
      {/* One row of dials, the 1px gaps their dividers; an opened dial's detail spans the row below. */}
      <ControlFoldProvider>
        <div
          className={cn("flex flex-wrap gap-px bg-border", environments.length > 1 && "border-t")}
          data-part="dials"
        >
          {environments.length > 1 ? null : (
            <div className={cn(DIAL_CELL, "basis-auto items-center gap-3 px-5 py-2.5")}>
              {/* The switch has no coarse-pointer hit area of its own; the label is the 44 px target. */}
              <label className="inline-flex items-center justify-center pointer-coarse:min-h-11 pointer-coarse:min-w-11">
                <Switch
                  aria-label={`Claims on ${selected.label}`}
                  checked={report !== null && !paused}
                  disabled={report === null || busy.has(selected.environmentId)}
                  onCheckedChange={() => onTogglePause(selected)}
                />
              </label>
              <div className="flex min-w-0 flex-col gap-1">
                <span className={cn(LABEL, "min-w-0 break-words")} data-part="machine">
                  {selected.label}
                  {report === null ? null : (
                    <span className="font-mono"> · {slotsText(report.slots)} slots</span>
                  )}
                </span>
                <span className="flex items-baseline gap-2">
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
                </span>
                {/* A countdown from a read that has since failed would tick on a pass nobody can see. */}
                <NextPass
                  passes={selected.status.status === "error" ? undefined : report?.passes}
                />
              </div>
            </div>
          )}
          {report === null ? null : (
            <MachineHealthPanel
              environmentId={selected.environmentId}
              label={selected.label}
              status={report}
            />
          )}
          {digest}
        </div>
      </ControlFoldProvider>
      <TodayStrip strip={strip} />
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
        dataAt={status.dataAt}
        error={status.error}
        label={label}
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

/** The note an environment may need while it loads, fails or idles; its place is the control bar. */
function Environments({ environments }: { environments: ReadonlyArray<FactoryEnvironment> }) {
  // With several machines the control bar's roster picks one and says which load or idle; only a
  // first read that failed stays here, for its Retry.
  if (environments.length > 1) {
    const failed = environments.filter(
      ({ status }) => status.data === null && status.status === "error",
    );
    return failed.length === 0 ? null : (
      <section aria-label="Factories" className="flex flex-col gap-2">
        {failed.map((environment) => (
          <EnvironmentNote environment={environment} key={environment.environmentId} />
        ))}
      </section>
    );
  }
  // One machine is named, with its slots, in the control bar's claims dial; only its note is here.
  const notes = environments.filter(
    ({ status }) => status.data === null || status.data.state === "idle",
  );
  return notes.length === 0 ? null : (
    <section aria-label="Factories" className="flex flex-col gap-2">
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
  dismissed,
  showEnvironment,
  onDismiss,
  onRestore,
  origin,
  digest,
  repo = null,
  firstRun = false,
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
  /** The items a person dismissed whose cause still holds, after the same filters. */
  dismissed: ReadonlyArray<EnvironmentAttention>;
  showEnvironment: boolean;
  onDismiss: (items: ReadonlyArray<EnvironmentAttention>) => void;
  onRestore: (items: ReadonlyArray<EnvironmentAttention>) => void;
  /** The page's filters, so a bin's run can step through its bin and come back. */
  origin?: QueueOrigin | undefined;
  /** What happened since the viewer caught up, shown in the control bar under the claims switch. */
  digest?: ReactNode;
  /** The page's repo filter: the rail, the strip and the bins show only its runs. */
  repo?: string | null;
  /**
   * No environment has ever run anything: the steps to a first run stand in for the empty rail.
   * While that is being checked, a placeholder stands there instead of an empty belt.
   */
  firstRun?: FirstRun;
}) {
  const [pickedId, setPickedId] = useState<EnvironmentId | null>(null);
  // The open post: undefined until the rail first has something to look at, then the user's.
  const [open, setOpen] = useState<Station | null | undefined>(undefined);
  const stopRun = useRunStop((environmentId) => {
    environments
      .find((environment) => environment.environmentId === environmentId)
      ?.status.refresh();
  });
  // The environments with a snooze or Update now in flight, the accepted Update nows, and each
  // environment's answer to its latest one that failed.
  const [deployBusy, setDeployBusy] = useState<ReadonlySet<EnvironmentId>>(() => new Set());
  const [updating, setUpdating] = useState<ReadonlyMap<EnvironmentId, Updating>>(() => new Map());
  const [deployNotes, setDeployNotes] = useState<ReadonlyMap<EnvironmentId, string>>(
    () => new Map(),
  );
  const legacyNotices = useLegacySessionNotices(
    environments.map(({ environmentId }) => environmentId),
  );
  // The environment picked, else the first (the primary): one that has gone is no longer picked.
  const selected =
    environments.find(({ environmentId }) => environmentId === pickedId) ?? environments[0];
  const inRepo = ({ id }: { readonly id: string }) =>
    repo === null || repoOfRun(id)?.toLowerCase() === repo.toLowerCase();
  const recentOf = (environmentId: EnvironmentId) =>
    (recent.get(environmentId)?.data?.runs ?? []).filter(inRepo);
  const belt = deriveBelt(
    environments.map(({ environmentId, label, status }) => ({
      environmentId,
      label,
      active: (status.data?.runs ?? []).filter(inRepo),
      recent: recentOf(environmentId),
    })),
    nowMs,
  );
  // The belt as drawn: a bin does not count a run until the run has slid into it.
  const { shown, tileRef, layerRef } = useBeltMotion(belt, open !== undefined);
  const heard = useBeltNews(
    belt,
    open !== undefined,
    `${repo ?? ""} ${environments.map(({ environmentId }) => environmentId).join(" ")}`,
    showEnvironment,
    nowMs,
  );
  // What the recent runs lists say (the strip, Done, the bins, and the rail's first pick) is known
  // once some status has answered and no answered environment's list is still loading. A list that
  // failed before its first answer adds nothing; the page names it. The rail's pick is made then,
  // once, and the rail stays after it, whatever an environment does later.
  const answered = environments.filter(({ status }) => status.data !== null);
  const known =
    answered.length > 0 &&
    answered.every(({ environmentId }) => recent.get(environmentId)?.status !== "loading");
  if (open === undefined && known) setOpen(belt.newest);
  const settled = settleUpdating(updating, environments);
  if (settled !== updating) setUpdating(settled);
  if (selected === undefined) return null;

  const deploy = async ({ environmentId, status }: FactoryEnvironment, now: boolean) => {
    const shown = status.data?.deploy_pending?.commit ?? null;
    setDeployBusy((current) => withMember(current, environmentId, true));
    setDeployNotes((current) => withEntry(current, environmentId, null));
    try {
      if (now) {
        const { commit, kicked } = await factoryApi.deployNow(environmentId, shown);
        const message = kicked
          ? "Updating. The server restarts once the build is installed."
          : "Updating within 10 minutes.";
        setUpdating((current) =>
          new Map(current).set(environmentId, { commit, message, away: false }),
        );
      } else {
        await factoryApi.snoozeDeploy(environmentId, shown);
      }
    } catch (error) {
      // A refusal for a missing permission to a session that predates the permissions ends with the fix.
      const legacy =
        now &&
        error instanceof FactoryApiError &&
        error.code === "insufficient_scope" &&
        legacyNotices[environments.findIndex((e) => e.environmentId === environmentId)] != null;
      setDeployNotes((current) =>
        withEntry(
          current,
          environmentId,
          legacy
            ? `${messageOf(error).replace(PAIR_AGAIN_TAIL, "")} ${LEGACY_SESSION_PAIR_AGAIN}`
            : messageOf(error),
        ),
      );
    }
    setDeployBusy((current) => withMember(current, environmentId, false));
    status.refresh();
  };
  // A hand pause names the hold before an update does.
  const report = selected.status.data;
  // A low disk has no since of its own; its attention item says when the pass first held for it.
  const lowDiskSince = (report ? stillTrue(report) : []).find(
    (item) => item.id === "low-disk",
  )?.first_seen;
  const held: { why: ClaimsHeldWhy; since: number | null } | null = report?.paused_by_hand
    ? { why: "paused by hand", since: Date.parse(report.paused_by_hand.since) }
    : report?.deploy_pending && report.deploy_pending.snoozed_until === null
      ? { why: "held for update", since: Date.parse(report.deploy_pending.since) }
      : report && machineHold(report)?.word === "low disk"
        ? {
            why: "held for low disk",
            since: lowDiskSince === undefined ? null : Date.parse(lowDiskSince),
          }
        : report && machineHold(report)?.word === "gh signed out"
          ? {
              why: "held for GitHub sign-in",
              since: Date.parse(signedOutCause(stillTrue(report))!.firstSeen),
            }
          : null;
  const deployNote = deployNotes.get(selected.environmentId);

  return (
    <div
      className="relative flex flex-col gap-4"
      data-factory-belt=""
      style={
        {
          "--factory-cols": beltColumns({
            claimed: shown.runs.claimed.length,
            building: shown.runs.building.length,
            gate: shown.runs.gate.length,
            pr: shown.runs.pr.length,
          }),
        } as CSSProperties
      }
    >
      <section
        aria-label="Production belt"
        className={cn(
          "@container flex min-w-0 flex-col gap-4 rounded-xl border bg-card p-4",
          JUMP_TARGET_CLASS,
        )}
        {...jumpTarget("belt")}
      >
        <Environments environments={environments} />
        <LegacySessionBanner environments={environments} />
        {report?.deploy_pending ? (
          <DeployBanner
            // A new build, or another environment, starts with its dialog closed.
            key={`${selected.environmentId} ${report.deploy_pending.since} ${report.deploy_pending.commit}`}
            busy={deployBusy.has(selected.environmentId)}
            environmentId={selected.environmentId}
            nowMs={nowMs}
            onDeployNow={() => void deploy(selected, true)}
            onSnooze={() => void deploy(selected, false)}
            status={report}
            updating={settled.get(selected.environmentId)?.message ?? null}
          />
        ) : null}
        {deployNote ? (
          <p className="break-words text-sm text-muted-foreground" role="status">
            {deployNote}
          </p>
        ) : null}
        <ControlBar
          busy={busy}
          digest={digest}
          environments={environments}
          onSelect={setPickedId}
          onTogglePause={onTogglePause}
          selected={selected}
          strip={
            known
              ? dayStrip(
                  environments.map(({ environmentId, label }) => ({
                    environmentId,
                    label,
                    recent: recentOf(environmentId),
                  })),
                  nowMs,
                  held?.since ?? null,
                )
              : null
          }
        />
        {firstRun === "checking" ? (
          <Skeleton aria-label="Loading belt" className="h-40 w-full" role="status" />
        ) : firstRun ? (
          <FirstRunGuide
            busy={busy.has(selected.environmentId)}
            environmentId={selected.environmentId}
            // A new environment reads its own config.
            key={selected.environmentId}
            onResume={() => onTogglePause(selected)}
            paused={report?.paused_by_hand != null}
          />
        ) : open !== undefined ? (
          <BeltRail
            belt={shown}
            known={known}
            nowMs={nowMs}
            onOpenChange={setOpen}
            open={open}
            claimsHeld={
              held === null
                ? null
                : { ...held, since: Number.isNaN(held.since) ? null : held.since }
            }
            selectedId={selected.environmentId}
            stopOf={(run) => stopRun(run.environmentId, run.id)}
            tileRef={tileRef}
          />
        ) : (
          <Skeleton aria-label="Loading belt" className="h-40 w-full" role="status" />
        )}
        {firstRun === false && open !== undefined ? (
          <BeltChanges at={heard.at} news={heard.news} />
        ) : null}
      </section>
      {firstRun !== false && attention.length === 0 && dismissed.length === 0 ? null : (
        <BeltLowerRow
          attention={attention}
          dismissed={dismissed}
          known={known}
          needsInfo={shown.info}
          nowMs={nowMs}
          onDismiss={onDismiss}
          onRestore={onRestore}
          origin={origin}
          selectedId={selected.environmentId}
          showEnvironment={showEnvironment}
          stuck={shown.stuck}
        />
      )}
      {/* Where the tiles fly: last, so that it is laid over the rest and set after every tile. */}
      <div aria-hidden className="pointer-events-none absolute inset-0" ref={layerRef} />
    </div>
  );
}
