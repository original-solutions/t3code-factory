import type { RepoBlock } from "./settings/api";
import { repoHealth, type SetupStepState } from "./settings/repoRoster";

/**
 * True once every answered environment says it has never run anything: nothing in flight and an
 * empty list of every run. A list still loading (`ever` null) is not yet an answer.
 */
export const neverBuilt = (
  environments: ReadonlyArray<{ readonly active: number; readonly ever: number | null }>,
): boolean =>
  environments.length > 0 && environments.every(({ active, ever }) => active === 0 && ever === 0);

/** Whether the page shows the way to a first run, or is still reading every run to know. */
export type FirstRun = boolean | "checking";

export type FirstRunConfig =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly message: string }
  | {
      readonly kind: "ok";
      readonly repos: ReadonlyArray<RepoBlock>;
      readonly watchError: string | null;
    };

/**
 * The four things between a machine and its first run: a watched repo, a config the factory can
 * build from, claims on, an issue labelled. The first one not done is current; a step that cannot
 * pass as things are is blocked. `paused` is null where claims are not read, so that step is not done.
 */
export const firstRunSteps = (config: FirstRunConfig, paused: boolean | null) => {
  const repos = config.kind === "ok" ? config.repos : [];
  const ready = repos.filter((repo) => {
    const health = repoHealth(repo);
    return health === "ready" || health === "default";
  });
  const errored = repos.filter((repo) => repoHealth(repo) === "error");
  const broken = errored[0] ?? null;
  // Each step: true when done, "blocked" when it cannot pass as things are, false when not yet.
  const watch =
    config.kind === "failed" || (config.kind === "ok" && config.watchError !== null)
      ? "blocked"
      : repos.length > 0;
  const read =
    ready.length > 0
      ? true
      : repos.length > 0 && errored.length === repos.length
        ? "blocked"
        : false;
  const raw: ReadonlyArray<boolean | "blocked"> = [watch, read, paused === false, false];
  let reached = false;
  const states = raw.map((step): SetupStepState => {
    if (step === true) return "done";
    if (reached || config.kind === "loading") return "todo";
    reached = true;
    return step === "blocked" ? "blocked" : "current";
  });
  const at = states.findIndex((state) => state === "current" || state === "blocked");
  return { states, current: at + 1, ready, broken, errors: errored.length };
};
