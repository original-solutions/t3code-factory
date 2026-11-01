import type { FactoryGitHubPart, FactoryRunGitHub } from "./api";

type Unread = Exclude<FactoryGitHubPart<never>, { kind: "ok" } | { kind: "gone" }>;

/**
 * What the run page's GitHub section shows: the parts GitHub answered, or one line saying why it
 * could not be read when no part could. `unread` is the reason shared by the parts that failed.
 */
export type GitHubView =
  | { readonly kind: "none" }
  | { readonly kind: "unread"; readonly reason: Unread }
  | {
      readonly kind: "read";
      readonly issue: FactoryRunGitHub["issue"];
      readonly pr: FactoryRunGitHub["pr"];
    };

export function gitHubView(answer: FactoryRunGitHub): GitHubView {
  const parts = [answer.issue, answer.pr].filter((part) => part !== null);
  if (parts.length === 0) return { kind: "none" };
  const failed = parts.filter((part): part is Unread => part.kind !== "ok" && part.kind !== "gone");
  if (failed.length === parts.length) {
    return {
      kind: "unread",
      reason: failed.find((part) => part.kind === "signed-out") ?? failed[0]!,
    };
  }
  return { kind: "read", issue: answer.issue, pr: answer.pr };
}

/** Text long enough to fold: more than this many lines or characters. */
const FOLD_LINES = 14;
const FOLD_CHARS = 900;

export const isLongText = (text: string): boolean =>
  text.length > FOLD_CHARS || text.split("\n").length > FOLD_LINES;

export interface FileChurn {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
}

/** The `n` files that changed most, most first; GitHub's order breaks a tie. */
export const topFiles = (files: ReadonlyArray<FileChurn>, n: number): Array<FileChurn> =>
  files
    .map((file, at) => ({ file, at }))
    .toSorted(
      (a, b) =>
        b.file.additions + b.file.deletions - (a.file.additions + a.file.deletions) || a.at - b.at,
    )
    .slice(0, n)
    .map(({ file }) => file);

/** A path as its folder (with the trailing slash) and its file name. */
export const splitPath = (path: string): { readonly dir: string; readonly name: string } => {
  const at = path.lastIndexOf("/");
  return at < 0
    ? { dir: "", name: path }
    : { dir: path.slice(0, at + 1), name: path.slice(at + 1) };
};
