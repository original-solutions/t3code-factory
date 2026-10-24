import type { EnvironmentId } from "@t3tools/contracts";

import { FactoryApiError, get, post } from "../api";
import type {
  Catalog,
  DecodeError,
  Pipeline,
  PipelineListItem,
  PipelineRecord,
  Problem,
  RunDetail,
  RunSummary,
  Trace,
} from "./types";

/** The pipelines API as the server serves it, under `/api/factory/pipelines` (factory/docs/pipelines.md). */
export interface PipelineApi {
  readonly catalog: (environmentId: EnvironmentId) => Promise<Catalog>;
  readonly list: (
    environmentId: EnvironmentId,
  ) => Promise<{ readonly pipelines: ReadonlyArray<PipelineListItem> }>;
  readonly get: (environmentId: EnvironmentId, id: string) => Promise<PipelineRecord>;
  /** Saves `pipeline` under its id; a body the server cannot decode rejects with its errors (422). */
  readonly save: (environmentId: EnvironmentId, pipeline: Pipeline) => Promise<PipelineRecord>;
  readonly remove: (
    environmentId: EnvironmentId,
    id: string,
  ) => Promise<{ readonly deleted: boolean }>;
  readonly validate: (
    environmentId: EnvironmentId,
    pipeline: Pipeline,
  ) => Promise<{ readonly problems: ReadonlyArray<Problem> }>;
  readonly simulate: (
    environmentId: EnvironmentId,
    pipeline: Pipeline,
    script: ReadonlyArray<string>,
  ) => Promise<{ readonly trace: Trace }>;
  readonly run: (
    environmentId: EnvironmentId,
    id: string,
    request: { readonly projectRoot: string; readonly issue?: number },
  ) => Promise<{ readonly run: RunSummary }>;
  readonly runs: (
    environmentId: EnvironmentId,
    pipelineId: string,
  ) => Promise<{ readonly runs: ReadonlyArray<RunSummary> }>;
  readonly runDetail: (
    environmentId: EnvironmentId,
    runId: string,
  ) => Promise<{ readonly run: RunDetail }>;
  readonly stopRun: (
    environmentId: EnvironmentId,
    runId: string,
  ) => Promise<{ readonly run: RunSummary }>;
}

const BASE = "/api/factory/pipelines";
const pipelinePath = (id: string) => `${BASE}/${encodeURIComponent(id)}`;
const runPath = (id: string) => `${BASE}/runs/${encodeURIComponent(id)}`;

const httpApi: PipelineApi = {
  catalog: (environmentId) => get(environmentId, `${BASE}/catalog`),
  list: (environmentId) => get(environmentId, BASE),
  get: (environmentId, id) => get(environmentId, pipelinePath(id)),
  save: (environmentId, pipeline) => post(environmentId, pipelinePath(pipeline.id), pipeline),
  remove: (environmentId, id) => post(environmentId, `${pipelinePath(id)}/delete`),
  validate: (environmentId, pipeline) => post(environmentId, `${BASE}/validate`, pipeline),
  simulate: (environmentId, pipeline, script) =>
    post(environmentId, `${BASE}/simulate`, { pipeline, script }),
  run: (environmentId, id, request) => post(environmentId, `${pipelinePath(id)}/run`, request),
  runs: (environmentId, pipelineId) => get(environmentId, `${BASE}/runs`, { pipeline: pipelineId }),
  runDetail: (environmentId, runId) => get(environmentId, runPath(runId)),
  stopRun: (environmentId, runId) => post(environmentId, `${runPath(runId)}/stop`),
};

let override: PipelineApi | undefined;

/** Swaps the API for a test; no argument restores the HTTP one. */
export const __setPipelineApiForTests = (api?: PipelineApi): void => {
  override = api;
};

/** Delegates on every call, so a swap takes effect for components that already hold the object. */
export const pipelineApi: PipelineApi = {
  catalog: (environmentId) => (override ?? httpApi).catalog(environmentId),
  list: (environmentId) => (override ?? httpApi).list(environmentId),
  get: (environmentId, id) => (override ?? httpApi).get(environmentId, id),
  save: (environmentId, pipeline) => (override ?? httpApi).save(environmentId, pipeline),
  remove: (environmentId, id) => (override ?? httpApi).remove(environmentId, id),
  validate: (environmentId, pipeline) => (override ?? httpApi).validate(environmentId, pipeline),
  simulate: (environmentId, pipeline, script) =>
    (override ?? httpApi).simulate(environmentId, pipeline, script),
  run: (environmentId, id, request) => (override ?? httpApi).run(environmentId, id, request),
  runs: (environmentId, pipelineId) => (override ?? httpApi).runs(environmentId, pipelineId),
  runDetail: (environmentId, runId) => (override ?? httpApi).runDetail(environmentId, runId),
  stopRun: (environmentId, runId) => (override ?? httpApi).stopRun(environmentId, runId),
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** The field errors of a 422 the server could not decode, or null for any other failure. */
export const decodeErrorsOf = (error: unknown): ReadonlyArray<DecodeError> | null => {
  if (!(error instanceof FactoryApiError) || error.status !== 422) return null;
  const errors = isRecord(error.body) ? error.body["errors"] : null;
  return Array.isArray(errors) ? (errors as ReadonlyArray<DecodeError>) : null;
};

/** The problems a 409 refused a run for, or null for any other failure. */
export const runProblemsOf = (error: unknown): ReadonlyArray<Problem> | null => {
  if (!(error instanceof FactoryApiError) || error.status !== 409) return null;
  const problems = isRecord(error.body) ? error.body["problems"] : null;
  return Array.isArray(problems) ? (problems as ReadonlyArray<Problem>) : null;
};
