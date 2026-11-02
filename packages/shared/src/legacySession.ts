import {
  AuthStandardClientScopes,
  sessionHasLegacyPermissions,
  type AuthEnvironmentScope,
  type SessionGrantInput,
} from "@t3tools/contracts";

/** Mints a pairing link for the factory server, whose state is not in `t3`'s default base dir. */
const PAIR_COMMAND = "~/.local/share/t3fac/current/t3 pair --base-dir ~/.config/t3fac";

/** The fix for a session that predates the fine-grained permissions, as the end of a failure message. */
export const LEGACY_SESSION_PAIR_AGAIN = `Pair again with a new link (run ${PAIR_COMMAND} on the server's machine).`;

export interface LegacySessionNotice {
  readonly missing: ReadonlyArray<AuthEnvironmentScope>;
  readonly sentence: string;
}

const listOf = (items: ReadonlyArray<string>) =>
  items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

/**
 * What a session paired before the fine-grained permissions cannot do, and how to fix it. Null for
 * any other session, including one limited on purpose (it holds a scope outside the legacy set).
 */
export function legacySessionNotice(
  session: SessionGrantInput | null | undefined,
): LegacySessionNotice | null {
  if (!session || !sessionHasLegacyPermissions(session)) return null;
  const held = new Set(session.permissions);
  const missing = AuthStandardClientScopes.filter((scope) => !held.has(scope));
  if (missing.length === 0) return null;
  return {
    missing,
    sentence: `This session was paired before the current permissions existed, so it cannot ${listOf(missing)}. Pair again with a new link: run \`${PAIR_COMMAND}\` on the server's machine, then scan or open it here.`,
  };
}
