/**
 * The node editor: nodes are positioned divs in a transformed layer, edges are SVG paths drawn in
 * the same coordinate space. Geometry lives in `geometry.ts`; this file only maps pointer, wheel
 * and key input onto it. Nothing animates: every repaint follows an input.
 *
 * A pan changes only the layer transforms and the grid: the nodes, edges and labels are memoised
 * on primitive props and handed handlers that never change, so they keep their render. A drag
 * re-renders the dragged node and the edges whose path moved.
 */
import { LayoutGridIcon, MaximizeIcon, MinusIcon, PlusIcon } from "lucide-react";
import {
  memo,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type Ref,
} from "react";

import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";

import type { Selection } from "./editorState";
import {
  NODE_WIDTH,
  boundsOf,
  curvePath,
  edgeLabelPoint,
  edgeRoute,
  fitView,
  hitTest,
  nodeRect,
  portPoint,
  previewCurve,
  screenToWorld,
  snap,
  zoomAt,
  type Point,
  type Rect,
  type View,
} from "./geometry";
import { tidyLayout } from "./layout";
import {
  KIND_ACCENT,
  edgeLabelText,
  hasOwnLabel,
  kindLabel,
  nodeName,
  summaryOf,
  type Trail,
} from "./model";
import type { Kind, KindInfo, Pipeline, PipelineNode, Problem } from "./types";

export type CanvasHandle = {
  /** The world point at the middle of the viewport, where a new node goes. */
  readonly centre: () => Point;
};

type Gesture =
  | { readonly kind: "pan"; readonly start: Point; readonly view: View; moved: boolean }
  | {
      readonly kind: "drag";
      readonly id: string;
      readonly start: Point;
      readonly origin: Point;
      moved: boolean;
    }
  | {
      readonly kind: "connect";
      readonly from: string;
      readonly port: string;
      readonly start: Point;
      moved: boolean;
    };

/** Pointer travel, in screen pixels, below which a press is a click and not a drag. */
const CLICK_SLOP = 3;
const DEFAULT_VIEW: View = { x: 0, y: 0, k: 1 };
const ZOOM_STEP = 1.2;
const NO_PORTS: ReadonlySet<string> = new Set();
const NO_PROBLEMS: ReadonlyArray<Problem> = [];
const NO_PORT_NAMES: ReadonlyArray<string> = [];

const levelOf = (problems: ReadonlyArray<Problem>): "error" | "warning" | null =>
  problems.some((problem) => problem.level === "error")
    ? "error"
    : problems.length > 0
      ? "warning"
      : null;

function ProblemDot({ problems }: { problems: ReadonlyArray<Problem> }) {
  const level = levelOf(problems);
  if (level === null) return null;
  const text = problems.map((problem) => problem.message).join("\n");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-label={`${level === "error" ? "Error" : "Warning"}: ${text}`}
            className={cn(
              "inline-block size-2 shrink-0 rounded-full",
              level === "error" ? "bg-destructive" : "bg-warning",
            )}
            role="img"
          />
        }
      />
      <TooltipPopup className="max-w-72 whitespace-pre-line" side="top">
        {text}
      </TooltipPopup>
    </Tooltip>
  );
}

type NodeMark = "current" | "visited" | "dim" | null;

/** Handlers the canvas creates once; they read the latest props and view through refs. */
type Handlers = {
  readonly nodePointerDown: (event: ReactPointerEvent<HTMLElement>, node: PipelineNode) => void;
  readonly nodeKeyDown: (event: ReactKeyboardEvent<HTMLElement>, id: string) => void;
  readonly portPointerDown: (
    event: ReactPointerEvent<HTMLElement>,
    node: PipelineNode,
    port: string,
  ) => void;
  readonly edgePointerDown: (event: ReactPointerEvent<Element>, id: string) => void;
  readonly edgeClick: (id: string) => void;
};

const NodeCard = memo(function NodeCard({
  node,
  height,
  kinds,
  ports,
  connected,
  selected,
  mark,
  problems,
  handlers,
}: {
  node: PipelineNode;
  height: number;
  kinds: ReadonlyArray<KindInfo>;
  ports: ReadonlyArray<string>;
  connected: ReadonlySet<string>;
  selected: boolean;
  mark: NodeMark;
  problems: ReadonlyArray<Problem>;
  handlers: Handlers;
}) {
  const name = nodeName(kinds, node);
  const style = {
    left: node.x,
    top: node.y,
    width: NODE_WIDTH,
    height,
    "--kind": KIND_ACCENT[node.kind],
  } as CSSProperties;
  return (
    <div
      aria-current={mark === "current" ? "step" : undefined}
      aria-label={`${name} node`}
      aria-pressed={selected}
      className={cn(
        "absolute cursor-grab touch-none select-none rounded-lg border bg-card text-card-foreground shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        selected && "ring-2 ring-ring",
        mark === "current" && "ring-2 ring-primary",
        mark === "dim" && "opacity-50",
      )}
      data-node={node.id}
      onKeyDown={(event) => handlers.nodeKeyDown(event, node.id)}
      onPointerDown={(event) => handlers.nodePointerDown(event, node)}
      role="button"
      style={style}
      tabIndex={0}
    >
      <span
        aria-hidden="true"
        className="absolute inset-y-0 left-0 w-1 rounded-l-lg"
        style={{ background: "var(--kind)" }}
      />
      <div className="flex flex-col px-3 pt-2">
        <div className="flex h-5 min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate text-sm font-medium">{name}</span>
          {/* The kind is the title when there is no label of its own; say it once. */}
          {hasOwnLabel(kinds, node) ? (
            <span className="shrink-0 text-xs" style={{ color: "var(--kind)" }}>
              {kindLabel(kinds, node.kind)}
            </span>
          ) : null}
          <span className="ml-auto flex shrink-0 items-center">
            <ProblemDot problems={problems} />
          </span>
        </div>
        <div className="h-4 truncate text-xs text-muted-foreground">{summaryOf(node)}</div>
      </div>
      {ports.map((port, index) => {
        const point = portPoint(node, index);
        return (
          <div
            aria-label={`Connect ${port} from ${name}`}
            className="absolute right-0 flex cursor-crosshair items-center justify-end gap-1.5 pl-3 text-xs text-muted-foreground"
            key={port}
            onPointerDown={(event) => handlers.portPointerDown(event, node, port)}
            role="button"
            style={{ top: point.y - node.y - 10, height: 20 }}
            tabIndex={-1}
          >
            <span className="truncate">{port}</span>
            <span
              aria-hidden="true"
              className="-mr-1.5 size-3 shrink-0 rounded-full border-2 bg-background"
              style={{
                borderColor: "var(--kind)",
                ...(connected.has(port) ? { background: "var(--kind)" } : {}),
              }}
            />
          </div>
        );
      })}
    </div>
  );
});

type EdgeLook = "normal" | "selected" | "trail" | "dim";

const EdgePath = memo(function EdgePath({
  id,
  d,
  endX,
  endY,
  look,
  handlers,
}: {
  id: string;
  d: string;
  endX: number;
  endY: number;
  look: EdgeLook;
  handlers: Handlers;
}) {
  const strong = look === "selected" || look === "trail";
  const stroke = strong ? "var(--color-primary)" : "var(--color-muted-foreground)";
  return (
    <g opacity={look === "dim" ? 0.4 : 1}>
      <path d={d} fill="none" stroke={stroke} strokeWidth={strong ? 2.5 : 1.5} />
      <path
        d={`M ${endX - 7} ${endY - 4} L ${endX} ${endY} L ${endX - 7} ${endY + 4} Z`}
        fill={stroke}
      />
      <path
        className="cursor-pointer"
        d={d}
        fill="none"
        onPointerDown={(event) => handlers.edgePointerDown(event, id)}
        pointerEvents="stroke"
        stroke="transparent"
        strokeWidth={14}
      />
    </g>
  );
});

const EdgeLabel = memo(function EdgeLabel({
  id,
  name,
  text,
  x,
  y,
  selected,
  problems,
  handlers,
}: {
  id: string;
  name: string;
  text: string;
  x: number;
  y: number;
  selected: boolean;
  problems: ReadonlyArray<Problem>;
  handlers: Handlers;
}) {
  return (
    <button
      aria-label={name}
      aria-pressed={selected}
      className={cn(
        "absolute flex -translate-x-1/2 -translate-y-1/2 items-center gap-1 whitespace-nowrap rounded-sm border bg-background px-1 text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        selected && "border-primary text-foreground",
      )}
      onClick={() => handlers.edgeClick(id)}
      onPointerDown={(event) => handlers.edgePointerDown(event, id)}
      style={{ left: x, top: y }}
      type="button"
    >
      {text}
      <ProblemDot problems={problems} />
    </button>
  );
});

type Latest = {
  readonly rects: ReadonlyArray<{ readonly id: string; readonly rect: Rect }>;
  readonly portsOfKind: (kind: Kind) => ReadonlyArray<string>;
  readonly readOnly: boolean;
  readonly onSelect: (selection: Selection) => void;
};

export function Canvas({
  pipeline,
  kinds,
  selection,
  problems,
  trail,
  taken,
  readOnly = false,
  onSelect,
  onMove,
  onConnect,
  onLayout,
  ref,
}: {
  pipeline: Pipeline;
  kinds: ReadonlyArray<KindInfo>;
  selection: Selection;
  problems: ReadonlyArray<Problem>;
  /** A simulation's or a run's walk: visited nodes and edges, and where it is. */
  trail: Trail | null;
  /** Traversals per edge for the trail, shown on the edge labels. */
  taken: Readonly<Record<string, number>> | null;
  /** Shows the graph without letting it be edited: a run's own snapshot. */
  readOnly?: boolean;
  onSelect: (selection: Selection) => void;
  onMove: (id: string, x: number, y: number) => void;
  onConnect: (from: string, port: string, to: string) => void;
  onLayout: (positions: Readonly<Record<string, Point>>) => void;
  ref?: Ref<CanvasHandle>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const viewRef = useRef<View>(DEFAULT_VIEW);
  const [view, setViewState] = useState<View>(DEFAULT_VIEW);
  const [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(null);
  const [preview, setPreview] = useState<{ from: Point; to: Point } | null>(null);

  const portsByKind = new Map(kinds.map((info) => [info.kind, info.ports.map((p) => p.name)]));
  const portsOfKind = (kind: Kind) => portsByKind.get(kind) ?? NO_PORT_NAMES;

  const placed = pipeline.nodes.map((node) =>
    drag !== null && drag.id === node.id ? { ...node, x: drag.x, y: drag.y } : node,
  );
  const rects = placed.map((node) => ({
    id: node.id,
    node,
    rect: nodeRect(node, portsOfKind(node.kind).length),
  }));
  const rectById = new Map(rects.map((entry) => [entry.id, entry]));

  const drawn = pipeline.edges.flatMap((edge) => {
    const source = rectById.get(edge.from);
    const target = rectById.get(edge.to);
    if (source === undefined || target === undefined) return [];
    const index = portsOfKind(source.node.kind).indexOf(edge.port);
    if (index < 0) return [];
    const route = edgeRoute(source.rect, portPoint(source.node, index), target.rect);
    return [{ edge, d: curvePath(route.curve), end: route.curve[3], label: edgeLabelPoint(route) }];
  });

  const connectedPorts = new Map<string, Set<string>>();
  for (const edge of pipeline.edges) {
    const set = connectedPorts.get(edge.from) ?? new Set<string>();
    set.add(edge.port);
    connectedPorts.set(edge.from, set);
  }
  const problemsByNode = new Map<string, Array<Problem>>();
  const problemsByEdge = new Map<string, Array<Problem>>();
  for (const problem of problems) {
    const owner =
      problem.node !== undefined
        ? { map: problemsByNode, id: problem.node }
        : problem.edge !== undefined
          ? { map: problemsByEdge, id: problem.edge }
          : null;
    if (owner === null) continue;
    owner.map.set(owner.id, [...(owner.map.get(owner.id) ?? []), problem]);
  }

  const latest = useRef<Latest | null>(null);
  useLayoutEffect(() => {
    latest.current = { rects, portsOfKind, readOnly, onSelect };
  });

  const setView = (next: View) => {
    viewRef.current = next;
    setViewState(next);
  };

  const local = (event: { clientX: number; clientY: number }): Point => {
    const box = containerRef.current?.getBoundingClientRect();
    return { x: event.clientX - (box?.left ?? 0), y: event.clientY - (box?.top ?? 0) };
  };

  const fitTo = (bounds: Rect | null) => {
    const box = containerRef.current?.getBoundingClientRect();
    if (bounds === null || box === undefined || box.width === 0 || box.height === 0) return;
    setView(fitView(bounds, { width: box.width, height: box.height }));
  };

  useImperativeHandle(ref, () => ({
    centre: () => {
      const box = containerRef.current?.getBoundingClientRect();
      return screenToWorld(viewRef.current, {
        x: (box?.width ?? 0) / 2,
        y: (box?.height ?? 0) / 2,
      });
    },
  }));

  useEffect(() => {
    const element = containerRef.current;
    if (element === null) return;
    const apply = (next: View) => {
      viewRef.current = next;
      setViewState(next);
    };
    let fitted = false;
    const stop = observeResize(element, (entries) => {
      const box = entries[0]?.contentRect;
      const bounds = boundsOf((latest.current?.rects ?? []).map((entry) => entry.rect));
      if (fitted || box === undefined || box.width === 0 || bounds === null) return;
      fitted = true;
      apply(fitView(bounds, { width: box.width, height: box.height }));
    });
    // A native listener: React's wheel listener is passive, and ctrl + wheel must not zoom the page.
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const box = element.getBoundingClientRect();
      const cursor = { x: event.clientX - box.left, y: event.clientY - box.top };
      const scale = event.deltaMode === 1 ? 16 : 1;
      const current = viewRef.current;
      if (event.ctrlKey || event.metaKey) {
        apply(zoomAt(current, Math.exp(-event.deltaY * scale * 0.01), cursor));
      } else {
        apply({
          ...current,
          x: current.x - event.deltaX * scale,
          y: current.y - event.deltaY * scale,
        });
      }
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      stop();
      element.removeEventListener("wheel", onWheel);
    };
  }, [latest]);

  // Created once, so the memoised layers never see a new handler; what they need that changes is
  // read through `latest` and `gesture` when the event happens.
  const [handlers] = useState<Handlers>(() => {
    const at = (event: { clientX: number; clientY: number }): Point => {
      const box = containerRef.current?.getBoundingClientRect();
      return { x: event.clientX - (box?.left ?? 0), y: event.clientY - (box?.top ?? 0) };
    };
    return {
      nodePointerDown: (event, node) => {
        const now = latest.current;
        // A read-only graph pans from anywhere: the press falls through to the background.
        if (event.button !== 0 || now === null || now.readOnly) return;
        event.stopPropagation();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        now.onSelect({ kind: "node", id: node.id });
        gesture.current = {
          kind: "drag",
          id: node.id,
          start: at(event),
          origin: { x: node.x, y: node.y },
          moved: false,
        };
      },
      nodeKeyDown: (event, id) => {
        const now = latest.current;
        if (now === null || now.readOnly || event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          now.onSelect({ kind: "node", id });
        }
      },
      portPointerDown: (event, node, port) => {
        const now = latest.current;
        if (event.button !== 0 || now === null || now.readOnly) return;
        event.stopPropagation();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        const from = portPoint(node, Math.max(0, now.portsOfKind(node.kind).indexOf(port)));
        gesture.current = { kind: "connect", from: node.id, port, start: at(event), moved: false };
        setPreview({ from, to: from });
      },
      edgePointerDown: (event, id) => {
        const now = latest.current;
        if (event.button !== 0 || now === null || now.readOnly) return;
        event.stopPropagation();
        now.onSelect({ kind: "edge", id });
      },
      edgeClick: (id) => {
        const now = latest.current;
        if (now !== null && !now.readOnly) now.onSelect({ kind: "edge", id });
      },
    };
  });

  const onBackgroundPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    gesture.current = { kind: "pan", start: local(event), view: viewRef.current, moved: false };
  };

  /** Where a drag puts its node for the pointer at `point`, snapped to the grid. */
  const dragTarget = (current: Extract<Gesture, { kind: "drag" }>, point: Point) => ({
    x: snap(current.origin.x + (point.x - current.start.x) / viewRef.current.k),
    y: snap(current.origin.y + (point.y - current.start.y) / viewRef.current.k),
  });

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = gesture.current;
    if (current === null) return;
    const point = local(event);
    const travel = Math.hypot(point.x - current.start.x, point.y - current.start.y);
    if (!current.moved && travel < CLICK_SLOP) return;
    current.moved = true;
    if (current.kind === "pan") {
      setView({
        ...current.view,
        x: current.view.x + point.x - current.start.x,
        y: current.view.y + point.y - current.start.y,
      });
    } else if (current.kind === "drag") {
      const { x, y } = dragTarget(current, point);
      setDrag((last) =>
        last !== null && last.x === x && last.y === y ? last : { id: current.id, x, y },
      );
    } else {
      const to = screenToWorld(viewRef.current, point);
      setPreview((last) => (last === null ? null : { ...last, to }));
    }
  };

  /**
   * The node card under the pointer, port rows included, as the browser lays it out: what the
   * person sees is what they drop on, whatever the view or a move just did.
   */
  const nodeUnder = (clientX: number, clientY: number): string | null => {
    const container = containerRef.current;
    if (container === null || typeof document.elementsFromPoint !== "function") return null;
    for (const element of document.elementsFromPoint(clientX, clientY)) {
      if (!container.contains(element)) continue;
      const id = element.closest<HTMLElement>("[data-node]")?.dataset.node;
      if (id !== undefined) return id;
    }
    return null;
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = gesture.current;
    gesture.current = null;
    if (current === null) return;
    if (current.kind === "pan") {
      if (!current.moved && !readOnly) onSelect(null);
    } else if (current.kind === "drag") {
      // From the release point, not the last rendered drag: a quick flick may end between moves.
      if (current.moved) {
        const { x, y } = dragTarget(current, local(event));
        onMove(current.id, x, y);
      }
      setDrag(null);
    } else {
      setPreview(null);
      // A press on a port that never moved is a click on its node, not a loop into itself.
      if (!current.moved) {
        onSelect({ kind: "node", id: current.from });
        return;
      }
      const target =
        nodeUnder(event.clientX, event.clientY) ??
        hitTest(rects, screenToWorld(viewRef.current, local(event)));
      if (target !== null) onConnect(current.from, current.port, target);
    }
  };

  const onPointerCancel = () => {
    gesture.current = null;
    setDrag(null);
    setPreview(null);
  };

  const zoomBy = (factor: number) => {
    const box = containerRef.current?.getBoundingClientRect();
    setView(
      zoomAt(viewRef.current, factor, { x: (box?.width ?? 0) / 2, y: (box?.height ?? 0) / 2 }),
    );
  };
  const fit = () => fitTo(boundsOf(rects.map((entry) => entry.rect)));
  const tidy = () => {
    const positions = tidyLayout(pipeline);
    onLayout(positions);
    // Fit to where the nodes are going, not where they were: the move lands on the next render.
    fitTo(boundsOf(rects.map(({ id, rect }) => ({ ...rect, ...positions[id] }))));
  };

  const transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
  const gridSize = 16 * view.k;
  const selectedEdge = selection?.kind === "edge" ? selection.id : null;
  const selectedNode = selection?.kind === "node" ? selection.id : null;

  const markOf = (id: string): NodeMark => {
    if (trail === null) return null;
    if (trail.current === id) return "current";
    return trail.nodes.has(id) ? "visited" : "dim";
  };
  const lookOf = (id: string): EdgeLook =>
    id === selectedEdge
      ? "selected"
      : trail === null
        ? "normal"
        : trail.edges.has(id)
          ? "trail"
          : "dim";

  return (
    <div
      aria-label={readOnly ? "Pipeline canvas, as the run started" : "Pipeline canvas"}
      className="relative size-full touch-none select-none overflow-clip bg-background"
      onPointerCancel={onPointerCancel}
      onPointerDown={onBackgroundPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      ref={containerRef}
      role="application"
      style={{
        backgroundImage: "radial-gradient(circle, var(--color-border) 1px, transparent 1px)",
        backgroundSize: `${gridSize}px ${gridSize}px`,
        backgroundPosition: `${view.x}px ${view.y}px`,
      }}
    >
      <svg aria-hidden="true" className="absolute inset-0 size-full overflow-visible">
        <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          {drawn.map(({ edge, d, end }) => (
            <EdgePath
              d={d}
              endX={end.x}
              endY={end.y}
              handlers={handlers}
              id={edge.id}
              key={edge.id}
              look={lookOf(edge.id)}
            />
          ))}
          {preview !== null ? (
            <path
              d={curvePath(previewCurve(preview.from, preview.to))}
              fill="none"
              stroke="var(--color-primary)"
              strokeDasharray="6 4"
              strokeWidth={1.5}
            />
          ) : null}
        </g>
      </svg>
      <div className="absolute left-0 top-0 origin-top-left" style={{ transform }}>
        {drawn.map(({ edge, label }) => (
          <EdgeLabel
            handlers={handlers}
            id={edge.id}
            key={edge.id}
            name={`Transition ${edge.port} from ${edge.from} to ${edge.to}`}
            problems={problemsByEdge.get(edge.id) ?? NO_PROBLEMS}
            selected={edge.id === selectedEdge}
            text={edgeLabelText(edge, taken)}
            x={label.x}
            y={label.y}
          />
        ))}
        {rects.map(({ node, rect }) => (
          <NodeCard
            connected={connectedPorts.get(node.id) ?? NO_PORTS}
            handlers={handlers}
            height={rect.height}
            key={node.id}
            kinds={kinds}
            mark={markOf(node.id)}
            node={node}
            ports={portsOfKind(node.kind)}
            problems={problemsByNode.get(node.id) ?? NO_PROBLEMS}
            selected={node.id === selectedNode}
          />
        ))}
      </div>
      <div
        className="absolute bottom-3 left-3 flex items-center gap-0.5 rounded-lg border bg-popover p-0.5 shadow-xs"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <Button
          aria-label="Zoom out"
          onClick={() => zoomBy(1 / ZOOM_STEP)}
          size="icon-xs"
          variant="ghost"
        >
          <MinusIcon />
        </Button>
        <span className="w-10 text-center text-xs tabular-nums text-muted-foreground">
          {Math.round(view.k * 100)}%
        </span>
        <Button
          aria-label="Zoom in"
          onClick={() => zoomBy(ZOOM_STEP)}
          size="icon-xs"
          variant="ghost"
        >
          <PlusIcon />
        </Button>
        <Button aria-label="Fit to view" onClick={fit} size="icon-xs" variant="ghost">
          <MaximizeIcon />
        </Button>
        {readOnly ? null : (
          <Button onClick={tidy} size="xs" variant="ghost">
            <LayoutGridIcon />
            Tidy
          </Button>
        )}
      </div>
      {readOnly ? (
        <p className="absolute right-3 top-3 rounded-md border bg-popover px-2 py-1 text-xs text-muted-foreground">
          The pipeline as this run started. Go back to Inspect to edit.
        </p>
      ) : null}
    </div>
  );
}
