import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";

import * as Dialog from "../components/ui/Dialog";
import { environmentCatalog } from "../connection/catalog";
import { appAtomRegistry } from "../state/atom-registry";
import { environmentSession } from "../state/session";
import {
  FACTORY_SESSION_LABEL,
  factorySessionsMayRemain,
  revokeFactorySessions,
} from "./factorySignIn";

/**
 * Revokes the Factory browser sessions of a removed environment before its bearer goes, so the
 * WebView's cookie opens nothing. Never blocks the removal; when the server cannot be asked, the
 * user is told where to revoke by hand. Only direct (bearer) environments can have a session.
 */
export async function forgetFactorySession(environmentId: EnvironmentId): Promise<void> {
  const entry = appAtomRegistry.get(environmentCatalog.catalogValueAtom).entries.get(environmentId);
  if (entry?.target._tag !== "BearerConnectionTarget") return;
  const prepared = Option.getOrNull(
    appAtomRegistry.get(environmentSession.preparedConnectionValueAtom(environmentId)),
  );
  const outcome =
    prepared === null || prepared.httpAuthorization?._tag !== "Bearer"
      ? null
      : await revokeFactorySessions(
          { httpBaseUrl: prepared.httpBaseUrl, bearerToken: prepared.httpAuthorization.token },
          fetch,
        );
  if (factorySessionsMayRemain(outcome)) {
    Dialog.alert(
      "Factory sign-in not revoked",
      `If you opened the Factory screen for this environment, its sign-in is still valid on the server. Revoke "${FACTORY_SESSION_LABEL}" under the server's Connections settings.`,
    );
  }
}
