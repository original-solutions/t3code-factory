/**
 * The canvas's geometry, pure so it is tested without a browser. World coordinates are the
 * pipeline's own `x`, `y`; the view maps them to the screen as `screen = world * k + (x, y)`.
 * A node's size follows from its port count, so a port's position is known without measuring.
 */

export type Point = { readonly x: number; readonly y: number };

export type Rect = Point & { readonly width: number; readonly height: number };

export type View = { readonly x: number; readonly y: number; readonly k: number };

export const GRID = 8;
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 2;

export const NODE_WIDTH = 184;
/** Where the first port row starts, below the kind, label and summary lines. */
export const PORTS_TOP = 64;
export const PORT_ROW = 20;
const PORTS_BOTTOM_PAD = 6;
const PORTLESS_HEIGHT = 68;

export const nodeHeight = (portCount: number): number =>
  portCount === 0 ? PORTLESS_HEIGHT : PORTS_TOP + portCount * PORT_ROW + PORTS_BOTTOM_PAD;

export const nodeRect = (node: Point, portCount: number): Rect => ({
  x: node.x,
  y: node.y,
  width: NODE_WIDTH,
  height: nodeHeight(portCount),
});

/** The middle of port `index`'s handle, on the node's right edge. */
export const portPoint = (node: Point, index: number): Point => ({
  x: node.x + NODE_WIDTH,
  y: node.y + PORTS_TOP + index * PORT_ROW + PORT_ROW / 2,
});

/** Where edges arrive: the node's left middle. */
export const inputPoint = (rect: Rect): Point => ({ x: rect.x, y: rect.y + rect.height / 2 });

export const snap = (value: number, grid: number = GRID): number => Math.round(value / grid) * grid;

export const clampZoom = (k: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));

export const screenToWorld = (view: View, point: Point): Point => ({
  x: (point.x - view.x) / view.k,
  y: (point.y - view.y) / view.k,
});

/** The view zoomed by `factor` (clamped) so the world point under `cursor` stays under it. */
export const zoomAt = (view: View, factor: number, cursor: Point): View => {
  const k = clampZoom(view.k * factor);
  const world = screenToWorld(view, cursor);
  return { k, x: cursor.x - world.x * k, y: cursor.y - world.y * k };
};

/** The smallest rect holding every rect, or null for none. */
export const boundsOf = (rects: ReadonlyArray<Rect>): Rect | null => {
  if (rects.length === 0) return null;
  const left = Math.min(...rects.map((r) => r.x));
  const top = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.width));
  const bottom = Math.max(...rects.map((r) => r.y + r.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
};

/**
 * The view that shows `bounds` centred in a viewport `size`, with `padding` around it. It never
 * zooms in past 1, so a small pipeline reads at its real size.
 */
export const fitView = (
  bounds: Rect,
  size: { readonly width: number; readonly height: number },
  padding = 48,
): View => {
  const k = clampZoom(
    Math.min(
      1,
      (size.width - padding * 2) / Math.max(bounds.width, 1),
      (size.height - padding * 2) / Math.max(bounds.height, 1),
    ),
  );
  return {
    k,
    x: (size.width - bounds.width * k) / 2 - bounds.x * k,
    y: (size.height - bounds.height * k) / 2 - bounds.y * k,
  };
};

const contains = (rect: Rect, point: Point): boolean =>
  point.x >= rect.x &&
  point.x <= rect.x + rect.width &&
  point.y >= rect.y &&
  point.y <= rect.y + rect.height;

/** The id of the topmost (last drawn) rect containing `point`, or null. */
export const hitTest = (
  rects: ReadonlyArray<{ readonly id: string; readonly rect: Rect }>,
  point: Point,
): string | null => {
  for (let i = rects.length - 1; i >= 0; i--) {
    if (contains(rects[i]!.rect, point)) return rects[i]!.id;
  }
  return null;
};

/** A cubic bezier: start, two control points, end. */
export type Curve = readonly [Point, Point, Point, Point];

export type EdgeRoute = {
  /** `forward` runs right; `down` drops to a target below and to the left; `loop` goes back under both nodes. */
  readonly kind: "forward" | "down" | "loop";
  readonly curve: Curve;
};

/** How far right a target must start for an edge to run forward. */
const FORWARD_MARGIN = 24;

/**
 * The route of an edge from `port` on `source` into `target`'s left middle. A target to the
 * right reads left to right. A target to the left whose top is below the source drops in an S.
 * Any other target to the left is a back edge, a loop: it leaves right, passes under both nodes
 * with wide control points, and comes into the target from the left.
 */
export const edgeRoute = (source: Rect, port: Point, target: Rect): EdgeRoute => {
  const end = inputPoint(target);
  if (end.x >= port.x + FORWARD_MARGIN) {
    const dx = Math.max(48, (end.x - port.x) / 2);
    return {
      kind: "forward",
      curve: [port, { x: port.x + dx, y: port.y }, { x: end.x - dx, y: end.y }, end],
    };
  }
  if (target.y > source.y + source.height + 16) {
    return {
      kind: "down",
      curve: [port, { x: port.x + 72, y: port.y }, { x: end.x - 72, y: end.y }, end],
    };
  }
  const below = Math.max(source.y + source.height, target.y + target.height) + 64;
  return {
    kind: "loop",
    curve: [port, { x: port.x + 120, y: below }, { x: end.x - 120, y: below }, end],
  };
};

/** The live preview while a connection is dragged from `port` to the pointer. */
export const previewCurve = (port: Point, to: Point): Curve => {
  const dx = Math.max(48, Math.abs(to.x - port.x) / 2);
  return [port, { x: port.x + dx, y: port.y }, { x: to.x - dx, y: to.y }, to];
};

export const pointOnCurve = ([p0, p1, p2, p3]: Curve, t: number): Point => {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
};

const round = (n: number) => Math.round(n * 10) / 10;

export const curvePath = ([p0, p1, p2, p3]: Curve): string =>
  `M ${round(p0.x)} ${round(p0.y)} C ${round(p1.x)} ${round(p1.y)}, ${round(p2.x)} ${round(p2.y)}, ${round(p3.x)} ${round(p3.y)}`;
