import { signedOut } from "./gitHubSignIn";

/**
 * Attention items grouped by what a person fixes. Most items are their own cause; a gh with no
 * login raises one per repo plus one for the pass, all lifted by one sign-in. The page, the
 * sidebar badge, the shoulder taps, the Machine dial and the Queue all count and word causes from
 * here, so one signed-out gh reads as one thing everywhere.
 */

interface Item {
  readonly id: string;
  readonly repo: string | null;
  readonly message: string;
  readonly first_seen: string;
}

interface Entry {
  readonly environmentId: string;
  readonly item: Item;
}

const SIGNED_OUT = "signed-out";

/** The cause an item is raised for, unique within one environment. */
export const causeKey = (item: Item): string => (signedOut(item.message) ? SIGNED_OUT : item.id);

export type AttentionCause<E extends Entry> =
  | { readonly kind: "one"; readonly entry: E }
  | {
      readonly kind: "signed-out";
      readonly environmentId: E["environmentId"];
      readonly entries: ReadonlyArray<E>;
      /** The repos it cannot read, in the order their items came. */
      readonly repos: ReadonlyArray<string>;
      readonly firstSeen: string;
    };

const reposOf = (items: ReadonlyArray<Item>): ReadonlyArray<string> => [
  ...new Set(items.flatMap(({ repo }) => (repo === null ? [] : [repo]))),
];

/** Attention items as causes, each environment's signed-out ones folded where the first stood. */
export function groupByCause<E extends Entry>(
  entries: ReadonlyArray<E>,
): ReadonlyArray<AttentionCause<E>> {
  const groups = new Map<string, E[]>();
  const rows: Array<
    { readonly kind: "one"; readonly entry: E } | { readonly kind: "group"; readonly key: string }
  > = [];
  for (const entry of entries) {
    if (causeKey(entry.item) !== SIGNED_OUT) {
      rows.push({ kind: "one", entry });
      continue;
    }
    const group = groups.get(entry.environmentId);
    if (group) group.push(entry);
    else {
      groups.set(entry.environmentId, [entry]);
      rows.push({ kind: "group", key: entry.environmentId });
    }
  }
  return rows.map((row) => {
    if (row.kind === "one") return row;
    const members = groups.get(row.key)!;
    return {
      kind: "signed-out",
      environmentId: members[0]!.environmentId,
      entries: members,
      ...signedOutCause(members.map(({ item }) => item))!,
    };
  });
}

/** How many things one environment's items ask a person to fix. */
export const causeCount = (items: ReadonlyArray<Item>): number => new Set(items.map(causeKey)).size;

/** One environment's signed-out gh: the repos it cannot read and since when; null while signed in. */
export function signedOutCause(
  items: ReadonlyArray<Item>,
): { readonly repos: ReadonlyArray<string>; readonly firstSeen: string } | null {
  const out = items.filter((item) => causeKey(item) === SIGNED_OUT);
  return out.length === 0
    ? null
    : { repos: reposOf(out), firstSeen: out.map((item) => item.first_seen).toSorted()[0]! };
}

const repoNames = (repos: ReadonlyArray<string>) => {
  const shown = repos.slice(0, 3).map((repo) => repo.split("/").pop() ?? repo);
  return repos.length > 3 ? `${shown.join(", ")} and ${repos.length - 3} more` : shown.join(", ");
};

/** The one sentence every surface says about a signed-out gh. */
export const signedOutLine = (repos: ReadonlyArray<string>): string =>
  repos.length === 0
    ? "The factory's gh is signed out, so its passes cannot read GitHub."
    : `The factory's gh is signed out, so it cannot read ${
        repos.length === 1 ? repos[0] : `any of its ${repos.length} repos: ${repoNames(repos)}`
      }.`;
