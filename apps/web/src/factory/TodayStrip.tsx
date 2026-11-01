import { Link } from "@tanstack/react-router";

import { formatClock } from "./belt";
import type { DayStrip as Strip, DayTone } from "./dayStrip";
import { formatAge } from "./format";

const TONE_COLOR: Record<DayTone, string> = {
  claimed: "var(--factory-claimed)",
  building: "var(--factory-building)",
  pr: "var(--factory-pr)",
  done: "var(--factory-done)",
  closed: "var(--muted-foreground)",
  stuck: "var(--factory-stuck)",
  info: "var(--factory-info)",
};

const TONE_WORD: Record<DayTone, string> = {
  claimed: "claimed",
  building: "building",
  pr: "PR open",
  done: "merged",
  closed: "closed",
  stuck: "stuck",
  info: "needs info",
};

const LANE_PX = 8;
const GAP_PX = 4;
const HOURS = [0, 6, 12, 18, 24] as const;

const pct = (fraction: number) => `${fraction * 100}%`;

/**
 * Today on one 24-hour strip: each run that touched the day a bar from its claim to its end (to now
 * while it runs), coloured by its post or how it ended, linking to its run. Static between reads.
 */
export function TodayStrip({ strip }: { strip: Strip | null }) {
  const lanes = strip?.lanes ?? 1;
  const height = lanes * LANE_PX + (lanes - 1) * GAP_PX;
  const nowAt = strip?.nowAt ?? null;
  return (
    <section aria-label="Today" className="w-full border-t px-5 pt-2.5 pb-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs text-muted-foreground">Today</span>
        <span className="text-xs text-muted-foreground">
          {strip === null
            ? "-"
            : strip.bars.length === 0
              ? "no runs yet today"
              : `${strip.bars.length} ${strip.bars.length === 1 ? "run" : "runs"} on the clock`}
        </span>
      </div>
      <div className="relative mt-2" style={{ height }}>
        <div aria-hidden className="pointer-events-none absolute inset-0">
          {HOURS.map((hour) => (
            <span
              className="absolute -inset-y-1 w-px bg-border"
              key={hour}
              style={{ left: pct(hour / 24) }}
            />
          ))}
          {strip?.heldAt == null || nowAt === null ? null : (
            <span
              className="absolute -inset-y-1 border-x border-dashed border-(--factory-claimed)/50 bg-(--factory-claimed)/10"
              data-part="held"
              style={{ left: pct(strip.heldAt), width: pct(nowAt - strip.heldAt) }}
            />
          )}
          {nowAt === null ? null : (
            <>
              <span
                className="absolute inset-y-0 right-0 rounded-r-sm bg-muted/60"
                style={{ left: pct(nowAt) }}
              />
              <span
                className="absolute -inset-y-1.5 w-0.5 -translate-x-1/2 rounded-full bg-foreground/70"
                data-part="now"
                style={{ left: pct(nowAt) }}
              />
            </>
          )}
        </div>
        {strip && strip.bars.length > 0 ? (
          <ol aria-label="Today's runs" className="m-0 list-none p-0">
            {strip.bars.map((bar) => {
              const span = `${bar.clipped ? "since yesterday" : formatClock(bar.startedMs)} → ${
                bar.live ? "now" : formatClock(bar.endMs)
              }`;
              const took = formatAge(bar.startedMs, bar.endMs);
              const name = `${bar.issue} ${TONE_WORD[bar.tone]}, ${span} (${took}) on ${bar.label}`;
              return (
                <li
                  className="absolute"
                  data-tone={bar.tone}
                  key={bar.key}
                  style={{
                    left: pct(bar.from),
                    width: `max(${pct(bar.to - bar.from)}, 4px)`,
                    top: bar.lane * (LANE_PX + GAP_PX),
                    height: LANE_PX,
                  }}
                >
                  <Link
                    aria-label={name}
                    className="relative block size-full rounded-full opacity-80 outline-none transition-[opacity,transform] after:absolute after:-inset-y-1.5 after:inset-x-0 hover:scale-y-150 hover:opacity-100 focus-visible:scale-y-150 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                    params={{ environmentId: bar.environmentId, runId: bar.id }}
                    style={{ background: TONE_COLOR[bar.tone] }}
                    title={bar.title ? `${name}\n${bar.title}` : name}
                    to="/factory/$environmentId/$runId"
                  />
                </li>
              );
            })}
          </ol>
        ) : null}
      </div>
      <div aria-hidden className="relative mt-2 h-3.5 font-mono text-3xs text-muted-foreground">
        {HOURS.map((hour) => (
          <span
            className={
              hour === 0
                ? "absolute left-0"
                : hour === 24
                  ? "absolute right-0"
                  : "absolute -translate-x-1/2"
            }
            key={hour}
            style={hour === 0 || hour === 24 ? undefined : { left: pct(hour / 24) }}
          >
            {String(hour).padStart(2, "0")}
          </span>
        ))}
      </div>
    </section>
  );
}
