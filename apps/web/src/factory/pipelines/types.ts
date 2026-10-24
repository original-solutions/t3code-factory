/**
 * The pipeline shapes as the server answers them. The web cannot import server code, so these copy
 * `apps/server/src/factory/pipeline/model.ts`, `interpret.ts`, `validate.ts` and `runsService.ts`;
 * keep them in step when those change.
 */

export type Kind = "start" | "agent" | "verify" | "ask" | "pr" | "learn" | "end";

export type Instructions = { readonly skill: string } | { readonly brief: string };

export type Check = Instructions | { readonly commands: ReadonlyArray<string> };

type NodeBase = {
  readonly id: string;
  readonly label?: string;
  readonly x: number;
  readonly y: number;
};

export type PipelineNode = NodeBase &
  (
    | { readonly kind: "start" }
    | { readonly kind: "agent"; readonly instructions: Instructions; readonly fresh: boolean }
    | { readonly kind: "verify"; readonly check: Check }
    | { readonly kind: "ask" }
    | { readonly kind: "pr" }
    | { readonly kind: "learn"; readonly instructions: Instructions }
    | { readonly kind: "end"; readonly result: "done" | "stuck" }
  );

export type PipelineEdge = {
  readonly id: string;
  readonly from: string;
  readonly port: string;
  readonly to: string;
  /** The loop limit: how many times a run may take this edge. */
  readonly max?: number;
  readonly instructions?: Instructions;
};

export type Pipeline = {
  readonly id: string;
  readonly name: string;
  readonly nodes: ReadonlyArray<PipelineNode>;
  readonly edges: ReadonlyArray<PipelineEdge>;
};

export type PortInfo = { readonly name: string; readonly meaning: string };

export type KindInfo = {
  readonly kind: Kind;
  readonly label: string;
  readonly description: string;
  readonly ports: ReadonlyArray<PortInfo>;
  readonly instructions: "none" | "instructions" | "check";
};

export type SkillInfo = {
  readonly name: string;
  readonly description: string;
  readonly path: string;
};

export type Catalog = {
  readonly kinds: ReadonlyArray<KindInfo>;
  readonly skills: ReadonlyArray<SkillInfo>;
};

export type Problem = {
  readonly level: "error" | "warning";
  readonly message: string;
  readonly node?: string;
  readonly edge?: string;
};

/** A field of a body the server could not decode; `path` is dotted, e.g. `nodes.2.kind`. */
export type DecodeError = { readonly path: string; readonly message: string };

export type PipelineListItem = {
  readonly id: string;
  readonly name: string;
  readonly nodes: number;
  readonly edges: number;
  readonly errors: number;
  readonly warnings: number;
  readonly updatedAt: string;
};

export type PipelineRecord = {
  readonly pipeline: Pipeline;
  readonly problems: ReadonlyArray<Problem>;
  readonly updatedAt: string;
};

export type TraceStep =
  | { readonly kind: "entered"; readonly node: string }
  | { readonly kind: "outcome"; readonly node: string; readonly port: string }
  | { readonly kind: "moved"; readonly edge: string };

export type TraceEnd =
  | { readonly kind: "ended"; readonly result: "done" | "stuck"; readonly reason?: string }
  | { readonly kind: "waiting"; readonly node: string; readonly ports: ReadonlyArray<string> }
  | { readonly kind: "no-start" };

export type Trace = {
  readonly steps: ReadonlyArray<TraceStep>;
  readonly taken: Readonly<Record<string, number>>;
  readonly end: TraceEnd;
};

export type RunStatus = "running" | "done" | "stuck" | "stopped" | "interrupted" | "error";

export type RunEvent =
  | {
      readonly event: "started";
      readonly pipeline: Record<string, unknown>;
      readonly projectRoot: string;
      readonly repo: string | null;
      readonly issue: number | null;
    }
  | { readonly event: "entered"; readonly node: string; readonly visit: number }
  | {
      readonly event: "outcome";
      readonly node: string;
      readonly port: string;
      readonly detail: string | null;
    }
  | { readonly event: "moved"; readonly edge: string }
  | { readonly event: "waiting"; readonly node: string; readonly on: string }
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

export type RecordedEvent = RunEvent & { readonly ms: number };

export type RunSummary = {
  readonly id: string;
  readonly pipelineId: string;
  readonly pipelineName: string;
  readonly projectRoot: string;
  readonly repo: string | null;
  readonly issue: number | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly status: RunStatus;
  readonly node: string | null;
  readonly reason: string | null;
};

export type RunDetail = RunSummary & {
  readonly pipeline: Record<string, unknown>;
  readonly events: ReadonlyArray<RecordedEvent>;
};
