import { issueRef, parseRunId, prRef, type LinkRef } from "./format";

/** What every surface that shows a run knows about it, as far as its actions go. */
export interface RunFacts {
  readonly id: string;
  readonly state: string | null;
  readonly finished: boolean;
  readonly prUrl: string | null;
  /** The session's thread, where the surface has read it; null when it has not or there is none. */
  readonly threadId: string | null;
  /** A later attempt of the same issue exists, so this one's next step is already taken. */
  readonly superseded?: boolean;
}

export type RunAction =
  /** `live` while the run is unfinished: the link then says what its agent is doing. */
  | { readonly kind: "thread"; readonly threadId: string; readonly live: boolean }
  /** The run stopped for a person: its page opens on what to do and how to start it again. */
  | { readonly kind: "next"; readonly tone: "stuck" | "info" }
  | { readonly kind: "issue"; readonly ref: LinkRef }
  | { readonly kind: "pr"; readonly ref: LinkRef }
  | { readonly kind: "stop" };

export type RunActionKind = RunAction["kind"];

/**
 * The actions that can work on a run, in the order every surface shows them. Stop is there only
 * for an unfinished building run, the one state the server takes a stop request in. A reference
 * GitHub does not host stays, as text.
 */
export function runActions(run: RunFacts): ReadonlyArray<RunAction> {
  const actions: Array<RunAction> = [];
  if (run.threadId !== null)
    actions.push({ kind: "thread", threadId: run.threadId, live: !run.finished });
  if (!run.superseded && run.state === "stuck") actions.push({ kind: "next", tone: "stuck" });
  if (!run.superseded && run.state === "needs-info") actions.push({ kind: "next", tone: "info" });
  const parsed = parseRunId(run.id);
  const issue = parsed ? issueRef(`${parsed.owner}/${parsed.repo}`, parsed.issue) : null;
  if (issue) actions.push({ kind: "issue", ref: issue });
  const pr = prRef(run.prUrl);
  if (pr) actions.push({ kind: "pr", ref: pr });
  if (run.state === "building" && !run.finished) actions.push({ kind: "stop" });
  return actions;
}
