import type { EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { AlarmClockIcon, DownloadIcon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";

import type { FactoryStatus } from "./api";
import { clockOfIso, formatClock, STATION_META } from "./belt";
import { formatAge } from "./format";
import { runsInProgress } from "./updateInterrupts";
import { updateWait, type UpdateBlocker } from "./updateWait";

/**
 * The selected environment's waiting update: which build, how it holds claims, and Snooze 1 hour
 * and Update now. Update now asks first when it would interrupt a run or a thread at work. After an
 * Update now is accepted, `updating` says what happens next and stands in for the rest.
 */
export function DeployBanner({
  environmentId,
  status,
  nowMs,
  busy,
  updating,
  onSnooze,
  onDeployNow,
}: {
  environmentId: EnvironmentId;
  status: FactoryStatus;
  nowMs: number;
  /** A snooze or Update now of this environment is in flight. */
  busy: boolean;
  updating: string | null;
  onSnooze: () => void;
  onDeployNow: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const pending = status.deploy_pending;
  if (!pending) return null;

  if (updating !== null) {
    return (
      <div data-factory-update="">
        <Alert variant="info">
          <RefreshCwIcon />
          <AlertTitle>{updating}</AlertTitle>
        </Alert>
      </div>
    );
  }

  const inProgress = runsInProgress(status.runs);
  // A count T3 could not read may hide threads at work, so it asks as one would; an older server
  // that sends no count asks only for runs.
  const threads = status.threads === undefined ? 0 : status.threads.running;
  const build = pending.commit ? `Build ${pending.commit.slice(0, 7)}` : "A new build";
  const snoozedUntil = clockOfIso(pending.snoozed_until);
  const deployBy = clockOfIso(pending.deploy_by);
  const title = snoozedUntil !== null ? `Update snoozed until ${snoozedUntil}.` : "Update waiting.";
  const wait = snoozedUntil === null ? updateWait(status, nowMs) : null;
  // The track names the latest install time; without one, the sentence does.
  const description =
    snoozedUntil !== null
      ? `${build} is waiting. The factory claims work as normal until then.`
      : `${build} is ready to install. The factory claims no new work until it installs` +
        (deployBy === null || wait?.track ? "." : `, at ${deployBy} at the latest.`);

  return (
    <div data-factory-update="">
      <Alert controlAlignment="first-line" variant={snoozedUntil !== null ? "info" : "warning"}>
        {snoozedUntil !== null ? <AlarmClockIcon /> : <DownloadIcon />}
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription>
          <p>{description}</p>
          {wait ? <WaitDetail environmentId={environmentId} nowMs={nowMs} wait={wait} /> : null}
          {/* Under the detail rather than beside it, so a phone keeps the full width for it. */}
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy} onClick={onSnooze} size="xs" variant="outline">
              Snooze 1 hour
            </Button>
            <Button
              disabled={busy}
              onClick={() =>
                inProgress.length > 0 || threads !== 0 ? setConfirming(true) : onDeployNow()
              }
              size="xs"
            >
              Update now
            </Button>
          </div>
        </AlertDescription>
      </Alert>
      <AlertDialog onOpenChange={setConfirming} open={confirming}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Update now?</AlertDialogTitle>
            <AlertDialogDescription>
              {build} installs now and the server restarts.
              {inProgress.length > 0 ? " These runs in progress will be interrupted:" : ""}
            </AlertDialogDescription>
            {inProgress.length > 0 ? (
              <ul className="list-disc pl-5 text-sm">
                {inProgress.map(({ id, title: runTitle }) => (
                  <li className="break-words" key={id}>
                    {runTitle ?? id}
                  </li>
                ))}
              </ul>
            ) : null}
            {threads !== 0 ? (
              <p className="text-sm text-muted-foreground">
                {threads === null
                  ? "T3 could not say whether an agent is at work in a thread; any that is will be interrupted."
                  : `${threads} ${threads === 1 ? "thread" : "threads"} with an agent at work will be interrupted; you continue them in T3.`}
              </p>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              onClick={() => {
                setConfirming(false);
                onDeployNow();
              }}
              variant="destructive"
            >
              Update now
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

/** How far through its wait the build is, and what it installs after; static between reads. */
function WaitDetail({
  environmentId,
  nowMs,
  wait,
}: {
  environmentId: EnvironmentId;
  nowMs: number;
  wait: ReturnType<typeof updateWait>;
}) {
  const { track, blockers } = wait;
  return (
    <div className="flex flex-col gap-2.5" data-update-wait="">
      {track ? (
        <div className="flex flex-col gap-1">
          <div
            aria-label={`Waited ${formatAge(track.since, nowMs)} of the wait until ${formatClock(track.deployBy)}`}
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={Math.round(track.done * 100)}
            className="h-1.5 overflow-hidden rounded-full bg-warning/16"
            role="progressbar"
          >
            <div
              className="h-full rounded-full bg-warning"
              style={{ width: `${track.done * 100}%` }}
            />
          </div>
          <div className="flex justify-between gap-3 text-xs tabular-nums">
            <span>
              Waiting since {formatClock(track.since)} · {formatAge(track.since, nowMs)}
            </span>
            <span>Installs by {formatClock(track.deployBy)} at the latest</span>
          </div>
        </div>
      ) : null}
      {blockers.length === 0 ? (
        <p className="text-xs">
          Nothing is in the way: autodeploy installs it at its next check, within 10 minutes.
        </p>
      ) : (
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium text-warning-foreground">
            Installs sooner once {blockers.length === 1 ? "this finishes" : "these finish"}:
          </p>
          <ul className="flex flex-col gap-1">
            {blockers.map((blocker) => (
              <Blocker
                blocker={blocker}
                environmentId={environmentId}
                key={blocker.kind === "run" ? blocker.id : blocker.kind}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Blocker({
  blocker,
  environmentId,
}: {
  blocker: UpdateBlocker;
  environmentId: EnvironmentId;
}) {
  if (blocker.kind !== "run") {
    return (
      <li className="flex items-center gap-2 text-xs">
        <span aria-hidden className="size-2 shrink-0 rounded-xs bg-muted-foreground" />
        {blocker.running === null
          ? "Threads T3 could not count"
          : `${blocker.running} ${blocker.running === 1 ? "thread" : "threads"} with an agent at work`}
      </li>
    );
  }
  return (
    <li data-station={blocker.station ?? undefined}>
      <Link
        className="flex min-h-7 min-w-0 items-center gap-2 rounded-md text-xs text-foreground hover:underline"
        params={{ environmentId, runId: blocker.id }}
        to="/factory/$environmentId/$runId"
      >
        <span
          aria-hidden
          className={
            blocker.station === null
              ? "size-2 shrink-0 rounded-xs border border-muted-foreground"
              : "size-2 shrink-0 rounded-xs bg-(--factory-station)"
          }
        />
        <span className="shrink-0 font-mono text-muted-foreground">{blocker.issue}</span>
        <span className="min-w-0 truncate">{blocker.text}</span>
        <span className="ml-auto shrink-0 text-muted-foreground">
          {blocker.station === null ? "unreadable" : STATION_META[blocker.station].name}
        </span>
      </Link>
    </li>
  );
}
