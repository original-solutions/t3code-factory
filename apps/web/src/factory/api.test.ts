import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import type { Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentSession } from "~/state/session";

import {
  __setFactoryConnectionForTests,
  __setFactoryTimeoutForTests,
  FactoryApiError,
  factoryApi,
} from "./api";

// The session atom the lookup reads is writable here, so a test can be the session: what
// connection each environment holds.
vi.mock("~/state/session", async () => {
  const { Atom } = await import("effect/reactivity");
  const Option = await import("effect/Option");
  const connections = new Map<string, Atom.Writable<Option.Option<PreparedConnection>>>();
  return {
    environmentSession: {
      preparedConnectionValueAtom: (environmentId: string) => {
        let atom = connections.get(environmentId);
        if (atom === undefined) {
          atom = Atom.make(Option.none<PreparedConnection>()).pipe(Atom.keepAlive);
          connections.set(environmentId, atom);
        }
        return atom;
      },
    },
  };
});

const ENV_1 = "env-1" as EnvironmentId;
const ENV_2 = "env-2" as EnvironmentId;
const setConnectionOf = (environmentId: EnvironmentId, prepared: PreparedConnection | null) =>
  appAtomRegistry.set(
    environmentSession.preparedConnectionValueAtom(environmentId) as Atom.Writable<
      Option.Option<PreparedConnection>
    >,
    prepared === null ? Option.none() : Option.some(prepared),
  );

// Only the wire is stubbed: the calls go through `fetch` against the connected environment's HTTP
// base, never the window's own origin (kept at 127.0.0.1:3773 here to prove it).
const WINDOW_ORIGIN = "http://127.0.0.1:3773";
const cookieConnection = (httpBaseUrl = WINDOW_ORIGIN) =>
  ({ httpBaseUrl, httpAuthorization: null }) as unknown as PreparedConnection;
const REMOTE_BASE = "https://personal-mac.tail1234.ts.net:3876";
const bearerConnection = {
  httpBaseUrl: `${REMOTE_BASE}/`,
  httpAuthorization: { _tag: "Bearer", token: "tok-1" },
} as unknown as PreparedConnection;

const fetchMock = vi.fn<typeof fetch>();

beforeAll(() => {
  vi.stubGlobal("fetch", fetchMock);
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: { href: `${WINDOW_ORIGIN}/factory`, origin: WINDOW_ORIGIN },
    },
  });
});

afterAll(() => {
  Reflect.deleteProperty(globalThis, "window");
  vi.unstubAllGlobals();
});

beforeEach(() => {
  __setFactoryConnectionForTests(cookieConnection());
});

afterEach(() => {
  vi.useRealTimers();
  fetchMock.mockReset();
  __setFactoryTimeoutForTests();
  __setFactoryConnectionForTests();
  setConnectionOf(ENV_1, null);
  setConnectionOf(ENV_2, null);
});

const answer = (status: number, body: string, contentType = "application/json") =>
  fetchMock.mockResolvedValueOnce(
    new Response(body, { status, headers: { "content-type": contentType } }),
  );

/** The request the last call sent. */
const sent = () => {
  const call = fetchMock.mock.calls.at(-1)!;
  return new Request(call[0], call[1]);
};

const failure = async (call: Promise<unknown>): Promise<FactoryApiError> => {
  try {
    await call;
  } catch (error) {
    expect(error).toBeInstanceOf(FactoryApiError);
    return error as FactoryApiError;
  }
  throw new Error("the call did not fail");
};

describe("factoryApi over HTTP", () => {
  it("reads with GET and returns the body as JSON", async () => {
    answer(200, '{"runs":[{"id":"o__r__1__1"}]}');
    expect(await factoryApi.runs(ENV_1, { all: false })).toEqual({ runs: [{ id: "o__r__1__1" }] });
    expect(sent().method).toBe("GET");
    const url = new URL(sent().url);
    expect([url.pathname, url.search]).toEqual(["/api/factory/runs", ""]);
  });

  it("asks for every run with ?all=1", async () => {
    answer(200, '{"runs":[]}');
    await factoryApi.runs(ENV_1, { all: true });
    const url = new URL(sent().url);
    expect([url.pathname, url.search]).toEqual(["/api/factory/runs", "?all=1"]);
  });

  it("stops a run with a POST to its encoded path", async () => {
    answer(200, '{"stopped":"a/b","already":false,"message":"stop requested"}');
    const result = await factoryApi.stopRun(ENV_1, "a/b");
    expect(result.message).toBe("stop requested");
    expect(sent().method).toBe("POST");
    expect(new URL(sent().url).pathname).toBe("/api/factory/runs/a%2Fb/stop");
  });

  it("dismisses attention items with a POST of their ids as JSON", async () => {
    answer(200, '{"dismissed":["config"]}');
    expect(await factoryApi.dismissAttention(ENV_1, ["config", "gone"])).toEqual({
      dismissed: ["config"],
    });
    expect(sent().method).toBe("POST");
    expect(new URL(sent().url).pathname).toBe("/api/factory/attention/dismiss");
    expect(sent().headers.get("content-type")).toBe("application/json");
    expect(await sent().json()).toEqual({ ids: ["config", "gone"] });
  });

  it("snoozes and installs a waiting update with POSTs to the deploy paths", async () => {
    answer(200, '{"snoozed_until":"2026-10-30T09:00:00.000Z"}');
    expect(await factoryApi.snoozeDeploy(ENV_1, "abc")).toEqual({
      snoozed_until: "2026-10-30T09:00:00.000Z",
    });
    expect(sent().method).toBe("POST");
    expect(new URL(sent().url).pathname).toBe("/api/factory/deploy/snooze");
    expect(await sent().json()).toEqual({ commit: "abc" });
    answer(202, '{"commit":"abc","kicked":false,"message":"next tick"}');
    expect((await factoryApi.deployNow(ENV_1, "abc")).kicked).toBe(false);
    expect(sent().method).toBe("POST");
    expect(new URL(sent().url).pathname).toBe("/api/factory/deploy/now");
    expect(await sent().json()).toEqual({ commit: "abc" });
  });

  it("maps an error body to the status, code and message", async () => {
    answer(404, '{"code":"run_not_found","message":"no such run"}');
    const error = await failure(factoryApi.run(ENV_1, "x"));
    expect([error.status, error.code, error.message]).toEqual([
      404,
      "run_not_found",
      "no such run",
    ]);
  });

  it("names the status when the error body is not JSON", async () => {
    answer(500, "boom", "text/plain");
    const error = await failure(factoryApi.status(ENV_1));
    expect([error.status, error.code, error.message]).toEqual([
      500,
      null,
      "The factory answered 500.",
    ]);
  });

  it("is status 0 when the request never got an answer", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const error = await failure(factoryApi.status(ENV_1));
    expect(error.status).toBe(0);
    expect(error.code).toBeNull();
    expect(error.message).not.toBe("");
  });

  it("gives up on an answer that does not come in time", async () => {
    __setFactoryTimeoutForTests(20);
    fetchMock.mockImplementationOnce(() => new Promise(() => {}));
    const error = await failure(factoryApi.status(ENV_1));
    expect([error.status, error.code]).toEqual([0, "timeout"]);
    expect(error.message).toContain("did not answer");
  });

  it("keeps an answer that comes before the time is up", async () => {
    __setFactoryTimeoutForTests(1000);
    answer(200, '{"state":"idle"}');
    expect(await factoryApi.status(ENV_1)).toEqual({ state: "idle" });
  });
});

describe("factoryApi on the connected environment", () => {
  it("sends to a remote environment's base with its bearer token and no cookies", async () => {
    __setFactoryConnectionForTests(bearerConnection);
    answer(200, '{"state":"idle"}');
    await factoryApi.status(ENV_1);
    const [target, init] = fetchMock.mock.calls.at(-1)!;
    expect(String(target)).toBe(`${REMOTE_BASE}/api/factory/status`);
    expect(new URL(String(target)).origin).not.toBe(WINDOW_ORIGIN);
    expect(sent().headers.get("authorization")).toBe("Bearer tok-1");
    expect(init?.credentials).toBe("omit");
  });

  it("sends a cookie session's request with credentials and no authorization header", async () => {
    __setFactoryConnectionForTests(cookieConnection("https://other-host.test:4000"));
    answer(200, '{"state":"idle"}');
    await factoryApi.status(ENV_1);
    const [target, init] = fetchMock.mock.calls.at(-1)!;
    expect(String(target)).toBe("https://other-host.test:4000/api/factory/status");
    expect(init?.credentials).toBe("include");
    expect(sent().headers.get("authorization")).toBeNull();
  });

  it("fails without sending over a relay (DPoP) connection", async () => {
    __setFactoryConnectionForTests({
      httpBaseUrl: REMOTE_BASE,
      httpAuthorization: { _tag: "Dpop" },
    } as unknown as PreparedConnection);
    const error = await failure(factoryApi.status(ENV_1));
    expect(error.status).toBe(0);
    expect(error.message).toBe("The factory is not available over a relay connection yet.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("waits for a connection that appears after the call started", async () => {
    __setFactoryConnectionForTests(null);
    answer(200, '{"state":"idle"}');
    const pending = factoryApi.status(ENV_1);
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
    __setFactoryConnectionForTests(bearerConnection);
    expect(await pending).toEqual({ state: "idle" });
    expect(String(fetchMock.mock.calls.at(-1)![0])).toBe(`${REMOTE_BASE}/api/factory/status`);
  });

  it("fails with no_connection when none appears within the time", async () => {
    __setFactoryTimeoutForTests(20);
    __setFactoryConnectionForTests(null);
    const error = await failure(factoryApi.status(ENV_1));
    expect([error.status, error.code]).toEqual([0, "no_connection"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("gives the request only the time the wait for a connection left", async () => {
    vi.useFakeTimers();
    __setFactoryTimeoutForTests(2000);
    __setFactoryConnectionForTests(null);
    fetchMock.mockImplementationOnce(() => new Promise(() => {}));
    const pending = failure(factoryApi.status(ENV_1));
    await vi.advanceTimersByTimeAsync(1200);
    __setFactoryConnectionForTests(bearerConnection);
    await vi.advanceTimersByTimeAsync(799);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await Promise.race([pending, Promise.resolve("still waiting")])).toBe("still waiting");
    await vi.advanceTimersByTimeAsync(1);
    const error = await pending;
    expect([error.status, error.code]).toEqual([0, "timeout"]);
    expect(error.message).toBe("The factory did not answer within 2 seconds.");
  });

  it("keeps an answer that comes within the time left after the wait", async () => {
    vi.useFakeTimers();
    __setFactoryTimeoutForTests(2000);
    __setFactoryConnectionForTests(null);
    let answer!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => {
      answer = resolve;
    });
    fetchMock.mockImplementationOnce(() => response);
    const pending = factoryApi.status(ENV_1);
    await vi.advanceTimersByTimeAsync(1200);
    __setFactoryConnectionForTests(bearerConnection);
    await vi.advanceTimersByTimeAsync(500);
    answer(
      new Response('{"state":"idle"}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    expect(await pending).toEqual({ state: "idle" });
  });
});

describe("factoryApi on the given environment", () => {
  beforeEach(() => {
    __setFactoryConnectionForTests();
  });

  it("sends on the given environment's prepared connection, not another environment's", async () => {
    setConnectionOf(ENV_1, cookieConnection("https://other-host.test:4000"));
    setConnectionOf(ENV_2, bearerConnection);
    answer(200, '{"state":"running"}');
    expect(await factoryApi.status(ENV_2)).toEqual({ state: "running" });
    const [target, init] = fetchMock.mock.calls.at(-1)!;
    expect(String(target)).toBe(`${REMOTE_BASE}/api/factory/status`);
    expect(sent().headers.get("authorization")).toBe("Bearer tok-1");
    expect(init?.credentials).toBe("omit");

    answer(200, '{"state":"idle"}');
    await factoryApi.status(ENV_1);
    const [first, firstInit] = fetchMock.mock.calls.at(-1)!;
    expect(String(first)).toBe("https://other-host.test:4000/api/factory/status");
    expect(firstInit?.credentials).toBe("include");
    expect(sent().headers.get("authorization")).toBeNull();
  });

  it("sends every kind of call on the given environment", async () => {
    setConnectionOf(ENV_1, cookieConnection("https://other-host.test:4000"));
    setConnectionOf(ENV_2, bearerConnection);
    const calls: Array<() => Promise<unknown>> = [
      () => factoryApi.runs(ENV_2, { all: true }),
      () => factoryApi.run(ENV_2, "r"),
      () => factoryApi.stopRun(ENV_2, "r"),
      () => factoryApi.pauseClaims(ENV_2),
      () => factoryApi.resumeClaims(ENV_2),
      () => factoryApi.dismissAttention(ENV_2, ["config"]),
      () => factoryApi.snoozeDeploy(ENV_2, "abc"),
      () => factoryApi.deployNow(ENV_2, "abc"),
    ];
    for (const call of calls) {
      answer(200, "{}");
      await call();
      expect(new URL(String(fetchMock.mock.calls.at(-1)![0])).origin).toBe(REMOTE_BASE);
    }
  });

  it("fails with no_connection while the environment has none, even if another does", async () => {
    __setFactoryTimeoutForTests(20);
    setConnectionOf(ENV_1, bearerConnection);
    const error = await failure(factoryApi.status(ENV_2));
    expect([error.status, error.code]).toEqual([0, "no_connection"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("waits while the environment has no prepared connection yet", async () => {
    answer(200, '{"state":"idle"}');
    const pending = factoryApi.status(ENV_2);
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
    setConnectionOf(ENV_1, cookieConnection("https://other-host.test:4000"));
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
    setConnectionOf(ENV_2, bearerConnection);
    expect(await pending).toEqual({ state: "idle" });
    expect(String(fetchMock.mock.calls.at(-1)![0])).toBe(`${REMOTE_BASE}/api/factory/status`);
  });

  it("applies the test override to every environment", async () => {
    __setFactoryConnectionForTests(bearerConnection);
    answer(200, "{}");
    await factoryApi.status(ENV_2);
    expect(String(fetchMock.mock.calls.at(-1)![0])).toBe(`${REMOTE_BASE}/api/factory/status`);
  });
});
