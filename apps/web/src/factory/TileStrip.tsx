import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import { cn } from "~/lib/utils";
import { useThreadShell } from "~/state/entities";

import { BEAT_GAP_MS, oneShot } from "./beltMotion";

/**
 * A tile's top strip in its post's colour. Each time the run's thread gains an item (a message, a
 * tool call), a light runs along it once, at most every `BEAT_GAP_MS`: the belt moves when the
 * agent does and is still otherwise. `idle` fades it while the agent is not at work.
 */
export function TileStrip({
  environmentId,
  threadId,
  idle,
}: {
  environmentId: EnvironmentId;
  threadId: string | null;
  idle: boolean;
}) {
  const strip = useRef<HTMLSpanElement>(null);
  const lastBeat = useRef(0);
  // The live shell: the quiet one holds its item count through a turn.
  const items =
    useThreadShell(threadId === null ? null : scopeThreadRef(environmentId, threadId as ThreadId))
      ?.itemCount ?? null;
  const seen = useRef(items);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- plays a CSS one-shot on the DOM when the thread grows
  useEffect(() => {
    const before = seen.current;
    seen.current = items;
    if (items === null || before === null || items <= before) return;
    const now = Date.now();
    if (now - lastBeat.current < BEAT_GAP_MS) return;
    lastBeat.current = now;
    oneShot(strip.current, "factory-strip-beat");
  }, [items]);

  return (
    <span
      aria-hidden
      className={cn(
        "absolute inset-x-0 top-0 h-1 overflow-hidden bg-(--factory-station)",
        idle && "opacity-40",
      )}
      data-part="strip"
      ref={strip}
    />
  );
}
