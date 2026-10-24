/**
 * The editor's state as a reducer: the pipeline being edited, the one last saved, and the
 * selection. Pure, so adding, connecting, moving and removing are tested without a browser.
 */
import type { Instructions, Kind, Pipeline, PipelineEdge, PipelineNode } from "./types";

export type Selection =
  | { readonly kind: "node"; readonly id: string }
  | { readonly kind: "edge"; readonly id: string }
  | null;

export type EditorState = {
  readonly pipeline: Pipeline;
  /** The pipeline as last loaded or saved; the editor is dirty while `pipeline` is another object. */
  readonly saved: Pipeline;
  readonly selection: Selection;
};

export type EditorAction =
  | { readonly type: "loaded"; readonly pipeline: Pipeline }
  /** `pipeline` is the body that was saved: edits made while the save was in flight stay dirty. */
  | { readonly type: "saved"; readonly pipeline: Pipeline }
  | { readonly type: "select"; readonly selection: Selection }
  | { readonly type: "rename"; readonly name: string }
  | { readonly type: "add-node"; readonly kind: Kind; readonly x: number; readonly y: number }
  | { readonly type: "update-node"; readonly node: PipelineNode }
  | { readonly type: "move-node"; readonly id: string; readonly x: number; readonly y: number }
  | {
      readonly type: "connect";
      readonly from: string;
      readonly port: string;
      readonly to: string;
    }
  | { readonly type: "update-edge"; readonly edge: PipelineEdge }
  | { readonly type: "remove-selection" };

export const initialEditorState = (pipeline: Pipeline): EditorState => ({
  pipeline,
  saved: pipeline,
  selection: null,
});

export const isDirty = (state: EditorState): boolean => state.pipeline !== state.saved;

/** `base` if no id in `taken` has it, else `base-2`, `base-3`, ... */
export const freeId = (base: string, taken: ReadonlySet<string>): string => {
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
};

/** `e1`, `e2`, ...: the lowest edge id not in use, as the design doc's examples number them. */
export const freeEdgeId = (edges: ReadonlyArray<PipelineEdge>): string => {
  const taken = new Set(edges.map((edge) => edge.id));
  let n = 1;
  while (taken.has(`e${n}`)) n++;
  return `e${n}`;
};

const EMPTY_BRIEF: Instructions = { brief: "" };

/**
 * A new node of `kind`. A node that runs an agent starts with an empty brief, which the server
 * reports until the person writes one or picks a skill: no default would be the right one.
 */
export const newNode = (kind: Kind, id: string, x: number, y: number): PipelineNode => {
  const base = { id, x, y };
  switch (kind) {
    case "start":
    case "ask":
    case "pr":
      return { ...base, kind };
    case "agent":
      return { ...base, kind, instructions: EMPTY_BRIEF, fresh: false };
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

export const editorReducer = (state: EditorState, action: EditorAction): EditorState => {
  const { pipeline } = state;
  switch (action.type) {
    case "loaded":
      return initialEditorState(action.pipeline);
    case "saved":
      return { ...state, saved: action.pipeline };
    case "select":
      return { ...state, selection: action.selection };
    case "rename":
      return withPipeline(state, { ...pipeline, name: action.name });
    case "add-node": {
      const id = freeId(action.kind, new Set(pipeline.nodes.map((node) => node.id)));
      return {
        pipeline: {
          ...pipeline,
          nodes: [...pipeline.nodes, newNode(action.kind, id, action.x, action.y)],
        },
        saved: state.saved,
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
    case "connect": {
      // One edge per port: a new connection from a port replaces the old one, keeping its id,
      // limit and instructions, since the person is moving the transition, not starting over.
      const existing = pipeline.edges.find(
        (edge) => edge.from === action.from && edge.port === action.port,
      );
      if (existing !== undefined) {
        if (existing.to === action.to)
          return { ...state, selection: { kind: "edge", id: existing.id } };
        return {
          pipeline: {
            ...pipeline,
            edges: pipeline.edges.map((edge) =>
              edge.id === existing.id ? { ...edge, to: action.to } : edge,
            ),
          },
          saved: state.saved,
          selection: { kind: "edge", id: existing.id },
        };
      }
      const id = freeEdgeId(pipeline.edges);
      return {
        pipeline: {
          ...pipeline,
          edges: [...pipeline.edges, { id, from: action.from, port: action.port, to: action.to }],
        },
        saved: state.saved,
        selection: { kind: "edge", id },
      };
    }
    case "update-edge":
      return withPipeline(state, {
        ...pipeline,
        edges: pipeline.edges.map((edge) => (edge.id === action.edge.id ? action.edge : edge)),
      });
    case "remove-selection":
      return removeSelection(state);
  }
};
