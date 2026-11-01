import { cn } from "~/lib/utils";

import { STATION_META, STATIONS } from "./belt";
import type { RunTrack as Track } from "./runTrack";

const HALT_WORD = { stuck: "stuck", info: "needs info" } as const;

/**
 * The belt's five posts as one line, painted in their colours up to where the run got: the post it
 * is at (or stopped at, in the stuck or needs-info colour) full, the ones behind it faded, the ones
 * ahead blank.
 */
export function RunTrackLine({ track }: { track: Track }) {
  if (track.reached === null) return null;
  const at = STATIONS.indexOf(track.reached);
  return (
    <ol aria-label="Where it is on the belt" className="grid grid-cols-5 gap-1.5">
      {STATIONS.map((station, i) => {
        const here = i === at;
        const colour = here && track.halt !== null ? track.halt : station;
        const closed = here && track.end === "closed";
        const name =
          here && track.end !== null
            ? track.end === "merged"
              ? "Merged"
              : "Closed"
            : STATION_META[station].name;
        return (
          <li
            aria-current={here ? "step" : undefined}
            className="flex min-w-0 flex-col gap-1.5"
            data-station={colour}
            key={station}
          >
            <span
              aria-hidden
              className={cn(
                "h-1.5 rounded-full",
                i > at
                  ? "bg-muted"
                  : closed
                    ? "bg-muted-foreground/40"
                    : here
                      ? "bg-(--factory-station)"
                      : "bg-(--factory-station)/35",
              )}
            />
            <span
              className={cn(
                "min-w-0 text-xs leading-tight break-words",
                here ? "font-semibold text-foreground" : "text-muted-foreground",
                i > at && "text-muted-foreground/60",
              )}
            >
              {name}
              {here && track.halt !== null ? (
                <span className="font-normal text-muted-foreground">
                  {" "}
                  · {HALT_WORD[track.halt]}
                </span>
              ) : null}
              <span className="sr-only">{i < at ? ", passed" : i > at ? ", ahead" : ""}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
