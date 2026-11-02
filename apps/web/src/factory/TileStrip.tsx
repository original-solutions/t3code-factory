import { useEffect, useRef } from "react";

import { cn } from "~/lib/utils";

import { agentChanged, type AgentPulse } from "./agentPulse";
import { oneShot } from "./beltMotion";

/**
 * A tile's top strip in its post's colour. A light runs along it once when the run's agent changes
 * state (starts working, waits on you, fails), never on routine thread activity, so a busy agent
 * leaves the belt still. It fades while the agent is not at work.
 */
export function TileStrip({ pulse }: { pulse: AgentPulse | null }) {
  const strip = useRef<HTMLSpanElement>(null);
  const seen = useRef(pulse);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- plays a CSS one-shot on the DOM when the agent changes state
  useEffect(() => {
    const before = seen.current;
    seen.current = pulse;
    if (agentChanged(before, pulse)) oneShot(strip.current, "factory-strip-beat");
  }, [pulse]);

  return (
    <span
      aria-hidden
      className={cn(
        "absolute inset-x-0 top-0 h-1 overflow-hidden bg-(--factory-station)",
        pulse !== null && pulse.tone !== "working" && "opacity-40",
      )}
      data-part="strip"
      ref={strip}
    />
  );
}
