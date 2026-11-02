import type { FactoryStatus } from "./api";
import { issueOf, stationOf, type Station } from "./belt";
import { parseRunId } from "./format";
import { runsInProgress } from "./updateInterrupts";

/** One thing a waiting install waits for, as `factory/scripts/autodeploy.sh` asks the status. */
export type UpdateBlocker =
  | {
      readonly kind: "run";
      readonly id: string;
      /** The issue title, else the repo, else the run id. */
      readonly text: string;
      readonly issue: string;
      /** Its post on the belt; null for an unreadable run, which is on none. */
      readonly station: Exclude<Station, "done"> | null;
    }
  | { readonly kind: "pass" }
  | { readonly kind: "threads"; readonly running: number | null };

export interface UpdateWait {
  /** From the first wait to the latest install, and how much of it has gone; null without both. */
  readonly track: {
    readonly since: number;
    readonly deployBy: number;
    readonly done: number;
  } | null;
  readonly blockers: ReadonlyArray<UpdateBlocker>;
}

/** Where a waiting build stands: how far through its wait, and what it waits for to install. */
export function updateWait(status: FactoryStatus, nowMs: number): UpdateWait {
  const pending = status.deploy_pending;
  const since = pending ? Date.parse(pending.since) : Number.NaN;
  const deployBy = pending?.deploy_by ? Date.parse(pending.deploy_by) : Number.NaN;
  const track =
    Number.isFinite(since) && Number.isFinite(deployBy) && deployBy > since
      ? { since, deployBy, done: Math.min(1, Math.max(0, (nowMs - since) / (deployBy - since))) }
      : null;

  const blockers: UpdateBlocker[] = runsInProgress(status.runs).map((run) => {
    const parsed = parseRunId(run.id);
    return {
      kind: "run",
      id: run.id,
      text: run.title ?? (parsed ? `${parsed.owner}/${parsed.repo}` : run.id),
      issue: issueOf(run.id),
      station: run.unreadable ? null : stationOf(run),
    };
  });
  if (status.passes.running) blockers.push({ kind: "pass" });
  const threads = status.threads === undefined ? 0 : status.threads.running;
  if (threads !== 0) blockers.push({ kind: "threads", running: threads });
  return { track, blockers };
}
