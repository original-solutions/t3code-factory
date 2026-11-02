import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { legacySessionNotice, type LegacySessionNotice } from "@t3tools/shared/legacySession";

import { environmentIdsKey } from "~/state/environmentAtomList";
import { environmentSessionStatesAtom } from "~/state/session";

/** For each environment, what its session lacks if it was paired before the permissions existed, else null. */
export function useLegacySessionNotices(
  environmentIds: ReadonlyArray<EnvironmentId>,
): ReadonlyArray<LegacySessionNotice | null> {
  const states = useAtomValue(environmentSessionStatesAtom(environmentIdsKey(environmentIds)));
  return states.map((state) =>
    state._tag === "Success" ? legacySessionNotice(state.value) : null,
  );
}
