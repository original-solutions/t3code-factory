import type { FactoryEntry } from "./api";
import { STATIONS, type Station } from "./belt";
import { prEndOf, runState, textField, type PrEnd } from "./format";

/** A colour of the belt's: a post's, or one of the two bins'. */
export type BeltColour = Station | "stuck" | "info";

export interface RunTrack {
  /** The furthest post the run reached, or null before its ledger has a line. */
  readonly reached: Station | null;
  /** The run stopped there: stuck, or waiting on an answer. */
  readonly halt: "stuck" | "info" | null;
  readonly end: PrEnd | null;
}

const GATE_EVENTS = new Set(["gate_checkout", "gate_command", "gate_regate", "gate_finished"]);

/** Which belt post a ledger line proves the run reached, if any. */
function postOf(entry: FactoryEntry): Station | null {
  if (GATE_EVENTS.has(entry.event)) return "gate";
  if (entry.event === "pr_opened") return "pr";
  if (entry.event === "state_changed") {
    const to = textField(entry.data, "to");
    if (to === "building") return "building";
    if (to === "pr-open") return "pr";
  }
  return null;
}

/** Where a run got to on the belt, from its ledger. */
export function runTrack(entries: ReadonlyArray<FactoryEntry>): RunTrack {
  if (entries.length === 0) return { reached: null, halt: null, end: null };
  const end = prEndOf(entries);
  let furthest = 0;
  for (const entry of entries) {
    const post = postOf(entry);
    if (post !== null) furthest = Math.max(furthest, STATIONS.indexOf(post));
  }
  if (end !== null) return { reached: "done", halt: null, end };
  const state = runState(entries);
  const halt = state === "stuck" ? "stuck" : state === "needs-info" ? "info" : null;
  return { reached: STATIONS[furthest]!, halt, end: null };
}

const MARKS: Record<string, { station: BeltColour | null; name: string }> = {
  triage: { station: "claimed", name: "Claimed" },
  building: { station: "building", name: "Building" },
  "pr-open": { station: "pr", name: "PR open" },
  merged: { station: "done", name: "Merged" },
  closed: { station: null, name: "Closed" },
  stuck: { station: "stuck", name: "Stuck" },
  "needs-info": { station: "info", name: "Needs info" },
};

/** A run's shown state as the belt names it, and the belt colour it wears (none for closed). */
export function stateMark(state: string | null): { station: BeltColour | null; name: string } {
  if (state === null) return { station: null, name: "Unknown" };
  return MARKS[state] ?? { station: null, name: state };
}
