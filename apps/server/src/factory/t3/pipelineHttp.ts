/**
 * The pipeline routes, under `/api/factory/pipelines`, each behind T3's own authentication
 * (`route`). The table of routes and scopes is in factory/docs/pipelines.md under "HTTP".
 * `PipelineRoutes` is merged into `FactoryRoutes` (`http.ts`).
 *
 * Each handler decodes its input, calls the store, the skills catalog, the validator, the
 * interpreter or `PipelineRuns`, and maps the result to a status and a body. A failed read or
 * write answers 500 `factory_error`, mapped once for every route by `pipelineRoute`.
 */
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpRouter from "effect/http/HttpRouter";

import { simulate } from "../pipeline/interpret.ts";
import { decodePipeline, encodePipeline, KINDS, type Pipeline } from "../pipeline/model.ts";
import { TEMPLATES } from "../pipeline/templates.ts";
import { PipelineRuns, type PipelineRunError } from "../pipeline/runsService.ts";
import { listSkillsCached, PipelineSkillDirs, skillNames } from "../pipeline/skills.ts";
import {
  deletePipeline,
  listPipelines,
  readPipeline,
  writePipeline,
  type StoredPipeline,
} from "../pipeline/store.ts";
import { hasErrors, validate } from "../pipeline/validate.ts";
import { route } from "./auth.ts";
import { FactoryPaths } from "./paths.ts";

export const PIPELINES_PATH = "/api/factory/pipelines";
export const CATALOG_PATH = `${PIPELINES_PATH}/catalog` as const;
export const VALIDATE_PATH = `${PIPELINES_PATH}/validate` as const;
export const SIMULATE_PATH = `${PIPELINES_PATH}/simulate` as const;
export const PIPELINE_RUNS_PATH = `${PIPELINES_PATH}/runs` as const;
export const PIPELINE_RUN_PATH = `${PIPELINES_PATH}/runs/:id` as const;
export const PIPELINE_RUN_STOP_PATH = `${PIPELINES_PATH}/runs/:id/stop` as const;
export const PIPELINE_PATH = `${PIPELINES_PATH}/:id` as const;
export const PIPELINE_DELETE_PATH = `${PIPELINES_PATH}/:id/delete` as const;
export const PIPELINE_START_PATH = `${PIPELINES_PATH}/:id/run` as const;

/**
 * Ids a pipeline cannot have: the router serves the literal paths under `/api/factory/pipelines`
 * before `/:id`, so a pipeline with one of these ids could be saved but never read back.
 */
export const RESERVED_PIPELINE_IDS: ReadonlySet<string> = new Set([
  "catalog",
  "validate",
  "simulate",
  "runs",
]);

const respond = (body: unknown, status = 200) => HttpServerResponse.jsonUnsafe(body, { status });

const invalidBody = (message: string) => respond({ code: "invalid_body", message }, 400);
const pipelineNotFound = (id: string) =>
  respond({ code: "pipeline_not_found", id, message: `no pipeline ${id}` }, 404);
const runNotFound = (id: string) =>
  respond({ code: "run_not_found", id, message: `no run ${id}` }, 404);
const invalidPipeline = (errors: unknown) => respond({ code: "invalid_pipeline", errors }, 422);

/** A failed file read or write, or a run record that could not be read or written. */
const failure = (error: { readonly message: string }) =>
  respond({ code: "factory_error", message: error.message }, 500);

/** A route of the pipelines: `route`, with every failure answered by `failure`. */
const pipelineRoute = <E extends { readonly message: string }, R>(
  method: "GET" | "POST",
  path: `/${string}`,
  scope: Parameters<typeof route>[2],
  handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  route(method, path, scope, handler.pipe(Effect.catch((error) => Effect.succeed(failure(error)))));

const idParam = Effect.map(HttpRouter.params, ({ id }) => id ?? "");

/** The request's JSON body, or null when it is not JSON. */
const jsonBody = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const body = yield* Effect.result(request.json);
  return Result.isSuccess(body) ? { value: body.success as unknown } : null;
});

/** The names of the skills on this machine, which validation checks pipelines against. */
const machineSkills = Effect.gen(function* () {
  return skillNames(yield* listSkillsCached(yield* PipelineSkillDirs));
});

/** A stored pipeline as `GET /:id` answers it. */
const answerPipeline = (stored: StoredPipeline, skills: ReadonlySet<string>) => {
  const { updatedAt, unreadable: _, ...pipeline } = stored;
  return respond({
    pipeline: encodePipeline(pipeline),
    problems: validate(pipeline, skills),
    updatedAt,
  });
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The PipelineRuns failures a route answers itself; the rest are `failure`. */
const runFailure = (error: PipelineRunError, id: string) => {
  switch (error.kind) {
    case "not-found":
      return Effect.succeed(runNotFound(id));
    case "no-project":
      return Effect.succeed(respond({ code: "no_project", message: error.message }, 404));
    case "io":
      return Effect.fail(error);
  }
};

const catalogRoute = pipelineRoute(
  "GET",
  CATALOG_PATH,
  AuthOrchestrationReadScope,
  Effect.gen(function* () {
    return respond({
      kinds: KINDS,
      skills: yield* listSkillsCached(yield* PipelineSkillDirs),
      templates: TEMPLATES.map((template) => ({
        id: template.pipeline.id,
        name: template.pipeline.name,
        description: template.description,
        pipeline: encodePipeline(template.pipeline),
      })),
    });
  }),
);

const listRoute = pipelineRoute(
  "GET",
  PIPELINES_PATH,
  AuthOrchestrationReadScope,
  Effect.gen(function* () {
    const { factoryDir } = yield* FactoryPaths;
    const skills = yield* machineSkills;
    const listed = yield* listPipelines(factoryDir);
    return respond({
      pipelines: listed
        .filter((entry) => !RESERVED_PIPELINE_IDS.has(entry.id))
        .map((entry) => {
          if (entry.unreadable) {
            return {
              id: entry.id,
              name: entry.id,
              nodes: 0,
              edges: 0,
              errors: entry.errors.length,
              warnings: 0,
              updatedAt: entry.updatedAt,
              unreadable: true,
              decodeErrors: entry.errors,
            };
          }
          const problems = validate(entry, skills);
          return {
            id: entry.id,
            name: entry.name,
            nodes: entry.nodes.length,
            edges: entry.edges.length,
            errors: problems.filter((problem) => problem.level === "error").length,
            warnings: problems.filter((problem) => problem.level === "warning").length,
            updatedAt: entry.updatedAt,
          };
        }),
    });
  }),
);

const getRoute = pipelineRoute(
  "GET",
  PIPELINE_PATH,
  AuthOrchestrationReadScope,
  Effect.gen(function* () {
    const { factoryDir } = yield* FactoryPaths;
    const id = yield* idParam;
    if (RESERVED_PIPELINE_IDS.has(id)) return pipelineNotFound(id);
    const stored = yield* readPipeline(factoryDir, id);
    if (stored === null) return pipelineNotFound(id);
    if (stored.unreadable) return invalidPipeline(stored.errors);
    return answerPipeline(stored, yield* machineSkills);
  }),
);

// POST, not PUT or DELETE: the browser CORS layer allows only GET and POST.
const saveRoute = pipelineRoute(
  "POST",
  PIPELINE_PATH,
  AuthSettingsWriteScope,
  Effect.gen(function* () {
    const { factoryDir } = yield* FactoryPaths;
    const id = yield* idParam;
    const body = yield* jsonBody;
    if (body === null) return invalidBody("the body is not valid JSON");
    const decoded = decodePipeline(body.value);
    if (!decoded.ok) return invalidPipeline(decoded.errors);
    if (decoded.pipeline.id !== id) {
      return respond(
        {
          code: "id_mismatch",
          message: `the body is pipeline ${decoded.pipeline.id}, not ${id}`,
        },
        400,
      );
    }
    if (RESERVED_PIPELINE_IDS.has(id)) {
      return respond(
        { code: "reserved_id", message: `${id} is a path of the pipeline routes, not an id` },
        400,
      );
    }
    const stored = yield* writePipeline(factoryDir, decoded.pipeline);
    return answerPipeline(stored, yield* machineSkills);
  }),
);

const deleteRoute = pipelineRoute(
  "POST",
  PIPELINE_DELETE_PATH,
  AuthSettingsWriteScope,
  Effect.gen(function* () {
    const { factoryDir } = yield* FactoryPaths;
    const id = yield* idParam;
    if (RESERVED_PIPELINE_IDS.has(id)) return pipelineNotFound(id);
    if (!(yield* deletePipeline(factoryDir, id))) return pipelineNotFound(id);
    return respond({ deleted: true });
  }),
);

const validateRoute = pipelineRoute(
  "POST",
  VALIDATE_PATH,
  AuthOrchestrationReadScope,
  Effect.gen(function* () {
    const body = yield* jsonBody;
    if (body === null) return invalidBody("the body is not valid JSON");
    const decoded = decodePipeline(body.value);
    if (!decoded.ok) return invalidPipeline(decoded.errors);
    return respond({ problems: validate(decoded.pipeline, yield* machineSkills) });
  }),
);

const simulateRoute = pipelineRoute(
  "POST",
  SIMULATE_PATH,
  AuthOrchestrationReadScope,
  Effect.gen(function* () {
    const body = yield* jsonBody;
    if (body === null || !isRecord(body.value)) {
      return invalidBody("the body must be { pipeline, script: [<port>, ...] }");
    }
    const script = body.value["script"];
    if (!Array.isArray(script) || !script.every((port) => typeof port === "string")) {
      return invalidBody("script must be a list of outcome names");
    }
    const decoded = decodePipeline(body.value["pipeline"]);
    if (!decoded.ok) return invalidPipeline(decoded.errors);
    return respond({ trace: simulate(decoded.pipeline, script) });
  }),
);

/** The body of a run request, or null when it is not `{ projectRoot, issue? }`. */
const startRequestOf = (
  body: unknown,
): { readonly projectRoot: string; readonly issue: number | null } | null => {
  if (!isRecord(body)) return null;
  const projectRoot = body["projectRoot"];
  const issue = body["issue"];
  if (typeof projectRoot !== "string" || projectRoot.trim() === "") return null;
  if (issue !== undefined && issue !== null && !(Number.isInteger(issue) && (issue as number) > 0))
    return null;
  return { projectRoot, issue: typeof issue === "number" ? issue : null };
};

const startRoute = pipelineRoute(
  "POST",
  PIPELINE_START_PATH,
  AuthOrchestrationOperateScope,
  Effect.gen(function* () {
    const { factoryDir } = yield* FactoryPaths;
    const id = yield* idParam;
    const body = yield* jsonBody;
    const request = body === null ? null : startRequestOf(body.value);
    if (request === null) {
      return invalidBody("the body must be { projectRoot: <path>, issue?: <number> }");
    }
    if (RESERVED_PIPELINE_IDS.has(id)) return pipelineNotFound(id);
    const stored = yield* readPipeline(factoryDir, id);
    if (stored === null) return pipelineNotFound(id);
    if (stored.unreadable) return invalidPipeline(stored.errors);
    const { updatedAt: _, unreadable: __, ...pipeline } = stored;
    const problems = validate(pipeline, yield* machineSkills);
    if (hasErrors(problems)) return respond({ code: "invalid_pipeline", problems }, 409);
    const runs = yield* PipelineRuns;
    return yield* runs.start({ pipeline: pipeline satisfies Pipeline, ...request }).pipe(
      Effect.map((run) => respond({ run })),
      Effect.catch((error) => runFailure(error, id)),
    );
  }),
);

const runsRoute = pipelineRoute(
  "GET",
  PIPELINE_RUNS_PATH,
  AuthOrchestrationReadScope,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const pipelineId = Option.getOrUndefined(HttpServerRequest.toURL(request))?.searchParams.get(
      "pipeline",
    );
    const runs = yield* PipelineRuns;
    return respond({ runs: yield* runs.list(pipelineId ?? undefined) });
  }),
);

const runRoute = pipelineRoute(
  "GET",
  PIPELINE_RUN_PATH,
  AuthOrchestrationReadScope,
  Effect.gen(function* () {
    const id = yield* idParam;
    const runs = yield* PipelineRuns;
    return yield* runs.get(id).pipe(
      Effect.map((run) => respond({ run })),
      Effect.catch((error) => runFailure(error, id)),
    );
  }),
);

const stopRoute = pipelineRoute(
  "POST",
  PIPELINE_RUN_STOP_PATH,
  AuthOrchestrationOperateScope,
  Effect.gen(function* () {
    const id = yield* idParam;
    const runs = yield* PipelineRuns;
    return yield* runs.stop(id).pipe(
      Effect.map((run) => respond({ run })),
      Effect.catch((error) => runFailure(error, id)),
    );
  }),
);

/** The pipeline routes. `FactoryRoutes` merges this in. */
export const PipelineRoutes = Layer.mergeAll(
  catalogRoute,
  validateRoute,
  simulateRoute,
  runsRoute,
  runRoute,
  stopRoute,
  listRoute,
  getRoute,
  saveRoute,
  deleteRoute,
  startRoute,
);
