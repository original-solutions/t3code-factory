import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

import { formatAge } from "./format";
import type { RepoDay, RepoHealth, RepoVerdict } from "./repoHealth";

export const REPO_TONE: Record<RepoVerdict, string> = {
  stuck: "var(--factory-stuck)",
  info: "var(--factory-info)",
  moving: "var(--factory-building)",
  flowing: "var(--factory-done)",
  quiet: "var(--muted-foreground)",
};

/** The verdict as its count where it has one: "2 stuck", "1 needs info", "3 in flight". */
export const repoHeadline = (repo: RepoHealth): string => {
  switch (repo.verdict) {
    case "stuck":
      return `${repo.stuck} stuck`;
    case "info":
      return `${repo.info} ${repo.info === 1 ? "needs" : "need"} info`;
    case "moving":
      return `${repo.inFlight} in flight`;
    case "flowing":
      return "Flowing";
    case "quiet":
      return "Quiet";
  }
};

/** What else is true of the repo, past its headline. */
const facts = (repo: RepoHealth, nowMs: number): Array<string> => {
  const rest: Array<string> = [];
  if (repo.verdict !== "info" && repo.info > 0) rest.push(`${repo.info} needs info`);
  if (repo.verdict !== "moving" && repo.inFlight > 0) rest.push(`${repo.inFlight} in flight`);
  const last = repo.lastMergeMs === null ? null : formatAge(repo.lastMergeMs, nowMs);
  if (repo.merged > 0) rest.push(`${repo.merged} merged this week, last ${last} ago`);
  else rest.push(last === null ? "no recent merges" : `last merge ${last} ago`);
  return rest;
};

const dayName = (startMs: number) =>
  new Date(startMs).toLocaleDateString(undefined, { weekday: "short" });

/** The days that had something, as words: "Wed 16 merged, 3 stopped". */
const weekText = (days: ReadonlyArray<RepoDay>): string => {
  const busy = days.filter(({ merged, stopped }) => merged + stopped > 0);
  if (busy.length === 0) return "Nothing merged or stopped in the last seven days.";
  return busy
    .map(({ startMs, merged, stopped }) =>
      [
        `${dayName(startMs)}`,
        merged > 0 ? `${merged} merged` : null,
        stopped > 0 ? `${stopped} stopped` : null,
      ]
        .filter(Boolean)
        .join(" "),
    )
    .join(" · ");
};

/** The week as seven small columns, green for what merged over red for what stopped. */
function WeekBars({ days, scale }: { days: ReadonlyArray<RepoDay>; scale: number }) {
  const share = (count: number) => `${(count / scale) * 100}%`;
  return (
    <span aria-hidden className="flex h-6 shrink-0 items-end gap-0.5">
      {days.map(({ startMs, merged, stopped }) => (
        <span
          className="flex h-full w-1.5 flex-col-reverse overflow-hidden rounded-xs bg-muted"
          data-day={startMs}
          key={startMs}
        >
          <span style={{ height: share(stopped), background: "var(--factory-stuck)" }} />
          <span style={{ height: share(merged), background: "var(--factory-done)" }} />
        </span>
      ))}
    </span>
  );
}

/**
 * Every repo on the page as a tile, the ones that need a person first: its verdict on a coloured
 * rail, what else is in flight or waiting, and its week as bars. A tile picks that repo for the
 * whole page (belt, bins and runs); the picked one again goes back to every repo.
 */
export function RepoBoard({
  repos,
  selected,
  onSelect,
  nowMs,
}: {
  repos: ReadonlyArray<RepoHealth>;
  /** The repo the page is filtered to, as the board names it; null for every repo. */
  selected: string | null;
  onSelect: (repo: string | null) => void;
  nowMs: number;
}) {
  const scale = Math.max(
    1,
    ...repos.flatMap(({ days }) => days.map(({ merged, stopped }) => merged + stopped)),
  );
  const tally = (verdict: RepoVerdict) => repos.filter((repo) => repo.verdict === verdict).length;
  const summary = [
    [tally("stuck"), "stuck"],
    [tally("info"), "waiting on an answer"],
    [tally("moving"), "in flight"],
    [tally("flowing"), "flowing"],
    [tally("quiet"), "quiet"],
  ]
    .filter(([count]) => count !== 0)
    .map(([count, word]) => `${count} ${word}`)
    .join(" · ");
  const picked = selected?.toLowerCase() ?? null;

  return (
    <section aria-label="Repos" className="@container flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-sm font-medium">
          {repos.length} {repos.length === 1 ? "repo" : "repos"}
        </h2>
        <span className="min-w-0 text-xs text-muted-foreground">{summary}</span>
      </div>
      <ul className="grid grid-cols-2 gap-2 @3xl:grid-cols-[repeat(auto-fill,minmax(17rem,1fr))]">
        {repos.map((repo) => {
          const slash = repo.repo.indexOf("/");
          const owner = repo.repo.slice(0, slash);
          const name = repo.repo.slice(slash + 1);
          const on = picked === repo.repo.toLowerCase();
          const detail = facts(repo, nowMs).join(" · ");
          return (
            <li className="min-w-0" key={repo.repo}>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      aria-label={`${repo.repo}: ${repoHeadline(repo)}`}
                      aria-pressed={on}
                      className={cn(
                        "flex w-full min-w-0 items-center gap-2 rounded-lg border border-l-4 bg-card py-2 pr-2.5 pl-2.5 text-left outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                        on && "bg-accent/40 ring-2 ring-inset ring-ring",
                        picked !== null && !on && "opacity-60 hover:opacity-100",
                      )}
                      data-verdict={repo.verdict}
                      onClick={() => onSelect(on ? null : repo.repo)}
                      style={{ borderLeftColor: REPO_TONE[repo.verdict] }}
                      type="button"
                    />
                  }
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex min-w-0 items-baseline gap-1 text-sm">
                      <span className="hidden min-w-0 shrink-[999] truncate text-xs text-muted-foreground @3xl:inline">
                        {owner}/
                      </span>
                      <span className="truncate font-medium">{name}</span>
                    </span>
                    <span className="flex min-w-0 items-baseline gap-1.5 text-xs">
                      <span
                        aria-hidden
                        className="inline-block size-2 shrink-0 self-center rounded-full"
                        style={{ background: REPO_TONE[repo.verdict] }}
                      />
                      <span className="shrink-0 font-medium">{repoHeadline(repo)}</span>
                    </span>
                    <span className="hidden truncate text-xs text-muted-foreground @3xl:block">
                      {detail}
                    </span>
                  </span>
                  <WeekBars days={repo.days} scale={scale} />
                </TooltipTrigger>
                <TooltipPopup className="max-w-80" side="bottom">
                  <span className="flex flex-col gap-0.5">
                    <b className="font-medium">{repo.repo}</b>
                    <span>
                      {repoHeadline(repo)} · {detail}
                    </span>
                    <span className="text-muted-foreground">{weekText(repo.days)}</span>
                  </span>
                </TooltipPopup>
              </Tooltip>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
