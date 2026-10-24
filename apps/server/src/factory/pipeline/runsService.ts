/**
 * The pipeline runs service, as the HTTP routes and the executor agree on it. The executor
 * (`runs.ts`) implements it; the routes (`../t3/pipelineHttp.ts`) call it. The record formats are
 * what `<factory dir>/pipelines/runs/<id>.jsonl` holds, one event per line.
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { Pipeline } from "./model.ts";

export type RunStatus = "running" | "done" | "stuck" | "stopped" | "interrupted" | "error";

export type RunEvent =
  /** The first line: the pipeline as it was when the run began, so later edits do not move a run. */
  | {
      readonly event: "started";
      readonly pipeline: Record<string, unknown>;
      readonly projectRoot: string;
      readonly repo: string | null;
      readonly issue: number | null;
    }
  | { readonly event: "entered"; readonly node: string; readonly visit: number }
  /** What a node ended with; `detail` is the text the next node is told (output tail, feedback), or null. */
  | {
      readonly event: "outcome";
      readonly node: string;
      readonly port: string;
      readonly detail: string | null;
    }
  | { readonly event: "moved"; readonly edge: string }
  /** The run is waiting at `node` for `on`: a thread to settle, a person, the pull request. */
  | { readonly event: "waiting"; readonly node: string; readonly on: string }
  /** A thread the run launched or continued at `node`. */
  | {
      readonly event: "thread";
      readonly node: string;
      readonly threadId: string;
      readonly worktree: string | null;
      readonly branch: string | null;
    }
  | {
      readonly event: "ended";
      readonly result: Exclude<RunStatus, "running">;
      readonly reason: string | null;
    }
  | { readonly event: "error"; readonly message: string };

/** One line of a run's record. */
export type RecordedEvent = RunEvent & { readonly ms: number };

export type RunSummary = {
  readonly id: string;
  readonly pipelineId: string;
  readonly pipelineName: string;
  readonly projectRoot: string;
  readonly repo: string | null;
  readonly issue: number | null;
  /** ISO times. */
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly status: RunStatus;
  /** The node the run is at, or ended at. */
  readonly node: string | null;
  /** Why it ended, when it ended stuck or with an error. */
  readonly reason: string | null;
};

export type RunDetail = RunSummary & {
  /** The pipeline as the run started on it. */
  readonly pipeline: Record<string, unknown>;
  readonly events: ReadonlyArray<RecordedEvent>;
};

export type StartRequest = {
  /** Validated by the caller: a pipeline with errors is refused before this. */
  readonly pipeline: Pipeline;
  /** The workspace root of the T3 project the run works in. */
  readonly projectRoot: string;
  /** The issue on the project's repo the run works on, when the pipeline needs one. */
  readonly issue: number | null;
};

export class PipelineRunError extends Schema.TaggedError<PipelineRunError>()("PipelineRunError", {
  /** `no-project`: no T3 project has that root. `not-found`: no such run. `io`: the record could not be read or written. */
  kind: Schema.Literals(["no-project", "not-found", "io"]),
  message: Schema.String,
}) {}

export class PipelineRuns extends Context.Service<
  PipelineRuns,
  {
    /** Starts a run and answers once its record exists; the run itself continues in the background. */
    readonly start: (request: StartRequest) => Effect.Effect<RunSummary, PipelineRunError>;
    /** Stops a running run: its threads are archived and the record ends `stopped`. A run that already ended is answered as it is. */
    readonly stop: (id: string) => Effect.Effect<RunSummary, PipelineRunError>;
    /** Every run, newest first; `pipelineId` narrows to one pipeline. */
    readonly list: (
      pipelineId?: string,
    ) => Effect.Effect<ReadonlyArray<RunSummary>, PipelineRunError>;
    readonly get: (id: string) => Effect.Effect<RunDetail, PipelineRunError>;
  }
>()("t3/factory/pipeline/runsService/PipelineRuns") {}
