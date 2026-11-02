import { describe, expect, it } from "vite-plus/test";

import { failureMessage } from "./http";

describe("failureMessage", () => {
  it("shows the server's own message", () => {
    expect(
      failureMessage(403, { code: "insufficient_scope", message: "Needs a scope you lack." }),
    ).toBe("Needs a scope you lack.");
  });

  it("names the permission a session was paired without, when the body has no message", () => {
    expect(
      failureMessage(403, {
        code: "insufficient_scope",
        requiredScope: "orchestration:operate",
        requiredPermission: "environment:maintain",
      }),
    ).toBe(
      "This session cannot do that: it needs the environment:maintain permission, and this session was paired without it. Pair the app again to get it.",
    );
  });

  it("falls back to the required scope without a permission", () => {
    expect(
      failureMessage(403, { code: "insufficient_scope", requiredScope: "settings:write" }),
    ).toBe(
      "This session cannot do that: it needs the settings:write permission, and this session was paired without it. Pair the app again to get it.",
    );
  });

  it("keeps the status for any other body", () => {
    expect(failureMessage(403, null)).toBe("The factory answered 403.");
    expect(failureMessage(500, { code: "internal_error" })).toBe("The factory answered 500.");
    expect(failureMessage(403, { code: "insufficient_scope" })).toBe("The factory answered 403.");
  });
});
