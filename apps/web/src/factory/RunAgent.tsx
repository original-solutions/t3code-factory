import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import { useQuietThreadShell, useThreadShell } from "~/state/entities";

import { agentPulse, type AgentPulse, type AgentTone } from "./agentPulse";
import { clockOfIso } from "./belt";
import type { BeltColour } from "./runTrack";

/** The agent's state in the belt's colours: working is Building, waiting on a person Needs info. */
export const AGENT_STATION: Record<AgentTone, BeltColour | null> = {
  working: "building",
  waiting: "info",
  failed: "stuck",
  ended: null,
};

/** A static dot in the agent's tone; it never animates, so a list of them costs no paint. */
export function AgentDot({ tone }: { tone: AgentTone }) {
  const station = AGENT_STATION[tone];
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        station === null ? "bg-muted-foreground/60" : "bg-(--factory-station)",
      )}
      data-agent-tone={tone}
      data-station={station ?? undefined}
    />
  );
}

/** The agent of a run's thread, held through streaming ticks; for lists, which need only the state. */
export function useQuietRunAgent(
  environmentId: EnvironmentId,
  threadId: string,
): AgentPulse | null {
  return agentPulse(useQuietThreadShell(scopeThreadRef(environmentId, threadId as ThreadId)));
}

/**
 * What an unfinished run's agent is doing, as a row of the run's card, from its thread as this
 * client already holds it: no factory read, and nothing at all when the thread is not here. The
 * card's Thread link is the way in.
 */
export function RunAgentLine({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: string;
}) {
  // The live shell, so the item count climbs as the agent works; one row on a page.
  const pulse = agentPulse(useThreadShell(scopeThreadRef(environmentId, threadId as ThreadId)));
  if (pulse === null) return null;
  const since = clockOfIso(pulse.since);
  const lastAt = clockOfIso(pulse.lastActivity);
  return (
    <div
      aria-label="Agent"
      className="flex flex-col gap-1 border-t pt-3 text-sm"
      data-agent-pulse={pulse.tone}
      role="group"
    >
      <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <AgentDot tone={pulse.tone} />
        <span className="font-medium">{pulse.title}</span>
        {since ? (
          <span className="text-muted-foreground tabular-nums">
            {pulse.tone === "working" ? "since" : "at"} {since}
          </span>
        ) : null}
      </p>
      <p className="pl-4 text-xs text-muted-foreground tabular-nums">
        {pulse.items} {pulse.items === 1 ? "item" : "items"} in the thread
        {lastAt ? ` · last change ${lastAt}` : ""}
      </p>
      {pulse.hint ? (
        <p className="break-words pl-4 text-xs text-muted-foreground">{pulse.hint}</p>
      ) : null}
      {pulse.error ? (
        <p className="break-words pl-4 font-mono text-xs text-destructive-foreground">
          {pulse.error}
        </p>
      ) : null}
    </div>
  );
}
