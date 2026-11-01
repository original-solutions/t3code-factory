/**
 * A stuck run's stored reason is the factory's own fixed one-line reason, then a blank line and
 * what the session said (`runner/messages.ts`, `domain/resultLine.ts` on the server). The Stuck bin
 * groups runs by that first line, so N runs that hit the time limit read as one cause to fix.
 */

const NO_REASON = "No reason recorded";
const OTHER_BRANCH =
  /^the session reported PR (#\d+) but its branch (.+) is not this session's branch$/;
const DETAIL = /^(.*?) \((.+)\)$/;

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const joined = (...parts: ReadonlyArray<string | null>) =>
  parts.filter((part): part is string => part !== null && part !== "").join(" ") || null;

/** The cause a reason names, in sentence case, and the rest of it: specifics, then the session's text. */
export function splitStuckReason(reason: string | null): {
  cause: string;
  detail: string | null;
} {
  const text = reason?.trim() ?? "";
  if (text === "") return { cause: NO_REASON, detail: null };
  const newline = text.indexOf("\n");
  const lead = (newline === -1 ? text : text.slice(0, newline)).trim();
  const rest = newline === -1 ? null : text.slice(newline + 1).trim();
  const branch = OTHER_BRANCH.exec(lead);
  if (branch) {
    return {
      cause: "The session reported a pull request from another branch",
      detail: joined(`PR ${branch[1]}, branch ${branch[2]}.`, rest),
    };
  }
  const detail = DETAIL.exec(lead);
  if (detail) return { cause: sentence(detail[1]!), detail: joined(detail[2]!, rest) };
  return { cause: sentence(lead), detail: rest };
}

export interface StuckCause<R> {
  readonly cause: string;
  readonly entries: ReadonlyArray<{ readonly run: R; readonly detail: string | null }>;
}

/** The runs by cause: the most runs first, ties in the order first seen, runs in the order given. */
export function stuckCauses<R extends { readonly reason: string | null }>(
  runs: ReadonlyArray<R>,
): ReadonlyArray<StuckCause<R>> {
  const groups = new Map<string, Array<{ run: R; detail: string | null }>>();
  for (const run of runs) {
    const { cause, detail } = splitStuckReason(run.reason);
    const entries = groups.get(cause);
    if (entries) entries.push({ run, detail });
    else groups.set(cause, [{ run, detail }]);
  }
  return Array.from(groups, ([cause, entries]) => ({ cause, entries })).toSorted(
    (a, b) => b.entries.length - a.entries.length,
  );
}
