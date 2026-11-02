import { AuthStandardClientScopes, type AuthEnvironmentScope } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { LEGACY_SESSION_PAIR_AGAIN, legacySessionNotice } from "./legacySession.ts";

const auth = { policy: "loopback-browser", bootstrapMethods: [], sessionMethods: [] } as never;

const session = (permissions: ReadonlyArray<AuthEnvironmentScope>, authenticated = true) => ({
  authenticated,
  auth,
  permissions,
});

const LEGACY: ReadonlyArray<AuthEnvironmentScope> = [
  "orchestration:read",
  "orchestration:operate",
  "terminal:operate",
  "review:write",
  "relay:read",
];

describe("legacySessionNotice", () => {
  it("lists exactly the missing standard scopes, in standard order", () => {
    const notice = legacySessionNotice(session(LEGACY));
    expect(notice?.missing).toEqual(
      AuthStandardClientScopes.filter((scope) => !LEGACY.includes(scope)),
    );
    expect(notice?.missing.slice(0, 2)).toEqual(["settings:write", "providers:manage"]);
    expect(notice?.sentence).toContain("settings:write");
    expect(notice?.sentence).toContain("environment:maintain");
    expect(notice?.sentence).toContain("access:write");
    expect(notice?.sentence).toContain("This session was paired before the current permissions");
    expect(notice?.sentence).toContain("run `t3 pair` on the server's machine");
  });

  it("returns nothing for a full, unauthenticated, purposely limited or unscoped session", () => {
    expect(legacySessionNotice(session([...AuthStandardClientScopes]))).toBeNull();
    expect(legacySessionNotice(session(LEGACY, false))).toBeNull();
    expect(legacySessionNotice(session([...LEGACY, "providers:manage"]))).toBeNull();
    expect(legacySessionNotice({ authenticated: true, auth })).toBeNull();
    expect(legacySessionNotice(null)).toBeNull();
  });

  it("carries the one-line fix for a failure message", () => {
    expect(LEGACY_SESSION_PAIR_AGAIN).toBe(
      "Pair again with a new link (run t3 pair on the server's machine).",
    );
  });
});
