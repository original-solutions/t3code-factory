import type { FactoryEntry } from "./api";
import { lastGateOutput, prEndOf, prUrlOf, runState, textField, type GateCommand } from "./format";
import { splitStuckReason } from "./stuckCauses";

/**
 * What a person does about a run that stopped for them, from its ledger: the cause in plain words,
 * the fix for it (the table in the guide's "When a run stops"), where the work is and what a new
 * run will start from. Causes match the factory's fixed reason leads (`runner/messages.ts`); an
 * unknown lead falls back to reading the session, never to a wrong fix.
 */

/** Where the fix starts: the session's thread, the gate output, the PR's checks, or the issue. */
export type NextStepFocus = "thread" | "gate" | "checks" | "issue";

export interface NextStep {
  readonly kind: "stuck" | "needs-info";
  readonly cause: string;
  /** The factory's specifics, then the session's own words; plain text. */
  readonly detail: string | null;
  readonly fix: string;
  readonly focus: NextStepFocus;
  /** The commands that failed in the last gate run, when it failed. */
  readonly failedGate: ReadonlyArray<GateCommand>;
  /** What a new run starts from once the issue is `factory:ready` again. */
  readonly nextRun: string;
}

interface Fix {
  readonly fix: string;
  readonly focus: NextStepFocus;
}

const READ_SESSION: Fix = {
  fix: "Read what the session said in its thread, fix the cause or the issue.",
  focus: "thread",
};

function fixFor(lead: string, detail: string | null): Fix {
  const at = (prefix: string) => lead.startsWith(prefix);
  if (at("the run passed its time limit")) {
    return detail?.includes("looked idle")
      ? {
          fix: "The session had stalled: read its thread before starting a new run.",
          focus: "thread",
        }
      : {
          fix: "The session needed more time: split the issue, or raise limits.minutes in the repo's factory block.",
          focus: "issue",
        };
  }
  if (at("the gate failed")) {
    return { fix: "Read the gate output, then fix the cause or the issue.", focus: "gate" };
  }
  if (at("the required checks") || at("the pull request's head changed")) {
    return { fix: "Check the repo's CI and its required_checks.", focus: "checks" };
  }
  if (at("the session run ended as failed") && detail !== null && /\b(429|529)\b/.test(detail)) {
    return {
      fix: "The provider was rate limited or overloaded, not the code: a new run is usually enough.",
      focus: "issue",
    };
  }
  if (at("the session ran as the wrong github account") || at("the session's gh account is ")) {
    return {
      fix: "Restart the factory's T3 server so it has the right GH_CONFIG_DIR.",
      focus: "issue",
    };
  }
  if (at("no default model")) {
    return { fix: "Set a default model on the T3 project or in T3's Settings.", focus: "issue" };
  }
  if (at("the factory could not launch a session")) {
    return {
      fix: "Read the error in the timeline: often no T3 project or no default model on this machine.",
      focus: "issue",
    };
  }
  if (at("base branch ")) {
    return {
      fix: "Fix the issue's ## Base section so it names a branch on origin.",
      focus: "issue",
    };
  }
  if (
    at("the issue text was") ||
    at("the factory could not verify who") ||
    at("the factory could not confirm") ||
    at("the factory could not read")
  ) {
    return { fix: "Review the issue text.", focus: "issue" };
  }
  if (at("stopped by hand")) return { fix: "Someone stopped it; nothing to fix.", focus: "issue" };
  return READ_SESSION;
}

/** What to do about a stuck or needs-info run; null for any other state. */
export function nextStep(entries: ReadonlyArray<FactoryEntry>): NextStep | null {
  const state = runState(entries);
  if (state !== "stuck" && state !== "needs-info") return null;
  const prUrl = prEndOf(entries) === null ? prUrlOf(entries) : null;
  const pr = prUrl === null ? null : (/\/pull\/(\d+)/.exec(prUrl)?.[1] ?? null);
  const gate = lastGateOutput(entries);
  const failedGate = gate.commands.filter((command) => command.exit_code !== 0);

  if (state === "needs-info") {
    const questions = textField(
      entries.findLast((entry) => entry.event === "questions_posted")?.data,
      "questions",
    );
    return {
      kind: "needs-info",
      cause: "The session has questions about the issue",
      detail: questions,
      fix: "Answer every question in a comment on the issue, or edit the issue so it settles them.",
      focus: "issue",
      failedGate: [],
      nextRun: "A new run reads the issue from the top; it does not read the answer by itself.",
    };
  }

  const stuck = entries.findLast((entry) => entry.event === "stuck")?.data;
  const reason = textField(stuck, "reason");
  const lead = (reason ?? "").trim().split("\n", 1)[0]!.toLowerCase();
  const { cause, detail } = splitStuckReason(reason);
  const branch = textField(stuck, "branch");
  const continues =
    lead.startsWith("the run passed its time limit") || lead.startsWith("the t3 thread");
  const nextRun =
    pr !== null
      ? `A new run continues PR #${pr} on its branch. Close the PR first to start over.`
      : continues && branch !== null
        ? `A new run continues from ${branch}, unless the issue text changes first.`
        : branch !== null
          ? `A new run starts from the base branch; this run's work stays on ${branch}.`
          : "A new run starts from the base branch.";
  return { kind: "stuck", cause, detail, ...fixFor(lead, detail), failedGate, nextRun };
}
