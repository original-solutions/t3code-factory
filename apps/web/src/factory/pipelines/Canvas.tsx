/**
 * The node editor: nodes are positioned divs in a transformed layer, edges are SVG paths drawn in
 * the same coordinate space. Geometry lives in `geometry.ts`; this file only maps pointer and
 * wheel input onto it. Nothing animates: every repaint follows an input.
 */
import { MaximizeIcon, MinusIcon, PlusIcon } from "lucide-react";
import {
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type Ref,
} from "react";

import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";

import type { Selection } from "./editorState";
import {
  boundsOf,
  curvePath,
  edgeRoute,
  fitView,
  hitTest,
  nodeRect,
  pointOnCurve,
  portPoint,
  previewCurve,
  screenToWorld,
  snap,
  zoomAt,
  type Curve,
  type Point,
  type Rect,
  type View,
} from "./geometry";
import { KIND_ACCENT, kindLabel, nodeName, portsOf, summaryOf, type Trail } from "./model";
import type { KindInfo, Pipeline, PipelineEdge, PipelineNode, Problem } from "./types";

export type CanvasHandle = {
  /** The world point at the middle of the viewport, where a new node goes. */
  readonly centre: () => Point;
};

type Gesture =
  | {
      readonly kind: "pan";
      readonly start: Point;
      readonly view: View;
      moved: boolean;
    }
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

function NodeCard({
  node,
  rect,
  kinds,
  ports,
  connected,
  selected,
  mark,
  problems,
  onNodePointerDown,
  onPortPointerDown,
}: {
  node: PipelineNode;
  rect: Rect;
  kinds: ReadonlyArray<KindInfo>;
  ports: ReadonlyArray<string>;
  connected: ReadonlySet<string>;
  selected: boolean;
  mark: NodeMark;
  problems: ReadonlyArray<Problem>;
  onNodePointerDown: (event: ReactPointerEvent<HTMLElement>, node: PipelineNode) => void;
  onPortPointerDown: (
    event: ReactPointerEvent<HTMLElement>,
    node: PipelineNode,
    port: string,
  ) => void;
}) {
  const name = nodeName(kinds, node);
  const style = {
    left: rect.x,
    top: rect.y,
    width: rect.width,
    height: rect.height,
    "--kind": KIND_ACCENT[node.kind],
  } as CSSProperties;
  return (
    <div
      aria-label={`${name} node`}
      aria-pressed={selected}
      className={cn(
        "absolute cursor-grab touch-none select-none rounded-lg border bg-card text-card-foreground shadow-xs",
        selected && "ring-2 ring-ring",
        mark === "current" && "ring-2 ring-primary",
        mark === "dim" && "opacity-50",
      )}
      data-node={node.id}
      onPointerDown={(event) => onNodePointerDown(event, node)}
      role="button"
      style={style}
      tabIndex={-1}
    >
      <span
        aria-hidden="true"
        className="absolute inset-y-0 left-0 w-1 rounded-l-lg"
        style={{ background: "var(--kind)" }}
      />
      <div className="flex flex-col px-3 pt-2">
        <div className="flex h-4 items-center gap-1.5 text-xs text-muted-foreground">
          <span className="truncate" style={{ color: "var(--kind)" }}>
            {kindLabel(kinds, node.kind)}
          </span>
          <span className="ml-auto flex items-center">
            <ProblemDot problems={problems} />
          </span>
        </div>
        <div className="h-5 truncate text-sm font-medium">{name}</div>
        <div className="h-4 truncate text-xs text-muted-foreground">{summaryOf(node)}</div>
      </div>
      {ports.map((port, index) => {
        const point = portPoint(node, index);
        return (
          <div
            aria-label={`Connect ${port} from ${name}`}
            className="absolute right-0 flex cursor-crosshair items-center justify-end gap-1.5 pl-3 text-xs text-muted-foreground"
            key={port}
            onPointerDown={(event) => onPortPointerDown(event, node, port)}
            role="button"
            style={{ top: point.y - rect.y - 10, height: 20 }}
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
}

type DrawnEdge = {
  readonly edge: PipelineEdge;
  readonly curve: Curve;
  readonly label: Point;
};

const edgeLabelText = (edge: PipelineEdge, taken: Readonly<Record<string, number>> | null) => {
  if (taken !== null) {
    const n = taken[edge.id] ?? 0;
    if (edge.max !== undefined) return `${edge.port} ${n}/${edge.max}`;
    return n > 0 ? `${edge.port} ×${n}` : edge.port;
  }
  return edge.max === undefined ? edge.port : `${edge.port} ×${edge.max}`;
};

export function Canvas({
  pipeline,
  kinds,
  selection,
  problems,
  trail,
  taken,
  onSelect,
  onMove,
  onConnect,
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
  onSelect: (selection: Selection) => void;
  onMove: (id: string, x: number, y: number) => void;
  onConnect: (from: string, port: string, to: string) => void;
  ref?: Ref<CanvasHandle>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const [view, setView] = useState<View>(DEFAULT_VIEW);
  const [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(null);
  const [preview, setPreview] = useState<{ from: Point; to: Point } | null>(null);

  const placed = pipeline.nodes.map((node) =>
    drag !== null && drag.id === node.id ? { ...node, x: drag.x, y: drag.y } : node,
  );
  const portsByNode = new Map(placed.map((node) => [node.id, portsOf(kinds, node.kind)]));
  const rects = placed.map((node) => ({
    id: node.id,
    node,
    rect: nodeRect(node, portsByNode.get(node.id)?.length ?? 0),
  }));
  const rectById = new Map(rects.map((entry) => [entry.id, entry]));

  const drawn: Array<DrawnEdge> = pipeline.edges.flatMap((edge) => {
    const source = rectById.get(edge.from);
    const target = rectById.get(edge.to);
    const index = portsByNode.get(edge.from)?.indexOf(edge.port) ?? -1;
    if (source === undefined || target === undefined || index < 0) return [];
    const { curve } = edgeRoute(source.rect, portPoint(source.node, index), target.rect);
    return [{ edge, curve, label: pointOnCurve(curve, 0.5) }];
  });

  const connectedPorts = new Map<string, Set<string>>();
  for (const edge of pipeline.edges) {
    const set = connectedPorts.get(edge.from) ?? new Set<string>();
    set.add(edge.port);
    connectedPorts.set(edge.from, set);
  }
  const problemsOfNode = (id: string) => problems.filter((problem) => problem.node === id);
  const problemsOfEdge = (id: string) => problems.filter((problem) => problem.edge === id);

  const local = (event: { clientX: number; clientY: number }): Point => {
    const box = containerRef.current?.getBoundingClientRect();
    return { x: event.clientX - (box?.left ?? 0), y: event.clientY - (box?.top ?? 0) };
  };

  const fitToContent = (size: { width: number; height: number }) => {
    const bounds = boundsOf(rects.map((entry) => entry.rect));
    if (bounds !== null && size.width > 0 && size.height > 0) setView(fitView(bounds, size));
  };
  const fitOnFirstSize = useEffectEvent(fitToContent);

  useImperativeHandle(ref, () => ({
    centre: () => {
      const box = containerRef.current?.getBoundingClientRect();
      return screenToWorld(view, { x: (box?.width ?? 0) / 2, y: (box?.height ?? 0) / 2 });
    },
  }));

  useEffect(() => {
    const element = containerRef.current;
    if (element === null) return;
    let fitted = false;
    const stop = observeResize(element, (entries) => {
      const box = entries[0]?.contentRect;
      if (fitted || box === undefined || box.width === 0) return;
      fitted = true;
      fitOnFirstSize({ width: box.width, height: box.height });
    });
    // A native listener: React's wheel listener is passive, and ctrl + wheel must not zoom the page.
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const box = element.getBoundingClientRect();
      const cursor = { x: event.clientX - box.left, y: event.clientY - box.top };
      const scale = event.deltaMode === 1 ? 16 : 1;
      const dx = event.deltaX * scale;
      const dy = event.deltaY * scale;
      if (event.ctrlKey || event.metaKey) {
        setView((current) => zoomAt(current, Math.exp(-dy * 0.01), cursor));
      } else {
        setView((current) => ({ ...current, x: current.x - dx, y: current.y - dy }));
      }
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      stop();
      element.removeEventListener("wheel", onWheel);
    };
  }, []);

  const capture = (event: ReactPointerEvent<Element>) => {
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const onBackgroundPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    capture(event);
    gesture.current = { kind: "pan", start: local(event), view, moved: false };
  };

  const onNodePointerDown = (event: ReactPointerEvent<HTMLElement>, node: PipelineNode) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    capture(event);
    onSelect({ kind: "node", id: node.id });
    gesture.current = {
      kind: "drag",
      id: node.id,
      start: local(event),
      origin: { x: node.x, y: node.y },
      moved: false,
    };
  };

  const onPortPointerDown = (
    event: ReactPointerEvent<HTMLElement>,
    node: PipelineNode,
    port: string,
  ) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    capture(event);
    const index = portsByNode.get(node.id)?.indexOf(port) ?? 0;
    const from = portPoint(node, index);
    gesture.current = { kind: "connect", from: node.id, port, start: local(event), moved: false };
    setPreview({ from, to: from });
  };

  const onEdgePointerDown = (event: ReactPointerEvent<Element>, edge: PipelineEdge) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    onSelect({ kind: "edge", id: edge.id });
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = gesture.current;
    if (current === null) return;
    const point = local(event);
    if (current.kind === "pan") {
      const dx = point.x - current.start.x;
      const dy = point.y - current.start.y;
      if (!current.moved && Math.hypot(dx, dy) < CLICK_SLOP) return;
      current.moved = true;
      setView({ ...current.view, x: current.view.x + dx, y: current.view.y + dy });
    } else if (current.kind === "drag") {
      const dx = point.x - current.start.x;
      const dy = point.y - current.start.y;
      if (!current.moved && Math.hypot(dx, dy) < CLICK_SLOP) return;
      current.moved = true;
      const x = snap(current.origin.x + dx / view.k);
      const y = snap(current.origin.y + dy / view.k);
      if (drag === null || drag.x !== x || drag.y !== y) setDrag({ id: current.id, x, y });
    } else {
      if (
        !current.moved &&
        Math.hypot(point.x - current.start.x, point.y - current.start.y) < CLICK_SLOP
      )
        return;
      current.moved = true;
      const to = screenToWorld(view, point);
      setPreview((last) => (last === null ? null : { ...last, to }));
    }
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = gesture.current;
    gesture.current = null;
    if (current === null) return;
    if (current.kind === "pan") {
      if (!current.moved) onSelect(null);
    } else if (current.kind === "drag") {
      if (current.moved && drag !== null) onMove(drag.id, drag.x, drag.y);
      setDrag(null);
    } else {
      setPreview(null);
      // A press on a port that never moved is a click on its node, not a loop into itself.
      if (!current.moved) {
        onSelect({ kind: "node", id: current.from });
        return;
      }
      const target = hitTest(rects, screenToWorld(view, local(event)));
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
    setView((current) =>
      zoomAt(current, factor, { x: (box?.width ?? 0) / 2, y: (box?.height ?? 0) / 2 }),
    );
  };
  const fit = () => {
    const box = containerRef.current?.getBoundingClientRect();
    if (box !== undefined) fitToContent({ width: box.width, height: box.height });
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

  return (
    <div
      aria-label="Pipeline canvas"
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
          {drawn.map(({ edge, curve }) => {
            const selected = edge.id === selectedEdge;
            const onTrail = trail?.edges.has(edge.id) ?? false;
            const dimmed = trail !== null && !onTrail;
            const stroke =
              selected || onTrail ? "var(--color-primary)" : "var(--color-muted-foreground)";
            const end = curve[3];
            return (
              <g key={edge.id} opacity={dimmed ? 0.4 : 1}>
                <path
                  d={curvePath(curve)}
                  fill="none"
                  stroke={stroke}
                  strokeWidth={selected || onTrail ? 2.5 : 1.5}
                />
                <path
                  d={`M ${end.x - 7} ${end.y - 4} L ${end.x} ${end.y} L ${end.x - 7} ${end.y + 4} Z`}
                  fill={stroke}
                />
                <path
                  className="cursor-pointer"
                  d={curvePath(curve)}
                  fill="none"
                  onPointerDown={(event) => onEdgePointerDown(event, edge)}
                  pointerEvents="stroke"
                  stroke="transparent"
                  strokeWidth={14}
                />
              </g>
            );
          })}
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
        {drawn.map(({ edge, label }) => {
          const edgeProblems = problemsOfEdge(edge.id);
          return (
            <button
              aria-label={`Transition ${edge.port} from ${edge.from} to ${edge.to}`}
              aria-pressed={edge.id === selectedEdge}
              className={cn(
                "absolute flex -translate-x-1/2 -translate-y-1/2 items-center gap-1 whitespace-nowrap rounded-sm border bg-background px-1 text-xs text-muted-foreground",
                edge.id === selectedEdge && "border-primary text-foreground",
              )}
              key={edge.id}
              onPointerDown={(event) => onEdgePointerDown(event, edge)}
              style={{ left: label.x, top: label.y }}
              type="button"
            >
              {edgeLabelText(edge, taken)}
              <ProblemDot problems={edgeProblems} />
            </button>
          );
        })}
        {rects.map(({ node, rect }) => (
          <NodeCard
            connected={connectedPorts.get(node.id) ?? NO_PORTS}
            key={node.id}
            kinds={kinds}
            mark={markOf(node.id)}
            node={node}
            onNodePointerDown={onNodePointerDown}
            onPortPointerDown={onPortPointerDown}
            ports={portsByNode.get(node.id) ?? []}
            problems={problemsOfNode(node.id)}
            rect={rect}
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
      </div>
    </div>
  );
}
