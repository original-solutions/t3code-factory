import { describe, expect, it } from "vite-plus/test";

import {
  HISTORY_LIMIT,
  canRedo,
  canUndo,
  editorReducer,
  initialEditorState,
  isDirty,
  type EditorState,
} from "./editorState";
import type { Pipeline } from "./types";

const PIPELINE: Pipeline = {
  id: "p",
  name: "P",
  nodes: [
    { id: "start", kind: "start", x: 40, y: 200 },
    {
      id: "build",
      kind: "agent",
      x: 280,
      y: 200,
      instructions: { skill: "factory" },
      fresh: false,
    },
    { id: "done", kind: "end", result: "done", x: 520, y: 200 },
  ],
  edges: [
    { id: "e1", from: "start", port: "next", to: "build" },
    { id: "e2", from: "build", port: "done", to: "done", max: 3 },
  ],
};

const reduce = (state: EditorState, ...actions: Parameters<typeof editorReducer>[1][]) =>
  actions.reduce(editorReducer, state);

describe("editorReducer", () => {
  it("starts clean and is dirty after an edit", () => {
    const state = initialEditorState(PIPELINE);
    expect(isDirty(state)).toBe(false);
    expect(isDirty(reduce(state, { type: "rename", name: "Q" }))).toBe(true);
  });

  it("is clean after saving what it holds, but not after saving an older body", () => {
    const edited = reduce(initialEditorState(PIPELINE), { type: "rename", name: "Q" });
    expect(isDirty(reduce(edited, { type: "saved", pipeline: edited.pipeline }))).toBe(false);
    const later = reduce(edited, { type: "rename", name: "R" });
    expect(isDirty(reduce(later, { type: "saved", pipeline: edited.pipeline }))).toBe(true);
  });

  it("adds a node with a free id and selects it", () => {
    const state = reduce(
      initialEditorState(PIPELINE),
      { type: "add-node", kind: "agent", x: 0, y: 0 },
      { type: "add-node", kind: "agent", x: 8, y: 8 },
    );
    expect(state.pipeline.nodes.map((node) => node.id)).toEqual([
      "start",
      "build",
      "done",
      "agent",
      "agent-2",
    ]);
    expect(state.selection).toEqual({ kind: "node", id: "agent-2" });
    expect(state.pipeline.nodes[3]).toMatchObject({ kind: "agent", fresh: false });
  });

  it("connects a free port with the lowest free edge id", () => {
    const state = reduce(initialEditorState(PIPELINE), {
      type: "connect",
      from: "build",
      port: "stop",
      to: "done",
    });
    expect(state.pipeline.edges.at(-1)).toEqual({
      id: "e3",
      from: "build",
      port: "stop",
      to: "done",
    });
    expect(state.selection).toEqual({ kind: "edge", id: "e3" });
  });

  it("moves a port's edge when it is connected again, keeping its limit", () => {
    const state = reduce(initialEditorState(PIPELINE), {
      type: "connect",
      from: "build",
      port: "done",
      to: "build",
    });
    expect(state.pipeline.edges).toHaveLength(2);
    expect(state.pipeline.edges[1]).toEqual({
      id: "e2",
      from: "build",
      port: "done",
      to: "build",
      max: 3,
    });
  });

  it("moves a node, and a move to where it is changes nothing", () => {
    const start = initialEditorState(PIPELINE);
    const moved = reduce(start, { type: "move-node", id: "build", x: 296, y: 216 });
    expect(moved.pipeline.nodes[1]).toMatchObject({ x: 296, y: 216 });
    expect(reduce(start, { type: "move-node", id: "build", x: 280, y: 200 })).toBe(start);
  });

  it("removes a selected node with the edges into and out of it", () => {
    const state = reduce(
      initialEditorState(PIPELINE),
      { type: "select", selection: { kind: "node", id: "build" } },
      { type: "remove-selection" },
    );
    expect(state.pipeline.nodes.map((node) => node.id)).toEqual(["start", "done"]);
    expect(state.pipeline.edges).toEqual([]);
    expect(state.selection).toBeNull();
  });

  it("removes a selected edge only", () => {
    const state = reduce(
      initialEditorState(PIPELINE),
      { type: "select", selection: { kind: "edge", id: "e1" } },
      { type: "remove-selection" },
    );
    expect(state.pipeline.edges.map((edge) => edge.id)).toEqual(["e2"]);
    expect(state.pipeline.nodes).toHaveLength(3);
  });

  it("moves every node Tidy names in one change", () => {
    const start = initialEditorState(PIPELINE);
    const state = reduce(start, {
      type: "layout",
      positions: { start: { x: 40, y: 40 }, build: { x: 280, y: 40 } },
    });
    expect(state.pipeline.nodes.map(({ x, y }) => [x, y])).toEqual([
      [40, 40],
      [280, 40],
      [520, 200],
    ]);
    expect(isDirty(state)).toBe(true);
    expect(reduce(start, { type: "layout", positions: { done: { x: 520, y: 200 } } })).toBe(start);
  });

  it("never gives a deleted edge's id to a new one", () => {
    const state = reduce(
      initialEditorState(PIPELINE),
      { type: "select", selection: { kind: "edge", id: "e2" } },
      { type: "remove-selection" },
      { type: "connect", from: "build", port: "stop", to: "done" },
    );
    expect(state.pipeline.edges.map((edge) => edge.id)).toEqual(["e1", "e3"]);
  });
});

describe("undo", () => {
  const rename = (name: string, at: number) =>
    ({ type: "rename", name, edit: { key: "name", at } }) as const;

  it("undoes and redoes a structural edit, and is clean back at the saved pipeline", () => {
    const start = initialEditorState(PIPELINE);
    const added = reduce(start, { type: "add-node", kind: "verify", x: 0, y: 0 });
    const undone = reduce(added, { type: "undo" });
    expect(undone.pipeline).toBe(PIPELINE);
    expect(isDirty(undone)).toBe(false);
    expect(undone.selection).toBeNull();
    expect(canRedo(undone)).toBe(true);
    const redone = reduce(undone, { type: "redo" });
    expect(redone.pipeline).toBe(added.pipeline);
    expect(canRedo(redone)).toBe(false);
  });

  it("joins edits to one field within half a second into one step", () => {
    const state = reduce(
      initialEditorState(PIPELINE),
      rename("Q", 0),
      rename("Qu", 200),
      rename("Que", 650),
      rename("Quea", 1_500),
    );
    expect(state.past.map((pipeline) => pipeline.name)).toEqual(["P", "Que"]);
    expect(reduce(state, { type: "undo" }).pipeline.name).toBe("Que");
  });

  it("does not join edits to different fields", () => {
    const node = PIPELINE.nodes[1]!;
    const state = reduce(initialEditorState(PIPELINE), rename("Q", 0), {
      type: "update-node",
      node: { ...node, label: "B" },
      edit: { key: "node build label", at: 100 },
    });
    expect(state.past).toHaveLength(2);
  });

  it("drops what was undone once something new is done", () => {
    const state = reduce(
      initialEditorState(PIPELINE),
      { type: "move-node", id: "build", x: 8, y: 8 },
      { type: "undo" },
      { type: "move-node", id: "done", x: 16, y: 16 },
    );
    expect(canRedo(state)).toBe(false);
    expect(canUndo(state)).toBe(true);
  });

  it("keeps at most fifty steps", () => {
    const moves = Array.from({ length: HISTORY_LIMIT + 10 }, (_, i) => ({
      type: "move-node" as const,
      id: "build",
      x: (i + 1) * 8,
      y: 200,
    }));
    const state = reduce(initialEditorState(PIPELINE), ...moves);
    expect(state.past).toHaveLength(HISTORY_LIMIT);
  });

  it("does not record selecting or a no-op", () => {
    const state = reduce(
      initialEditorState(PIPELINE),
      { type: "select", selection: { kind: "node", id: "build" } },
      { type: "move-node", id: "build", x: 280, y: 200 },
    );
    expect(canUndo(state)).toBe(false);
  });
});
