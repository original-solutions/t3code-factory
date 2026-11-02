import { useState } from "react";

import { placesOf, STATION_META, tileMotions, type Belt, type BeltRun, type Place } from "./belt";
import { samePlaces } from "./beltMotion";
import { parseRunId } from "./format";
import { splitStuckReason } from "./stuckCauses";

/** One run that changed place between two reads of the belt, in words. */
export interface BeltNewsItem {
  readonly key: string;
  readonly run: BeltRun;
  /** `widgets #158`: the repo without its owner, and the issue. */
  readonly who: string;
  /** `moved from Building to Gate`, `merged`, `is stuck: <cause>`… */
  readonly what: string;
}

const postName = (place: Exclude<Place, "stuck" | "info">) => STATION_META[place].name;

/**
 * What changed on the belt since `previous`, as the tiles' motion shows it to a sighted viewer:
 * a run moved post, was claimed, or landed in a bin. Nothing on the first read (`previous` null),
 * and nothing for a run that left the rail before any bin has it: it is told when it lands.
 */
export function beltNews(
  previous: ReadonlyMap<string, Place> | null,
  belt: Belt,
  showEnvironment: boolean,
): Array<BeltNewsItem> {
  const runs = new Map<string, BeltRun>();
  for (const run of [...Object.values(belt.runs).flat(), ...belt.stuck, ...belt.info]) {
    runs.set(run.key, run);
  }
  const news: Array<BeltNewsItem> = [];
  for (const motion of tileMotions(previous, placesOf(belt))) {
    if (motion.kind === "exit") continue;
    const run = runs.get(motion.key);
    if (run === undefined) continue;
    let what: string;
    if (motion.kind === "slide") {
      what = `moved from ${postName(motion.from)} to ${postName(motion.to)}`;
    } else if (motion.kind === "enter") {
      what = motion.to === "claimed" ? "was claimed" : `is at ${postName(motion.to)}`;
    } else if (motion.to === "done") {
      what = run.step === "closed" ? "closed" : "merged";
    } else if (motion.to === "stuck") {
      what = `is stuck: ${splitStuckReason(run.reason).cause}`;
    } else {
      what = "needs an answer";
    }
    const repo = parseRunId(run.id)?.repo;
    news.push({
      key: motion.key,
      run,
      who: repo === undefined ? run.issue : `${repo} ${run.issue}`,
      what: showEnvironment ? `${what} on ${run.label}` : what,
    });
  }
  return news;
}

interface Heard {
  /** What the belt shows (its filters): a new scope is a first read, not news. */
  readonly scope: string;
  readonly places: ReadonlyMap<string, Place> | null;
  readonly news: ReadonlyArray<BeltNewsItem>;
  /** When the latest news came (epoch ms). */
  readonly at: number;
}

/**
 * The latest news of the belt as each poll derives it, kept until newer news replaces it. `live`
 * is false until the belt has a first read; that read, and the first under a new `scope`, are
 * silent. Unlike the tiles' motion, this does not stop for `prefers-reduced-motion`. News is dated
 * `nowMs`, the page's clock.
 */
export function useBeltNews(
  belt: Belt,
  live: boolean,
  scope: string,
  showEnvironment: boolean,
  nowMs: number,
) {
  const [heard, setHeard] = useState<Heard>({ scope, places: null, news: [], at: 0 });
  const places = placesOf(belt);
  if (live) {
    if (heard.scope !== scope) {
      setHeard({ scope, places, news: [], at: 0 });
    } else if (heard.places === null || !samePlaces(heard.places, places)) {
      const news = beltNews(heard.places, belt, showEnvironment);
      setHeard(news.length > 0 ? { scope, places, news, at: nowMs } : { ...heard, places });
    }
  }
  return heard;
}
