import type { FactoryRunRow, FactoryStatus } from "./api";
import { parseRunId, prRef, shownState } from "./format";
import { dayLabel } from "./runLedger";
import { stateMark, type BeltColour } from "./runTrack";
import { splitStuckReason } from "./stuckCauses";

/** One environment's runs as the palette reads them: its full list, and its live status. */
export interface PaletteSource {
  readonly environmentId: string;
  readonly label: string;
  readonly runs: ReadonlyArray<FactoryRunRow> | null;
  readonly status: FactoryStatus | null;
}

export interface RunFind {
  readonly environmentId: string;
  readonly runId: string;
  readonly repo: string;
  /** `name #N title`: what the palette's root search matches, so `294` or a title word finds it. */
  readonly title: string;
  readonly description: string;
  readonly station: BeltColour | null;
  /** State, cause, reason, day words, PR, machine: what the Factory submenu's search also matches. */
  readonly searchTerms: ReadonlyArray<string>;
}

export interface RepoFind {
  readonly repo: string;
  readonly title: string;
  readonly description: string;
  readonly searchTerms: ReadonlyArray<string>;
}

export interface PaletteFinds {
  readonly runs: ReadonlyArray<RunFind>;
  readonly repos: ReadonlyArray<RepoFind>;
}

interface Row {
  readonly environmentId: string;
  readonly label: string;
  readonly id: string;
  readonly state: string | null;
  readonly lastEvent: string | null;
  readonly title: string | null;
  readonly reason: string | null;
  readonly startedMs: number;
  readonly prUrl: string | null;
}

const DAY_MS = 86_400_000;

const startOfWeek = (ms: number): number => {
  const date = new Date(ms);
  const sinceMonday = (date.getDay() + 6) % 7;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - sinceMonday).getTime();
};

/** Words a person uses for when something happened: today, yesterday, this or last week, the month. */
function dayWords(ms: number, nowMs: number): ReadonlyArray<string> {
  if (!Number.isFinite(ms)) return [];
  const date = new Date(ms);
  const words = [
    dayLabel(ms, nowMs),
    date.toLocaleDateString(undefined, { weekday: "long" }),
    date.toLocaleDateString(undefined, { month: "long" }),
  ];
  const week = startOfWeek(nowMs);
  if (ms >= week) words.push("this week");
  else if (ms >= week - 7 * DAY_MS) words.push("last week");
  return words;
}

/** A stuck run's cause, as the Stuck bin names it; null for any other run. */
const causeOf = (state: string | null, reason: string | null): string | null =>
  state === "stuck" && reason !== null && reason.trim() !== ""
    ? splitStuckReason(reason).cause
    : null;

/**
 * Every run on every machine as a palette row, newest first, and every repo they came from. A run
 * the live status lists takes its state from there, and one only the status knows (claimed since
 * the full list was read) is added, so the palette never shows a finished run as still building.
 */
export function paletteFinds(sources: ReadonlyArray<PaletteSource>, nowMs: number): PaletteFinds {
  const many = sources.length > 1;
  const rows: Row[] = [];
  for (const { environmentId, label, runs, status } of sources) {
    const live = new Map((status?.runs ?? []).map((run) => [run.id, run]));
    const seen = new Set<string>();
    for (const run of runs ?? []) {
      seen.add(run.id);
      const now = live.get(run.id);
      rows.push({
        environmentId,
        label,
        id: run.id,
        state: now?.state ?? shownState(run.state, run.pr_end),
        lastEvent: now?.last_event ?? run.last_event,
        title: run.title ?? now?.title ?? null,
        reason: run.reason ?? null,
        startedMs: run.started_ts === null ? Number.NaN : Date.parse(run.started_ts),
        prUrl: now?.pr_url ?? run.pr_url,
      });
    }
    for (const run of status?.runs ?? []) {
      if (seen.has(run.id)) continue;
      rows.push({
        environmentId,
        label,
        id: run.id,
        state: run.state,
        lastEvent: run.last_event ?? null,
        title: run.title ?? null,
        reason: null,
        startedMs: run.for_ms === null ? Number.NaN : nowMs - run.for_ms,
        prUrl: run.pr_url,
      });
    }
  }
  rows.sort((a, b) => (b.startedMs || 0) - (a.startedMs || 0));

  const repoRuns = new Map<
    string,
    { total: number; waiting: number; name: string; owner: string }
  >();
  const runs = rows.flatMap((row): RunFind[] => {
    const parsed = parseRunId(row.id);
    if (parsed === null) return [];
    const repo = `${parsed.owner}/${parsed.repo}`;
    const mark = stateMark(row.state, row.lastEvent);
    const tally = repoRuns.get(repo) ?? {
      total: 0,
      waiting: 0,
      name: parsed.repo,
      owner: parsed.owner,
    };
    tally.total++;
    if (row.state === "stuck" || row.state === "needs-info") tally.waiting++;
    repoRuns.set(repo, tally);
    const lead = causeOf(row.state, row.reason);
    const pr = prRef(row.prUrl);
    const day = Number.isFinite(row.startedMs) ? dayLabel(row.startedMs, nowMs) : null;
    const title = [`${parsed.repo} #${parsed.issue}`, row.title].filter(Boolean).join(" ");
    return [
      {
        environmentId: row.environmentId,
        runId: row.id,
        repo,
        title,
        description: [
          mark.name,
          parsed.attempt > 1 ? `attempt ${parsed.attempt}` : null,
          day,
          many ? row.label : null,
          lead,
        ]
          .filter(Boolean)
          .join(" · "),
        station: mark.station,
        searchTerms: [
          title,
          `#${parsed.issue}`,
          repo,
          mark.name,
          ...(row.state !== null && row.state !== mark.name ? [row.state] : []),
          ...(row.reason ? [row.reason.slice(0, 400)] : []),
          ...(pr ? [`PR ${pr.text}`] : []),
          ...dayWords(row.startedMs, nowMs),
          ...(many ? [row.label] : []),
        ],
      },
    ];
  });

  const repos = Array.from(repoRuns, ([repo, { total, waiting, name, owner }]): RepoFind => ({
    repo,
    title: name,
    description: [
      owner,
      `${total} ${total === 1 ? "run" : "runs"}`,
      waiting > 0 ? `${waiting} ${waiting === 1 ? "needs" : "need"} a person` : null,
    ]
      .filter(Boolean)
      .join(" · "),
    searchTerms: [name, repo, owner, "repo"],
  })).toSorted((a, b) => a.repo.localeCompare(b.repo));

  return { runs, repos };
}
