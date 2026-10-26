/**
 * The interpreter: where a run is in the graph and where an outcome takes it. Pure, so the
 * simulation and the executor share it; the executor supplies outcomes from agents, commands and
 * the tracker, the simulation from a script.
 */
import { kindInfo, nodeName, type Edge, type Node, type Pipeline } from "./model.ts";

/** Where a run stands: the node it is at and how often it took each limited edge. */
export type Cursor = {
  readonly node: string;
  /** Traversals per edge id, counted for every edge so the trace can show them. */
  readonly taken: Readonly<Record<string, number>>;
};

export type Move =
  /** The outcome took `edge` into `cursor.node`. */
  | { readonly kind: "move"; readonly edge: Edge; readonly cursor: Cursor }
  /** The run ended `stuck`: no transition for the outcome, or a loop past its limit. */
  | { readonly kind: "stuck"; readonly reason: string; readonly edge?: Edge };

export const nodeOf = (pipeline: Pipeline, id: string): Node | undefined =>
  pipeline.nodes.find((node) => node.id === id);

export const startOf = (pipeline: Pipeline): Node | undefined =>
  pipeline.nodes.find((node) => node.kind === "start");

export const edgeFrom = (pipeline: Pipeline, node: string, port: string): Edge | undefined =>
  pipeline.edges.find((edge) => edge.from === node && edge.port === port);

/** The cursor at the start node. */
export const initialCursor = (pipeline: Pipeline): Cursor | undefined => {
  const start = startOf(pipeline);
  return start === undefined ? undefined : { node: start.id, taken: {} };
};

/** Where the outcome `port` at `cursor.node` takes the run. */
export const advance = (pipeline: Pipeline, cursor: Cursor, port: string): Move => {
  const node = nodeOf(pipeline, cursor.node);
  const edge = edgeFrom(pipeline, cursor.node, port);
  if (edge === undefined) {
    const name = node === undefined ? cursor.node : nodeName(node);
    return { kind: "stuck", reason: `${name} ended with ${port}, which has no transition` };
  }
  const count = (cursor.taken[edge.id] ?? 0) + 1;
  if (edge.max !== undefined && count > edge.max) {
    const name = node === undefined ? cursor.node : nodeName(node);
    return {
      kind: "stuck",
      reason: `${name} ended with ${port} for the ${ordinal(count)} time; the limit is ${edge.max}`,
      edge,
    };
  }
  return {
    kind: "move",
    edge,
    cursor: { node: edge.to, taken: { ...cursor.taken, [edge.id]: count } },
  };
};

const ordinal = (n: number): string => {
  const rest = n % 100;
  if (rest >= 11 && rest <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
};

export type TraceStep =
  | { readonly kind: "entered"; readonly node: string }
  | { readonly kind: "outcome"; readonly node: string; readonly port: string }
  | { readonly kind: "moved"; readonly edge: string };

export type TraceEnd =
  | { readonly kind: "ended"; readonly result: "done" | "stuck"; readonly reason?: string }
  /** The script ran out at `node`: the next outcome is one of `ports`. */
  | { readonly kind: "waiting"; readonly node: string; readonly ports: ReadonlyArray<string> }
  | { readonly kind: "no-start" };

export type Trace = {
  readonly steps: ReadonlyArray<TraceStep>;
  readonly taken: Readonly<Record<string, number>>;
  readonly end: TraceEnd;
};

/** A script of outcomes can at most take this many steps, so a pipeline with a bug ends. */
export const MAX_SIMULATED_STEPS = 500;

/** Walks the pipeline with the outcomes of `script`, in order, and reports the trace. */
export const simulate = (pipeline: Pipeline, script: ReadonlyArray<string>): Trace => {
  const steps: Array<TraceStep> = [];
  let cursor = initialCursor(pipeline);
  if (cursor === undefined) return { steps, taken: {}, end: { kind: "no-start" } };
  steps.push({ kind: "entered", node: cursor.node });
  let next = 0;
  while (steps.length < MAX_SIMULATED_STEPS) {
    const node = nodeOf(pipeline, cursor.node);
    if (node === undefined) {
      return {
        steps,
        taken: cursor.taken,
        end: { kind: "ended", result: "stuck", reason: `node ${cursor.node} does not exist` },
      };
    }
    if (node.kind === "end")
      return { steps, taken: cursor.taken, end: { kind: "ended", result: node.result } };
    const ports = kindInfo(node.kind).ports.map((port) => port.name);
    if (next >= script.length)
      return { steps, taken: cursor.taken, end: { kind: "waiting", node: node.id, ports } };
    const port = script[next++]!;
    steps.push({ kind: "outcome", node: node.id, port });
    const move = advance(pipeline, cursor, port);
    if (move.kind === "stuck") {
      return {
        steps,
        taken: cursor.taken,
        end: { kind: "ended", result: "stuck", reason: move.reason },
      };
    }
    cursor = move.cursor;
    steps.push({ kind: "moved", edge: move.edge.id });
    steps.push({ kind: "entered", node: cursor.node });
  }
  return {
    steps,
    taken: cursor.taken,
    end: { kind: "ended", result: "stuck", reason: `more than ${MAX_SIMULATED_STEPS} steps` },
  };
};
