import type { FactoryRunRow } from "./api";
import "./belt.css";
import { FactoryCard, FactoryCardHeader } from "./FactoryCard";
import { factoryTrends, type TrendFigures, type TrendOutcome, type TrendWeek } from "./trends";

/** Bottom to top: what ended well, then what stopped, then what is still going. */
const STACK: ReadonlyArray<{ outcome: TrendOutcome; color: string; word: string }> = [
  { outcome: "merged", color: "var(--factory-done)", word: "merged" },
  {
    outcome: "closed",
    color: "color-mix(in srgb, var(--muted-foreground) 45%, transparent)",
    word: "closed",
  },
  { outcome: "stuck", color: "var(--factory-stuck)", word: "stuck" },
  { outcome: "info", color: "var(--factory-info)", word: "needs info" },
  { outcome: "active", color: "var(--factory-pr)", word: "in flight" },
];

const percent = (rate: number | null) => (rate === null ? "-" : `${Math.round(rate * 100)}%`);
/** Minutes are as fine as a week's trend needs: `<1m`, `42m`, `1h 52m`, `2d 3h`. */
const formatSpan = (ms: number) => {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
};
const span = (ms: number | null) => (ms === null ? "-" : formatSpan(ms));

const weekLabel = (week: TrendWeek, last: boolean) =>
  last
    ? "This week"
    : new Date(week.startMs).toLocaleDateString(undefined, { day: "numeric", month: "short" });

const weekSummary = (week: TrendWeek) =>
  STACK.filter(({ outcome }) => week.counts[outcome] > 0)
    .map(({ outcome, word }) => `${week.counts[outcome]} ${word}`)
    .join(", ") || "no runs";

/**
 * How `now` stands against `before`, and whether that is good news: `lower` says a fall is better.
 * Within `same` of each other they read as the same.
 */
function change(
  now: number | null,
  before: number | null,
  lower: boolean,
  same: number,
  show: (value: number) => string,
): { text: string; tone: "good" | "bad" | "same" } | null {
  if (now === null || before === null) return null;
  if (Math.abs(now - before) <= same)
    return { text: `about the same as ${show(before)}`, tone: "same" };
  const up = now > before;
  return {
    text: `${up ? "up" : "down"} from ${show(before)}`,
    tone: up === lower ? "bad" : "good",
  };
}

const TONE_CLASS = {
  good: "text-success-foreground",
  bad: "text-destructive-foreground",
  same: "text-muted-foreground",
} as const;

function Figure({
  label,
  value,
  note,
  delta,
}: {
  label: string;
  value: string;
  note: string;
  delta: ReturnType<typeof change>;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-lg bg-muted/40 px-3 py-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <b className="font-mono text-xl font-semibold leading-tight">{value}</b>
      <span className={`text-xs ${delta ? TONE_CLASS[delta.tone] : "text-muted-foreground"}`}>
        {delta?.text ?? note}
      </span>
    </div>
  );
}

function Figures({ now, before }: { now: TrendFigures; before: TrendFigures | null }) {
  const first = "no earlier week to compare";
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <Figure
        delta={null}
        label="Merged this week"
        note={before === null ? first : `so far; ${Number(before.merged.toFixed(1))} a week before`}
        value={String(now.merged)}
      />
      <Figure
        delta={change(now.stuckRate, before?.stuckRate ?? null, true, 0.02, percent)}
        label="Stuck"
        note={before === null ? first : "nothing ended yet"}
        value={percent(now.stuckRate)}
      />
      <Figure
        delta={change(now.infoRate, before?.infoRate ?? null, true, 0.02, percent)}
        label="Needs info"
        note={before === null ? first : "nothing ended yet"}
        value={percent(now.infoRate)}
      />
      <Figure
        delta={change(
          now.mergeMs,
          before?.mergeMs ?? null,
          true,
          0.1 * (before?.mergeMs ?? 0),
          formatSpan,
        )}
        label="Claim to merge"
        note={before === null ? first : "nothing merged yet"}
        value={span(now.mergeMs)}
      />
    </div>
  );
}

function WeekChart({ weeks }: { weeks: ReadonlyArray<TrendWeek> }) {
  const scale = Math.max(1, ...weeks.map((week) => week.total));
  return (
    <div className="flex flex-col gap-2">
      <ol aria-label="Runs per week" className="flex h-44 min-w-0 items-end gap-1.5 sm:gap-3">
        {weeks.map((week, i) => {
          const label = weekLabel(week, i === weeks.length - 1);
          return (
            <li
              aria-label={`${label}: ${weekSummary(week)}`}
              className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1"
              key={week.startMs}
            >
              <span className="font-mono text-xs text-muted-foreground">{week.total}</span>
              <span
                className="flex w-full max-w-12 flex-col-reverse overflow-hidden rounded-sm"
                style={{ height: `${(week.total / scale) * 100}%` }}
              >
                {STACK.map(({ outcome, color }) =>
                  week.counts[outcome] > 0 ? (
                    <span
                      className="block w-full"
                      key={outcome}
                      style={{ background: color, flexGrow: week.counts[outcome] }}
                    />
                  ) : null,
                )}
              </span>
              <span className="w-full truncate text-center text-2xs text-muted-foreground">
                {label}
              </span>
            </li>
          );
        })}
      </ol>
      <p aria-hidden className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {STACK.map(({ outcome, color, word }) => (
          <span className="inline-flex items-center gap-1.5" key={outcome}>
            <span className="inline-block size-2 rounded-full" style={{ background: color }} />
            {word}
          </span>
        ))}
      </p>
    </div>
  );
}

function WeekTable({ weeks }: { weeks: ReadonlyArray<TrendWeek> }) {
  const rows = weeks.map((week, i) => ({ week, label: weekLabel(week, i === weeks.length - 1) }));
  return (
    <table className="w-full self-start text-sm">
      <thead className="text-xs text-muted-foreground">
        <tr className="border-b">
          <th className="py-1.5 pr-2 text-left font-normal">Week of</th>
          <th className="hidden px-2 py-1.5 text-right font-normal sm:table-cell">Runs</th>
          <th className="px-2 py-1.5 text-right font-normal">Merged</th>
          <th className="px-2 py-1.5 text-right font-normal">Stuck</th>
          <th className="px-2 py-1.5 text-right font-normal">Needs info</th>
          <th className="py-1.5 pl-2 text-right font-normal">To merge</th>
        </tr>
      </thead>
      <tbody className="whitespace-nowrap font-mono">
        {rows.toReversed().map(({ week, label }) => (
          <tr className="border-b last:border-b-0" key={week.startMs}>
            <td className="py-1.5 pr-2 font-sans">{label}</td>
            <td className="hidden px-2 py-1.5 text-right sm:table-cell">{week.total}</td>
            <td className="px-2 py-1.5 text-right">{week.counts.merged}</td>
            <td className="px-2 py-1.5 text-right">{percent(week.stuckRate)}</td>
            <td className="px-2 py-1.5 text-right">{percent(week.infoRate)}</td>
            <td className="py-1.5 pl-2 text-right">{span(week.mergeMs)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function StuckCauses({
  causes,
  weeks,
}: {
  causes: NonNullable<ReturnType<typeof factoryTrends>>["causes"];
  weeks: ReadonlyArray<TrendWeek>;
}) {
  if (causes.length === 0) return null;
  const scale = Math.max(1, ...causes.flatMap(({ perWeek }) => perWeek));
  return (
    <FactoryCard aria-label="Why runs got stuck">
      <FactoryCardHeader eyebrow="Stuck runs by cause" title="Why runs got stuck" />
      <ul className="flex flex-col divide-y">
        {causes.slice(0, 6).map(({ cause, total, perWeek }) => (
          <li className="flex min-w-0 items-center gap-3 py-2 first:pt-0 last:pb-0" key={cause}>
            <span className="min-w-0 flex-1 text-sm break-words">{cause}</span>
            <span
              aria-label={`Per week: ${perWeek.join(", ")}`}
              className="flex h-5 shrink-0 items-end gap-0.5"
              role="img"
            >
              {perWeek.map((count, i) => (
                <span
                  className="w-2 rounded-xs bg-muted"
                  key={weeks[i]!.startMs}
                  style={
                    count > 0
                      ? {
                          height: `${Math.max(15, (count / scale) * 100)}%`,
                          background: "var(--factory-stuck)",
                        }
                      : { height: "15%" }
                  }
                />
              ))}
            </span>
            <b className="w-8 shrink-0 text-right font-mono text-sm font-semibold">{total}</b>
          </li>
        ))}
      </ul>
    </FactoryCard>
  );
}

/**
 * How the factory has done over the last weeks, from the full runs list the page already reads:
 * each week's runs by how they came out, this week against the weeks before, and the causes that
 * stopped runs, so a change to how issues are written or to the config shows in the weeks after.
 */
export function FactoryTrends({
  runs,
  nowMs,
}: {
  runs: ReadonlyArray<FactoryRunRow>;
  nowMs: number;
}) {
  const trends = factoryTrends(runs, nowMs);
  if (trends === null) {
    return <p className="text-sm text-muted-foreground">No runs to chart yet.</p>;
  }
  const { weeks, now, before, causes } = trends;
  const total = weeks.reduce((sum, week) => sum + week.total, 0);
  return (
    <section aria-label="Trends" className="flex min-w-0 flex-col gap-4">
      <FactoryCard>
        <FactoryCardHeader
          eyebrow="Runs per week"
          title={`The last ${weeks.length} ${weeks.length === 1 ? "week" : "weeks"}`}
        />
        <p className="-mt-2 text-xs text-muted-foreground">
          {total} runs, each in the week it was claimed. Rates are of the runs that ended.
        </p>
        <Figures before={before} now={now} />
        <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <WeekChart weeks={weeks} />
          <WeekTable weeks={weeks} />
        </div>
      </FactoryCard>
      <StuckCauses causes={causes} weeks={weeks} />
    </section>
  );
}
