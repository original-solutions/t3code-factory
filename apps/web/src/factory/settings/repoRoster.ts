import type { RepoBlock } from "./api";

/** Where a watched repo stands: `error` and `unread` need a look, the other two can take work. */
export type RepoHealth = "error" | "unread" | "default" | "ready";

export const repoHealth = (block: RepoBlock): RepoHealth =>
  block.errors !== null && block.errors.length > 0
    ? "error"
    : block.factory === null
      ? "unread"
      : block.default_config === true
        ? "default"
        : "ready";

const NEEDS_A_LOOK: Record<RepoHealth, number> = { error: 0, unread: 1, default: 2, ready: 2 };

export interface RosterRow {
  readonly block: RepoBlock;
  readonly health: RepoHealth;
}

/** The watched repos, the ones that need a look first, and a one-line count of them. */
export const repoRoster = (repos: ReadonlyArray<RepoBlock>) => {
  const rows = repos
    .map((block): RosterRow => ({ block, health: repoHealth(block) }))
    .toSorted(
      (a, b) =>
        NEEDS_A_LOOK[a.health] - NEEDS_A_LOOK[b.health] ||
        a.block.title.localeCompare(b.block.title, undefined, { sensitivity: "base" }),
    );
  const count = (health: RepoHealth) => rows.filter((row) => row.health === health).length;
  const parts = [
    rows.length > 0 ? `${rows.length} watched` : null,
    count("error") > 0 ? `${count("error")} with errors` : null,
    count("unread") > 0 ? `${count("unread")} not read yet` : null,
  ].filter((part) => part !== null);
  return { rows, summary: parts.join(" · ") };
};

export type SetupStepState = "done" | "current" | "todo" | "blocked";

/**
 * How far a machine is from its first build: a repo watched, then one whose config the factory can
 * build from. Null once any repo can take work, when there is nothing left to set up.
 */
export const setupProgress = (repos: ReadonlyArray<RepoBlock>, watchError: string | null) => {
  const healths = repos.map(repoHealth);
  if (healths.some((health) => health === "ready" || health === "default")) return null;
  const broken = repos.find((block) => repoHealth(block) === "error");
  const watch: SetupStepState =
    watchError !== null ? "blocked" : repos.length > 0 ? "done" : "current";
  const read: SetupStepState = repos.length > 0 ? "current" : "todo";
  return {
    watch,
    read,
    errors: healths.filter((health) => health === "error").length,
    firstError:
      broken === undefined
        ? null
        : { title: broken.title, message: broken.errors?.[0]?.message ?? "" },
  };
};
