import { type ReactNode, useRef } from "react";

import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { cn } from "~/lib/utils";

import type { RunDetailTab } from "./runDetailTabs";

export interface RunDetailPart {
  readonly label: string;
  /** A count or a mark beside the label. */
  readonly aside?: ReactNode;
  readonly panel: ReactNode;
}

/**
 * Everything about a run past its lead, one part at a time behind a bar that stays in reach while
 * the part scrolls. The page picks which part opens for the run's state.
 */
export function RunDetails({
  tabs,
  tab,
  onTab,
  parts,
}: {
  tabs: ReadonlyArray<RunDetailTab>;
  tab: RunDetailTab;
  onTab: (tab: RunDetailTab) => void;
  parts: Record<RunDetailTab, RunDetailPart>;
}) {
  const sectionRef = useRef<HTMLElement>(null);
  const pick = (next: RunDetailTab) => {
    onTab(next);
    // Deep in a long part, the next one starts at its top, under the bar.
    const section = sectionRef.current;
    if (section !== null && section.getBoundingClientRect().top < 0) {
      section.scrollIntoView({ block: "start" });
    }
  };
  return (
    <section aria-label="Run details" className="flex flex-col gap-3" ref={sectionRef}>
      <div className="sticky top-0 z-10 -mx-5 overflow-x-auto bg-background px-5 py-2 sm:-mx-6 sm:px-6">
        <ToggleGroup
          aria-label="Show"
          onValueChange={(value) => {
            const next = value[0] as RunDetailTab | undefined;
            if (next !== undefined && tabs.includes(next)) pick(next);
          }}
          value={[tab]}
          variant="segmented"
        >
          {tabs.map((id) => (
            <Toggle data-tab={id} key={id} value={id}>
              {parts[id].label}
              {parts[id].aside ?? null}
            </Toggle>
          ))}
        </ToggleGroup>
      </div>
      <div data-panel={tab}>{parts[tab].panel}</div>
    </section>
  );
}

/** A tab's count, quiet beside its label. */
export const TabCount = ({ n }: { n: number }) => (
  <span className="font-mono text-muted-foreground tabular-nums">{n}</span>
);

/** Whether the last gate passed: a dot in the gate's own colours. */
export const TabDot = ({ ok }: { ok: boolean }) => (
  <span
    aria-label={ok ? "passed" : "failed"}
    className={cn("size-1.5 rounded-full", ok ? "bg-success" : "bg-destructive")}
    role="img"
  />
);
