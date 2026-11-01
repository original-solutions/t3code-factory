import type { EnvironmentId } from "@t3tools/contracts";

import type { FactoryAttentionItem, FactoryReadyQueue, FactoryRunRow } from "./api";
import { signedOutCause } from "./attentionCauses";
import { parseRunId } from "./format";

/** One environment's queue read, with its recent runs to tell a claimed issue and a title by. */
export interface QueueSource {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly queue: FactoryReadyQueue;
  readonly runs: ReadonlyArray<FactoryRunRow>;
  /** Its open attention items, to tell a signed-out gh from an unreadable config. */
  readonly attention: ReadonlyArray<FactoryAttentionItem>;
}

export interface QueueIssue {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly repo: string;
  readonly issue: string;
  readonly reason: string;
  readonly sinceMs: number;
  /** When the pass that last held it back read the list: the wait is known up to then. */
  readonly checkedMs: number;
  readonly passes: number;
  /** The wait began before `sinceMs`: the server stopped reading the log there. */
  readonly sinceCut: boolean;
  /** The title the issue's newest run launched with: only an issue that ran before has one. */
  readonly title: string | null;
  /** The issue's newest run, when it ran before and was put back to ready. */
  readonly lastRun: FactoryRunRow | null;
}

export interface QueueGroup {
  readonly reason: string;
  readonly title: string;
  readonly help: string;
  readonly issues: ReadonlyArray<QueueIssue>;
}

/** Why the newest pass of one environment claimed nothing, and since when its list is stale. */
export interface QueueHold {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly words: ReadonlyArray<string>;
  /** When the ready issues were last read, when that is older than the newest pass. */
  readonly checkedMs: number | null;
  /** Its gh is signed out, so a sign-in lifts it. */
  readonly signedOut: boolean;
}

export interface QueueView {
  readonly groups: ReadonlyArray<QueueGroup>;
  readonly waiting: number;
  readonly holds: ReadonlyArray<QueueHold>;
  readonly skipped: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly repo: string;
    readonly words: string;
  }>;
  readonly turnedAway: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly repo: string;
    readonly issue: string;
    readonly atMs: number;
  }>;
  /** The newest time any environment read its ready issues; null when none ever did in the log's window. */
  readonly checkedMs: number | null;
}

/** The waits, in the order a person can act on them: the ones only they can lift first. */
const REASONS: ReadonlyArray<Omit<QueueGroup, "issues">> = [
  {
    reason: "postponed",
    title: "Parked with postponed",
    help: "Remove the postponed label and the next pass claims it.",
  },
  {
    reason: "blocked",
    title: "Waiting on a dependency",
    help: "An issue it depends on, by a blocked-by link or its ## Depends on, is still open. It takes no slot and is claimed on the first pass after that issue closes.",
  },
  {
    reason: "limit",
    title: "Waiting for a free slot",
    help: "Every run slot is taken. It is claimed on the first pass after a run ends.",
  },
];

/** A machine-wide skip in words; an unknown one as written. */
const HOLD_WORDS: Readonly<Record<string, string>> = {
  paused: "claims are paused by hand",
  "low-disk": "free disk space is below min_free_gib",
  "high-load": "the machine's load is too high",
  "deploy-pending": "a new build waits to install",
  "cooling-down": "every model is cooling down after a rate limit",
  late: "the pass ran out of time before it reached every issue",
  preflight: "the pass failed its preflight checks",
};

const SIGNED_OUT_WORDS = "the factory's gh is signed out, so no repo's ready issues can be read";

const REPO_WORDS: Readonly<Record<string, string>> = {
  "config-not-loaded": "its .dw/config.yml could not be read",
  "ambiguous-project": "more than one T3 project points at it",
  "not-owner": "factory.owner names another machine",
};

const sameRepo = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const runsOfIssue = (runs: ReadonlyArray<FactoryRunRow>, repo: string, issue: string) =>
  runs.filter((run) => {
    const parsed = parseRunId(run.id);
    return (
      parsed !== null && sameRepo(`${parsed.owner}/${parsed.repo}`, repo) && parsed.issue === issue
    );
  });

const startedMs = (run: FactoryRunRow) => (run.started_ts ? Date.parse(run.started_ts) : 0);

/**
 * Every environment's queue as one view. An issue whose run started after it began waiting was
 * claimed since the read and is left out; `repo` keeps only that repo's issues and skips.
 */
export function queueView(sources: ReadonlyArray<QueueSource>, repo: string | null): QueueView {
  const inRepo = (name: string) => repo === null || sameRepo(name, repo);
  const issues: Array<QueueIssue> = [];
  const holds: Array<QueueHold> = [];
  const skipped: Array<QueueView["skipped"][number]> = [];
  const turnedAway: Array<QueueView["turnedAway"][number]> = [];
  let checkedMs: number | null = null;
  for (const { environmentId, label, queue, runs, attention } of sources) {
    const checked = queue.checked_at === null ? null : Date.parse(queue.checked_at);
    if (checked !== null) checkedMs = Math.max(checkedMs ?? 0, checked);
    const signedOut = signedOutCause(attention);
    if (queue.holds.length > 0 || signedOut !== null) {
      const last = queue.last_pass_at === null ? null : Date.parse(queue.last_pass_at);
      holds.push({
        environmentId,
        label,
        words: [
          ...queue.holds.map((hold) => HOLD_WORDS[hold] ?? hold),
          ...(signedOut === null ? [] : [SIGNED_OUT_WORDS]),
        ],
        checkedMs: checked !== null && last !== null && checked < last ? checked : null,
        signedOut: signedOut !== null,
      });
    }
    for (const { repo: name, reason } of queue.skipped_repos) {
      if (!inRepo(name)) continue;
      const words =
        reason === "config-not-loaded" && signedOut?.repos.some((out) => sameRepo(out, name))
          ? "gh is signed out"
          : (REPO_WORDS[reason] ?? reason);
      skipped.push({ environmentId, label, repo: name, words });
    }
    for (const { repo: name, issue, at } of queue.turned_away) {
      if (!inRepo(name)) continue;
      const atMs = Date.parse(at);
      // Put back to ready and claimed since: no longer turned away.
      if (runsOfIssue(runs, name, issue).some((run) => startedMs(run) > atMs)) continue;
      turnedAway.push({ environmentId, label, repo: name, issue, atMs });
    }
    for (const wait of queue.waiting) {
      if (!inRepo(wait.repo)) continue;
      const sinceMs = Date.parse(wait.since);
      const own = runsOfIssue(runs, wait.repo, wait.issue).toSorted(
        (a, b) => startedMs(b) - startedMs(a),
      );
      if (own.some((run) => startedMs(run) > sinceMs)) continue;
      const lastRun = own[0] ?? null;
      issues.push({
        environmentId,
        label,
        repo: wait.repo,
        issue: wait.issue,
        reason: wait.reason,
        sinceMs,
        checkedMs: checked ?? sinceMs,
        passes: wait.passes,
        sinceCut: wait.since_cut === true,
        title: lastRun?.title ?? null,
        lastRun,
      });
    }
  }
  // Longest waiting first within a group.
  issues.sort((a, b) => a.sinceMs - b.sinceMs);
  const known = new Set(REASONS.map(({ reason }) => reason));
  const groups: Array<QueueGroup> = REASONS.map((group) => ({
    ...group,
    issues: issues.filter(({ reason }) => reason === group.reason),
  }));
  const other = issues.filter(({ reason }) => !known.has(reason));
  if (other.length > 0)
    groups.push({
      reason: "other",
      title: "Held back",
      help: "The factory held these back.",
      issues: other,
    });
  return {
    groups: groups.filter(({ issues }) => issues.length > 0),
    waiting: issues.length,
    holds,
    skipped,
    turnedAway: turnedAway.sort((a, b) => b.atMs - a.atMs),
    checkedMs,
  };
}

/** The issue shape the factory builds (factory/site/guide/filing-work.md), to paste into a new issue. */
export const ISSUE_TEMPLATE = `## Outcome

What is true when this is done, in a few sentences.

## Acceptance criteria

1. Each one checkable: a command that exits 0, a page that shows something, a file that exists.

## Depends on

None.

## Notes

Constraints, pointers into the code, and anything out of scope.
`;

/** GitHub's new-issue page for `repo` with the template as its body; the person files it there. */
export const newIssueUrl = (repo: string): string =>
  `https://github.com/${repo}/issues/new?body=${encodeURIComponent(ISSUE_TEMPLATE)}`;
