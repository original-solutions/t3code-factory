/**
 * The factory's HTTP routes, each behind T3's own authentication (`route`), with the scope named at
 * each route. Restart needs `environment:maintain`, so an operate-only MCP client cannot end the
 * server. A run id is parsed before anything is read, so none reaches the file system as a path.
 */
import {
  AuthAccessReadScope,
  AuthClientSession,
  AuthEnvironmentMaintainScope,
  EnvironmentAuthenticatedPrincipal,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpRouter from "effect/http/HttpRouter";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as AuthHttp from "../../auth/http.ts";
import packageJson from "../../../package.json" with { type: "json" };
import { Attention } from "../attention.ts";
import {
  DEPLOY_SNOOZE_LIMIT,
  deployWait,
  loadDeploySnooze,
  loadPendingDeploy,
  requestDeployNow,
  snoozeDeploy,
} from "../claims.ts";
import { pauseClaimsNow, resumeClaimsNow, showRun, stopRun } from "../control.ts";
import { FactoryLoop, hostName } from "../index.ts";
import { isLedgerError, type LedgerError } from "../ledger/errors.ts";
import { listRuns, type RunReadCache, type RunSummary } from "../ledger/listRuns.ts";
import { runIdToString } from "../ledger/runId.ts";
import { formatTs } from "../ledger/time.ts";
import { readMachineConfigReport } from "../settings.ts";
import { buildStatus } from "../status.ts";
import { route } from "./auth.ts";
import { DeployKick } from "./deployKick.ts";
import { ServerExit } from "./exit.ts";
import { FactoryPaths } from "./paths.ts";

export const STATUS_PATH = "/api/factory/status";
const RUNS_PATH = "/api/factory/runs";
const RUN_PATH = "/api/factory/runs/:id";
const STOP_PATH = "/api/factory/runs/:id/stop";
const PAUSE_PATH = "/api/factory/claims/pause";
const RESUME_PATH = "/api/factory/claims/resume";
export const DISMISS_PATH = "/api/factory/attention/dismiss";
export const CONFIG_PATH = "/api/factory/config";
export const RESTART_PATH = "/api/factory/restart";
export const CLIENTS_PATH = "/api/factory/auth/clients";
export const DEPLOY_SNOOZE_PATH = "/api/factory/deploy/snooze";
export const DEPLOY_NOW_PATH = "/api/factory/deploy/now";

/** What the restart's 202 tells the caller to expect. */
const RESTART_MESSAGE =
  "the server is exiting; when it runs as the LaunchAgent, launchd starts it again in about 10 seconds";

/** How far back `GET /api/factory/runs` lists finished runs unless asked for `?all=1`. */
const RECENT_FINISHED_MS = 7 * 86_400_000;

const respond = (body: unknown, status = 200) => HttpServerResponse.jsonUnsafe(body, { status });

/** A file read or write that failed with something other than a ledger error. */
class FactoryFileError extends Data.TaggedError("FactoryFileError")<{ readonly cause: unknown }> {}

/** Runs a synchronous ledger or file call; whatever it throws is the failure. */
const guarded = <A>(call: () => A): Effect.Effect<A, LedgerError | FactoryFileError> =>
  Effect.try({
    try: call,
    catch: (cause) => (isLedgerError(cause) ? cause : new FactoryFileError({ cause })),
  });

/**
 * The response for what a handler's ledger or file call threw. The message may name a path under
 * the T3 home; that is accepted, because the same scope already reads `data_dir` and
 * `machine_config` in the status report.
 */
const failure = (error: LedgerError | FactoryFileError) => {
  const cause = error._tag === "FactoryFileError" ? error.cause : error;
  return respond(
    { code: "factory_error", message: cause instanceof Error ? cause.message : String(cause) },
    500,
  );
};

/** A route of the factory: `route`, with every ledger or file failure answered by `failure`. */
const factoryRoute = <R>(
  method: "GET" | "POST",
  path: `/${string}`,
  scope: Parameters<typeof route>[2],
  handler: Effect.Effect<HttpServerResponse.HttpServerResponse, LedgerError | FactoryFileError, R>,
) =>
  route(method, path, scope, handler.pipe(Effect.catch((error) => Effect.succeed(failure(error)))));

const invalidRunId = (message: string) => respond({ code: "invalid_run_id", message }, 400);
const runNotFound = (id: string) =>
  respond({ code: "run_not_found", id, message: `no run ${id}` }, 404);

/** The word `softfac runs list` gives a run's status. */
const statusWord = (run: RunSummary) =>
  run.unreadable
    ? "unreadable"
    : run.finished
      ? "finished"
      : run.state === "pr-open"
        ? "watching"
        : "running";

/** The `:id` of the route, as text: `control.ts` parses it before anything is read. */
const idParam = Effect.map(HttpRouter.params, ({ id }) => id ?? "");

/** The Factory page asks for a status every 5 seconds, so the route keeps the run files it read. */
const statusRoute = Layer.unwrap(
  Effect.sync(() => {
    const cache: RunReadCache = new Map();
    return factoryRoute(
      "GET",
      STATUS_PATH,
      AuthOrchestrationReadScope,
      Effect.gen(function* () {
        const loop = yield* FactoryLoop;
        const paths = yield* FactoryPaths;
        const attention = yield* (yield* Attention).list();
        const passRunning = yield* loop.passRunning;
        const runningThreads = yield* loop.runningThreads.pipe(
          Effect.tapError((error) => Effect.logWarning(`status: ${error.message}`, error.cause)),
          Effect.orElseSucceed(() => null),
        );
        const nowMs = yield* Clock.currentTimeMillis;
        const report = yield* guarded(() =>
          buildStatus({
            status: loop.status,
            version: packageJson.version,
            machine: hostName(),
            machineConfigPath: paths.machineConfigPath,
            dataDir: paths.factoryDir,
            nowMs,
            passRunning,
            runningThreads,
            attention,
            cache,
          }),
        );
        return respond(report);
      }),
    );
  }),
);

const runsRoute = factoryRoute(
  "GET",
  RUNS_PATH,
  AuthOrchestrationReadScope,
  Effect.gen(function* () {
    const { factoryDir } = yield* FactoryPaths;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const all = Option.getOrUndefined(HttpServerRequest.toURL(request))?.searchParams.get("all");
    const nowMs = yield* Clock.currentTimeMillis;
    const runs = yield* guarded(() =>
      listRuns(factoryDir, all === "1" ? {} : { skipFinishedBefore: nowMs - RECENT_FINISHED_MS }),
    );
    return respond({
      runs: runs.map((run) => ({
        id: runIdToString(run.id),
        started_ts: run.startedTs,
        state: run.state,
        last_event: run.lastEvent,
        step: run.step,
        status: statusWord(run),
        pr_url: run.prUrl,
        pr_end: run.prEnd,
        finished: run.finished,
        total_ms: run.totalMs,
        unreadable: run.unreadable,
        title: run.title,
        reason: run.reason,
      })),
    });
  }),
);

const runRoute = factoryRoute(
  "GET",
  RUN_PATH,
  AuthOrchestrationReadScope,
  Effect.gen(function* () {
    const { factoryDir } = yield* FactoryPaths;
    const idText = yield* idParam;
    const shown = yield* guarded(() => showRun(factoryDir, idText));
    switch (shown.kind) {
      case "ok":
        return respond({
          id: shown.id,
          entries: shown.entries,
          truncated: shown.truncated,
          skipped: shown.skipped,
        });
      case "invalid":
        return invalidRunId(shown.message);
      case "not-found":
        return runNotFound(shown.id);
    }
  }),
);

const stopRoute = factoryRoute(
  "POST",
  STOP_PATH,
  AuthOrchestrationOperateScope,
  Effect.gen(function* () {
    const loop = yield* FactoryLoop;
    const { factoryDir } = yield* FactoryPaths;
    const idText = yield* idParam;
    const stopped = yield* guarded(() => stopRun(factoryDir, idText));
    switch (stopped.kind) {
      case "stopped":
        if (!stopped.already) yield* loop.wake;
        return respond({ stopped: stopped.id, already: stopped.already, message: stopped.message });
      case "refused":
        return respond({ code: "not_building", message: stopped.message }, 409);
      case "not-found":
        return runNotFound(stopped.id);
      case "invalid":
        return invalidRunId(stopped.message);
    }
  }),
);

const pauseRoute = factoryRoute(
  "POST",
  PAUSE_PATH,
  AuthOrchestrationOperateScope,
  Effect.gen(function* () {
    const { factoryDir } = yield* FactoryPaths;
    const nowMs = yield* Clock.currentTimeMillis;
    return respond(yield* guarded(() => pauseClaimsNow(factoryDir, nowMs)));
  }),
);

const resumeRoute = factoryRoute(
  "POST",
  RESUME_PATH,
  AuthOrchestrationOperateScope,
  Effect.gen(function* () {
    const { factoryDir } = yield* FactoryPaths;
    return respond(yield* guarded(() => resumeClaimsNow(factoryDir)));
  }),
);

const invalidBody = (message: string) => respond({ code: "invalid_body", message }, 400);

/** The body's `ids` when it is an array of strings, else `null`. */
const idsOf = (body: unknown): ReadonlyArray<string> | null => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const ids = (body as Record<string, unknown>)["ids"];
  return Array.isArray(ids) && ids.every((id) => typeof id === "string") ? ids : null;
};

const dismissRoute = factoryRoute(
  "POST",
  DISMISS_PATH,
  AuthOrchestrationOperateScope,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* Effect.result(request.json);
    const ids = Result.isSuccess(body) ? idsOf(body.success) : null;
    if (ids === null) return invalidBody("the body must be { ids: [<id>, ...] }");
    return respond({ dismissed: yield* (yield* Attention).dismiss(ids) });
  }),
);

const toFileError = Effect.mapError((cause: unknown) => new FactoryFileError({ cause }));

const configRoute = factoryRoute(
  "GET",
  CONFIG_PATH,
  AuthOrchestrationReadScope,
  Effect.gen(function* () {
    const loop = yield* FactoryLoop;
    const { machineConfigPath } = yield* FactoryPaths;
    return respond(
      yield* readMachineConfigReport(
        machineConfigPath,
        yield* Effect.result(loop.watchedRepos),
        yield* loop.repoConfigs,
      ),
    );
  }),
);

// POST, not PUT: the browser CORS layer allows only GET and POST, so a remote client's PUT is
// blocked at the preflight.
const saveConfigRoute = factoryRoute(
  "POST",
  CONFIG_PATH,
  AuthSettingsWriteScope,
  Effect.gen(function* () {
    const loop = yield* FactoryLoop;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* Effect.result(request.json);
    if (Result.isFailure(body)) return invalidBody("the body is not valid JSON");
    const saved = yield* loop.save(body.success).pipe(toFileError);
    switch (saved.kind) {
      case "invalid-body":
        return invalidBody("the body must be a JSON object");
      case "invalid":
        return respond({ code: "invalid_config", errors: saved.errors }, 422);
      case "ok":
        return respond(saved.report);
    }
  }),
);

const restartRoute = factoryRoute(
  "POST",
  RESTART_PATH,
  AuthEnvironmentMaintainScope,
  Effect.gen(function* () {
    const { request } = yield* ServerExit;
    switch (yield* request) {
      case "started":
        return respond({ restarting: true, message: RESTART_MESSAGE }, 202);
      case "pending":
        return respond({ code: "restart_pending", message: "a restart is already under way" }, 409);
    }
  }),
);

const NO_DEPLOY_PENDING = { code: "no_deploy_pending", message: "no build is waiting to deploy" };

const DEPLOY_CHANGED = {
  code: "deploy_changed",
  message: "another build is waiting now than the one shown; check it and ask again",
};

/** The build autodeploy has waiting, by sha, or null when there is none. */
const waitingBuild = (factoryDir: string, nowMs: number) => {
  const wait = deployWait(loadPendingDeploy(factoryDir), loadDeploySnooze(factoryDir), nowMs);
  return wait?.pending.commit ?? null;
};

/** The build the caller saw, from a `{ commit }` body; null when the body names none. */
const seenBuild = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const body = yield* Effect.result(request.json);
  if (Result.isFailure(body) || typeof body.success !== "object" || body.success === null) {
    return null;
  }
  const commit = (body.success as Record<string, unknown>)["commit"];
  return typeof commit === "string" ? commit : null;
});

/**
 * The waiting build, or "changed" when it is not the one the caller saw. A caller that names no
 * build, such as a page from before the check, takes the build that is waiting.
 */
const waitingBuildSeen = (factoryDir: string, nowMs: number, seen: string | null) => {
  const build = waitingBuild(factoryDir, nowMs);
  return build !== null && seen !== null && seen !== build ? ("changed" as const) : build;
};

/**
 * Snoozes the waiting build for an hour from now; a second snooze starts the hour again, up to
 * {@link DEPLOY_SNOOZE_LIMIT} for one build. It does not undo an update now for that build.
 */
const snoozeDeployRoute = factoryRoute(
  "POST",
  DEPLOY_SNOOZE_PATH,
  AuthOrchestrationOperateScope,
  Effect.gen(function* () {
    const { factoryDir } = yield* FactoryPaths;
    const nowMs = yield* Clock.currentTimeMillis;
    const seen = yield* seenBuild;
    const snoozed = yield* guarded(() => {
      const commit = waitingBuildSeen(factoryDir, nowMs, seen);
      return commit === null || commit === "changed"
        ? commit
        : snoozeDeploy(factoryDir, nowMs, commit);
    });
    if (snoozed === null) return respond(NO_DEPLOY_PENDING, 409);
    if (snoozed === "changed") return respond(DEPLOY_CHANGED, 409);
    switch (snoozed.kind) {
      case "snoozed":
        return respond({ snoozed_until: formatTs(snoozed.untilMs) });
      case "limit":
        return respond(
          {
            code: "snooze_limit",
            message: `this build has been snoozed ${DEPLOY_SNOOZE_LIMIT} times; it installs when its wait is up`,
          },
          409,
        );
      case "deploy_now":
        return respond(
          {
            code: "deploy_now_requested",
            message: "an update now is already asked for this build",
          },
          409,
        );
    }
  }),
);

/**
 * Asks autodeploy to install the waiting build over the runs in progress, and starts its tick at
 * once. The request names the build, so autodeploy drops it when main has moved on. Maintain
 * scope, as for restart: the install restarts the server.
 */
const deployNowRoute = factoryRoute(
  "POST",
  DEPLOY_NOW_PATH,
  AuthEnvironmentMaintainScope,
  Effect.gen(function* () {
    const { factoryDir } = yield* FactoryPaths;
    const nowMs = yield* Clock.currentTimeMillis;
    const seen = yield* seenBuild;
    const commit = yield* guarded(() => {
      const build = waitingBuildSeen(factoryDir, nowMs, seen);
      if (build !== null && build !== "changed") requestDeployNow(factoryDir, nowMs, build);
      return build;
    });
    if (commit === null) return respond(NO_DEPLOY_PENDING, 409);
    if (commit === "changed") return respond(DEPLOY_CHANGED, 409);
    const kicked = yield* (yield* DeployKick).kick;
    return respond(
      {
        commit,
        kicked,
        message: kicked
          ? "autodeploy is installing the waiting build now"
          : "the update starts on the next autodeploy tick, within 10 minutes",
      },
      202,
    );
  }),
);

const encodeClientSessions = Schema.encodeEffect(
  Schema.toCodecJson(Schema.Array(AuthClientSession)),
);

/**
 * The server's client sessions, for the mobile Factory screen to find and revoke the browser
 * sessions it signed in. Upstream serves this list only over the WebSocket now.
 */
const clientsRoute = route(
  "GET",
  CLIENTS_PATH,
  AuthAccessReadScope,
  Effect.gen(function* () {
    const principal = yield* EnvironmentAuthenticatedPrincipal;
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const sessions = yield* serverAuth.listClientSessions(principal.sessionId);
    return respond(yield* encodeClientSessions(sessions));
  }).pipe(
    Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
      AuthHttp.failEnvironmentInternal("client_sessions_load_failed", error),
    ),
  ),
);

/** The factory's HTTP routes. server.ts merges this into `layerMakeRoutes`. */
export const FactoryRoutes = Layer.mergeAll(
  statusRoute,
  runsRoute,
  runRoute,
  stopRoute,
  pauseRoute,
  resumeRoute,
  dismissRoute,
  configRoute,
  saveConfigRoute,
  restartRoute,
  snoozeDeployRoute,
  deployNowRoute,
  clientsRoute,
);
