/**
 * Tidy: a layered layout of a pipeline, pure so it is tested on the fixture shapes. Columns are
 * ranks, the longest path from Start over the forward edges; rows follow a breadth-first walk;
 * stuck ends sit in a row of their own at the bottom, out of the way of the work.
 */
import type { Point } from "./geometry";
import type { Pipeline } from "./types";

export const COLUMN_STEP = 240;
export const ROW_STEP = 200;
const ORIGIN = { x: 40, y: 40 };

/**
 * The loop edges: those a depth-first walk from Start (then from any node it missed, in pipeline
 * order) finds pointing back at a node still open on the walk. Removing them leaves the forward
 * graph acyclic. "An edge whose target can reach its source" would also drop forward edges that
 * sit inside a loop (build to gate, when gate fails back to build), leaving gate with no rank.
 */
export const loopEdges = (pipeline: Pipeline): ReadonlySet<string> => {
  const out = new Map<string, Array<{ id: string; to: string }>>();
  for (const edge of pipeline.edges) {
    const list = out.get(edge.from) ?? [];
    list.push({ id: edge.id, to: edge.to });
    out.set(edge.from, list);
  }
  const state = new Map<string, "open" | "done">();
  const loops = new Set<string>();
  const visit = (id: string) => {
    state.set(id, "open");
    for (const edge of out.get(id) ?? []) {
      const seen = state.get(edge.to);
      if (seen === "open") loops.add(edge.id);
      else if (seen === undefined) visit(edge.to);
    }
    state.set(id, "done");
  };
  const roots = [
    ...pipeline.nodes.filter((node) => node.kind === "start"),
    ...pipeline.nodes.filter((node) => node.kind !== "start"),
  ];
  for (const node of roots) if (!state.has(node.id)) visit(node.id);
  return loops;
};

/** Each node's rank: the longest path to it over the forward edges, 0 for a node nothing enters. */
const ranksOf = (pipeline: Pipeline, loops: ReadonlySet<string>): Map<string, number> => {
  const forward = pipeline.edges.filter((edge) => !loops.has(edge.id));
  const ranks = new Map(pipeline.nodes.map((node) => [node.id, 0]));
  // Longest paths in a DAG settle within one pass per node; the graph is small.
  for (let pass = 0; pass < pipeline.nodes.length; pass++) {
    let changed = false;
    for (const edge of forward) {
      const from = ranks.get(edge.from);
      const to = ranks.get(edge.to);
      if (from === undefined || to === undefined) continue;
      if (from + 1 > to) {
        ranks.set(edge.to, from + 1);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return ranks;
};

/** Nodes in the order a breadth-first walk from Start meets them, then the rest in pipeline order. */
const walkOrder = (pipeline: Pipeline): ReadonlyArray<string> => {
  const seen = new Set<string>();
  const order: Array<string> = [];
  const start = pipeline.nodes.find((node) => node.kind === "start");
  const queue = start === undefined ? [] : [start.id];
  if (start !== undefined) seen.add(start.id);
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const edge of pipeline.edges) {
      if (edge.from === id && !seen.has(edge.to)) {
        seen.add(edge.to);
        queue.push(edge.to);
      }
    }
  }
  for (const node of pipeline.nodes) if (!seen.has(node.id)) order.push(node.id);
  return order;
};

/** Where Tidy puts each node, by id. */
export const tidyLayout = (pipeline: Pipeline): Record<string, Point> => {
  const ranks = ranksOf(pipeline, loopEdges(pipeline));
  const isStuck = new Set(
    pipeline.nodes
      .filter((node) => node.kind === "end" && node.result === "stuck")
      .map((node) => node.id),
  );
  const order = walkOrder(pipeline);
  const rowsUsed = new Map<number, number>();
  const positions: Record<string, Point> = {};
  for (const id of order) {
    if (isStuck.has(id)) continue;
    const rank = ranks.get(id) ?? 0;
    const row = rowsUsed.get(rank) ?? 0;
    rowsUsed.set(rank, row + 1);
    positions[id] = { x: ORIGIN.x + rank * COLUMN_STEP, y: ORIGIN.y + row * ROW_STEP };
  }
  const bottom = ORIGIN.y + Math.max(0, ...rowsUsed.values()) * ROW_STEP;
  const stuckColumns = new Set<number>();
  for (const id of order) {
    if (!isStuck.has(id)) continue;
    let rank = ranks.get(id) ?? 0;
    while (stuckColumns.has(rank)) rank++;
    stuckColumns.add(rank);
    positions[id] = { x: ORIGIN.x + rank * COLUMN_STEP, y: bottom };
  }
  return positions;
};
