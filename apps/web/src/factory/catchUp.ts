import type { EnvironmentId } from "@t3tools/contracts";

import type { FactoryRunRow } from "./api";
import { issueOf, newestAttempts } from "./belt";
import { parseRunId } from "./format";

const DAY_MS = 24 * 60 * 60 * 1000;
/** The recent runs list holds the unfinished runs and the week's finished ones; nothing older. */
const WEEK_MS = 7 * DAY_MS;

/** Where the digest starts: the user's last "caught up", a day back without one, at most a week. */
export const catchUpSince = (markMs: number | null, nowMs: number): number =>
  Math.max(markMs ?? nowMs - DAY_MS, nowMs - WEEK_MS);

export interface CatchUpRun {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly id: string;
  readonly issue: string;
  readonly title: string | null;
  readonly repo: string | null;
  readonly endMs: number;
  readonly outcome: "merged" | "closed" | "stuck" | "info";
  /** Why it stopped, for a stuck or needs-info run. Untrusted text. */
  readonly reason: string | null;
}

export interface CatchUp {
  /** Newest first, each list. */
  readonly merged: ReadonlyArray<CatchUpRun>;
  readonly closed: ReadonlyArray<CatchUpRun>;
  /** Stuck or needs info, and no later attempt of the issue has taken over. */
  readonly stopped: ReadonlyArray<CatchUpRun>;
  /** Runs claimed since, every attempt. */
  readonly claimed: number;
}

const outcomeOf = (row: FactoryRunRow): CatchUpRun["outcome"] | null => {
  if (row.pr_end === "merged") return "merged";
  if (row.pr_end === "closed") return "closed";
  if (row.state === "stuck") return "stuck";
  if (row.state === "needs-info") return "info";
  return null;
};

/**
 * What the factory did since `sinceMs`, from every environment's recent runs: the issues that
 * merged or closed, the ones that stopped for a person, and how many runs it claimed. Only an
 * issue's newest attempt counts for how it ended, so a stuck run a retry has taken over drops out.
 */
export function catchUp(
  environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly recent: ReadonlyArray<FactoryRunRow>;
  }>,
  sinceMs: number,
): CatchUp {
  const ended: Array<CatchUpRun> = [];
  let claimed = 0;
  for (const { environmentId, label, recent } of environments) {
    const readable = recent.filter(
      (row) =>
        !row.unreadable && row.started_ts !== null && !Number.isNaN(Date.parse(row.started_ts)),
    );
    for (const row of readable) if (Date.parse(row.started_ts!) >= sinceMs) claimed++;
    for (const row of newestAttempts(readable)) {
      const outcome = row.finished ? outcomeOf(row) : null;
      const endMs = Date.parse(row.started_ts!) + (row.total_ms ?? 0);
      if (outcome === null || endMs < sinceMs) continue;
      const parsed = parseRunId(row.id);
      ended.push({
        key: `${environmentId} ${row.id}`,
        environmentId,
        label,
        id: row.id,
        issue: issueOf(row.id),
        title: row.title ?? null,
        repo: parsed ? `${parsed.owner}/${parsed.repo}` : null,
        endMs,
        outcome,
        reason: outcome === "stuck" || outcome === "info" ? (row.reason ?? null) : null,
      });
    }
  }
  ended.sort((a, b) => b.endMs - a.endMs);
  return {
    merged: ended.filter(({ outcome }) => outcome === "merged"),
    closed: ended.filter(({ outcome }) => outcome === "closed"),
    stopped: ended.filter(({ outcome }) => outcome === "stuck" || outcome === "info"),
    claimed,
  };
}
