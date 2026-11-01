import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import { formatClock } from "./belt";

export type AgentTone = "working" | "waiting" | "failed" | "ended";

/** What a run's agent session is doing now, read from its thread as the client already holds it. */
export interface AgentPulse {
  readonly tone: AgentTone;
  /** A few words, lower case, for beside a Thread link: `working`, `needs approval`. */
  readonly word: string;
  /** The same as a sentence head: `Agent working`. */
  readonly title: string;
  /** What to know or do about it; null when the title says it all. */
  readonly hint: string | null;
  /** When the current activity started (working) or the turn ended (ended); ISO. */
  readonly since: string | null;
  /** Items in the thread so far (messages, tool calls); it climbs while the agent works. */
  readonly items: number;
  /** The thread's last change; ISO. */
  readonly lastActivity: string;
  /** The session's error, for a failed one. */
  readonly error: string | null;
}

export type AgentThread = Pick<
  EnvironmentThreadShell,
  | "runtime"
  | "latestRun"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "blockedOnThreadWait"
  | "updatedAt"
  | "itemCount"
>;

const ACTIVE = new Set(["preparing", "queued", "starting", "running"]);

const FAILED: Record<string, { word: string; title: string }> = {
  failed: { word: "failed", title: "Agent session failed" },
  interrupted: { word: "interrupted", title: "Agent session interrupted" },
  cancelled: { word: "cancelled", title: "Agent session cancelled" },
};

const ENDED_HINT = "The factory reads how it ended at its next pass.";

/**
 * The agent's state, first match wins: a request waiting on a person, a usage limit, at work,
 * waiting, ended badly, ended. Null when the thread is not in this client's store (another
 * device's project, or not loaded yet), so a surface shows nothing rather than a guess.
 */
export function agentPulse(thread: AgentThread | null): AgentPulse | null {
  if (thread === null) return null;
  const base = {
    items: thread.itemCount,
    lastActivity: thread.updatedAt,
    error: null,
    since: null,
    hint: null,
  };
  const runtime = thread.runtime;
  const status = runtime?.status ?? "idle";
  if (thread.hasPendingApprovals) {
    return {
      ...base,
      tone: "waiting",
      word: "needs approval",
      title: "Agent waiting for an approval",
      hint: "Approve or decline it in the thread; the run builds on once you do.",
    };
  }
  if (thread.hasPendingUserInput) {
    return {
      ...base,
      tone: "waiting",
      word: "needs answer",
      title: "Agent waiting for an answer",
      hint: "Answer it in the thread; the run builds on once you do.",
    };
  }
  if (runtime?.usageLimitResetAt && !ACTIVE.has(status)) {
    return {
      ...base,
      tone: "waiting",
      word: "usage limit",
      title: "Agent hit a usage limit",
      hint: Number.isNaN(Date.parse(runtime.usageLimitResetAt))
        ? null
        : `The provider resets it at ${formatClock(Date.parse(runtime.usageLimitResetAt))}.`,
    };
  }
  if (ACTIVE.has(status)) {
    return {
      ...base,
      tone: "working",
      word: "working",
      title: "Agent working",
      since: runtime?.activityStartedAt ?? thread.latestRun?.startedAt ?? null,
    };
  }
  if (status === "waiting") {
    return {
      ...base,
      tone: "waiting",
      word: "waiting",
      title: thread.blockedOnThreadWait ? "Agent waiting on another thread" : "Agent waiting",
    };
  }
  const failed = FAILED[status];
  if (failed) {
    return {
      ...base,
      tone: "failed",
      ...failed,
      hint: ENDED_HINT,
      since: thread.latestRun?.completedAt ?? thread.updatedAt,
      error: runtime?.lastError ?? null,
    };
  }
  return {
    ...base,
    tone: "ended",
    word: "turn ended",
    title: "Agent's turn ended",
    hint: ENDED_HINT,
    since: thread.latestRun?.completedAt ?? thread.updatedAt,
  };
}

const NEEDS_PERSON = new Set(["needs approval", "needs answer"]);

/**
 * What the agents of a post's runs are doing, as a post's note: `2 need you · 1 working`, the ones
 * a person must answer first. Null when none of them is in this client's store.
 */
export function agentCensus(pulses: ReadonlyArray<AgentPulse | null>): string | null {
  const counts = { you: 0, failed: 0, working: 0, waiting: 0, ended: 0 };
  for (const pulse of pulses) {
    if (pulse === null) continue;
    if (NEEDS_PERSON.has(pulse.word)) counts.you += 1;
    else counts[pulse.tone] += 1;
  }
  const parts = [
    counts.you > 0 ? `${counts.you} ${counts.you === 1 ? "needs" : "need"} you` : null,
    counts.failed > 0 ? `${counts.failed} failed` : null,
    counts.working > 0 ? `${counts.working} working` : null,
    counts.waiting > 0 ? `${counts.waiting} waiting` : null,
    counts.ended > 0 ? `${counts.ended} idle` : null,
  ].filter((part) => part !== null);
  return parts.length === 0 ? null : parts.join(" · ");
}
