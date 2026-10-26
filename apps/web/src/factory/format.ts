import { formatElapsedDurationLabel } from "../timestampFormat";
import type { FactoryEntry } from "./api";

export interface ParsedRunId {
  readonly owner: string;
  readonly repo: string;
  readonly issue: string;
  readonly attempt: number;
}

/**
 * `<owner>__<repo>__<issue>__<attempt>`; null for anything else. Read the way the server reads it:
 * the owner ends at the first `__`, the attempt and issue come from the right, and the rest is the
 * repo, which may hold `__`.
 */
export function parseRunId(id: string): ParsedRunId | null {
  const first = id.indexOf("__");
  if (first === -1) return null;
  const owner = id.slice(0, first);
  const afterOwner = id.slice(first + 2);
  const lastA = afterOwner.lastIndexOf("__");
  if (lastA === -1) return null;
  const attemptText = afterOwner.slice(lastA + 2);
  const beforeAttempt = afterOwner.slice(0, lastA);
  const lastB = beforeAttempt.lastIndexOf("__");
  if (lastB === -1) return null;
  const repo = beforeAttempt.slice(0, lastB);
  const issue = beforeAttempt.slice(lastB + 2);
  if (!/^[0-9]+$/.test(attemptText) || !owner || !repo || !issue) return null;
  return { owner, repo, issue, attempt: Number(attemptText) };
}

/** An error's message, or the value as text, for a notice. */
export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The string at `key` of an object, null for anything else. */
export const textField = (data: unknown, key: string): string | null => {
  if (typeof data !== "object" || data === null) return null;
  const value = (data as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
};

const numberField = (data: unknown, key: string): number | null => {
  if (typeof data !== "object" || data === null) return null;
  const value = (data as Record<string, unknown>)[key];
  return typeof value === "number" ? value : null;
};

/** The `step` of the last `step_changed` entry that has one. */
export function currentStep(entries: ReadonlyArray<FactoryEntry>): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.event !== "step_changed") continue;
    const step = textField(entry.data, "step");
    if (step !== null) return step;
  }
  return null;
}

/** The `thread_id` of the last `session_launched` entry that has one. */
export function threadIdOf(entries: ReadonlyArray<FactoryEntry>): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.event !== "session_launched") continue;
    const id = textField(entry.data, "thread_id");
    if (id !== null) return id;
  }
  return null;
}

export interface GateCommand {
  readonly command: string;
  readonly exit_code: number;
  readonly duration_ms: number;
}

export interface GateOutput {
  readonly attempt: number | null;
  readonly commands: ReadonlyArray<GateCommand>;
  /** What was last sent to the session: untrusted text, show it as text only. */
  readonly message: string | null;
}

const MESSAGE_EVENTS = new Set([
  "regate_relaunching",
  "feedback_relaunching",
  "feedback_forwarding",
]);

/**
 * What a ledger holds of the last gate: the commands of the highest attempt, and the message of
 * the last relaunch or forward after that attempt's last command.
 */
export function lastGateOutput(entries: ReadonlyArray<FactoryEntry>): GateOutput {
  let attempt: number | null = null;
  for (const entry of entries) {
    if (entry.event !== "gate_command") continue;
    const n = numberField(entry.data, "attempt");
    if (n !== null && (attempt === null || n > attempt)) attempt = n;
  }
  // The index of the last command of that attempt: a message counts only after it, as the answer
  // to that attempt's failure. One before it was about an earlier attempt.
  let lastCommandAt = -1;
  entries.forEach((entry, index) => {
    if (entry.event === "gate_command" && numberField(entry.data, "attempt") === attempt) {
      lastCommandAt = index;
    }
  });
  const commands: Array<GateCommand> = [];
  let message: string | null = null;
  for (const [index, entry] of entries.entries()) {
    if (entry.event === "gate_command" && numberField(entry.data, "attempt") === attempt) {
      const command = textField(entry.data, "command");
      const exit = numberField(entry.data, "exit_code");
      const duration = numberField(entry.data, "duration_ms");
      if (command !== null && exit !== null && duration !== null) {
        commands.push({ command, exit_code: exit, duration_ms: duration });
      }
    } else if (MESSAGE_EVENTS.has(entry.event) && index > lastCommandAt) {
      message = textField(entry.data, "message") ?? message;
    }
  }
  return { attempt, commands, message };
}

/** The time since `sinceMs` (Unix epoch ms) as `5m`; a dash when it is not a time. */
export function formatAge(sinceMs: number, nowMs: number): string {
  if (!Number.isFinite(sinceMs)) return "-";
  return formatElapsedDurationLabel(new Date(sinceMs).toISOString(), nowMs);
}

export function labelForState(state: string | null): string {
  return state ?? "unknown";
}

export type StateBadgeVariant = "info" | "success" | "error" | "warning" | "secondary";

export function stateBadgeVariant(state: string | null): StateBadgeVariant {
  switch (state) {
    case "building":
      return "info";
    case "pr-open":
      return "success";
    case "stuck":
      return "error";
    case "needs-info":
      return "warning";
    default:
      return "secondary";
  }
}

/** The `to` of the last `state_changed` entry. */
export function runState(entries: ReadonlyArray<FactoryEntry>): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.event !== "state_changed") continue;
    const to = textField(entry.data, "to");
    if (to !== null) return to;
  }
  return null;
}

export type PrEnd = "merged" | "closed";

/**
 * `merged` or `closed` for a run that finished because its pull request ended, else its last
 * state: the issue keeps its label after the pull request ends, so that state alone reads as if
 * the pull request were still waiting.
 */
export const shownState = (state: string | null, prEnd: PrEnd | null | undefined): string | null =>
  prEnd ?? state;

/** The `pr_end` of the `finished` entry, when it names one. */
export function prEndOf(entries: ReadonlyArray<FactoryEntry>): PrEnd | null {
  const end = textField(entries.findLast((entry) => entry.event === "finished")?.data, "pr_end");
  return end === "merged" || end === "closed" ? end : null;
}

/** A `finished` entry is written: the run is over whatever its last state says. */
export function runIsFinished(entries: ReadonlyArray<FactoryEntry>): boolean {
  return entries.some((entry) => entry.event === "finished");
}

/** What a stuck or needs-info run waits on a person for: untrusted text, show it as text only. */
export function whyStopped(
  entries: ReadonlyArray<FactoryEntry>,
): { readonly title: string; readonly text: string } | null {
  const state = runState(entries);
  const [event, key, title] =
    state === "stuck"
      ? ["stuck", "reason", "Why it is stuck"]
      : state === "needs-info"
        ? ["questions_posted", "questions", "Questions on the issue"]
        : [null, null, null];
  if (event === null) return null;
  const text = textField(entries.findLast((entry) => entry.event === event)?.data, key);
  return text === null ? null : { title, text };
}

/** A reference to show: a link when it has a target, else plain text. */
export interface LinkRef {
  readonly text: string;
  readonly href: string | null;
}

/** An issue of `owner/repo`: `#20` linked to GitHub when numeric, else the bare text. */
export const issueRef = (repo: string, issue: string): LinkRef =>
  /^[0-9]+$/.test(issue)
    ? { text: `#${issue}`, href: `https://github.com/${repo}/issues/${issue}` }
    : { text: issue, href: null };

/** A pull request: `#30` linked only for a github.com URL, else the URL as text. */
export const prRef = (url: string | null | undefined): LinkRef | null => {
  if (!url) return null;
  const match = /\/pull\/(\d+)/.exec(url);
  return url.startsWith("https://github.com/")
    ? { text: match ? `#${match[1]}` : "PR", href: url }
    : { text: url, href: null };
};

/** The `finished` line's pull request URL, else the last `pr_opened` one, as the runs list reads it. */
export function prUrlOf(entries: ReadonlyArray<FactoryEntry>): string | null {
  const end = textField(entries.findLast((entry) => entry.event === "finished")?.data, "pr_url");
  return end ?? textField(entries.findLast((entry) => entry.event === "pr_opened")?.data, "url");
}
