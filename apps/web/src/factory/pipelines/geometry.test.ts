import { describe, expect, it } from "vite-plus/test";

import {
  MAX_ZOOM,
  MIN_ZOOM,
  NODE_WIDTH,
  afterRect,
  curvePath,
  edgeLabelPoint,
  edgeRoute,
  fitView,
  freeSlot,
  hitTest,
  inputPoint,
  nodeRect,
  pointOnCurve,
  portPoint,
  screenToWorld,
  snap,
  zoomAt,
} from "./geometry";

const at = (x: number, y: number, ports = 2) => nodeRect({ x, y }, ports);

describe("ports and inputs", () => {
  it("puts each port on the right edge, one row below the last", () => {
    const first = portPoint({ x: 100, y: 50 }, 0);
    const second = portPoint({ x: 100, y: 50 }, 1);
    expect(first.x).toBe(100 + NODE_WIDTH);
    expect(second.x).toBe(first.x);
    expect(second.y).toBeGreaterThan(first.y);
  });

  it("makes a node with more ports taller, so every port fits", () => {
    const rect = at(0, 0, 4);
    expect(portPoint(rect, 3).y).toBeLessThan(rect.y + rect.height);
    expect(at(0, 0, 4).height).toBeGreaterThan(at(0, 0, 1).height);
  });

  it("brings edges into the left middle of the target", () => {
    expect(inputPoint({ x: 10, y: 20, width: 100, height: 60 })).toEqual({ x: 10, y: 50 });
  });
});

describe("edgeRoute", () => {
  it("runs forward from the port to the target's input", () => {
    const source = at(40, 200);
    const target = at(400, 200);
    const port = portPoint(source, 0);
    const route = edgeRoute(source, port, target);
    expect(route.kind).toBe("forward");
    expect(route.curve[0]).toEqual(port);
    expect(route.curve[3]).toEqual(inputPoint(target));
    expect(curvePath(route.curve)).toMatch(/^M 224 258 C .* 400 /);
  });

  it("routes a back edge as a loop below both nodes", () => {
    const build = at(280, 200, 3);
    const gate = at(520, 200, 2);
    const route = edgeRoute(gate, portPoint(gate, 1), build);
    expect(route.kind).toBe("loop");
    const lowest = Math.max(build.y + build.height, gate.y + gate.height);
    expect(pointOnCurve(route.curve, 0.5).y).toBeGreaterThan(lowest);
    expect(route.curve[3]).toEqual(inputPoint(build));
  });

  it("treats an edge back into its own node as a loop", () => {
    const node = at(100, 100);
    expect(edgeRoute(node, portPoint(node, 0), node).kind).toBe("loop");
  });

  it("drops to a target below and to the left without looping under it", () => {
    const gate = at(520, 200);
    const stuck = at(280, 420, 0);
    expect(edgeRoute(gate, portPoint(gate, 0), stuck).kind).toBe("down");
  });
});

describe("view", () => {
  it("snaps to the 8 px grid", () => {
    expect(snap(13)).toBe(16);
    expect(snap(11)).toBe(8);
    expect(snap(-3)).toBe(-0);
  });

  it("keeps the world point under the cursor while zooming", () => {
    const view = { x: 30, y: -20, k: 1 };
    const cursor = { x: 300, y: 200 };
    const before = screenToWorld(view, cursor);
    const zoomed = zoomAt(view, 1.5, cursor);
    expect(zoomed.k).toBe(1.5);
    const after = screenToWorld(zoomed, cursor);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it("clamps zoom between a quarter and double", () => {
    expect(zoomAt({ x: 0, y: 0, k: 1 }, 100, { x: 0, y: 0 }).k).toBe(MAX_ZOOM);
    expect(zoomAt({ x: 0, y: 0, k: 1 }, 0.001, { x: 0, y: 0 }).k).toBe(MIN_ZOOM);
  });

  it("fits content into the viewport without zooming past real size", () => {
    const small = fitView({ x: 0, y: 0, width: 100, height: 100 }, { width: 1000, height: 800 });
    expect(small.k).toBe(1);
    expect(small.x).toBe(450);
    const wide = fitView({ x: 0, y: 0, width: 4000, height: 100 }, { width: 1000, height: 800 });
    expect(wide.k).toBeLessThan(1);
  });
});

describe("hitTest", () => {
  const rects = [
    { id: "under", rect: { x: 0, y: 0, width: 100, height: 100 } },
    { id: "over", rect: { x: 50, y: 50, width: 100, height: 100 } },
  ];

  it("finds the topmost rect under the point", () => {
    expect(hitTest(rects, { x: 75, y: 75 })).toBe("over");
    expect(hitTest(rects, { x: 10, y: 10 })).toBe("under");
  });

  it("finds nothing over empty canvas", () => {
    expect(hitTest(rects, { x: 500, y: 500 })).toBeNull();
  });
});

describe("freeSlot", () => {
  const size = { width: NODE_WIDTH, height: 100 };

  it("takes the start when nothing is there", () => {
    expect(freeSlot([], size, { x: 101, y: 203 })).toEqual({ x: 104, y: 200 });
  });

  it("steps right past every node in the way", () => {
    const first = at(280, 200);
    const second = at(280 + NODE_WIDTH + 32, 200);
    const slot = freeSlot([first, second], size, { x: 280, y: 200 });
    expect(slot).toEqual({ x: 280 + 2 * (NODE_WIDTH + 32), y: 200 });
  });

  it("wraps to the next row when a row is full", () => {
    const row = Array.from({ length: 6 }, (_, i) => at(i * (NODE_WIDTH + 32), 0));
    expect(freeSlot(row, size, { x: 0, y: 0 })).toEqual({ x: 0, y: 200 });
  });

  it("takes the size from a rect that carries its own x and y, and still moves", () => {
    // The editor passes a measured node rect as the size. Its x and y are 0, and must not pin
    // every candidate to the origin: with a node at the origin that never ends.
    const measured = nodeRect({ x: 0, y: 0 }, 2);
    const slot = freeSlot([at(40, 40, 1)], measured, { x: 40, y: 40 });
    expect(slot).toEqual({ x: 40 + NODE_WIDTH + 32, y: 40 });
  });

  it("gives up on a wall of nodes after a bounded search instead of spinning", () => {
    const wall = Array.from({ length: 6 * 60 }, (_, i) =>
      at((i % 6) * (NODE_WIDTH + 32), Math.floor(i / 6) * 200),
    );
    const slot = freeSlot(wall, size, { x: 0, y: 0 });
    expect(slot.y).toBeGreaterThanOrEqual(60 * 200);
  });

  it("starts after a node one gap to its right, level with it", () => {
    const node = at(280, 200);
    expect(afterRect(node)).toEqual({ x: 280 + NODE_WIDTH + 32, y: 200 });
  });
});

describe("edgeLabelPoint", () => {
  it("puts a forward edge's label 30% along from the source", () => {
    const source = at(40, 200);
    const route = edgeRoute(source, portPoint(source, 0), at(400, 200));
    expect(edgeLabelPoint(route)).toEqual(pointOnCurve(route.curve, 0.3));
  });

  it("parts the labels of edges that leave nearby ports for one target", () => {
    const build = at(280, 200, 3);
    const stuck = at(760, 420, 0);
    const labels = [0, 1, 2].map((index) =>
      edgeLabelPoint(edgeRoute(build, portPoint(build, index), stuck)),
    );
    expect(labels[1]!.y - labels[0]!.y).toBeGreaterThan(10);
    expect(labels[2]!.y - labels[1]!.y).toBeGreaterThan(10);
  });

  it("puts a loop's label at the lowest point of the loop", () => {
    const build = at(280, 200, 3);
    const gate = at(520, 200, 2);
    const route = edgeRoute(gate, portPoint(gate, 1), build);
    const label = edgeLabelPoint(route);
    for (let t = 0; t <= 1; t += 0.05) {
      expect(label.y).toBeGreaterThanOrEqual(pointOnCurve(route.curve, t).y - 0.5);
    }
  });
});
