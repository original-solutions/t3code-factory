import {
  EnvironmentAuthInvalidError,
  EnvironmentScopeRequiredError,
  type AuthPairingCredentialResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  FACTORY_SESSION_LABEL,
  FACTORY_SESSION_SCOPES,
  factoryLinkAction,
  mintAndInject,
  mintPairingToken,
  parseFactoryMessage,
  probeFactory,
  factorySessionsMayRemain,
  revokeFactorySessions,
  nextSignIn,
  type FactoryFetch,
  type SignInState,
} from "./factorySignIn";

const BASE = "https://mac.tail1234.ts.net";
const SLASH_BASE = "https://mac.tail1234.ts.net:3876/";
const BEARER = "bearer-secret-123";
const CREDENTIAL = "credential-secret-456";
const server = { httpBaseUrl: BASE, bearerToken: BEARER };

function json(status: number, body: unknown) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const issued = {
  id: "link-1",
  credential: CREDENTIAL,
  label: FACTORY_SESSION_LABEL,
  expiresAt: "2030-01-01T00:00:00Z",
} satisfies Record<keyof AuthPairingCredentialResult, unknown>;

const encodeScopeRequired = Schema.encodeSync(Schema.fromJsonString(EnvironmentScopeRequiredError));

const scopeRequired = (requiredPermission: string) =>
  encodeScopeRequired(
    new EnvironmentScopeRequiredError({
      code: "insufficient_scope",
      requiredScope: "access:write",
      requiredPermission,
      traceId: "trace-1",
    }),
  );

const authInvalid = Schema.encodeSync(Schema.fromJsonString(EnvironmentAuthInvalidError))(
  new EnvironmentAuthInvalidError({
    code: "auth_invalid",
    reason: "invalid_credential",
    traceId: "trace-2",
  }),
);

/** Settles only when the request is aborted, like a peer that accepts the connection and never answers. */
const hanging: FactoryFetch = (_url, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
  });

describe("factoryLinkAction", () => {
  it.each([
    [`${BASE}/factory`, "webview"],
    [`${BASE}/factory/runs/3?x=1`, "webview"],
    [`${BASE}/pair`, "webview"],
    ["about:blank", "webview"],
    ["blob:https://mac.tail1234.ts.net/abc", "webview"],
    ["data:text/html,hi", "webview"],
    ["https://github.com/org/repo/pull/1", "system"],
    ["https://mac.tail1234.ts.net:8443/factory", "system"],
    ["http://mac.tail1234.ts.net/factory", "system"],
    ["mailto:a@b.co", "system"],
    ["tel:123", "system"],
    ["not a url", "system"],
  ])("%s -> %s", (url, expected) => {
    expect(factoryLinkAction(url, BASE)).toBe(expected);
  });

  it("matches the server's explicit port", () => {
    expect(factoryLinkAction("http://10.0.0.2:3876/factory", "http://10.0.0.2:3876")).toBe(
      "webview",
    );
    expect(factoryLinkAction("http://10.0.0.2:3877/factory", "http://10.0.0.2:3876")).toBe(
      "system",
    );
  });
});

describe("nextSignIn", () => {
  const pair = { type: "location", href: `${BASE}/pair` } as const;
  const factory = { type: "location", href: `${BASE}/factory/runs/1` } as const;
  const unauthorized = { type: "unauthorized" } as const;
  const authorized = { type: "authorized" } as const;
  const step = (
    state: SignInState,
    event: Parameters<typeof nextSignIn>[1],
    eventUrl: string = `${BASE}/pair`,
  ) => nextSignIn(state, event, eventUrl, BASE);

  it("mints once when idle on the pair page, with or without a trailing slash", () => {
    expect(step("idle", pair)).toEqual({ state: "minting", action: "mint" });
    expect(step("idle", { type: "location", href: `${BASE}/pair/#token=x` })).toEqual({
      state: "minting",
      action: "mint",
    });
    expect(step("idle", unauthorized)).toEqual({ state: "minting", action: "mint" });
  });

  it("mints nothing when the WebView lands on /factory with a valid cookie", () => {
    expect(step("idle", factory, `${BASE}/factory`)).toEqual({ state: "idle", action: "none" });
    expect(step("idle", authorized, `${BASE}/factory`)).toEqual({ state: "idle", action: "none" });
    expect(step("idle", { type: "location", href: `${BASE}/settings` })).toEqual({
      state: "idle",
      action: "none",
    });
  });

  it("ignores duplicate signals while a sign-in is in flight", () => {
    expect(step("minting", unauthorized).action).toBe("none");
    expect(step("exchanging", pair).action).toBe("none");
    expect(step("minting", unauthorized).state).toBe("minting");
  });

  it("moves minting -> exchanging -> exchanged -> signed-in once the status call succeeds", () => {
    expect(step("minting", { type: "minted" })).toEqual({ state: "exchanging", action: "none" });
    expect(step("exchanging", { type: "exchange", ok: true })).toEqual({
      state: "exchanged",
      action: "none",
    });
    expect(step("exchanged", authorized, `${BASE}/factory`)).toEqual({
      state: "signed-in",
      action: "none",
    });
  });

  it("does not count landing on /factory as signed in: the cookie is checked only after the page loads", () => {
    expect(step("exchanged", factory, `${BASE}/factory`)).toEqual({
      state: "exchanged",
      action: "none",
    });
  });

  it("fails instead of looping when the accepted cookie does not authenticate the WebView", () => {
    const landed = step("exchanged", factory, `${BASE}/factory`);
    expect(step(landed.state, unauthorized, `${BASE}/factory`)).toEqual({
      state: "idle",
      action: "rejected",
    });
    expect(step("exchanged", pair).action).toBe("rejected");
  });

  it("signs in again when a signed-in session later ends", () => {
    expect(step("signed-in", unauthorized)).toEqual({ state: "minting", action: "mint" });
    expect(step("signed-in", pair)).toEqual({ state: "minting", action: "mint" });
  });

  it("reports a failed exchange", () => {
    expect(step("exchanging", { type: "exchange", ok: false })).toEqual({
      state: "idle",
      action: "exchange-failed",
    });
  });

  it("ignores exchange messages when no exchange was started", () => {
    expect(step("idle", { type: "exchange", ok: false }).action).toBe("none");
  });

  it("ignores messages whose top frame is not the server", () => {
    expect(step("idle", unauthorized, "https://evil.example/pair")).toEqual({
      state: "idle",
      action: "none",
    });
    expect(step("idle", pair, "about:blank").action).toBe("none");
    expect(step("exchanged", authorized, "https://evil.example/").state).toBe("exchanged");
    expect(
      step("exchanging", { type: "exchange", ok: false }, "https://evil.example/").action,
    ).toBe("none");
  });

  it("accepts a base URL with a trailing slash", () => {
    expect(nextSignIn("idle", unauthorized, `${BASE}/pair`, `${BASE}/`)).toEqual({
      state: "minting",
      action: "mint",
    });
  });
});

describe("parseFactoryMessage", () => {
  it("parses known messages and rejects the rest", () => {
    expect(
      parseFactoryMessage(JSON.stringify({ type: "location", href: `${BASE}/factory` })),
    ).toEqual({ type: "location", href: `${BASE}/factory` });
    expect(parseFactoryMessage(JSON.stringify({ type: "unauthorized" }))).toEqual({
      type: "unauthorized",
    });
    expect(parseFactoryMessage(JSON.stringify({ type: "authorized" }))).toEqual({
      type: "authorized",
    });
    expect(parseFactoryMessage(JSON.stringify({ type: "exchange", ok: false }))).toEqual({
      type: "exchange",
      ok: false,
    });
    expect(parseFactoryMessage("nope")).toBeNull();
    expect(parseFactoryMessage(JSON.stringify({ type: "location" }))).toBeNull();
    expect(parseFactoryMessage(JSON.stringify(["location"]))).toBeNull();
    expect(parseFactoryMessage(JSON.stringify({ type: "other" }))).toBeNull();
  });
});

describe("mintPairingToken", () => {
  it("asks the pairing endpoint, with the bearer, for a labelled credential with the Factory scopes only", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const result = await mintPairingToken(server, async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return json(200, issued);
    });
    expect(result).toEqual({ ok: true, credential: CREDENTIAL });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${BASE}/api/auth/pairing-token`);
    expect(calls[0]?.init.method).toBe("POST");
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe(`Bearer ${BEARER}`);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      label: FACTORY_SESSION_LABEL,
      scopes: FACTORY_SESSION_SCOPES,
    });
    expect(FACTORY_SESSION_SCOPES).not.toContain("terminal:operate");
    expect(FACTORY_SESSION_SCOPES).not.toContain("access:write");
  });

  it("explains a missing bearer without calling the server", async () => {
    let called = false;
    const result = await mintPairingToken({ httpBaseUrl: BASE, bearerToken: null }, async () => {
      called = true;
      return json(200, issued);
    });
    expect(called).toBe(false);
    expect(result.ok).toBe(false);
  });

  it.each([
    [401, authInvalid],
    [403, scopeRequired("orchestration:operate")],
    [403, JSON.stringify({ code: "insufficient_scope" })],
    [500, "boom"],
    [200, JSON.stringify({ nope: true })],
  ])("maps status %s to a one-line reason without secrets", async (status, body) => {
    const result = await mintPairingToken(server, async () => json(status, body));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).not.toContain("\n");
      expect(result.reason).not.toContain(BEARER);
      expect(result.reason).not.toContain(CREDENTIAL);
    }
  });

  it("names the scope the server asked for on 403 insufficient_scope", async () => {
    const result = await mintPairingToken(server, async () =>
      json(403, scopeRequired("settings:write")),
    );
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.reason).toContain("settings:write");
      expect(result.reason).not.toContain("access:write");
    }
  });

  it("tells a pairing without the permission how to pair again", async () => {
    const result = await mintPairingToken(server, async () =>
      json(403, scopeRequired("access:write")),
    );
    expect(result).toEqual({
      ok: false,
      reason:
        "This pairing cannot sign in the Factory pages: it lacks access:write. Pair again with a new link (run t3 pair on the server's machine).",
    });
  });

  it("reports an unreachable server on a network error", async () => {
    const result = await mintPairingToken(server, async () => {
      throw new TypeError(`Network request failed for ${BEARER}`);
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("unreachable");
      expect(result.reason).not.toContain(BEARER);
    }
  });

  it("gives distinct reasons for 401 and server errors", async () => {
    const unauthorized = await mintPairingToken(server, async () => json(401, authInvalid));
    const failed = await mintPairingToken(server, async () => json(500, "boom"));
    expect(unauthorized).not.toEqual(failed);
  });

  it("resolves the endpoint against a base with a trailing slash", async () => {
    const urls: string[] = [];
    await mintPairingToken({ httpBaseUrl: SLASH_BASE, bearerToken: BEARER }, async (url) => {
      urls.push(url);
      return json(200, issued);
    });
    expect(urls).toEqual(["https://mac.tail1234.ts.net:3876/api/auth/pairing-token"]);
  });
});

describe("request timeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ["probeFactory", probeFactory],
    ["mintPairingToken", mintPairingToken],
  ])("%s gives up on a request that never answers", async (_name, call) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = call(server, hanging);
    await vi.advanceTimersByTimeAsync(14_999);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ ok: false, reason: "The server is unreachable." });
  });
});

describe("mintAndInject", () => {
  function harness(fetchFn: FactoryFetch, current = () => true) {
    const events: string[] = [];
    const injected: string[] = [];
    const run = mintAndInject({
      server,
      fetchFn,
      isCurrent: current,
      onMinted: () => events.push("minted"),
      inject: (script) => {
        events.push("inject");
        injected.push(script);
      },
      onFailure: (reason) => events.push(`failure:${reason}`),
    });
    return { run, events, injected };
  }

  it("marks the state minted, then injects the credential once, bound to the server origin", async () => {
    const { run, events, injected } = harness(async () => json(200, issued));
    await expect(run).resolves.toBe("injected");
    expect(events).toEqual(["minted", "inject"]);
    expect(injected).toHaveLength(1);
    expect(injected[0]).toContain(JSON.stringify(CREDENTIAL));
    expect(injected[0]).toContain(JSON.stringify(BASE));
  });

  it("reports a failed mint in the open it belongs to", async () => {
    const { run, events, injected } = harness(async () => json(401, authInvalid));
    await expect(run).resolves.toBe("failed");
    expect(events).toEqual(["failure:The server no longer accepts this pairing."]);
    expect(injected).toEqual([]);
  });

  it("drops a mint that resolves after its open ended: no injection, no error", async () => {
    let current = true;
    let answer!: (response: Response) => void;
    const { run, events, injected } = harness(
      () => new Promise<Response>((resolve) => (answer = resolve)),
      () => current,
    );
    current = false;
    answer(json(200, issued));
    await expect(run).resolves.toBe("stale");
    expect(events).toEqual([]);
    expect(injected).toEqual([]);
  });
});

describe("revokeFactorySessions", () => {
  const session = (sessionId: string, method: string, label?: string) => ({
    sessionId,
    subject: "one-time-token",
    scopes: ["orchestration:read"],
    method,
    client: { deviceType: "mobile", ...(label ? { label } : {}) },
    issuedAt: "2026-10-01T00:00:00Z",
    expiresAt: "2026-11-01T00:00:00Z",
    lastConnectedAt: null,
    connected: false,
    current: false,
  });
  const clients = [
    session("s-phone", "bearer-access-token", "T3 Code Mobile"),
    session("s-factory-1", "browser-session-cookie", FACTORY_SESSION_LABEL),
    session("s-browser", "browser-session-cookie"),
    session("s-factory-2", "browser-session-cookie", FACTORY_SESSION_LABEL),
  ];

  function serverWith(
    sessions: unknown[],
    answer: (sessionId: string) => Response = () => json(200, { revoked: true }),
    list: () => Response = () => json(200, sessions),
  ) {
    const revoked: string[] = [];
    const authorizations: string[] = [];
    const fetchFn: FactoryFetch = async (url, init) => {
      authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
      if (url === `${BASE}/api/factory/auth/clients`) return list();
      if (url === `${BASE}/api/auth/clients/revoke`) {
        const body = JSON.parse(String(init?.body)) as { sessionId: string };
        revoked.push(body.sessionId);
        return answer(body.sessionId);
      }
      return json(404, "");
    };
    return { fetchFn, revoked, authorizations };
  }

  it("revokes only the browser sessions this screen labelled, with the bearer", async () => {
    const { fetchFn, revoked, authorizations } = serverWith(clients);
    await expect(revokeFactorySessions(server, fetchFn)).resolves.toEqual({
      ok: true,
      revoked: 2,
      left: 0,
    });
    expect(revoked).toEqual(["s-factory-1", "s-factory-2"]);
    expect(new Set(authorizations)).toEqual(new Set([`Bearer ${BEARER}`]));
  });

  it("revokes nothing when the screen never signed in", async () => {
    const { fetchFn, revoked } = serverWith([clients[0]!, clients[2]!]);
    await expect(revokeFactorySessions(server, fetchFn)).resolves.toEqual({
      ok: true,
      revoked: 0,
      left: 0,
    });
    expect(revoked).toEqual([]);
  });

  it("keeps revoking after one session fails, and counts what is left", async () => {
    const { fetchFn, revoked } = serverWith(clients, (sessionId) =>
      sessionId === "s-factory-1" ? json(500, "boom") : json(200, { revoked: true }),
    );
    await expect(revokeFactorySessions(server, fetchFn)).resolves.toEqual({
      ok: true,
      revoked: 1,
      left: 1,
    });
    expect(revoked).toEqual(["s-factory-1", "s-factory-2"]);
  });

  it("counts a session the server declined to revoke as left", async () => {
    const { fetchFn } = serverWith(clients, (sessionId) =>
      json(200, { revoked: sessionId === "s-factory-2" }),
    );
    await expect(revokeFactorySessions(server, fetchFn)).resolves.toEqual({
      ok: true,
      revoked: 1,
      left: 1,
    });
  });

  it("revokes nothing and reports a distinct reason when the list is refused or fails", async () => {
    const reasons = new Set<string>();
    for (const status of [401, 403, 500]) {
      const { fetchFn, revoked } = serverWith(clients, undefined, () => json(status, "no"));
      const result = await revokeFactorySessions(server, fetchFn);
      expect(result.ok, String(status)).toBe(false);
      if (!result.ok) reasons.add(result.reason);
      expect(revoked).toEqual([]);
    }
    expect(reasons.size).toBe(3);
  });

  it("does not read a session list it cannot decode as empty", async () => {
    const { fetchFn, revoked } = serverWith(clients, undefined, () =>
      json(200, [{ sessionId: 1 }]),
    );
    const result = await revokeFactorySessions(server, fetchFn);
    expect(result.ok).toBe(false);
    expect(revoked).toEqual([]);
  });

  it("reports an unreachable server without touching the bearer", async () => {
    const result = await revokeFactorySessions(server, async () => {
      throw new TypeError(`Network request failed for ${BEARER}`);
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("unreachable");
      expect(result.reason).not.toContain(BEARER);
    }
  });

  it("does nothing without a bearer", async () => {
    let called = false;
    const result = await revokeFactorySessions(
      { httpBaseUrl: BASE, bearerToken: null },
      async () => {
        called = true;
        return json(200, []);
      },
    );
    expect(called).toBe(false);
    expect(result.ok).toBe(false);
  });
});

describe("factorySessionsMayRemain", () => {
  it("is false only when every labelled session was revoked", () => {
    expect(factorySessionsMayRemain({ ok: true, revoked: 2, left: 0 })).toBe(false);
    expect(factorySessionsMayRemain({ ok: true, revoked: 0, left: 0 })).toBe(false);
    expect(factorySessionsMayRemain({ ok: true, revoked: 1, left: 1 })).toBe(true);
    expect(factorySessionsMayRemain({ ok: false, reason: "The server is unreachable." })).toBe(
      true,
    );
    expect(factorySessionsMayRemain(null)).toBe(true);
  });
});

describe("probeFactory", () => {
  it("is ok for a JSON 2xx and sends the bearer", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const result = await probeFactory(server, async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return json(200, { enabled: true });
    });
    expect(result).toEqual({ ok: true });
    expect(calls[0]?.url).toBe(`${BASE}/api/factory/status`);
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe(`Bearer ${BEARER}`);
  });

  it("says the server has no Factory pages on 404", async () => {
    const result = await probeFactory(server, async () => json(404, {}));
    expect(result).toEqual({ ok: false, reason: "This server has no Factory pages." });
  });

  it("says the same when a 200 is not JSON (SPA fallback)", async () => {
    const result = await probeFactory(
      server,
      async () =>
        new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } }),
    );
    expect(result).toEqual({ ok: false, reason: "This server has no Factory pages." });
  });

  it.each([401, 403])("explains %s", async (status) => {
    const result = await probeFactory(server, async () => json(status, {}));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).not.toContain(BEARER);
  });

  it("reports an unreachable server on a network error", async () => {
    const result = await probeFactory(server, async () => {
      throw new TypeError(`Network request failed for ${BEARER}`);
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("unreachable");
      expect(result.reason).not.toContain(BEARER);
    }
  });

  it("resolves the endpoint against a base with a trailing slash", async () => {
    const urls: string[] = [];
    await probeFactory({ httpBaseUrl: SLASH_BASE, bearerToken: BEARER }, async (url) => {
      urls.push(url);
      return json(200, {});
    });
    expect(urls).toEqual(["https://mac.tail1234.ts.net:3876/api/factory/status"]);
  });
});
