/**
 * The one way the factory pages reach the server: a plain `fetch` on a connection's HTTP base with
 * its credential (cookie, or bearer token), as the factory API is outside the typed HTTP API. Going
 * through the connection, not the page's origin, works from a paired phone. A relay (DPoP) one is
 * reported unsupported, not sent unauthenticated: the shared helper signs only typed calls.
 */
import type { PreparedConnection } from "@t3tools/client-runtime/connection";

import { textField } from "./format";

/** How long one call may wait for its answer. */
export const DEFAULT_TIMEOUT_MS = 15_000;

export const timeoutMessage = (timeoutMs: number): string =>
  `The factory did not answer within ${Math.round(timeoutMs / 1000)} seconds.`;

/** A call that was not sent (`relay`) or got no answer in time (`timeout`). */
export class FactoryHttpError extends Error {
  readonly kind: "relay" | "timeout";
  constructor(kind: "relay" | "timeout", message: string) {
    super(message);
    this.name = "FactoryHttpError";
    this.kind = kind;
  }
}

export interface FactoryHttpRequest {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly searchParams?: Record<string, string> | undefined;
  /** Sent as JSON. */
  readonly body?: unknown;
  readonly timeoutMs?: number;
}

export interface FactoryHttpResponse {
  readonly status: number;
  readonly text: string;
}

/**
 * Sends one request on `prepared` and reads the whole answer within the timeout. Any status comes
 * back as a response for the caller to map; a request that never gets one rejects.
 */
export const factoryRequest = async (
  prepared: PreparedConnection,
  request: FactoryHttpRequest,
): Promise<FactoryHttpResponse> => {
  const authorization = prepared.httpAuthorization;
  if (authorization?._tag === "Dpop") {
    throw new FactoryHttpError(
      "relay",
      "The factory is not available over a relay connection yet.",
    );
  }
  const url = new URL(`${prepared.httpBaseUrl.replace(/\/+$/, "")}${request.path}`);
  for (const [key, value] of Object.entries(request.searchParams ?? {})) {
    url.searchParams.set(key, value);
  }
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new FactoryHttpError("timeout", timeoutMessage(timeoutMs)));
    }, timeoutMs);
  });
  const send = async (): Promise<FactoryHttpResponse> => {
    const response = await fetch(url, {
      method: request.method,
      signal: controller.signal,
      // A cookie session sends no header; a bearer token must not also send cookies.
      credentials: authorization === null ? "include" : "omit",
      headers: {
        accept: "application/json",
        ...(authorization === null ? {} : { authorization: `Bearer ${authorization.token}` }),
        ...(request.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
    });
    return { status: response.status, text: await response.text() };
  };
  try {
    return await Promise.race([send(), deadline]);
  } finally {
    clearTimeout(timer);
  }
};

export const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** The server's own `message` for a non-2xx answer, else the status. */
export const failureMessage = (status: number, body: unknown): string =>
  textField(body, "message") ?? `The factory answered ${status}.`;
