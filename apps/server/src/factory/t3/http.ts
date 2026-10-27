/**
 * The factory's HTTP routes, each behind T3's own authentication (`route`). Reads need
 * `orchestration:read`, config writes `settings:write`, control `orchestration:operate`, and `POST
 * /api/factory/restart` needs `environment:maintain`, so an operate-only MCP client cannot end the
 * server. A run id is parsed before anything is read, so none reaches the file system as a path.
 */
import {
  AuthEnvironmentMaintainScope,
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
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpRouter from "effect/http/HttpRouter";

import packageJson from "../../../package.json" with { type: "json" };
import { Attention } from "../attention.ts";
import { pauseClaimsNow, resumeClaimsNow, showRun, stopRun } from "../control.ts";
import { FactoryLoop, hostName } from "../index.ts";
import { isLedgerError, type LedgerError } from "../ledger/errors.ts";
import { listRuns, type RunReadCache, type RunSummary } from "../ledger/listRuns.ts";
import { runIdToString } from "../ledger/runId.ts";
import { readMachineConfigReport } from "../settings.ts";
import { buildStatus } from "../status.ts";
import { route } from "./auth.ts";
import { ServerExit } from "./exit.ts";
import { FactoryPaths } from "./paths.ts";

export const STATUS_PATH = "/api/factory/status";
export const RUNS_PATH = "/api/factory/runs";
export const RUN_PATH = "/api/factory/runs/:id";
export const STOP_PATH = "/api/factory/runs/:id/stop";
export const PAUSE_PATH = "/api/factory/claims/pause";
export const RESUME_PATH = "/api/factory/claims/resume";
export const DISMISS_PATH = "/api/factory/attention/dismiss";
export const CONFIG_PATH = "/api/factory/config";
export const RESTART_PATH = "/api/factory/restart";

/** What the restart's 202 tells the caller to expect. */
export const RESTART_MESSAGE =
  "the server is exiting; when it runs as the LaunchAgent, launchd starts it again in about 10 seconds";

/** How far back `GET /api/factory/runs` lists finished runs unless asked for `?all=1`. */
export const RECENT_FINISHED_MS = 7 * 86_400_000;

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
);
