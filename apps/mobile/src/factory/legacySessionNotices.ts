import { useAtomValue } from "@effect/atom-react";
import { legacySessionNotice } from "@t3tools/shared/legacySession";
import { Atom } from "effect/reactivity";

import { projectEnvironmentPresentation } from "../state/environments";
import { environmentPresentations } from "../state/presentation";
import { environmentSession } from "../state/session";

export interface LegacySessionEnvironmentNotice {
  readonly environmentId: string;
  /** The environment's name when more than one is connected, else null. */
  readonly label: string | null;
  readonly sentence: string;
}

/** The environments whose session was paired before the permissions existed. Not tied to the one-time dialog. */
export const legacySessionNoticesAtom = Atom.make((get) => {
  const presentations = [...get(environmentPresentations.presentationsAtom).entries()];
  return presentations.flatMap(([environmentId, presentation]) => {
    const session = get(environmentSession.sessionStateAtom(environmentId));
    const notice = session._tag === "Success" ? legacySessionNotice(session.value) : null;
    return notice
      ? [
          {
            environmentId,
            label:
              presentations.length > 1
                ? projectEnvironmentPresentation(environmentId, presentation).label
                : null,
            sentence: notice.sentence,
          } satisfies LegacySessionEnvironmentNotice,
        ]
      : [];
  });
}).pipe(Atom.withLabel("mobile:legacy-session-notices"));

export function useLegacySessionNotices(): ReadonlyArray<LegacySessionEnvironmentNotice> {
  return useAtomValue(legacySessionNoticesAtom);
}
