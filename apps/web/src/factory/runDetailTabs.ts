import type { FactoryEntry } from "./api";
import { lastGateOutput, prUrlOf, runState } from "./format";
import { nextStep } from "./nextStep";

/** The run page's parts below its lead, one shown at a time. */
export type RunDetailTab = "timeline" | "gate" | "github" | "ledger";

/**
 * The tabs a run has and the one its page opens on: where the fix starts for a run that stopped
 * for a person, the pull request once there is one and the agent is not at work, else the timeline.
 */
export function runDetails(
  entries: ReadonlyArray<FactoryEntry>,
  { gitHub }: { gitHub: boolean },
): { tabs: ReadonlyArray<RunDetailTab>; lead: RunDetailTab } {
  const gate = lastGateOutput(entries);
  const tabs: Array<RunDetailTab> = ["timeline"];
  if (gate.commands.length > 0 || gate.message !== null) tabs.push("gate");
  if (gitHub) tabs.push("github");
  tabs.push("ledger");

  const step = nextStep(entries);
  let lead: RunDetailTab = "timeline";
  if (step !== null) {
    if (step.focus === "gate") lead = "gate";
    else if (step.focus === "issue" || step.focus === "checks") lead = "github";
  } else if (prUrlOf(entries) !== null && runState(entries) !== "building") {
    lead = "github";
  }
  return { tabs, lead: tabs.includes(lead) ? lead : "timeline" };
}
