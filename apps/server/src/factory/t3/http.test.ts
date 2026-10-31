// @effect-diagnostics nodeBuiltinImport:off - the tests lay out real run files and read the pause file back.
// @effect-diagnostics globalDate:off - the pause time is the handler's wall clock, which the test brackets.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthAccessReadScope,
  AuthClientSession,
  AuthEnvironmentMaintainScope,
  type AuthEnvironmentScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpServerResponse } from "effect/http";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import { describe } from "vite-plus/test";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as SessionStore from "../../auth/SessionStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ServerHttp from "../../http.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import packageJson from "../../../package.json" with { type: "json" };
import { Attention, type AttentionItem } from "../attention.ts";
import type { WatchedListing, WatchedProject } from "../config.ts";
import { FactoryLoop, hostName, type RepoConfigReading } from "../index.ts";
import { makeCause, type RunEvent } from "../ledger/events.ts";
import { Ledger } from "../ledger/ledger.ts";
import { runIdToString, runPath, type RunId } from "../ledger/runId.ts";
import { T0, useTempDirs } from "../ledger/testSupport.ts";
import { formatTs } from "../ledger/time.ts";
import { stopRequestPath } from "../runner/stop.ts";
import type { FactoryStatus } from "../status.ts";
import { saveMachineConfig } from "../settings.ts";
import { route } from "./auth.ts";
import { DeployKick } from "./deployKick.ts";
import * as ServerExitService from "./exit.ts";
import {
  CLIENTS_PATH,
  CONFIG_PATH,
  DEPLOY_NOW_PATH,
  DEPLOY_SNOOZE_PATH,
  DISMISS_PATH,
  FactoryRoutes,
  RESTART_PATH,
  STATUS_PATH,
} from "./http.ts";
import { FactoryPaths } from "./paths.ts";
import { SessionsError } from "./sessions.ts";
import { WatchedReposError } from "./watchedRepos.ts";

const TEST_ROUTE_PATH = "/api/factory/test/settings";

const decodeClientSessions = Schema.decodeUnknownSync(
  Schema.toCodecJson(Schema.Array(AuthClientSession)),
);

/** A route that needs a scope a standard client lacks, to prove the scope check. */
const testOnlyRoute = route(
  "GET",
  TEST_ROUTE_PATH,
  AuthSettingsWriteScope,
  Effect.succeed(HttpServerResponse.empty({ status: 204 })),
);

const layerEnvironmentAuth = EnvironmentAuth.layer.pipe(
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.layerIdentity),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-factory-http-test-" })),
  Layer.provide(NodeServices.layer),
);

const layerRoutes = Layer.mergeAll(FactoryRoutes, testOnlyRoute).pipe(
  Layer.provideMerge(
    HttpPlatform.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(Etag.layerWeak),
    ),
  ),
);

/** The routes behind the server's own browser CORS layer, as `server.ts` serves them. */
const layerRoutesWithCors = Layer.merge(
  layerRoutes,
  ServerHttp.layerBrowserApiCors.pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-factory-cors-test-" })),
    Layer.provide(NodeServices.layer),
  ),
);

const tempDir = useTempDirs();

const run10: RunId = { repo: "rawphp/softfac", issue: "10", attempt: 1 };
const ID = runIdToString(run10);
const run11: RunId = { repo: "rawphp/softfac", issue: "11", attempt: 1 };
const run12: RunId = { repo: "rawphp/softfac", issue: "12", attempt: 2 };

const CLAIMED: RunEvent = {
  event: "claimed",
  data: { machine: "mac-mini", github_user: "rawphp" },
};
const moved = (from: string, to: string): RunEvent =>
  ({ event: "state_changed", data: { from, to } }) as RunEvent;
const stepped = (step: string): RunEvent => ({ event: "step_changed", data: { step } }) as RunEvent;
const FINISHED: RunEvent = {
  event: "finished",
  data: {
    outcome: "pr-open",
    total_ms: 0,
    gate_attempts: 0,
    review_cycles: null,
    pr_url: null,
    pr_end: null,
  },
};
const BUILDING: ReadonlyArray<RunEvent> = [
  CLAIMED,
  moved("ready", "triage"),
  moved("triage", "building"),
];

/** Writes a run's ledger, one second apart from `startMs`. */
const seed = (dir: string, id: RunId, events: ReadonlyArray<RunEvent>, startMs = T0) => {
  let now = startMs;
  const ledger = Ledger.create(dir, id, { clock: () => (now += 1000) });
  try {
    for (const event of events) ledger.append(event, makeCause("start", "seed"));
  } finally {
    ledger.close();
  }
};

const ledgerBytes = (dir: string, id: RunId = run10) =>
  NodeFS.readFileSync(runPath(dir, id), "utf8");

const attentionItem = (over: Partial<AttentionItem> = {}): AttentionItem => ({
  id: "stuck:a/b#1",
  kind: "stuck",
  repo: "a/b",
  issue: 1,
  run: "a__b__1__1",
  message: "run went stuck",
  firstSeenMs: T0,
  ...over,
});

/** A string body is sent as it is, so a test can send what is not JSON; anything else as JSON. */
type Call = (
  method: "GET" | "POST" | "PUT",
  path: string,
  token?: string,
  body?: unknown,
) => Promise<Response>;

interface Tokens {
  readonly read: string;
  readonly operate: string;
  readonly maintain: string;
  readonly settingsWrite: string;
  readonly accessRead: string;
}

/** Counts the calls to the exit the restart route makes; `done` settles on the first. */
interface Exits {
  count: number;
  readonly done: Promise<void>;
}

const makeExits = (): Exits & { readonly settle: () => void } => {
  let settle = () => {};
  const done = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { count: 0, done, settle };
};

interface World {
  readonly status?: FactoryStatus;
  readonly passRunning?: boolean;
  /** Threads with an agent at work, or "fails" for a read that fails. */
  readonly runningThreads?: number | "fails";
  readonly attention?: ReadonlyArray<AttentionItem>;
  /** The factory dir; the machine config is `<dir>/config.yml`. */
  readonly dir?: string;
  /** What the loop last read of each repo's project config. */
  readonly readings?: ReadonlyMap<string, RepoConfigReading>;
  /** The T3 projects the loop watches. */
  readonly watched?: ReadonlyArray<WatchedProject>;
  /** The checkouts the reader could not settle. */
  readonly unresolved?: ReadonlyArray<string>;
  /** Listing the T3 projects fails with this cause instead. */
  readonly watchFails?: string;
  /** The clock the routes read; the live one when unset. */
  readonly clock?: Clock.Clock;
  /** Serve the routes behind the server's browser CORS layer. */
  readonly cors?: boolean;
  /** What kickstarting the autodeploy job answers; false (it fails) when unset. */
  readonly kicks?: boolean;
}

/** What the loop was asked to do: `count` wakes, `reloads` config reloads; `kicks` autodeploy kickstarts. */
interface Calls {
  count: number;
  reloads: number;
  kicks: number;
}

const attentionWith = (items: ReadonlyArray<AttentionItem>) =>
  Attention.of({
    list: () => Effect.succeed(items),
    raise: () => Effect.void,
    clear: () => Effect.void,
    passEnded: () => Effect.void,
    setNotify: () => Effect.void,
    dismiss: (ids) =>
      Effect.succeed(items.filter((item) => ids.includes(item.id)).map((item) => item.id)),
  });

const worldContext = (
  auth: EnvironmentAuth.EnvironmentAuth["Service"],
  world: World,
  dir: string,
  wakes: Calls,
  exits: ReturnType<typeof makeExits>,
) => {
  const reload = Effect.sync(() => {
    wakes.reloads += 1;
  });
  const repoConfigs = Effect.succeed(world.readings ?? new Map<string, RepoConfigReading>());
  const watchedRepos =
    world.watchFails === undefined
      ? Effect.succeed<WatchedListing>({
          repos: world.watched ?? [],
          departed: [],
          unresolved: world.unresolved ?? [],
        })
      : Effect.fail(new WatchedReposError({ cause: new Error(world.watchFails) }));
  return Context.make(EnvironmentAuth.EnvironmentAuth, auth).pipe(
    Context.add(DeployKick, {
      kick: Effect.sync(() => {
        wakes.kicks += 1;
        return world.kicks ?? false;
      }),
    }),
    Context.add(
      ServerExitService.ServerExit,
      ServerExitService.make(
        Effect.sync(() => {
          exits.count += 1;
          exits.settle();
        }),
      ),
    ),
    Context.add(
      FactoryLoop,
      FactoryLoop.of({
        wake: Effect.sync(() => {
          wakes.count += 1;
        }),
        awaitPass: Effect.never,
        passRunning: Effect.succeed(world.passRunning ?? false),
        runningThreads:
          world.runningThreads === "fails"
            ? Effect.fail(new SessionsError({ operation: "running-threads", cause: "locked" }))
            : Effect.succeed(world.runningThreads ?? 0),
        status: world.status ?? idle,
        reload,
        // The real save, over a loop that counts its reloads: the loop's own is tested in index.test.ts.
        save: (body) =>
          saveMachineConfig(NodePath.join(dir, "config.yml"), body, {
            reload,
            repoConfigs,
            watchedRepos,
          }).pipe(Effect.provide(NodeServices.layer)),
        repoConfigs,
        watchedRepos,
      }),
    ),
    Context.add(Attention, attentionWith(world.attention ?? [])),
    Context.add(FactoryPaths, {
      baseDir: dir,
      worktreesDir: NodePath.join(dir, "worktrees"),
      factoryDir: dir,
      machineConfigPath: NodePath.join(dir, "config.yml"),
    }),
    (context) =>
      world.clock === undefined ? context : Context.add(context, Clock.Clock, world.clock),
  );
};

/**
 * Runs `use` against the factory's routes behind T3's auth, with a loop reporting the world's
 * status and a factory dir in a temp directory. `wakes` counts the loop's wakes.
 */
const serving = <A>(
  world: World,
  use: (
    call: Call,
    context: {
      readonly tokens: Tokens;
      readonly dir: string;
      readonly wakes: Calls;
      readonly exits: Exits;
      /** The name of the browser session cookie. */
      readonly cookieName: string;
      /** Sends a request as it is, for what `call` cannot shape. */
      readonly send: (request: Request) => Promise<Response>;
    },
  ) => Promise<A>,
) =>
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const { cookieName } = yield* SessionStore.SessionStore;
    const dir = world.dir ?? tempDir("factory");
    const wakes = { count: 0, reloads: 0, kicks: 0 };
    const exits = makeExits();
    const context = worldContext(auth, world, dir, wakes, exits);
    // Issued on the live clock: the handler checks expiry on it, not on the test clock.
    const issue = (scope: AuthEnvironmentScope) =>
      auth.issueSession({ scopes: [scope] }).pipe(
        TestClock.withLive,
        Effect.map((session) => session.token),
      );
    const tokens: Tokens = {
      read: yield* issue(AuthOrchestrationReadScope),
      operate: yield* issue(AuthOrchestrationOperateScope),
      maintain: yield* issue(AuthEnvironmentMaintainScope),
      settingsWrite: yield* issue(AuthSettingsWriteScope),
      accessRead: yield* issue(AuthAccessReadScope),
    };
    return yield* Effect.acquireUseRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(world.cors ? layerRoutesWithCors : layerRoutes, {
          disableLogger: true,
        }),
      ),
      ({ handler }) =>
        Effect.tryPromise(() =>
          use(
            (method, path, token, body) =>
              handler(
                new Request(`http://127.0.0.1${path}`, {
                  method,
                  headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
                  ...(body === undefined
                    ? {}
                    : { body: typeof body === "string" ? body : JSON.stringify(body) }),
                }),
                context,
              ),
            {
              tokens,
              dir,
              wakes,
              exits,
              cookieName,
              send: (request) => handler(request, context),
            },
          ),
        ),
      ({ dispose }) => Effect.promise(dispose),
    );
  }).pipe(Effect.provide(layerEnvironmentAuth));

const idle: FactoryStatus = { state: "idle", reason: "no factory config" };
const running: FactoryStatus = {
  state: "running",
  settings: {
    pollSeconds: 45,
    maxConcurrentRuns: 2,
    deployWaitMinutes: 120,
    repos: ["rawphp/softfac"],
  },
};

const json = async (response: Response) => (await response.json()) as Record<string, unknown>;

const FACTORY_ROUTES = [
  ["GET", "/api/factory/status"],
  ["GET", "/api/factory/runs"],
  ["GET", `/api/factory/runs/${ID}`],
  ["POST", `/api/factory/runs/${ID}/stop`],
  ["POST", "/api/factory/claims/pause"],
  ["POST", "/api/factory/claims/resume"],
  ["POST", "/api/factory/attention/dismiss"],
  ["GET", "/api/factory/config"],
  ["POST", "/api/factory/config"],
  ["POST", "/api/factory/restart"],
  ["POST", "/api/factory/deploy/snooze"],
  ["POST", "/api/factory/deploy/now"],
  ["GET", "/api/factory/auth/clients"],
] as const;

describe("every factory route", () => {
  it("is served at the path the Factory page calls", () => {
    assert.strictEqual(STATUS_PATH, "/api/factory/status");
    assert.strictEqual(CONFIG_PATH, "/api/factory/config");
    assert.strictEqual(CLIENTS_PATH, "/api/factory/auth/clients");
  });

  it.effect.each(FACTORY_ROUTES)("%s %s answers 401 without credentials", ([method, path]) =>
    serving({}, async (call) => {
      const response = await call(method, path);
      assert.strictEqual(response.status, 401);
      assert.strictEqual((await json(response)).code, "auth_invalid");
    }),
  );

  it.effect.each(FACTORY_ROUTES)(
    "%s %s answers 401 for a token that is not a session",
    ([method, path]) =>
      serving({}, async (call) => {
        const response = await call(method, path, "not-a-session-token");
        assert.strictEqual(response.status, 401);
      }),
  );

  it.effect("a GET needs orchestration:read, and a session with only operate is refused", () =>
    serving({}, async (call, { tokens }) => {
      for (const path of [
        "/api/factory/status",
        "/api/factory/runs",
        `/api/factory/runs/${ID}`,
        CONFIG_PATH,
      ]) {
        for (const token of [tokens.operate, tokens.settingsWrite]) {
          const response = await call("GET", path, token);
          assert.strictEqual(response.status, 403, path);
          assert.strictEqual((await json(response)).code, "insufficient_scope");
        }
      }
    }),
  );

  it.effect("a POST needs orchestration:operate, and a session with only read is refused", () =>
    serving({}, async (call, { tokens, wakes, dir, exits }) => {
      seed(dir, run10, BUILDING);
      const bytes = ledgerBytes(dir);
      for (const path of [
        `/api/factory/runs/${ID}/stop`,
        "/api/factory/claims/pause",
        "/api/factory/claims/resume",
        "/api/factory/attention/dismiss",
        "/api/factory/restart",
        "/api/factory/deploy/snooze",
        "/api/factory/deploy/now",
      ]) {
        const response = await call("POST", path, tokens.read);
        assert.strictEqual(response.status, 403, path);
        assert.strictEqual((await json(response)).code, "insufficient_scope");
      }
      assert.strictEqual(ledgerBytes(dir), bytes);
      assert.strictEqual(wakes.count, 0);
      assert.strictEqual(exits.count, 0);
      assert.isFalse(NodeFS.existsSync(NodePath.join(dir, "claims-paused")));
      assert.isFalse(NodeFS.existsSync(NodePath.join(dir, "deploy-snoozed")));
      assert.isFalse(NodeFS.existsSync(NodePath.join(dir, "deploy-now")));
      assert.strictEqual(wakes.kicks, 0);
    }),
  );
});

describe("GET /api/factory/status", () => {
  it.effect("reports an idle factory and why, with the report's keys", () =>
    serving({ status: idle }, async (call, { tokens, dir }) => {
      const response = await call("GET", STATUS_PATH, tokens.read);
      assert.strictEqual(response.status, 200);
      const body = await json(response);
      assert.strictEqual(body.state, "idle");
      assert.strictEqual(body.reason, "no factory config");
      assert.strictEqual(body.version, packageJson.version);
      assert.strictEqual(body.machine, hostName());
      assert.strictEqual(body.machine_config, NodePath.join(dir, "config.yml"));
      assert.strictEqual(body.data_dir, dir);
      assert.deepStrictEqual(Object.keys(body), [
        "state",
        "reason",
        "version",
        "machine_config",
        "machine",
        "data_dir",
        "passes",
        "slots",
        "threads",
        "paused_by_hand",
        "deploy_pending",
        "runs",
        "left_out",
        "problems",
        "attention",
      ]);
      assert.strictEqual((body.passes as { poll_seconds: unknown }).poll_seconds, null);
      assert.deepStrictEqual(body.slots, { used: 0, max: null });
    }),
  );

  it.effect("reports a running factory with its settings, whether a pass runs, and its runs", () =>
    serving({ status: running, passRunning: true }, async (call, { tokens, dir }) => {
      seed(dir, run10, BUILDING);
      const response = await call("GET", STATUS_PATH, tokens.read);
      assert.strictEqual(response.status, 200);
      const body = await json(response);
      assert.strictEqual(body.state, "running");
      assert.strictEqual(body.reason, null);
      const passes = body.passes as { poll_seconds: number; running: boolean };
      assert.strictEqual(passes.poll_seconds, 45);
      assert.isTrue(passes.running);
      assert.strictEqual((body.slots as { max: number }).max, 2);
      assert.deepStrictEqual(
        (body.runs as Array<{ id: string; state: string }>).map((run) => [run.id, run.state]),
        [[ID, "building"]],
      );
    }),
  );

  it.effect("counts the threads with an agent at work, and says null when T3 cannot", () =>
    Effect.gen(function* () {
      yield* serving({ status: running, runningThreads: 2 }, async (call, { tokens }) => {
        const body = await json(await call("GET", STATUS_PATH, tokens.read));
        assert.deepStrictEqual(body.threads, { running: 2 });
      });
      yield* serving({ status: running, runningThreads: "fails" }, async (call, { tokens }) => {
        const response = await call("GET", STATUS_PATH, tokens.read);
        assert.strictEqual(response.status, 200);
        assert.deepStrictEqual((await json(response)).threads, { running: null });
      });
    }),
  );

  it.effect("carries the open attention items", () =>
    serving({ status: running, attention: [attentionItem()] }, async (call, { tokens }) => {
      const body = await json(await call("GET", STATUS_PATH, tokens.read));
      assert.deepStrictEqual(body.attention, [
        {
          id: "stuck:a/b#1",
          kind: "stuck",
          repo: "a/b",
          issue: 1,
          run: "a__b__1__1",
          message: "run went stuck",
          first_seen: formatTs(T0),
        },
      ]);
    }),
  );

  it.effect("answers 500 factory_error when the machine log cannot be read", () =>
    serving({ status: running }, async (call, { tokens, dir }) => {
      NodeFS.writeFileSync(NodePath.join(dir, "real"), "");
      NodeFS.symlinkSync(NodePath.join(dir, "real"), NodePath.join(dir, "events.jsonl"));
      const response = await call("GET", STATUS_PATH, tokens.read);
      assert.strictEqual(response.status, 500);
      assert.strictEqual((await json(response)).code, "factory_error");
    }),
  );
});

describe("the scope a route requires", () => {
  it.effect("answers 403 to a session without it", () =>
    serving({}, async (call, { tokens }) => {
      const response = await call("GET", TEST_ROUTE_PATH, tokens.read);
      assert.strictEqual(response.status, 403);
      assert.strictEqual((await json(response)).code, "insufficient_scope");
    }),
  );

  it.effect("lets a session with it through", () =>
    serving({}, async (call, { tokens }) => {
      const response = await call("GET", TEST_ROUTE_PATH, tokens.settingsWrite);
      assert.strictEqual(response.status, 204);
    }),
  );

  it.effect("the restart route answers 401 without a session, and exits nothing", () =>
    serving({}, async (call, { exits }) => {
      const response = await call("POST", RESTART_PATH);
      assert.strictEqual(response.status, 401);
      assert.strictEqual((await json(response)).code, "auth_invalid");
      assert.strictEqual(exits.count, 0);
    }),
  );

  it.effect("the restart route answers 403 to a session without maintain, and exits nothing", () =>
    serving({}, async (call, { tokens, exits }) => {
      for (const token of [tokens.read, tokens.operate, tokens.settingsWrite]) {
        const response = await call("POST", RESTART_PATH, token);
        assert.strictEqual(response.status, 403);
        assert.strictEqual((await json(response)).code, "insufficient_scope");
      }
      assert.strictEqual(exits.count, 0);
    }),
  );
});

describe("GET /api/factory/auth/clients", () => {
  it.effect("lists every client session in the auth client schema, marking the caller", () =>
    serving({}, async (call, { tokens }) => {
      const response = await call("GET", CLIENTS_PATH, tokens.accessRead);
      assert.strictEqual(response.status, 200);
      const sessions = decodeClientSessions(await response.json());
      assert.strictEqual(sessions.length, Object.keys(tokens).length);
      const current = sessions.filter((session) => session.current);
      assert.strictEqual(current.length, 1);
      assert.include(current[0]!.permissions ?? current[0]!.scopes, AuthAccessReadScope);
    }),
  );

  it.effect("needs access:read, and refuses a session with only orchestration:read", () =>
    serving({}, async (call, { tokens }) => {
      const response = await call("GET", CLIENTS_PATH, tokens.read);
      assert.strictEqual(response.status, 403);
      assert.strictEqual((await json(response)).code, "insufficient_scope");
    }),
  );
});

describe("POST /api/factory/restart", () => {
  it("is served at the path the issue names", () => {
    assert.strictEqual(RESTART_PATH, "/api/factory/restart");
  });

  it.effect("answers 202 before the exit, exits exactly once, and refuses a second request", () =>
    serving({}, async (call, { tokens, exits }) => {
      const response = await call("POST", RESTART_PATH, tokens.maintain);
      assert.strictEqual(response.status, 202);
      const body = await json(response);
      assert.strictEqual(body.restarting, true);
      assert.isTrue(typeof body.message === "string" && body.message.length > 0);
      assert.strictEqual(exits.count, 0, "the response is produced before the exit");

      const again = await call("POST", RESTART_PATH, tokens.maintain);
      assert.strictEqual(again.status, 409);
      assert.strictEqual((await json(again)).code, "restart_pending");

      await exits.done;
      assert.strictEqual(exits.count, 1);

      const late = await call("POST", RESTART_PATH, tokens.maintain);
      assert.strictEqual(late.status, 409);
      assert.strictEqual(exits.count, 1, "a pending restart never exits twice");
    }),
  );
});

describe("a waiting deploy: snooze and update now", () => {
  const SHA = "7a70dadf1e2f3a4b5c6d7e8f901234567890abcd";
  const snoozeFile = (dir: string) => NodePath.join(dir, "deploy-snoozed");
  const nowFile = (dir: string) => NodePath.join(dir, "deploy-now");
  /** `deploy-pending` as autodeploy writes it; its mtime, just now, keeps it fresh. */
  const writePending = (dir: string) =>
    NodeFS.writeFileSync(NodePath.join(dir, "deploy-pending"), `${Math.floor(T0 / 1000)} ${SHA}\n`);

  it.effect(
    "snooze writes an hour from now privately, a second starts it again, a fourth is refused",
    () =>
      Effect.gen(function* () {
        // Before the live clock the sessions are issued on, so they have not expired by it.
        yield* TestClock.setTime(T0);
        return yield* serving({ clock: yield* Clock.Clock }, async (call, { tokens, dir }) => {
          writePending(dir);
          const first = await call("POST", DEPLOY_SNOOZE_PATH, tokens.operate);
          assert.strictEqual(first.status, 200);
          const until = Math.floor(T0 / 1000) + 3600;
          assert.deepStrictEqual(await json(first), { snoozed_until: formatTs(until * 1000) });
          assert.strictEqual(NodeFS.readFileSync(snoozeFile(dir), "utf8"), `${until} 1\n`);
          assert.strictEqual(NodeFS.statSync(snoozeFile(dir)).mode & 0o777, 0o600);

          // A snooze about to end: a second one starts the hour again from now.
          NodeFS.writeFileSync(snoozeFile(dir), `${until - 3500} 1\n`);
          const again = await json(await call("POST", DEPLOY_SNOOZE_PATH, tokens.operate));
          assert.deepStrictEqual(again, { snoozed_until: formatTs(until * 1000) });
          assert.strictEqual(NodeFS.readFileSync(snoozeFile(dir), "utf8"), `${until} 2\n`);

          await call("POST", DEPLOY_SNOOZE_PATH, tokens.operate);
          const fourth = await call("POST", DEPLOY_SNOOZE_PATH, tokens.operate);
          assert.strictEqual(fourth.status, 409);
          assert.strictEqual((await json(fourth)).code, "snooze_limit");
          assert.strictEqual(NodeFS.readFileSync(snoozeFile(dir), "utf8"), `${until} 3\n`);
        });
      }),
  );

  it.effect(
    "a snooze does not undo an update now for the same build, and withdraws an older one",
    () =>
      serving({}, async (call, { tokens, dir }) => {
        writePending(dir);
        await call("POST", DEPLOY_NOW_PATH, tokens.maintain);
        const refused = await call("POST", DEPLOY_SNOOZE_PATH, tokens.operate);
        assert.strictEqual(refused.status, 409);
        assert.strictEqual((await json(refused)).code, "deploy_now_requested");
        assert.strictEqual(NodeFS.readFileSync(nowFile(dir), "utf8"), `${SHA}\n`);
        assert.isFalse(NodeFS.existsSync(snoozeFile(dir)));

        NodeFS.writeFileSync(nowFile(dir), `${"1".repeat(40)}\n`);
        assert.strictEqual((await call("POST", DEPLOY_SNOOZE_PATH, tokens.operate)).status, 200);
        assert.isFalse(NodeFS.existsSync(nowFile(dir)));
      }),
  );

  it.effect(
    "snooze and update now refuse a build that is no longer the one waiting, and write and kick nothing",
    () =>
      serving({}, async (call, { tokens, dir, wakes }) => {
        writePending(dir);
        const older = { commit: "1".repeat(40) };
        for (const [path, token] of [
          [DEPLOY_NOW_PATH, tokens.maintain],
          [DEPLOY_SNOOZE_PATH, tokens.operate],
        ] as const) {
          const response = await call("POST", path, token, older);
          assert.strictEqual(response.status, 409, path);
          assert.strictEqual((await json(response)).code, "deploy_changed");
        }
        assert.isFalse(NodeFS.existsSync(nowFile(dir)));
        assert.isFalse(NodeFS.existsSync(snoozeFile(dir)));
        assert.strictEqual(wakes.kicks, 0);

        const shown = { commit: SHA };
        assert.strictEqual(
          (await call("POST", DEPLOY_SNOOZE_PATH, tokens.operate, shown)).status,
          200,
        );
        assert.strictEqual(
          (await call("POST", DEPLOY_NOW_PATH, tokens.maintain, shown)).status,
          202,
        );
        assert.strictEqual(NodeFS.readFileSync(nowFile(dir), "utf8"), `${SHA}\n`);
      }),
  );

  it.effect("the status shows a snoozed build", () =>
    serving({ status: running }, async (call, { tokens, dir }) => {
      writePending(dir);
      const snoozed = await json(await call("POST", DEPLOY_SNOOZE_PATH, tokens.operate));
      const status = await json(await call("GET", STATUS_PATH, tokens.read));
      const pending = status.deploy_pending as Record<string, unknown>;
      assert.strictEqual(pending.commit, SHA);
      assert.strictEqual(pending.snoozed_until, snoozed.snoozed_until);
      assert.isNull(pending.deploy_by);
    }),
  );

  it.effect(
    "snooze and update now answer 409 when no build is waiting, and write and kick nothing",
    () =>
      serving({}, async (call, { tokens, dir, wakes }) => {
        for (const [path, token] of [
          [DEPLOY_NOW_PATH, tokens.maintain],
          [DEPLOY_SNOOZE_PATH, tokens.operate],
        ] as const) {
          const response = await call("POST", path, token);
          assert.strictEqual(response.status, 409, path);
          assert.strictEqual((await json(response)).code, "no_deploy_pending");
        }
        assert.isFalse(NodeFS.existsSync(nowFile(dir)));
        assert.isFalse(NodeFS.existsSync(snoozeFile(dir)));
        assert.strictEqual(wakes.kicks, 0);
      }),
  );

  it.effect(
    "update now asks autodeploy to install the build shown, ends a snooze, and a failed kick is no error",
    () =>
      serving({}, async (call, { tokens, dir, wakes }) => {
        writePending(dir);
        await call("POST", DEPLOY_SNOOZE_PATH, tokens.operate);
        const response = await call("POST", DEPLOY_NOW_PATH, tokens.maintain);
        assert.strictEqual(response.status, 202);
        const body = await json(response);
        assert.strictEqual(body.commit, SHA);
        assert.strictEqual(body.kicked, false);
        assert.include(String(body.message), "next autodeploy tick");
        assert.strictEqual(NodeFS.readFileSync(nowFile(dir), "utf8"), `${SHA}\n`);
        const status = await json(await call("GET", STATUS_PATH, tokens.read));
        assert.isNull((status.deploy_pending as Record<string, unknown>).snoozed_until);
        // The snooze ended, but it still counts against the limit.
        assert.match(NodeFS.readFileSync(snoozeFile(dir), "utf8"), / 1\n$/);
        assert.strictEqual(wakes.kicks, 1);
      }),
  );

  it.effect("update now says so when the kick started the tick", () =>
    serving({ kicks: true }, async (call, { tokens, dir }) => {
      writePending(dir);
      const body = await json(await call("POST", DEPLOY_NOW_PATH, tokens.maintain));
      assert.strictEqual(body.kicked, true);
    }),
  );

  it.effect("update now needs environment:maintain", () =>
    serving({}, async (call, { tokens, dir, wakes }) => {
      writePending(dir);
      const response = await call("POST", DEPLOY_NOW_PATH, tokens.operate);
      assert.strictEqual(response.status, 403);
      assert.isFalse(NodeFS.existsSync(nowFile(dir)));
      assert.strictEqual(wakes.kicks, 0);
    }),
  );
});

describe("GET /api/factory/runs", () => {
  it.effect("is an empty list for an empty ledger", () =>
    serving({}, async (call, { tokens }) => {
      const response = await call("GET", "/api/factory/runs", tokens.read);
      assert.strictEqual(response.status, 200);
      assert.deepStrictEqual(await response.json(), { runs: [] });
    }),
  );

  it.effect("lists every run oldest first with the word runs list gives its status", () =>
    serving({}, async (call, { tokens, dir }) => {
      seed(dir, run12, [...BUILDING, FINISHED], T0 + 20_000);
      seed(dir, run10, [...BUILDING, stepped("gate-passed")], T0);
      seed(
        dir,
        run11,
        [
          CLAIMED,
          moved("ready", "triage"),
          moved("triage", "building"),
          moved("building", "pr-open"),
        ],
        T0 + 10_000,
      );
      const body = (await json(await call("GET", "/api/factory/runs", tokens.read))) as {
        runs: Array<Record<string, unknown>>;
      };
      assert.deepStrictEqual(
        body.runs.map((run) => [run.id, run.state, run.status, run.finished, run.last_event]),
        [
          [ID, "building", "running", false, "step_changed"],
          [runIdToString(run11), "pr-open", "watching", false, "state_changed"],
          [runIdToString(run12), "building", "finished", true, "finished"],
        ],
      );
      assert.deepStrictEqual(Object.keys(body.runs[0]!), [
        "id",
        "started_ts",
        "state",
        "last_event",
        "step",
        "status",
        "pr_url",
        "pr_end",
        "finished",
        "total_ms",
        "unreadable",
        "title",
        "reason",
      ]);
      assert.deepStrictEqual(
        body.runs.map((run) => run.step),
        ["gate-passed", null, null],
      );
      assert.deepStrictEqual(
        body.runs.map((run) => [run.title, run.reason]),
        [
          [null, null],
          [null, null],
          [null, null],
        ],
      );
      assert.strictEqual(body.runs[0]!.started_ts, formatTs(T0 + 1000));
      assert.strictEqual(body.runs[0]!.unreadable, false);
    }),
  );

  it.effect("serves the issue title a run launched with and why a stopped run waits", () =>
    serving({}, async (call, { tokens, dir }) => {
      const launched = (title?: string): RunEvent =>
        ({
          event: "session_launched",
          data: {
            thread_id: "thr_1",
            worktree: null,
            branch: null,
            model_instance: null,
            model: null,
            model_options: null,
            resumed_from: null,
            base: "main",
            ...(title === undefined ? {} : { title }),
          },
        }) as RunEvent;
      seed(
        dir,
        run10,
        [
          ...BUILDING,
          launched("Fix the login"),
          { event: "stuck", data: { reason: "gate failed" } },
          moved("building", "stuck"),
        ],
        T0,
      );
      seed(
        dir,
        run11,
        [
          CLAIMED,
          launched(),
          { event: "questions_posted", data: { questions: "which db?" } },
          moved("triage", "needs-info"),
        ],
        T0 + 10_000,
      );
      const body = (await json(await call("GET", "/api/factory/runs", tokens.read))) as {
        runs: Array<Record<string, unknown>>;
      };
      assert.deepStrictEqual(
        body.runs.map((run) => [run.id, run.state, run.title, run.reason]),
        [
          [ID, "stuck", "Fix the login", "gate failed"],
          [runIdToString(run11), "needs-info", null, "which db?"],
        ],
      );
    }),
  );

  const LONG_AGO_S = 1_577_836_800; // 2020-01-01

  it.effect("leaves out finished runs older than a week unless asked for all", () =>
    serving({}, async (call, { tokens, dir }) => {
      seed(dir, run10, [...BUILDING, FINISHED], T0);
      seed(dir, run11, BUILDING, T0 + 10_000);
      seed(dir, run12, [...BUILDING, FINISHED], T0 + 20_000);
      // Years before the live clock the routes read here.
      const longAgo = (id: RunId) => NodeFS.utimesSync(runPath(dir, id), LONG_AGO_S, LONG_AGO_S);
      longAgo(run10);
      longAgo(run11);
      const ids = async (path: string) =>
        (
          (await json(await call("GET", path, tokens.read))) as { runs: Array<{ id: string }> }
        ).runs.map((run) => run.id);
      assert.deepStrictEqual(await ids("/api/factory/runs"), [
        runIdToString(run11),
        runIdToString(run12),
      ]);
      assert.deepStrictEqual(await ids("/api/factory/runs?all=1"), [
        ID,
        runIdToString(run11),
        runIdToString(run12),
      ]);
    }),
  );

  it.effect("lists a run file that cannot be read as unreadable", () =>
    serving({}, async (call, { tokens, dir }) => {
      seed(dir, run10, BUILDING);
      // A regular file over the 2 GiB a Node read allows: it fails at once, whoever runs the test.
      const broken = NodePath.join(dir, "runs", "rawphp__broken__2__1.jsonl");
      NodeFS.writeFileSync(broken, "");
      NodeFS.truncateSync(broken, 3 * 2 ** 30);
      const body = (await json(await call("GET", "/api/factory/runs", tokens.read))) as {
        runs: Array<Record<string, unknown>>;
      };
      assert.deepStrictEqual(
        body.runs.map((run) => [run.id, run.status, run.unreadable]),
        [
          [ID, "running", false],
          ["rawphp__broken__2__1", "unreadable", true],
        ],
      );
    }),
  );
});

describe("GET /api/factory/runs/:id", () => {
  it.effect("shows each entry with its time, event, data and cause", () =>
    serving({}, async (call, { tokens, dir }) => {
      seed(dir, run10, BUILDING);
      const response = await call("GET", `/api/factory/runs/${ID}`, tokens.read);
      assert.strictEqual(response.status, 200);
      const body = (await json(response)) as {
        id: string;
        entries: Array<Record<string, unknown>>;
        truncated: boolean;
        skipped: number;
      };
      assert.strictEqual(body.id, ID);
      assert.deepStrictEqual(
        body.entries.map((entry) => entry.event),
        ["claimed", "state_changed", "state_changed"],
      );
      assert.deepStrictEqual(body.entries[0], {
        ts: formatTs(T0 + 1000),
        ms: T0 + 1000,
        event: "claimed",
        data: { machine: "mac-mini", github_user: "rawphp" },
        cause: { step: "start", reason: "seed" },
      });
      assert.strictEqual(body.truncated, false);
      assert.strictEqual(body.skipped, 0);
    }),
  );

  it.effect("counts the damaged lines it skips", () =>
    serving({}, async (call, { tokens, dir }) => {
      seed(dir, run10, BUILDING);
      const path = runPath(dir, run10);
      const lines = NodeFS.readFileSync(path, "utf8").split("\n");
      // One damaged line in the middle, and a last line cut off.
      NodeFS.writeFileSync(
        path,
        [lines[0], "not json", lines[1], lines[2], '{"ts":"2026-10-0'].join("\n"),
      );
      const body = (await json(await call("GET", `/api/factory/runs/${ID}`, tokens.read))) as {
        entries: Array<unknown>;
        truncated: boolean;
        skipped: number;
      };
      assert.strictEqual(body.entries.length, 3);
      assert.strictEqual(body.skipped, 1);
      assert.isTrue(body.truncated);
    }),
  );

  it.effect("answers 404 run_not_found for a run with no ledger", () =>
    serving({}, async (call, { tokens }) => {
      const response = await call("GET", `/api/factory/runs/${ID}`, tokens.read);
      assert.strictEqual(response.status, 404);
      assert.deepStrictEqual(await response.json(), {
        code: "run_not_found",
        id: ID,
        message: `no run ${ID}`,
      });
    }),
  );

  it.effect("answers 400 invalid_run_id for an id that could reach another file", () =>
    serving({}, async (call, { tokens, dir }) => {
      for (const id of ["..%2F..%2Fetc%2Fpasswd", "a%2Fb", "not-a-run", "x__y__1__01"]) {
        const response = await call("GET", `/api/factory/runs/${id}`, tokens.read);
        assert.strictEqual(response.status, 400, id);
        const body = await json(response);
        assert.strictEqual(body.code, "invalid_run_id");
        assert.isString(body.message);
      }
      assert.isFalse(NodeFS.existsSync(NodePath.join(dir, "runs")));
    }),
  );

  it.effect("answers 404 for a symlink named like a run and shows nothing from its target", () =>
    serving({}, async (call, { tokens, dir }) => {
      const target = NodePath.join(dir, "secret.txt");
      NodeFS.writeFileSync(target, '{"ts":"x","ms":1,"event":"leaked","data":null}\n');
      NodeFS.mkdirSync(NodePath.join(dir, "runs"));
      NodeFS.symlinkSync(target, runPath(dir, run10));
      const response = await call("GET", `/api/factory/runs/${ID}`, tokens.read);
      assert.strictEqual(response.status, 404);
      assert.notInclude(await response.text(), "leaked");
    }),
  );
});

describe("POST /api/factory/runs/:id/stop", () => {
  const stop = (call: Call, token: string, id = ID) =>
    call("POST", `/api/factory/runs/${id}/stop`, token);

  it.effect("leaves a stop request for a building run once, and wakes the loop", () =>
    serving({}, async (call, { tokens, dir, wakes }) => {
      seed(dir, run10, BUILDING);
      const bytes = ledgerBytes(dir);
      const response = await stop(call, tokens.operate);
      assert.strictEqual(response.status, 200);
      assert.deepStrictEqual(await response.json(), {
        stopped: ID,
        already: false,
        message: `stop requested: ${ID}; the issue goes to factory:stuck on the next pass`,
      });
      const request = stopRequestPath(dir, run10);
      assert.strictEqual(NodeFS.readFileSync(request, "utf8"), "operator\n");
      assert.strictEqual(ledgerBytes(dir), bytes, "the route writes no ledger line");
      assert.strictEqual(wakes.count, 1);

      const again = await stop(call, tokens.operate);
      assert.strictEqual(again.status, 200);
      assert.deepStrictEqual(await again.json(), {
        stopped: ID,
        already: true,
        message: `stop already requested: ${ID}; the issue goes to factory:stuck on the next pass`,
      });
      assert.strictEqual(NodeFS.readFileSync(request, "utf8"), "operator\n");
      assert.strictEqual(ledgerBytes(dir), bytes, "still no ledger line");
      assert.strictEqual(wakes.count, 1, "no second wake");
    }),
  );

  it.effect("refuses a run that left building with a stale stop line, and wakes nothing", () =>
    serving({}, async (call, { tokens, dir, wakes }) => {
      seed(dir, run10, [
        ...BUILDING,
        { event: "stop_requested", data: { by: "operator" } },
        moved("building", "pr-open"),
      ]);
      const response = await stop(call, tokens.operate);
      assert.strictEqual(response.status, 409);
      assert.strictEqual((await json(response)).code, "not_building");
      assert.isFalse(NodeFS.existsSync(stopRequestPath(dir, run10)));
      assert.strictEqual(wakes.count, 0);
    }),
  );

  it.effect("refuses a run waiting on its pull request, and says how it ends", () =>
    serving({}, async (call, { tokens, dir, wakes }) => {
      seed(dir, run10, [...BUILDING, moved("building", "pr-open")]);
      const bytes = ledgerBytes(dir);
      const response = await stop(call, tokens.operate);
      assert.strictEqual(response.status, 409);
      assert.deepStrictEqual(await response.json(), {
        code: "not_building",
        message: `run ${ID} is not building: its state is pr-open. Only a building run is stopped this way. It ends when its pull request is merged or closed.`,
      });
      assert.strictEqual(ledgerBytes(dir), bytes);
      assert.strictEqual(wakes.count, 0);
    }),
  );

  it.effect("refuses a finished run", () =>
    serving({}, async (call, { tokens, dir }) => {
      seed(dir, run10, [...BUILDING, FINISHED]);
      const response = await stop(call, tokens.operate);
      assert.strictEqual(response.status, 409);
      assert.deepStrictEqual(await response.json(), {
        code: "not_building",
        message: `run ${ID} is not building: it is finished. Only a building run is stopped this way.`,
      });
    }),
  );

  it.effect("refuses a run in triage, and says to close its issue", () =>
    serving({}, async (call, { tokens, dir }) => {
      seed(dir, run10, [CLAIMED, moved("ready", "triage")]);
      const response = await stop(call, tokens.operate);
      assert.strictEqual(response.status, 409);
      assert.include(
        ((await json(response)).message as string) ?? "",
        "To end it, close its issue.",
      );
    }),
  );

  it.effect("answers 500 factory_error and wakes nothing when the request cannot be written", () =>
    serving({}, async (call, { tokens, dir, wakes }) => {
      seed(dir, run10, BUILDING);
      NodeFS.writeFileSync(NodePath.join(dir, "stop-requests"), "");
      const response = await stop(call, tokens.operate);
      assert.strictEqual(response.status, 500);
      assert.strictEqual((await json(response)).code, "factory_error");
      assert.strictEqual(wakes.count, 0);
    }),
  );

  // Root writes into a read-only directory, so the failure cannot be set up that way as root.
  it.effect.skipIf(process.getuid?.() === 0)(
    "answers 500 factory_error, wakes nothing and leaves no request when the write is refused",
    () =>
      serving({}, async (call, { tokens, dir, wakes }) => {
        seed(dir, run10, BUILDING);
        const requests = NodePath.join(dir, "stop-requests");
        NodeFS.mkdirSync(requests);
        NodeFS.chmodSync(requests, 0o500);
        try {
          const response = await stop(call, tokens.operate);
          assert.strictEqual(response.status, 500);
          assert.strictEqual((await json(response)).code, "factory_error");
          assert.strictEqual(wakes.count, 0);
          assert.isFalse(NodeFS.existsSync(stopRequestPath(dir, run10)));
        } finally {
          NodeFS.chmodSync(requests, 0o700);
        }
      }),
  );

  it.effect("answers 404 for an unknown run and 400 for a bad id", () =>
    serving({}, async (call, { tokens, wakes }) => {
      const unknown = await stop(call, tokens.operate);
      assert.strictEqual(unknown.status, 404);
      assert.deepStrictEqual(await unknown.json(), {
        code: "run_not_found",
        id: ID,
        message: `no run ${ID}`,
      });
      const bad = await stop(call, tokens.operate, "..%2F..%2Fetc%2Fpasswd");
      assert.strictEqual(bad.status, 400);
      assert.strictEqual((await json(bad)).code, "invalid_run_id");
      assert.strictEqual(wakes.count, 0);
    }),
  );
});

describe("claims pause and resume", () => {
  const pauseFile = (dir: string) => NodePath.join(dir, "claims-paused");

  it.effect("pause writes the time privately, and again keeps the first", () =>
    Effect.gen(function* () {
      // Before the live clock the sessions are issued on, so they have not expired by it.
      yield* TestClock.setTime(T0);
      return yield* serving({ clock: yield* Clock.Clock }, async (call, { tokens, dir }) => {
        const response = await call("POST", "/api/factory/claims/pause", tokens.operate);
        assert.strictEqual(response.status, 200);
        const body = await json(response);
        assert.deepStrictEqual(body, {
          paused: true,
          already: false,
          since: formatTs(T0),
          message: "claims paused",
        });
        assert.strictEqual(NodeFS.readFileSync(pauseFile(dir), "utf8"), `${body.since}\n`);
        assert.strictEqual(NodeFS.statSync(pauseFile(dir)).mode & 0o777, 0o600);

        const again = await json(await call("POST", "/api/factory/claims/pause", tokens.operate));
        assert.deepStrictEqual(again, {
          paused: true,
          already: true,
          since: body.since,
          message: `claims already paused since ${String(body.since)}`,
        });
        assert.strictEqual(NodeFS.readFileSync(pauseFile(dir), "utf8"), `${body.since}\n`);
      });
    }),
  );

  it.effect("the status shows the pause, and resume removes it", () =>
    serving({ status: running }, async (call, { tokens, dir }) => {
      await call("POST", "/api/factory/claims/pause", tokens.operate);
      const paused = await json(await call("GET", STATUS_PATH, tokens.read));
      assert.isNotNull(paused.paused_by_hand);

      const resumed = await call("POST", "/api/factory/claims/resume", tokens.operate);
      assert.strictEqual(resumed.status, 200);
      assert.deepStrictEqual(await resumed.json(), {
        paused: false,
        already: false,
        message: "claims resumed",
      });
      assert.isFalse(NodeFS.existsSync(pauseFile(dir)));
      assert.isNull((await json(await call("GET", STATUS_PATH, tokens.read))).paused_by_hand);

      const again = await call("POST", "/api/factory/claims/resume", tokens.operate);
      assert.strictEqual(again.status, 200);
      assert.deepStrictEqual(await again.json(), {
        paused: false,
        already: true,
        message: "claims were not paused",
      });
    }),
  );

  it.effect("answers 500 factory_error when the factory dir cannot be written", () =>
    serving({ dir: NodePath.join(tempDir("missing"), "nope") }, async (call, { tokens }) => {
      const response = await call("POST", "/api/factory/claims/pause", tokens.operate);
      assert.strictEqual(response.status, 500);
      assert.strictEqual((await json(response)).code, "factory_error");
    }),
  );
});

describe("POST /api/factory/attention/dismiss", () => {
  it("is served at the path the Factory page calls", () => {
    assert.strictEqual(DISMISS_PATH, "/api/factory/attention/dismiss");
  });

  it.effect("answers 200 with the ids it dismissed, ignoring ids that are not open", () =>
    serving({ attention: [attentionItem()] }, async (call, { tokens }) => {
      const response = await call("POST", DISMISS_PATH, tokens.operate, {
        ids: ["stuck:a/b#1", "gone"],
      });
      assert.strictEqual(response.status, 200);
      assert.deepStrictEqual(await response.json(), { dismissed: ["stuck:a/b#1"] });
    }),
  );

  it.effect("answers 400 invalid_body without an ids array of strings", () =>
    serving({ attention: [attentionItem()] }, async (call, { tokens }) => {
      for (const body of ["{not json", {}, { ids: "stuck:a/b#1" }, { ids: [1] }, ["x"]]) {
        const response = await call("POST", DISMISS_PATH, tokens.operate, body);
        assert.strictEqual(response.status, 400, JSON.stringify(body));
        assert.strictEqual((await json(response)).code, "invalid_body");
      }
    }),
  );
});

describe("an auth failure inside T3", () => {
  it.effect("answers 500 internal_error, not 401, and never runs the handler", () => {
    let handled = false;
    const failingRoute = route(
      "GET",
      "/api/factory/test/internal",
      AuthOrchestrationReadScope,
      Effect.sync(() => {
        handled = true;
        return HttpServerResponse.empty({ status: 204 });
      }),
    );
    return Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const context = worldContext(
        {
          ...auth,
          authenticateHttpRequest: () =>
            Effect.fail(
              new EnvironmentAuth.ServerAuthSessionCredentialValidationError({
                cause: new Error("session store unreadable"),
              }),
            ),
        },
        {},
        tempDir("factory"),
        { count: 0, reloads: 0, kicks: 0 },
        makeExits(),
      );
      const layer = failingRoute.pipe(Layer.provideMerge(layerRoutes));
      const response = yield* Effect.acquireUseRelease(
        Effect.sync(() => HttpRouter.toWebHandler(layer, { disableLogger: true })),
        ({ handler }) =>
          Effect.promise(() =>
            handler(new Request("http://127.0.0.1/api/factory/test/internal"), context),
          ),
        ({ dispose }) => Effect.promise(dispose),
      );
      assert.strictEqual(response.status, 500);
      const body = (yield* Effect.promise(() => response.json())) as { code: string };
      assert.strictEqual(body.code, "internal_error");
      assert.isFalse(handled);
    }).pipe(Effect.provide(layerEnvironmentAuth));
  });
});

describe("/api/factory/config", () => {
  const COMMENTED = `# the factory on this machine
gh_config_dir: /gh # login
poll_seconds: 60
max_concurrent_runs: 1
# stays a hand edit
notify: false
# retired by #106, and kept as written
repos:
  - repo: rawphp/softfac
    path: /softfac
`;
  const DEFAULTS = {
    gh_config_dir: "",
    poll_seconds: 60,
    max_concurrent_runs: 1,
    max_concurrent_gates: 2,
    feedback_seconds: 600,
  };
  const configFile = (dir: string) => NodePath.join(dir, "config.yml");
  const fileText = (dir: string) => NodeFS.readFileSync(configFile(dir), "utf8");
  const VALID_BODY = {
    gh_config_dir: "/gh",
    poll_seconds: 30,
    max_concurrent_runs: 2,
    max_concurrent_gates: 2,
    feedback_seconds: 120,
  };

  it.effect(
    "GET answers a listing that failed as watch_error, still 200 with the file's values",
    () =>
      serving({ watchFails: "project store down" }, async (call, { tokens, dir }) => {
        NodeFS.writeFileSync(configFile(dir), COMMENTED);
        const response = await call("GET", CONFIG_PATH, tokens.read);
        assert.strictEqual(response.status, 200);
        const body = await json(response);
        assert.strictEqual(body.watch_error, "cannot list the T3 projects: project store down");
        assert.deepStrictEqual(body.repos, []);
        assert.deepStrictEqual(body.unresolved, []);
        assert.strictEqual((body.config as { poll_seconds: number }).poll_seconds, 60);
      }),
  );

  it.effect("GET names the checkouts the reader could not settle", () =>
    serving({ unresolved: ["/slow"] }, async (call, { tokens, dir }) => {
      NodeFS.writeFileSync(configFile(dir), COMMENTED);
      const body = await json(await call("GET", CONFIG_PATH, tokens.read));
      assert.deepStrictEqual(body.unresolved, ["/slow"]);
      assert.strictEqual(body.watch_error, null);
    }),
  );

  it.effect("GET reports a commented file: its values, and that it exists", () =>
    serving({}, async (call, { tokens, dir }) => {
      NodeFS.writeFileSync(configFile(dir), COMMENTED);
      const response = await call("GET", CONFIG_PATH, tokens.read);
      assert.strictEqual(response.status, 200);
      assert.deepStrictEqual(await json(response), {
        file: configFile(dir),
        exists: true,
        config: {
          gh_config_dir: "/gh",
          poll_seconds: 60,
          max_concurrent_runs: 1,
          max_concurrent_gates: 2,
          feedback_seconds: 600,
        },
        defaults: DEFAULTS,
        errors: [],
        repos: [],
        unresolved: [],
        watch_error: null,
      });
    }),
  );

  it.effect("GET with no file reports exists false and the defaults", () =>
    serving({}, async (call, { tokens, dir }) => {
      const body = await json(await call("GET", CONFIG_PATH, tokens.read));
      assert.strictEqual(body.exists, false);
      assert.strictEqual(body.file, configFile(dir));
      assert.deepStrictEqual(body.config, DEFAULTS);
      assert.deepStrictEqual(body.defaults, DEFAULTS);
      assert.deepStrictEqual(body.errors, []);
    }),
  );

  it.effect("GET on an invalid file reports no config and the errors", () =>
    serving({}, async (call, { tokens, dir }) => {
      NodeFS.writeFileSync(configFile(dir), COMMENTED.replace("max_concurrent_runs: 1\n", ""));
      const body = await json(await call("GET", CONFIG_PATH, tokens.read));
      assert.strictEqual(body.exists, true);
      assert.strictEqual(body.config, null);
      assert.deepStrictEqual(body.draft, {
        gh_config_dir: "/gh",
        poll_seconds: 60,
      });
      assert.deepStrictEqual(body.errors, [
        { file: configFile(dir), field: "max_concurrent_runs", message: "is missing" },
      ]);
    }),
  );

  const project = {
    instructors: ["i"],
    base: "main",
    provision: [],
    gate: ["g"],
    requiredChecks: ["ci"],
    limits: { minutes: 5, gateRetries: 1, checksMinutes: 3, interruptionResumes: 4 },
    autonomy: "pr",
    owner: null,
  } as const;

  it.effect("GET lists the watched projects, each with what the loop last read of it", () =>
    serving(
      {
        watched: [
          { repo: "rawphp/softfac", path: "/softfac", title: "Softfac" },
          { repo: "a/b", path: "/b", title: "Bee" },
          { repo: "c/d", path: "/d", title: "Dee" },
        ],
        readings: new Map<string, RepoConfigReading>([
          ["rawphp/softfac", { kind: "ok", project }],
          ["a/b", { kind: "errors", errors: [{ file: ".dw/config.yml", message: "cannot read" }] }],
        ]),
      },
      async (call, { tokens, dir }) => {
        NodeFS.writeFileSync(configFile(dir), COMMENTED);
        const body = await json(await call("GET", CONFIG_PATH, tokens.read));
        assert.deepStrictEqual(body.repos, [
          {
            repo: "rawphp/softfac",
            path: "/softfac",
            title: "Softfac",
            default_config: false,
            factory: {
              instructors: ["i"],
              base: "main",
              provision: [],
              gate: ["g"],
              required_checks: ["ci"],
              limits: {
                minutes: 5,
                gate_retries: 1,
                checks_minutes: 3,
                interruption_resumes: 4,
              },
              autonomy: "pr",
            },
            errors: null,
          },
          {
            repo: "a/b",
            path: "/b",
            title: "Bee",
            default_config: false,
            factory: null,
            errors: [{ file: ".dw/config.yml", message: "cannot read" }],
          },
          {
            repo: "c/d",
            path: "/d",
            title: "Dee",
            default_config: false,
            factory: null,
            errors: null,
          },
        ]);
      },
    ),
  );

  it.effect(
    "POST needs settings:write: read and operate sessions are refused, file untouched",
    () =>
      serving({}, async (call, { tokens, dir, wakes }) => {
        NodeFS.writeFileSync(configFile(dir), COMMENTED);
        for (const token of [tokens.read, tokens.operate]) {
          const response = await call("POST", CONFIG_PATH, token, VALID_BODY);
          assert.strictEqual(response.status, 403);
          assert.strictEqual((await json(response)).code, "insufficient_scope");
        }
        assert.strictEqual(fileText(dir), COMMENTED);
        assert.strictEqual(wakes.reloads, 0);
      }),
  );

  it.effect(
    "POST with an invalid body answers 422 with a field on each error and writes nothing",
    () =>
      serving({}, async (call, { tokens, dir, wakes }) => {
        NodeFS.writeFileSync(configFile(dir), COMMENTED);
        const response = await call("POST", CONFIG_PATH, tokens.settingsWrite, {
          poll_seconds: 5,
          gh_config_dir: "",
        });
        assert.strictEqual(response.status, 422);
        const body = await json(response);
        assert.strictEqual(body.code, "invalid_config");
        const errors = body.errors as ReadonlyArray<{ field?: string }>;
        assert.deepStrictEqual(errors.map((e) => e.field).sort(), [
          "gh_config_dir",
          "poll_seconds",
        ]);
        assert.strictEqual(fileText(dir), COMMENTED);
        assert.strictEqual(wakes.reloads, 0);
        assert.deepStrictEqual(NodeFS.readdirSync(dir), ["config.yml"]);
      }),
  );

  it.effect("POST with a body that is not a JSON object answers 400", () =>
    serving({}, async (call, { tokens, dir, wakes }) => {
      for (const body of ["not json", "[1]", "null", '"x"']) {
        const response = await call("POST", CONFIG_PATH, tokens.settingsWrite, body);
        assert.strictEqual(response.status, 400, body);
        assert.strictEqual((await json(response)).code, "invalid_body");
      }
      assert.isFalse(NodeFS.existsSync(configFile(dir)));
      assert.strictEqual(wakes.reloads, 0);
    }),
  );

  it.effect("POST on a missing file creates it, reloads the loop and answers the new report", () =>
    serving({}, async (call, { tokens, dir, wakes }) => {
      const response = await call("POST", CONFIG_PATH, tokens.settingsWrite, VALID_BODY);
      assert.strictEqual(response.status, 200);
      const body = await json(response);
      assert.strictEqual(body.exists, true);
      assert.deepStrictEqual(body.config, VALID_BODY);
      assert.strictEqual(wakes.reloads, 1);
      assert.include(fileText(dir), "poll_seconds: 30");
      assert.deepStrictEqual(NodeFS.readdirSync(dir), ["config.yml"]);
    }),
  );

  it.effect("POST keeps the comments and the keys the form does not edit", () =>
    serving({}, async (call, { tokens, dir }) => {
      NodeFS.writeFileSync(configFile(dir), COMMENTED);
      const response = await call("POST", CONFIG_PATH, tokens.settingsWrite, { poll_seconds: 90 });
      assert.strictEqual(response.status, 200);
      const text = fileText(dir);
      assert.include(text, "# the factory on this machine");
      assert.include(text, "# login");
      assert.include(text, "# stays a hand edit\nnotify: false");
      assert.include(
        text,
        "# retired by #106, and kept as written\nrepos:\n  - repo: rawphp/softfac",
      );
      assert.include(text, "poll_seconds: 90");
    }),
  );
  it.effect(
    "PUT is not served: the save is POST, the one method CORS lets a remote client send",
    () =>
      serving({}, async (call, { tokens, dir, wakes }) => {
        const response = await call("PUT", CONFIG_PATH, tokens.settingsWrite, VALID_BODY);
        assert.strictEqual(response.status, 404);
        assert.isFalse(NodeFS.existsSync(configFile(dir)));
        assert.strictEqual(wakes.reloads, 0);
      }),
  );

  it.effect("a remote client's preflight for the save is allowed, and the save then answers", () =>
    serving({ cors: true }, async (_call, { tokens, send }) => {
      const preflight = await send(
        new Request(`https://backend.example${CONFIG_PATH}`, {
          method: "OPTIONS",
          headers: {
            origin: "https://app.t3.codes",
            "access-control-request-method": "POST",
            "access-control-request-headers": "authorization, content-type",
          },
        }),
      );
      assert.strictEqual(preflight.status, 204);
      const allowed = (preflight.headers.get("access-control-allow-methods") ?? "")
        .split(",")
        .map((method) => method.trim());
      assert.include(allowed, "POST");
      const response = await send(
        new Request(`https://backend.example${CONFIG_PATH}`, {
          method: "POST",
          headers: {
            origin: "https://app.t3.codes",
            authorization: `Bearer ${tokens.settingsWrite}`,
          },
          body: JSON.stringify(VALID_BODY),
        }),
      );
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.headers.get("access-control-allow-origin"), "*");
    }),
  );

  // A POST that is a plain form submit needs no preflight, so the browser sends it, cookie and all,
  // from any page on the same site. Only the session's origin check stops it.
  it.effect(
    "a browser session's save from another origin is refused, from its own it answers",
    () =>
      serving({ cors: true }, async (_call, { tokens, dir, wakes, cookieName, send }) => {
        const formPost = (origin: string) =>
          send(
            new Request(`http://127.0.0.1:3773${CONFIG_PATH}`, {
              method: "POST",
              headers: {
                host: "127.0.0.1:3773",
                origin,
                cookie: `${cookieName}=${tokens.settingsWrite}`,
                "content-type": "text/plain",
              },
              body: JSON.stringify(VALID_BODY),
            }),
          );
        const foreign = await formPost("http://127.0.0.1:3000");
        assert.strictEqual(foreign.status, 401);
        assert.isFalse(NodeFS.existsSync(configFile(dir)));
        assert.strictEqual(wakes.reloads, 0);
        const own = await formPost("http://127.0.0.1:3773");
        assert.strictEqual(own.status, 200);
        assert.strictEqual(wakes.reloads, 1);
      }),
  );
});
