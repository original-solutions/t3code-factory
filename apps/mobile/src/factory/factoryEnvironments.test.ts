import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { SavedRemoteConnection } from "../lib/connection";
import { FACTORY_RELAY_ONLY_MESSAGE, factoryEnvironmentChoice } from "./factoryEnvironments";

function connection(
  label: string,
  extra: Partial<SavedRemoteConnection> = {},
): SavedRemoteConnection {
  return {
    environmentId: `env-${label}` as EnvironmentId,
    environmentLabel: label,
    pairingUrl: "",
    displayUrl: "",
    httpBaseUrl: `https://${label}.example.ts.net`,
    wsBaseUrl: `wss://${label}.example.ts.net`,
    bearerToken: "bearer",
    ...extra,
  };
}

describe("factoryEnvironmentChoice", () => {
  it("is none without connections", () => {
    expect(factoryEnvironmentChoice([])).toEqual({ kind: "none" });
  });

  it("opens the only connection when it is direct", () => {
    const direct = connection("direct");
    expect(factoryEnvironmentChoice([direct])).toEqual({ kind: "one", connection: direct });
  });

  it("is relay-only when the only connection is relay managed", () => {
    expect(factoryEnvironmentChoice([connection("a", { relayManaged: true })])).toEqual({
      kind: "relay-only",
    });
  });

  it("is relay-only when the only connection is DPoP", () => {
    expect(factoryEnvironmentChoice([connection("a", { authenticationMethod: "dpop" })])).toEqual({
      kind: "relay-only",
    });
  });

  it("lists several direct connections sorted by label, all openable", () => {
    const choice = factoryEnvironmentChoice([
      connection("zeta"),
      connection("Alpha"),
      connection("mid"),
    ]);
    expect(choice.kind).toBe("several");
    if (choice.kind === "several") {
      expect(choice.options.map((o) => [o.connection.environmentLabel, o.openable])).toEqual([
        ["Alpha", true],
        ["mid", true],
        ["zeta", true],
      ]);
    }
  });

  it("lists a relay connection beside a direct one instead of dropping it", () => {
    const choice = factoryEnvironmentChoice([
      connection("Trilogy Mac"),
      connection("relay", { relayManaged: true }),
      connection("dpop", { authenticationMethod: "dpop" }),
    ]);
    expect(choice.kind).toBe("several");
    if (choice.kind === "several") {
      expect(choice.options.map((o) => [o.connection.environmentLabel, o.openable])).toEqual([
        ["dpop", false],
        ["relay", false],
        ["Trilogy Mac", true],
      ]);
    }
  });

  it("lists several relay connections, none openable", () => {
    const choice = factoryEnvironmentChoice([
      connection("b", { relayManaged: true }),
      connection("a", { authenticationMethod: "dpop" }),
    ]);
    expect(choice.kind).toBe("several");
    if (choice.kind === "several") {
      expect(choice.options.map((o) => [o.connection.environmentLabel, o.openable])).toEqual([
        ["a", false],
        ["b", false],
      ]);
    }
  });

  it("states the relay message from the issue", () => {
    expect(FACTORY_RELAY_ONLY_MESSAGE).toBe(
      "Factory pages need a direct connection. Pair this phone with the server over the tailnet.",
    );
  });
});
