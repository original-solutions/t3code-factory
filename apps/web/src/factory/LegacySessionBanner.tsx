import type { EnvironmentId } from "@t3tools/contracts";
import { LockIcon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";

import { useLegacySessionNotices } from "./useLegacySessionNotices";

/**
 * Stays while an environment's session was paired before the current permissions existed, and goes
 * once it is paired again. It says what the session lacks and how to pair again; it builds no link.
 */
export function LegacySessionBanner({
  environments,
}: {
  environments: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly label: string }>;
}) {
  const notices = useLegacySessionNotices(environments.map(({ environmentId }) => environmentId));
  return environments.map(({ environmentId, label }) => {
    const notice = notices.get(environmentId);
    if (!notice) return null;
    return (
      <Alert
        controlAlignment="first-line"
        data-factory-legacy-session=""
        key={environmentId}
        variant="warning"
      >
        <LockIcon />
        <AlertTitle>
          {environments.length > 1 ? `${label} has a limited session` : "This session is limited"}
        </AlertTitle>
        <AlertDescription>{notice.sentence}</AlertDescription>
      </Alert>
    );
  });
}
