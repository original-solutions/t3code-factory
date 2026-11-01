import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { MessageSquareIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import { useQuietThreadShell, useThreadShell } from "~/state/entities";

import { agentPulse, type AgentPulse, type AgentTone } from "./agentPulse";
import { formatClock } from "./belt";

const DOT: Record<AgentTone, string> = {
  working: "bg-success",
  waiting: "bg-warning",
  failed: "bg-destructive",
  ended: "bg-muted-foreground/60",
};

const RAIL: Record<AgentTone, string> = {
  working: "border-l-success",
  waiting: "border-l-warning",
  failed: "border-l-destructive",
  ended: "border-l-border",
};

const clockOf = (iso: string | null): string | null => {
  const ms = iso === null ? Number.NaN : Date.parse(iso);
  return Number.isNaN(ms) ? null : formatClock(ms);
};

/** A static dot in the agent's tone; it never animates, so a list of them costs no paint. */
export function AgentDot({ tone }: { tone: AgentTone }) {
  return (
    <span
      aria-hidden
      className={cn("inline-block size-2 shrink-0 rounded-full", DOT[tone])}
      data-agent-tone={tone}
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
 * What a building run's agent is doing, from its thread as this client already holds it: no
 * factory read, and nothing at all when the thread is not here.
 */
export function RunAgentCard({
  environmentId,
  threadId,
  stateLabel,
}: {
  environmentId: EnvironmentId;
  threadId: string;
  stateLabel: string;
}) {
  // The live shell, so the item count climbs as the agent works; one card on a page.
  const pulse = agentPulse(useThreadShell(scopeThreadRef(environmentId, threadId as ThreadId)));
  if (pulse === null) return null;
  const since = clockOf(pulse.since);
  const lastAt = clockOf(pulse.lastActivity);
  return (
    <section
      aria-label="Agent"
      className={cn(
        "flex flex-col gap-3 overflow-hidden rounded-xl border border-l-4 bg-card px-4 py-3",
        RAIL[pulse.tone],
      )}
      data-agent-pulse={pulse.tone}
    >
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="text-xs text-muted-foreground">{stateLabel} · live from its thread</p>
          <h2 className="flex flex-wrap items-center gap-x-2 text-base font-medium">
            <AgentDot tone={pulse.tone} />
            <span>{pulse.title}</span>
            {since ? (
              <span className="text-sm font-normal text-muted-foreground tabular-nums">
                {pulse.tone === "working" ? "since" : "at"} {since}
              </span>
            ) : null}
          </h2>
          <p className="text-xs text-muted-foreground tabular-nums">
            {pulse.items} {pulse.items === 1 ? "item" : "items"} in the thread
            {lastAt ? ` · last change ${lastAt}` : ""}
          </p>
          {pulse.hint ? (
            <p className="break-words text-xs text-muted-foreground">{pulse.hint}</p>
          ) : null}
        </div>
        <Button
          render={<Link params={{ environmentId, threadId }} to="/$environmentId/$threadId" />}
          size="sm"
          variant="outline"
        >
          <MessageSquareIcon />
          Open thread
        </Button>
      </header>
      {pulse.error ? (
        <p className="break-words font-mono text-xs text-destructive-foreground">{pulse.error}</p>
      ) : null}
    </section>
  );
}
