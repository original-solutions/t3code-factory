import type { FactoryRunDetail, FactoryStatus } from "./api";
import { type Place, stationOf } from "./belt";
import { prEndOf, prUrlOf, runIsFinished, runState, shownState, textField } from "./format";

/** The factory run a chat thread is the session of, as the thread's header shows it. */
export interface ThreadRun {
  readonly id: string;
  /** Its shown state: `merged`/`closed` for a run that ended on its pull request. */
  readonly state: string | null;
  /** Where the belt shows it, which colours its mark; null for a run that ended on neither. */
  readonly place: Place | null;
  readonly prUrl: string | null;
  /** The issue title its launch recorded. */
  readonly title: string | null;
  readonly finished: boolean;
}

const FINISHED_PLACE: Readonly<Record<string, Place>> = {
  merged: "done",
  stuck: "stuck",
  "needs-info": "info",
};

/** More attempts than any issue has needed; the reads stop sooner, at the first that is missing. */
const MAX_ATTEMPTS = 12;

/**
 * The factory names each session thread `<owner>/<repo>#<issue> <issue title>` (runner/start.ts);
 * from that, the run id up to its attempt: `owner__repo__issue__`. Null for any other title.
 */
export function issueOfThreadTitle(title: string): { readonly prefix: string } | null {
  const match =
    /^([A-Za-z0-9][A-Za-z0-9_-]*)\/([A-Za-z0-9._-]+)#([0-9]+|[A-Za-z][A-Za-z0-9]*-[0-9]+) \S/.exec(
      title,
    );
  if (match === null) return null;
  const [, owner, repo, issue] = match;
  return { prefix: `${owner}__${repo}__${issue}__`.toLowerCase() };
}

/** The unfinished run whose session is `threadId`, from a status already read. */
type StatusRun = FactoryStatus["runs"][number];

export function threadRunOfStatus(
  status: {
    readonly runs: ReadonlyArray<
      Pick<
        StatusRun,
        "id" | "state" | "thread_id" | "pr_url" | "title" | "last_event" | "pr_reported"
      >
    >;
  } | null,
  threadId: string,
): ThreadRun | null {
  const run = status?.runs.find((candidate) => candidate.thread_id === threadId);
  if (run === undefined) return null;
  return {
    id: run.id,
    state: run.state,
    place: stationOf(run),
    prUrl: run.pr_url,
    title: run.title ?? null,
    finished: false,
  };
}

/**
 * Reads the issue's attempts from the first until one launched `threadId`, and stops at the first
 * attempt that does not exist. Null when none did, or a read fails.
 */
export async function findThreadRun(
  read: (id: string) => Promise<FactoryRunDetail>,
  prefix: string,
  threadId: string,
): Promise<ThreadRun | null> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const id = `${prefix}${attempt}`;
    let detail: FactoryRunDetail;
    try {
      detail = await read(id);
    } catch {
      // A missing attempt (404) ends the issue's runs; any other failure leaves the thread unlinked.
      return null;
    }
    const launch = detail.entries.find(
      (entry) =>
        entry.event === "session_launched" && textField(entry.data, "thread_id") === threadId,
    );
    if (launch === undefined) continue;
    const state = shownState(runState(detail.entries), prEndOf(detail.entries));
    return {
      id,
      state,
      place: FINISHED_PLACE[state ?? ""] ?? null,
      prUrl: prUrlOf(detail.entries),
      title: textField(launch.data, "title"),
      finished: runIsFinished(detail.entries),
    };
  }
  return null;
}
