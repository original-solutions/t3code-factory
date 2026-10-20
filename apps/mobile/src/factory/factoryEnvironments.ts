import { isRelayManagedConnection, type SavedRemoteConnection } from "../lib/connection";

export const FACTORY_RELAY_ONLY_MESSAGE =
  "Factory pages need a direct connection. Pair this phone with the server over the tailnet.";

export const FACTORY_NO_ENVIRONMENT_MESSAGE = "Add an environment in Settings to open Factory.";

export interface FactoryEnvironmentOption {
  readonly connection: SavedRemoteConnection;
  /** False for relay (DPoP, T3 Connect) connections, which cannot sign a WebView in. */
  readonly openable: boolean;
}

export type FactoryEnvironmentChoice =
  | { readonly kind: "none" }
  | { readonly kind: "relay-only" }
  | { readonly kind: "one"; readonly connection: SavedRemoteConnection }
  | { readonly kind: "several"; readonly options: ReadonlyArray<FactoryEnvironmentOption> };

/**
 * One saved connection opens straight away, or explains why it cannot. Several are all
 * listed, sorted by label, so a relay one shows as unopenable instead of vanishing.
 */
export function factoryEnvironmentChoice(
  connections: ReadonlyArray<SavedRemoteConnection>,
): FactoryEnvironmentChoice {
  if (connections.length === 0) return { kind: "none" };
  if (connections.length === 1) {
    const connection = connections[0]!;
    return isRelayManagedConnection(connection)
      ? { kind: "relay-only" }
      : { kind: "one", connection };
  }
  const options = connections
    .map((connection) => ({ connection, openable: !isRelayManagedConnection(connection) }))
    .sort((a, b) => a.connection.environmentLabel.localeCompare(b.connection.environmentLabel));
  return { kind: "several", options };
}
