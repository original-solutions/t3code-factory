/**
 * The editor's state as a reducer: the pipeline being edited, the one last saved, the selection
 * and the undo history. Pure, so adding, connecting, moving, removing and undoing are tested
 * without a browser.
 */
import type { Point } from "./geometry";
import type { Instructions, Kind, Pipeline, PipelineEdge, PipelineNode } from "./types";

export type Selection =
  | { readonly kind: "node"; readonly id: string }
  | { readonly kind: "edge"; readonly id: string }
  | null;

/** A field edit that may join the one before it: same `key` within `COALESCE_MS` is one undo step. */
export type FieldEdit = { readonly key: string; readonly at: number };

export type EditorState = {
  readonly pipeline: Pipeline;
  /** The pipeline as last loaded or saved; the editor is dirty while `pipeline` is another object. */
  readonly saved: Pipeline;
  readonly selection: Selection;
  /** Earlier pipelines, oldest first, at most `HISTORY_LIMIT`. */
  readonly past: ReadonlyArray<Pipeline>;
  /** Undone pipelines, the next redo first. */
  readonly future: ReadonlyArray<Pipeline>;
  readonly lastEdit: FieldEdit | null;
  /**
   * The number of the next edge id. It only grows, so a deleted edge's id is never given to a new
   * one: a run's record names edges by id, and a reused id would point at another transition.
   */
  readonly nextEdge: number;
};

export type EditorAction =
  | { readonly type: "loaded"; readonly pipeline: Pipeline }
  /** `pipeline` is the body that was saved: edits made while the save was in flight stay dirty. */
  | { readonly type: "saved"; readonly pipeline: Pipeline }
  | { readonly type: "select"; readonly selection: Selection }
  | { readonly type: "rename"; readonly name: string; readonly edit?: FieldEdit }
  | { readonly type: "add-node"; readonly kind: Kind; readonly x: number; readonly y: number }
  | { readonly type: "update-node"; readonly node: PipelineNode; readonly edit?: FieldEdit }
  | { readonly type: "move-node"; readonly id: string; readonly x: number; readonly y: number }
  | {
      readonly type: "connect";
      readonly from: string;
      readonly port: string;
      readonly to: string;
    }
  | { readonly type: "update-edge"; readonly edge: PipelineEdge; readonly edit?: FieldEdit }
  /** Moves every node named in `positions` at once, as Tidy does. */
  | { readonly type: "layout"; readonly positions: Readonly<Record<string, Point>> }
  | { readonly type: "remove-selection" }
  | { readonly type: "undo" }
  | { readonly type: "redo" };

export const HISTORY_LIMIT = 50;
export const COALESCE_MS = 500;

const EDGE_ID = /^e(\d+)$/;

const firstFreeEdgeNumber = (edges: ReadonlyArray<PipelineEdge>): number =>
  Math.max(0, ...edges.map((edge) => Number(EDGE_ID.exec(edge.id)?.[1] ?? 0))) + 1;

export const initialEditorState = (pipeline: Pipeline): EditorState => ({
  pipeline,
  saved: pipeline,
  selection: null,
  past: [],
  future: [],
  lastEdit: null,
  nextEdge: firstFreeEdgeNumber(pipeline.edges),
});

export const isDirty = (state: EditorState): boolean => state.pipeline !== state.saved;

export const canUndo = (state: EditorState): boolean => state.past.length > 0;
export const canRedo = (state: EditorState): boolean => state.future.length > 0;

/** `base` if no id in `taken` has it, else `base-2`, `base-3`, ... */
export const freeId = (base: string, taken: ReadonlySet<string>): string => {
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
};

const EMPTY_BRIEF: Instructions = { brief: "" };

/**
 * A new node of `kind`. A node that runs an agent starts with an empty brief, a gate with no
 * commands: the server decodes both and reports them as errors on the node until filled in.
 */
export const newNode = (kind: Kind, id: string, x: number, y: number): PipelineNode => {
  const base = { id, x, y };
  switch (kind) {
    case "start":
    case "ask":
    case "pr":
      return { ...base, kind };
    case "agent":
      return { ...base, kind, instructions: EMPTY_BRIEF };
    case "learn":
      return { ...base, kind, instructions: EMPTY_BRIEF };
    case "verify":
      return { ...base, kind, check: { commands: [] } };
    case "end":
      return { ...base, kind, result: "done" };
  }
};

const withPipeline = (state: EditorState, pipeline: Pipeline): EditorState => ({
  ...state,
  pipeline,
});

const removeSelection = (state: EditorState): EditorState => {
  const { selection, pipeline } = state;
  if (selection === null) return state;
  if (selection.kind === "edge") {
    return {
      ...state,
      selection: null,
      pipeline: { ...pipeline, edges: pipeline.edges.filter((edge) => edge.id !== selection.id) },
    };
  }
  return {
    ...state,
    selection: null,
    pipeline: {
      ...pipeline,
      nodes: pipeline.nodes.filter((node) => node.id !== selection.id),
      edges: pipeline.edges.filter(
        (edge) => edge.from !== selection.id && edge.to !== selection.id,
      ),
    },
  };
};

const connect = (
  state: EditorState,
  action: Extract<EditorAction, { type: "connect" }>,
): EditorState => {
  const { pipeline } = state;
  // One edge per port: a new connection from a port replaces the old one, keeping its id,
  // limit and instructions, since the person is moving the transition, not starting over.
  const existing = pipeline.edges.find(
    (edge) => edge.from === action.from && edge.port === action.port,
  );
  if (existing !== undefined) {
    const selection = { kind: "edge", id: existing.id } as const;
    if (existing.to === action.to) return { ...state, selection };
    return {
      ...state,
      pipeline: {
        ...pipeline,
        edges: pipeline.edges.map((edge) =>
          edge.id === existing.id ? { ...edge, to: action.to } : edge,
        ),
      },
      selection,
    };
  }
  const taken = new Set(pipeline.edges.map((edge) => edge.id));
  let n = state.nextEdge;
  while (taken.has(`e${n}`)) n++;
  const id = `e${n}`;
  return {
    ...state,
    pipeline: {
      ...pipeline,
      edges: [...pipeline.edges, { id, from: action.from, port: action.port, to: action.to }],
    },
    selection: { kind: "edge", id },
    nextEdge: n + 1,
  };
};

/** The selection, if what it names is still in `pipeline`. */
const keptSelection = (selection: Selection, pipeline: Pipeline): Selection => {
  if (selection === null) return null;
  const list = selection.kind === "node" ? pipeline.nodes : pipeline.edges;
  return list.some((item) => item.id === selection.id) ? selection : null;
};

/** One edit to the pipeline, before it is recorded in the history. */
const apply = (state: EditorState, action: EditorAction): EditorState => {
  const { pipeline } = state;
  switch (action.type) {
    case "rename":
      return withPipeline(state, { ...pipeline, name: action.name });
    case "add-node": {
      const id = freeId(action.kind, new Set(pipeline.nodes.map((node) => node.id)));
      return {
        ...state,
        pipeline: {
          ...pipeline,
          nodes: [...pipeline.nodes, newNode(action.kind, id, action.x, action.y)],
        },
        selection: { kind: "node", id },
      };
    }
    case "update-node":
      return withPipeline(state, {
        ...pipeline,
        nodes: pipeline.nodes.map((node) => (node.id === action.node.id ? action.node : node)),
      });
    case "move-node": {
      const node = pipeline.nodes.find((candidate) => candidate.id === action.id);
      if (node === undefined || (node.x === action.x && node.y === action.y)) return state;
      return withPipeline(state, {
        ...pipeline,
        nodes: pipeline.nodes.map((candidate) =>
          candidate.id === action.id ? { ...candidate, x: action.x, y: action.y } : candidate,
        ),
      });
    }
    case "connect":
      return connect(state, action);
    case "update-edge":
      return withPipeline(state, {
        ...pipeline,
        edges: pipeline.edges.map((edge) => (edge.id === action.edge.id ? action.edge : edge)),
      });
    case "layout": {
      const moved = pipeline.nodes.map((node) => {
        const to = action.positions[node.id];
        return to === undefined || (to.x === node.x && to.y === node.y)
          ? node
          : { ...node, x: to.x, y: to.y };
      });
      if (moved.every((node, i) => node === pipeline.nodes[i])) return state;
      return withPipeline(state, { ...pipeline, nodes: moved });
    }
    case "remove-selection":
      return removeSelection(state);
    default:
      return state;
  }
};

/** `after`, with `before.pipeline` pushed onto the history unless the edit joins the last one. */
const record = (before: EditorState, after: EditorState, edit: FieldEdit | undefined) => {
  if (after.pipeline === before.pipeline) return after;
  const last = before.lastEdit;
  const joins =
    edit !== undefined && last !== null && last.key === edit.key && edit.at - last.at < COALESCE_MS;
  return {
    ...after,
    past: joins ? before.past : [...before.past, before.pipeline].slice(-HISTORY_LIMIT),
    future: [],
    lastEdit: edit ?? null,
  };
};

export const editorReducer = (state: EditorState, action: EditorAction): EditorState => {
  switch (action.type) {
    case "loaded":
      return initialEditorState(action.pipeline);
    case "saved":
      return { ...state, saved: action.pipeline };
    case "select":
      return { ...state, selection: action.selection };
    case "undo": {
      const previous = state.past.at(-1);
      if (previous === undefined) return state;
      return {
        ...state,
        pipeline: previous,
        past: state.past.slice(0, -1),
        future: [state.pipeline, ...state.future],
        selection: keptSelection(state.selection, previous),
        lastEdit: null,
      };
    }
    case "redo": {
      const [next, ...rest] = state.future;
      if (next === undefined) return state;
      return {
        ...state,
        pipeline: next,
        past: [...state.past, state.pipeline].slice(-HISTORY_LIMIT),
        future: rest,
        selection: keptSelection(state.selection, next),
        lastEdit: null,
      };
    }
    default:
      return record(state, apply(state, action), "edit" in action ? action.edit : undefined);
  }
};
