import type { FactoryEntry } from "./api";
import { prEndOf, type PrEnd, textField } from "./format";

/** Where a run's time went: its agent building, the factory's gate, or its pull request waiting on review. */
export type ReportStage = "agent" | "gate" | "review";

export interface ReportSegment {
  readonly stage: ReportStage;
  readonly startMs: number;
  readonly endMs: number;
}

/** A moment the run went back: a gate failure sent to the agent, review feedback, or a base branch move. */
export type ReportMarkKind = "gate-failed" | "feedback" | "base-moved";

export interface ReportMark {
  readonly kind: ReportMarkKind;
  readonly atMs: number;
}

export interface RunReport {
  readonly end: PrEnd;
  /** Claim to the `finished` line. */
  readonly totalMs: number;
  /** In order, neighbours of one stage joined. */
  readonly segments: ReadonlyArray<ReportSegment>;
  readonly totals: Readonly<Record<ReportStage, number>>;
  readonly marks: ReadonlyArray<ReportMark>;
  /** Review feedback and comments forwarded to the agent. */
  readonly feedbackRounds: number;
  /** Gate failures sent back to the agent to fix. */
  readonly gateSendBacks: number;
  /** Times the base branch moved and the gate ran again. */
  readonly baseMoves: number;
  readonly sessions: number;
  /** Merged with nothing sent back to the agent. */
  readonly firstTry: boolean;
}

const GATE_EVENTS = new Set(["gate_checkout", "gate_command", "gate_regate", "gate_finished"]);
const FEEDBACK_EVENTS = new Set([
  "feedback_relaunching",
  "feedback_forwarding",
  "comment_forwarded",
]);

/**
 * A finished run's time split by stage, and the rounds that sent it back, from its ledger. Null
 * unless its pull request ended (merged or closed); stuck and needs-info runs have a Next step card.
 * A gate is open from its checkout to its last gate line; the factory writes each command's line
 * when the command ends.
 */
export function runReport(entries: ReadonlyArray<FactoryEntry>): RunReport | null {
  const end = prEndOf(entries);
  const finished = entries.findLast((entry) => entry.event === "finished");
  if (end === null || finished === undefined) return null;
  const startAt = entries.findIndex((entry) => entry.event === "claimed");
  const from = Math.max(0, startAt);
  const segments: Array<ReportSegment> = [];
  let cursor = entries[from]?.ms ?? finished.ms;
  let current: ReportStage = "agent";
  let base: ReportStage = "agent";
  let gateLast: number | null = null;
  const cut = (atMs: number, next: ReportStage) => {
    if (atMs > cursor) {
      const last = segments.at(-1);
      if (last?.stage === current) segments[segments.length - 1] = { ...last, endMs: atMs };
      else segments.push({ stage: current, startMs: cursor, endMs: atMs });
      cursor = atMs;
    }
    current = next;
  };
  const marks: Array<ReportMark> = [];
  const mark = (kind: ReportMarkKind, atMs: number) => marks.push({ kind, atMs });
  let sessions = 0;
  for (const entry of entries.slice(from)) {
    if (entry === finished) break;
    if (gateLast !== null) {
      if (GATE_EVENTS.has(entry.event)) {
        gateLast = entry.ms;
        if (entry.event === "gate_regate") mark("base-moved", entry.ms);
        continue;
      }
      cut(gateLast, base);
      gateLast = null;
    }
    switch (entry.event) {
      case "gate_checkout":
        cut(entry.ms, "gate");
        gateLast = entry.ms;
        break;
      case "gate_regate":
        mark("base-moved", entry.ms);
        break;
      case "gate_sent_back":
        mark("gate-failed", entry.ms);
        break;
      case "session_launched":
        sessions++;
        break;
      case "state_changed":
        base = textField(entry.data, "to") === "pr-open" ? "review" : "agent";
        cut(entry.ms, base);
        break;
      default:
        if (FEEDBACK_EVENTS.has(entry.event)) mark("feedback", entry.ms);
    }
  }
  cut(gateLast ?? finished.ms, base);
  cut(finished.ms, base);
  const totals: Record<ReportStage, number> = { agent: 0, gate: 0, review: 0 };
  for (const segment of segments) totals[segment.stage] += segment.endMs - segment.startMs;
  const count = (kind: ReportMarkKind) => marks.filter((m) => m.kind === kind).length;
  const feedbackRounds = count("feedback");
  const gateSendBacks = count("gate-failed");
  return {
    end,
    totalMs: finished.ms - (entries[from]?.ms ?? finished.ms),
    segments,
    totals,
    marks,
    feedbackRounds,
    gateSendBacks,
    baseMoves: count("base-moved"),
    sessions,
    firstTry: end === "merged" && gateSendBacks === 0 && feedbackRounds === 0,
  };
}
