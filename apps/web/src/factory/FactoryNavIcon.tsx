import { FactoryIcon } from "lucide-react";

import { Badge } from "~/components/ui/badge";
import { cn } from "~/lib/utils";

import type { PulseTone } from "./pulse";

/**
 * The Factory glyph: attention count top-right, a dot bottom-right while runs are in flight or
 * claims are held. A fragment, so the svg is the button's direct child and takes its neighbours'
 * rules; the marks hang off an insetless `size-4` anchor placed first, so
 * `[&>span:last-child]:truncate` misses it.
 */
export function FactoryNavIcon({
  attention,
  tone = "idle",
}: {
  attention: number;
  tone?: PulseTone;
}) {
  return (
    <>
      {attention > 0 || tone !== "idle" ? (
        <span className="pointer-events-none absolute size-4">
          {attention > 0 ? (
            <span className="absolute -top-1 -right-2 flex">
              <Badge size="sm" variant="destructive">
                {attention}
              </Badge>
            </span>
          ) : null}
          {tone !== "idle" ? (
            <span
              className={cn(
                "absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2 ring-sidebar",
                tone === "held" ? "bg-(--factory-info)" : "bg-(--factory-building)",
              )}
              data-pulse={tone}
            />
          ) : null}
        </span>
      ) : null}
      <FactoryIcon />
    </>
  );
}
