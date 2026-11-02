import { cn } from "~/lib/utils";

import type { AgentTone } from "./agentPulse";
import { AGENT_STATION } from "./RunAgent";

/**
 * Marks which environment a run belongs to: a solid dot for the environment picked in the belt, a
 * ring for the others, as the tiles are solid and hollow. With `tone`, it wears the colour of what
 * the run's agent is doing.
 */
export function BeltDot({ selected, tone }: { selected: boolean; tone?: AgentTone | undefined }) {
  const station = tone === undefined ? null : AGENT_STATION[tone];
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        station === null
          ? selected
            ? "bg-foreground"
            : "border-2 border-muted-foreground"
          : selected
            ? "bg-(--factory-station)"
            : "border-2 border-(--factory-station)",
      )}
      data-station={station ?? undefined}
    />
  );
}
