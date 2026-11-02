import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { legacySessionNotice, type LegacySessionNotice } from "@t3tools/shared/legacySession";

import { environmentIdsKey } from "~/state/environmentAtomList";
import { environmentSessionStatesAtom } from "~/state/session";

/** What each environment's session lacks, for those paired before the permissions existed. */
export function useLegacySessionNotices(
  environmentIds: ReadonlyArray<EnvironmentId>,
): ReadonlyMap<EnvironmentId, LegacySessionNotice> {
  const states = useAtomValue(environmentSessionStatesAtom(environmentIdsKey(environmentIds)));
  const notices = new Map<EnvironmentId, LegacySessionNotice>();
  states.forEach((state, index) => {
    const notice = state._tag === "Success" ? legacySessionNotice(state.value) : null;
    if (notice) notices.set(environmentIds[index]!, notice);
  });
  return notices;
}
