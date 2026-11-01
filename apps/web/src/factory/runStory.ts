import type { FactoryEntry } from "./api";
import { type GateCommand, type LinkRef, prRef, textField } from "./format";
import type { BeltColour } from "./runTrack";

/**
 * A step's colour in the belt's language: its post's, Stuck for a failure, Needs info for what a
 * person may need to look at, muted for bookkeeping.
 */
export type StoryTone = BeltColour | "muted";

/** One thing that happened to a run, in words a person reads. Detail text is untrusted. */
export interface StoryStep {
  readonly key: string;
  readonly ts: string;
  /** Time since the ledger's first entry, as `+9m 14s`. */
  readonly at: string;
  readonly tone: StoryTone;
  readonly title: string;
  readonly detail: string | null;
  readonly commands?: ReadonlyArray<GateCommand>;
  readonly threadId?: string;
  readonly link?: LinkRef;
}

export interface RunStory {
  readonly steps: ReadonlyArray<StoryStep>;
  readonly gateRuns: { readonly total: number; readonly failed: number };
  readonly sessions: number;
  /** The `finished` entry's total time; null before the run finishes. */
  readonly tookMs: number | null;
}

/** A span of time as `0.4s`, `26s`, `9m 14s`, `2h 48m` or `3d 5h`. */
export function formatSpan(ms: number): string {
  if (ms < 10_000) return `${Number((ms / 1000).toFixed(1))}s`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

const numberField = (data: unknown, key: string): number | null => {
  if (typeof data !== "object" || data === null) return null;
  const value = (data as Record<string, unknown>)[key];
  return typeof value === "number" ? value : null;
};

const firstLine = (text: string | null): string | null => text?.split("\n")[0]?.trim() || null;

const prText = (data: unknown): string => {
  const pr = numberField(data, "pr");
  return pr === null ? "Pull request" : `Pull request #${pr}`;
};

const STEP_VERBS: Record<string, string> = {
  start: "starting",
  advance: "advancing",
  gate: "gating",
  forward: "forwarding",
  watch: "watching",
};

/** Events the story leaves to the raw ledger: bookkeeping, or told by a neighbouring step. */
const QUIET = new Set([
  "step_changed",
  "state_changed",
  "worktree_removed",
  "gate_checkout",
  "gate_finished",
  "regate_relaunching",
]);

type Told = Pick<StoryStep, "tone" | "title" | "detail"> & Partial<StoryStep>;

function tell(entry: FactoryEntry, sessionsBefore: number): Told {
  const { data } = entry;
  const by = (key: string) => textField(data, key);
  switch (entry.event) {
    case "claimed": {
      const user = by("github_user");
      const machine = by("machine");
      const detail =
        user && machine
          ? `by ${user} on ${machine}`
          : user
            ? `by ${user}`
            : machine
              ? `on ${machine}`
              : null;
      return { tone: "claimed", title: "Claimed", detail };
    }
    case "session_launched": {
      const threadId = by("thread_id");
      return {
        tone: "building",
        title: sessionsBefore === 0 ? "Agent session started" : "Agent session relaunched",
        detail: by("model"),
        ...(threadId ? { threadId } : {}),
      };
    }
    case "pr_opened": {
      const link = prRef(by("url"));
      return {
        tone: "pr",
        title: link ? "Opened pull request" : `Opened ${prText(data).toLowerCase()}`,
        detail: null,
        ...(link ? { link } : {}),
      };
    }
    case "gate_regate":
      return { tone: "muted", title: "Base branch moved; gating again", detail: null };
    case "gate_sent_back":
      return { tone: "building", title: "Sent the failure back to the agent", detail: null };
    case "feedback_relaunching":
    case "feedback_forwarding": {
      const n = numberField(data, "n");
      return {
        tone: "building",
        title: "Forwarded review feedback to the agent",
        detail: n === null ? null : `${n} ${n === 1 ? "item" : "items"}`,
      };
    }
    case "comment_forwarded":
      return { tone: "building", title: "Forwarded a comment to the agent", detail: null };
    case "pr_set_draft":
      return { tone: "muted", title: `${prText(data)} set to draft`, detail: null };
    case "pr_ready_outside": {
      const who = by("by");
      return {
        tone: "pr",
        title: `${prText(data)} marked ready${who ? ` by ${who}` : ""}`,
        detail: null,
      };
    }
    case "pr_left":
      return { tone: "muted", title: `Left ${prText(data).toLowerCase()}`, detail: null };
    case "session_interrupted":
      return { tone: "info", title: "Agent session interrupted", detail: null };
    case "session_rate_limited":
      return { tone: "info", title: "Agent hit a rate limit", detail: null };
    case "session_paused":
      return { tone: "info", title: "Agent session paused", detail: null };
    case "questions_posted":
      return {
        tone: "info",
        title: "Posted questions on the issue",
        detail: firstLine(by("questions")),
      };
    case "stuck":
      return { tone: "stuck", title: "Stuck", detail: firstLine(by("reason")) };
    case "stop_requested": {
      const who = by("by");
      return { tone: "info", title: `Stop requested${who ? ` by ${who}` : ""}`, detail: null };
    }
    case "error": {
      const kind = by("kind");
      const step = by("step");
      const what = kind ? `${kind[0]!.toUpperCase()}${kind.slice(1)} error` : "Error";
      const where = step ? ` while ${STEP_VERBS[step] ?? step}` : "";
      return { tone: "stuck", title: `${what}${where}`, detail: firstLine(by("message")) };
    }
    case "finished": {
      const end = by("pr_end");
      const total = numberField(data, "total_ms");
      const detail = total === null ? null : `after ${formatSpan(total)}`;
      if (end === "merged") return { tone: "done", title: "Pull request merged", detail };
      if (end === "closed") return { tone: "muted", title: "Pull request closed", detail };
      return { tone: "muted", title: `Finished: ${by("outcome") ?? "unknown"}`, detail };
    }
    default:
      return { tone: "muted", title: entry.event.replaceAll("_", " "), detail: null };
  }
}

function readCommand(data: unknown): GateCommand | null {
  const command = textField(data, "command");
  const exit = numberField(data, "exit_code");
  const duration = numberField(data, "duration_ms");
  return command === null || exit === null || duration === null
    ? null
    : { command, exit_code: exit, duration_ms: duration };
}

/**
 * A run's ledger as a story: what happened, in order, timed from its first entry. Each gate run,
 * a stretch of `gate_command` entries of one attempt, becomes one step.
 */
export function runStory(entries: ReadonlyArray<FactoryEntry>): RunStory {
  const startMs = entries[0]?.ms ?? 0;
  const steps: Array<StoryStep> = [];
  let sessions = 0;
  let total = 0;
  let failed = 0;
  let i = 0;
  while (i < entries.length) {
    const entry = entries[i]!;
    const base = {
      key: `${i}`,
      ts: entry.ts,
      at: `+${formatSpan(Math.max(0, entry.ms - startMs))}`,
    };
    if (entry.event === "gate_command") {
      const attempt = numberField(entry.data, "attempt");
      const commands: Array<GateCommand> = [];
      let last = entry;
      while (
        i < entries.length &&
        entries[i]!.event === "gate_command" &&
        numberField(entries[i]!.data, "attempt") === attempt
      ) {
        last = entries[i]!;
        const command = readCommand(last.data);
        if (command) commands.push(command);
        i++;
      }
      const passed = commands.every((command) => command.exit_code === 0);
      const ms = commands.reduce((sum, command) => sum + command.duration_ms, 0);
      total++;
      if (!passed) failed++;
      steps.push({
        ...base,
        ts: last.ts,
        tone: passed ? "gate" : "stuck",
        title: passed ? "Gate passed" : "Gate failed",
        detail: [attempt === null ? null : `attempt ${attempt}`, formatSpan(ms)]
          .filter(Boolean)
          .join(" · "),
        commands,
      });
      continue;
    }
    i++;
    if (QUIET.has(entry.event)) continue;
    steps.push({ ...base, ...tell(entry, sessions) });
    if (entry.event === "session_launched") sessions++;
  }
  const finished = entries.findLast((entry) => entry.event === "finished");
  return {
    steps,
    gateRuns: { total, failed },
    sessions,
    tookMs: finished ? numberField(finished.data, "total_ms") : null,
  };
}
