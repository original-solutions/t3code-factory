/** gh's own words when it has no login: every repo read then fails the same way, for one cause. */
export const signedOut = (message: string): boolean =>
  /gh auth login|GH_TOKEN environment variable/.test(message);

const shellWord = (text: string): string =>
  /^[\w@%+=:,./~-]+$/.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`;

/** The command that signs the factory's gh in, in the config directory the factory reads. */
export const signInCommand = (ghConfigDir: string): string =>
  ghConfigDir === "" ? "gh auth login" : `GH_CONFIG_DIR=${shellWord(ghConfigDir)} gh auth login`;

interface Entry {
  readonly environmentId: string;
  readonly item: {
    readonly repo: string | null;
    readonly message: string;
    readonly first_seen: string;
  };
}

export type FoldedAttention<E extends Entry> =
  | { readonly kind: "one"; readonly entry: E }
  | {
      readonly kind: "signed-out";
      readonly environmentId: E["environmentId"];
      readonly entries: ReadonlyArray<E>;
      /** The repos it cannot read, in the order their items came. */
      readonly repos: ReadonlyArray<string>;
      readonly firstSeen: string;
    };

/**
 * Attention items with each environment's signed-out ones folded into one entry where the first
 * stood: a gh with no login raises an item per repo and one for the pass, all for one fix.
 */
export function foldSignedOut<E extends Entry>(
  entries: ReadonlyArray<E>,
): ReadonlyArray<FoldedAttention<E>> {
  const groups = new Map<string, E[]>();
  const rows: Array<
    { readonly kind: "one"; readonly entry: E } | { readonly kind: "group"; readonly key: string }
  > = [];
  for (const entry of entries) {
    if (!signedOut(entry.item.message)) {
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
      repos: [...new Set(members.flatMap(({ item }) => (item.repo === null ? [] : [item.repo])))],
      firstSeen: members.map(({ item }) => item.first_seen).toSorted()[0]!,
    };
  });
}
