// Pure rules for the Factory screen: which links stay in the WebView, when to sign it
// in, and how the pairing-token and status requests map to one-line reasons. No reason
// ever carries the bearer or the minted credential.

import { environmentEndpointUrl } from "@t3tools/client-runtime/environment";
import {
  executeEnvironmentHttpRequest,
  layerRemoteHttpClient,
  makeEnvironmentHttpApiGroupClient,
  type RemoteEnvironmentRequestError,
} from "@t3tools/client-runtime/rpc";
import {
  AuthEnvironmentMaintainScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  type AuthGrantScope,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { factoryExchangeScript } from "./factoryWebViewScripts";

export type FactoryServer = {
  readonly httpBaseUrl: string;
  readonly bearerToken: string | null;
};

export type FactoryFetch = (url: string, init?: RequestInit) => Promise<Response>;

export type FactoryResult<T = object> =
  | ({ readonly ok: true } & T)
  | { readonly ok: false; readonly reason: string };

const REQUEST_TIMEOUT_MS = 15_000;
const UNREACHABLE = "The server is unreachable.";
const NO_FACTORY_PAGES = "This server has no Factory pages.";

/**
 * Only what the Factory pages' own routes check. The session the WebView ends up with has no
 * terminal, provider or filesystem scope, though orchestration:operate still lets it start
 * agents, which is what the Factory does.
 */
export const FACTORY_SESSION_SCOPES: ReadonlyArray<AuthGrantScope> = [
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  AuthEnvironmentMaintainScope,
];

/**
 * How the session reads in the server's Connections settings, and how revokeFactorySessions
 * finds it. Every phone uses the same label, so removing an environment from one phone also
 * signs out another phone's Factory screen, which then signs itself in again on its next open.
 */
export const FACTORY_SESSION_LABEL = "T3 Code Mobile · Factory";

export function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

/**
 * Same-origin and in-page schemes stay in the WebView. Any other http(s) origin, and
 * schemes such as mailto: and tel:, go to the system.
 */
export function factoryLinkAction(url: string, httpBaseUrl: string): "webview" | "system" {
  if (url === "about:blank" || url.startsWith("blob:") || url.startsWith("data:")) {
    return "webview";
  }
  const origin = originOf(url);
  return origin !== null && origin === originOf(httpBaseUrl) ? "webview" : "system";
}

export type FactoryWebViewMessage =
  | { readonly type: "location"; readonly href: string }
  | { readonly type: "unauthorized" }
  | { readonly type: "authorized" }
  | { readonly type: "exchange"; readonly ok: boolean };

export function parseFactoryMessage(data: string): FactoryWebViewMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const message = value as Record<string, unknown>;
  if (message.type === "location" && typeof message.href === "string") {
    return { type: "location", href: message.href };
  }
  if (message.type === "unauthorized") return { type: "unauthorized" };
  if (message.type === "authorized") return { type: "authorized" };
  if (message.type === "exchange" && typeof message.ok === "boolean") {
    return { type: "exchange", ok: message.ok };
  }
  return null;
}

export type SignInState = "idle" | "minting" | "exchanging" | "exchanged" | "signed-in";
export type SignInEvent = FactoryWebViewMessage | { readonly type: "minted" };
export type SignInAction = "mint" | "rejected" | "exchange-failed" | "none";

const IDLE_NONE = { action: "none" } as const;

/**
 * One sign-in per unauthenticated signal: idle -> minting -> exchanging -> exchanged -> signed-in.
 * Landing on /factory proves nothing, since the page loads before its cookie is checked, so an
 * unauthenticated signal while exchanged is "rejected" and Retry replaces a loop.
 * Messages count only when the WebView's top frame (eventUrl) is on the server's origin.
 */
export function nextSignIn(
  state: SignInState,
  event: SignInEvent,
  eventUrl: string,
  httpBaseUrl: string,
): { readonly state: SignInState; readonly action: SignInAction } {
  if (event.type === "minted") {
    return { state: state === "minting" ? "exchanging" : state, ...IDLE_NONE };
  }
  const serverOrigin = originOf(httpBaseUrl);
  if (serverOrigin === null || originOf(eventUrl) !== serverOrigin) return { state, ...IDLE_NONE };

  if (event.type === "exchange") {
    if (state !== "exchanging") return { state, ...IDLE_NONE };
    return event.ok
      ? { state: "exchanged", ...IDLE_NONE }
      : { state: "idle", action: "exchange-failed" };
  }
  if (event.type === "authorized") {
    return { state: state === "exchanged" ? "signed-in" : state, ...IDLE_NONE };
  }

  let href: URL | null = null;
  if (event.type === "location") {
    try {
      href = new URL(event.href);
    } catch {
      return { state, ...IDLE_NONE };
    }
  }
  const unauthenticated =
    event.type === "unauthorized" ||
    (href !== null &&
      href.origin === serverOrigin &&
      (href.pathname === "/pair" || href.pathname === "/pair/"));
  if (!unauthenticated) return { state, ...IDLE_NONE };
  if (state === "minting" || state === "exchanging") return { state, ...IDLE_NONE };
  if (state === "exchanged") return { state: "idle", action: "rejected" };
  return { state: "minting", action: "mint" };
}

/** A stalled peer must not hold the spinner: every request aborts after REQUEST_TIMEOUT_MS. */
async function request(fetchFn: FactoryFetch, url: string, init: RequestInit) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetchFn(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const NOT_CONNECTED = "This environment is not connected yet.";

function mintFailureReason(error: RemoteEnvironmentRequestError): string {
  switch (error._tag) {
    case "EnvironmentAuthInvalidError":
      return "The server no longer accepts this pairing.";
    case "EnvironmentScopeRequiredError":
      return `This pairing cannot sign in the Factory pages: it lacks ${error.requiredPermission ?? error.requiredScope}.`;
    case "EnvironmentRequestInvalidError":
    case "EnvironmentOperationForbiddenError":
      return "The server refused to sign in the Factory pages.";
    case "EnvironmentResourceNotFoundError":
      return "The server failed to sign in (404).";
    case "EnvironmentInternalError":
      return "The server failed to sign in (500).";
    case "RemoteEnvironmentAuthUndeclaredStatusError":
      return `The server failed to sign in (${error.status}).`;
    case "RemoteEnvironmentAuthInvalidJsonError":
      return "The server returned an unexpected sign-in response.";
    case "RemoteEnvironmentAuthFetchError":
    case "RemoteEnvironmentAuthTimeoutError":
      return UNREACHABLE;
  }
}

/**
 * Mints a one-time pairing credential with the connection's bearer token, through the
 * contract's typed auth client so an upstream change to the endpoint fails typecheck here
 * rather than on a phone. The credential carries FACTORY_SESSION_SCOPES and
 * FACTORY_SESSION_LABEL.
 */
export async function mintPairingToken(
  server: FactoryServer,
  fetchFn: FactoryFetch,
): Promise<FactoryResult<{ readonly credential: string }>> {
  if (server.bearerToken === null) return { ok: false, reason: NOT_CONNECTED };
  const authorization = `Bearer ${server.bearerToken}`;
  const mint = makeEnvironmentHttpApiGroupClient(server.httpBaseUrl, "auth").pipe(
    Effect.flatMap((auth) =>
      auth.pairingCredential({
        headers: { authorization },
        payload: { label: FACTORY_SESSION_LABEL, scopes: FACTORY_SESSION_SCOPES },
      }),
    ),
  );
  const timedFetch: typeof fetch = (input, init) =>
    request(fetchFn, input instanceof Request ? input.url : String(input), init ?? {});
  return Effect.runPromise(
    executeEnvironmentHttpRequest(
      environmentEndpointUrl(server.httpBaseUrl, "/api/auth/pairing-token"),
      REQUEST_TIMEOUT_MS,
      mint,
    ).pipe(
      Effect.map((issued) => ({ ok: true, credential: issued.credential }) as const),
      Effect.catch((error) =>
        Effect.succeed({ ok: false, reason: mintFailureReason(error) } as const),
      ),
      Effect.provide(layerRemoteHttpClient(timedFetch)),
    ),
  );
}

export type RevokeOutcome = FactoryResult<{ readonly revoked: number; readonly left: number }>;

/**
 * Revokes every browser session this app's Factory screen created on the server, so removing
 * the environment from the phone leaves no signed-in cookie behind. Each session is revoked
 * on its own: one refusal does not skip the rest, and `left` counts the sessions still signed
 * in. ok is false only when the list itself could not be read.
 */
export async function revokeFactorySessions(
  server: FactoryServer,
  fetchFn: FactoryFetch,
): Promise<RevokeOutcome> {
  if (server.bearerToken === null) return { ok: false, reason: NOT_CONNECTED };
  const headers = { authorization: `Bearer ${server.bearerToken}` };
  const revoke = Effect.gen(function* () {
    const auth = yield* makeEnvironmentHttpApiGroupClient(server.httpBaseUrl, "auth");
    const sessions = yield* auth.clients({ headers });
    const factorySessions = sessions.filter(
      (session) =>
        session.method === "browser-session-cookie" &&
        session.client.label === FACTORY_SESSION_LABEL,
    );
    const results = yield* Effect.forEach(factorySessions, (session) =>
      auth.revokeClient({ headers, payload: { sessionId: session.sessionId } }).pipe(
        Effect.map((result) => result.revoked),
        Effect.catch(() => Effect.succeed(false)),
      ),
    );
    const revoked = results.filter(Boolean).length;
    return { ok: true, revoked, left: results.length - revoked } as const;
  });
  const timedFetch: typeof fetch = (input, init) =>
    request(fetchFn, input instanceof Request ? input.url : String(input), init ?? {});
  return Effect.runPromise(
    executeEnvironmentHttpRequest(
      environmentEndpointUrl(server.httpBaseUrl, "/api/auth/clients"),
      REQUEST_TIMEOUT_MS,
      revoke,
    ).pipe(
      Effect.catch((error) =>
        Effect.succeed({ ok: false, reason: mintFailureReason(error) } as const),
      ),
      Effect.provide(layerRemoteHttpClient(timedFetch)),
    ),
  );
}

/**
 * Whether the user has to revoke the Factory session by hand: the app could not reach the
 * server's session list (or had no bearer to try with), or a session refused to go.
 */
export function factorySessionsMayRemain(outcome: RevokeOutcome | null): boolean {
  return outcome === null || !outcome.ok || outcome.left > 0;
}

/**
 * One mint for one open of the WebView. `isCurrent` is read after the mint returns: a mint
 * that outlived its open (Retry, a new bearer, unmount) neither injects its credential into
 * a newer WebView nor reports an error for it. `onMinted` runs before the injection, so the
 * state machine is "exchanging" by the time the exchange message arrives.
 */
export async function mintAndInject(input: {
  readonly server: FactoryServer;
  readonly fetchFn: FactoryFetch;
  readonly isCurrent: () => boolean;
  readonly onMinted: () => void;
  readonly inject: (script: string) => void;
  readonly onFailure: (reason: string) => void;
}): Promise<"injected" | "failed" | "stale"> {
  const minted = await mintPairingToken(input.server, input.fetchFn);
  if (!input.isCurrent()) return "stale";
  if (!minted.ok) {
    input.onFailure(minted.reason);
    return "failed";
  }
  input.onMinted();
  input.inject(factoryExchangeScript(minted.credential, originOf(input.server.httpBaseUrl) ?? ""));
  return "injected";
}

/** Checks the server has Factory pages and accepts this connection. Mints nothing. */
export async function probeFactory(
  server: FactoryServer,
  fetchFn: FactoryFetch,
): Promise<FactoryResult> {
  if (server.bearerToken === null) return { ok: false, reason: NOT_CONNECTED };
  let response: Response;
  try {
    response = await request(
      fetchFn,
      environmentEndpointUrl(server.httpBaseUrl, "/api/factory/status"),
      {
        method: "GET",
        headers: { authorization: `Bearer ${server.bearerToken}`, accept: "application/json" },
      },
    );
  } catch {
    return { ok: false, reason: UNREACHABLE };
  }
  if (response.status === 404) return { ok: false, reason: NO_FACTORY_PAGES };
  if (response.status === 401) {
    return { ok: false, reason: "The server no longer accepts this pairing." };
  }
  if (response.status === 403) {
    return { ok: false, reason: "This pairing cannot read the Factory status." };
  }
  if (!response.ok)
    return { ok: false, reason: `The server returned an error (${response.status}).` };
  const body = await response.json().catch(() => undefined);
  return body === undefined ? { ok: false, reason: NO_FACTORY_PAGES } : { ok: true };
}
