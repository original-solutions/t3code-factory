/**
 * The ready queue `GET /api/factory/queue` serves: the `factory:ready` issues the claim step held
 * back and why, read from the machine log's `claim_skipped` lines. It reads no network, so it
 * answers while `gh` is signed out, and it knows only what the passes recorded: an issue the
 * claim step never reached is not in it.
 */
import { scanMachineLogBack } from "./ledger/machineLog.ts";
import { field } from "./ledger/read.ts";
import { formatTs } from "./ledger/time.ts";

/** Machine-wide skips before the claim step reads any issue: a pass with one says nothing of the queue. */
const READS_NO_ISSUE = new Set(["paused", "low-disk", "high-load", "deploy-pending"]);

/** How far back the log is read at most: a factory held for longer shows no queue. */
const WINDOW_MS = 14 * 86_400_000;

/** How long an issue sent back to `factory:proposed` stays listed. */
const TURNED_AWAY_MS = 3 * 86_400_000;

export interface ReadyQueue {
  /** When the newest finished pass ended. */
  readonly last_pass_at: string | null;
  /** That pass's machine-wide skips (`paused`, `low-disk`, `late`, …), oldest first. */
  readonly holds: ReadonlyArray<string>;
  /** When the newest pass that read the ready issues ended; `waiting` is as of then. */
  readonly checked_at: string | null;
  readonly waiting: ReadonlyArray<{
    readonly repo: string;
    readonly issue: string;
    /** `blocked`, `limit` or `postponed`, as that pass recorded it. */
    readonly reason: string;
    /** The first skip of its unbroken run of passes that read the list. */
    readonly since: string;
    readonly passes: number;
  }>;
  /** Issues refused and moved to `factory:proposed` in the last three days, newest first. */
  readonly turned_away: ReadonlyArray<{
    readonly repo: string;
    readonly issue: string;
    readonly at: string;
  }>;
  /** Repos the newest finished pass did not claim from, by `repo_skipped` or `not-owner`. */
  readonly skipped_repos: ReadonlyArray<{ readonly repo: string; readonly reason: string }>;
}

interface Pass {
  readonly endMs: number;
  readonly holds: Array<string>;
  /** `repo#issue` to its skip, newest line first as read. */
  readonly issues: Map<string, { repo: string; issue: string; reason: string; ms: number }>;
  readonly repos: Map<string, string>;
}

const text = (value: unknown): string | null =>
  typeof value === "string" ? value : typeof value === "number" ? String(value) : null;

/** Reads the machine log back from its end over at most fourteen days. */
export const readReadyQueue = (dataDir: string, nowMs: number): ReadyQueue => {
  let newest: Pass | null = null;
  let checked: Pass | null = null;
  const streaks = new Map<string, { since: number; passes: number; open: boolean }>();
  const turnedAway: Array<ReadyQueue["turned_away"][number]> = [];
  const turnedAwaySeen = new Set<string>();
  // The pass being read, newest line first: opened by its end, closed by its start.
  let current: Pass | null = null;

  const close = (pass: Pass) => {
    newest ??= pass;
    if (pass.holds.some((hold) => READS_NO_ISSUE.has(hold))) return;
    if (checked === null) {
      checked = pass;
      for (const [key, skip] of pass.issues)
        streaks.set(key, { since: skip.ms, passes: 1, open: true });
      return;
    }
    for (const [key, streak] of streaks) {
      if (!streak.open) continue;
      const skip = pass.issues.get(key);
      if (skip === undefined) streak.open = false;
      else {
        streak.since = skip.ms;
        streak.passes += 1;
      }
    }
  };

  scanMachineLogBack(dataDir, (entry) => {
    if (entry.ms < nowMs - WINDOW_MS) return "stop";
    if (entry.event === "claim_skipped" && field(entry.data, "reason") === "unapproved") {
      const repo = text(field(entry.data, "repo"));
      const issue = text(field(entry.data, "issue"));
      const key = `${repo}#${issue}`;
      if (
        repo !== null &&
        issue !== null &&
        entry.ms >= nowMs - TURNED_AWAY_MS &&
        !turnedAwaySeen.has(key)
      ) {
        turnedAwaySeen.add(key);
        turnedAway.push({ repo, issue, at: formatTs(entry.ms) });
      }
    }
    if (entry.event === "pass_finished" || entry.event === "preflight_failed") {
      current = {
        endMs: entry.ms,
        holds: entry.event === "preflight_failed" ? ["preflight"] : [],
        issues: new Map(),
        repos: new Map(),
      };
    } else if (current !== null && entry.event === "pass_started") {
      close(current);
      current = null;
    } else if (current !== null && entry.event === "claim_skipped") {
      const reason = text(field(entry.data, "reason"));
      const repo = text(field(entry.data, "repo"));
      const issue = text(field(entry.data, "issue"));
      if (reason === null) return "continue";
      if (repo === null) {
        if (!current.holds.includes(reason)) current.holds.unshift(reason);
      } else if (issue === null) current.repos.set(repo, reason);
      else if (reason !== "unapproved" && !current.issues.has(`${repo}#${issue}`)) {
        current.issues.set(`${repo}#${issue}`, { repo, issue, reason, ms: entry.ms });
      }
    } else if (current !== null && entry.event === "repo_skipped") {
      const repo = text(field(entry.data, "repo"));
      const reason = text(field(entry.data, "reason"));
      if (repo !== null && reason !== null) current.repos.set(repo, reason);
    }
    const settled = checked !== null && [...streaks.values()].every((streak) => !streak.open);
    return settled && entry.ms < nowMs - TURNED_AWAY_MS ? "stop" : "continue";
  });

  const last = newest as Pass | null;
  const read = checked as Pass | null;
  return {
    last_pass_at: last === null ? null : formatTs(last.endMs),
    holds: last === null ? [] : last.holds,
    checked_at: read === null ? null : formatTs(read.endMs),
    waiting:
      read === null
        ? []
        : [...read.issues]
            .map(([key, { repo, issue, reason }]) => {
              const streak = streaks.get(key)!;
              return { repo, issue, reason, since: formatTs(streak.since), passes: streak.passes };
            })
            .sort(
              (a, b) =>
                a.repo.localeCompare(b.repo) ||
                a.issue.localeCompare(b.issue, undefined, { numeric: true }),
            ),
    turned_away: turnedAway,
    skipped_repos:
      last === null
        ? []
        : [...last.repos]
            .map(([repo, reason]) => ({ repo, reason }))
            .sort((a, b) => a.repo.localeCompare(b.repo)),
  };
};
