import type { CSSProperties } from "react";

import { Badge } from "~/components/ui/badge";

import { stateMark } from "./runTrack";

const STATION_LABEL = { "--label": "var(--factory-station)" } as CSSProperties;

/** A run's state in the colour and words of its belt post, so the list and run page match the belt. */
export function StateChip({ state }: { state: string | null }) {
  const { station, name } = stateMark(state);
  if (station === null) return <Badge variant="secondary">{name}</Badge>;
  return (
    <Badge data-station={station} style={STATION_LABEL} variant="label">
      <span aria-hidden className="size-2 shrink-0 rounded-xs bg-(--factory-station)" />
      {name}
    </Badge>
  );
}
