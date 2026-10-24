/** What the pipeline pages say about a pipeline: summaries, names, trails and the new template. */
import type {
  DecodeError,
  PipelineEdge,
  Kind,
  KindInfo,
  Pipeline,
  PipelineNode,
  Problem,
  RecordedEvent,
  Trace,
} from "./types";

/**
 * One colour family per kind, from the theme's own tokens so both themes stay legible. Kinds
 * that share a family (ask and verify are both a wait on something) are told apart by mixing.
 */
export const KIND_ACCENT: Record<Kind, string> = {
  start: "var(--color-success)",
  agent: "var(--color-info)",
  verify: "var(--color-warning)",
  ask: "color-mix(in oklab, var(--color-warning) 55%, var(--color-destructive))",
  pr: "var(--color-primary)",
  learn: "color-mix(in oklab, var(--color-info) 50%, var(--color-success))",
  end: "var(--color-muted-foreground)",
};

const BRIEF_WORDS = 5;

const briefSummary = (brief: string): string => {
  const words = brief.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "brief: empty";
  const head = words.slice(0, BRIEF_WORDS).join(" ");
  return words.length > BRIEF_WORDS ? `brief: ${head}…` : `brief: ${head}`;
};

/** The node's instructions in one line: "skill factory", "brief: first words…", "3 commands". */
export const summaryOf = (node: PipelineNode): string => {
  switch (node.kind) {
    case "agent":
    case "learn": {
      const { instructions } = node;
      if ("skill" in instructions)
        return instructions.skill ? `skill ${instructions.skill}` : "skill: none";
      return briefSummary(instructions.brief);
    }
    case "verify": {
      const { check } = node;
      if ("commands" in check) {
        const n = check.commands.length;
        return n === 1 ? "1 command" : `${n} commands`;
      }
      if ("skill" in check) return check.skill ? `reviewer skill ${check.skill}` : "skill: none";
      return `reviewer ${briefSummary(check.brief)}`;
    }
    case "end":
      return node.result === "done" ? "ends done" : "ends stuck";
    case "start":
      return "the run begins";
    case "ask":
      return "waits for answers";
    case "pr":
      return "waits on the pull request";
  }
};

export const kindLabel = (kinds: ReadonlyArray<KindInfo>, kind: Kind): string =>
  kinds.find((info) => info.kind === kind)?.label ?? kind;

/** Whether the node's label says more than its kind's name does. */
export const hasOwnLabel = (kinds: ReadonlyArray<KindInfo>, node: PipelineNode): boolean =>
  node.label !== undefined &&
  node.label.trim() !== "" &&
  node.label.trim().toLowerCase() !== kindLabel(kinds, node.kind).toLowerCase();

/** A node's name for people: its label, else its kind's. */
export const nodeName = (kinds: ReadonlyArray<KindInfo>, node: PipelineNode): string =>
  hasOwnLabel(kinds, node) ? node.label!.trim() : kindLabel(kinds, node.kind);

export const portsOf = (kinds: ReadonlyArray<KindInfo>, kind: Kind): ReadonlyArray<string> =>
  kinds.find((info) => info.kind === kind)?.ports.map((port) => port.name) ?? [];

/**
 * Ids the server refuses (400 reserved_id): its own routes under `/api/factory/pipelines` would
 * shadow them. Mirrors `RESERVED_PIPELINE_IDS` on the server.
 */
export const RESERVED_PIPELINE_IDS: ReadonlySet<string> = new Set([
  "catalog",
  "validate",
  "simulate",
  "runs",
]);

/** A pipeline id from a name, as the server accepts ids, neither reserved nor in `taken`. */
export const slugOf = (name: string, taken: ReadonlySet<string>): string => {
  const free = (id: string) => !taken.has(id) && !RESERVED_PIPELINE_IDS.has(id);
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 56)
      .replace(/-+$/, "") || "pipeline";
  if (free(base)) return base;
  let n = 2;
  while (!free(`${base}-${n}`)) n++;
  return `${base}-${n}`;
};

/** A new pipeline: a start, a done end to its right and a stuck end below, for the person to fill in. */
export const templatePipeline = (id: string, name: string): Pipeline => ({
  id,
  name,
  nodes: [
    { id: "start", kind: "start", x: 40, y: 200 },
    { id: "done", kind: "end", result: "done", x: 760, y: 200 },
    { id: "stuck", kind: "end", result: "stuck", x: 520, y: 420 },
  ],
  edges: [],
});

/**
 * Decode errors as problems on the node or edge they name. `nodes.2.instructions.brief` belongs
 * to the third node of the body that was sent, which is why `pipeline` must be that body.
 */
export const problemsFromDecodeErrors = (
  pipeline: Pipeline,
  errors: ReadonlyArray<DecodeError>,
): ReadonlyArray<Problem> =>
  errors.map(({ path, message }) => {
    const match = /^(nodes|edges)\.(\d+)(?:\.(.*))?$/.exec(path);
    if (match === null) return { level: "error", message: path ? `${path} ${message}` : message };
    const [, list, index, field] = match;
    const text = field ? `${field} ${message}` : message;
    if (list === "nodes") {
      const node = pipeline.nodes[Number(index)];
      return node
        ? { level: "error", message: text, node: node.id }
        : { level: "error", message: text };
    }
    const edge = pipeline.edges[Number(index)];
    return edge
      ? { level: "error", message: text, edge: edge.id }
      : { level: "error", message: text };
  });

export type Trail = {
  readonly nodes: ReadonlySet<string>;
  readonly edges: ReadonlySet<string>;
  /** The node the walk is at: waiting there, or the end it reached. */
  readonly current: string | null;
};

export const EMPTY_TRAIL: Trail = { nodes: new Set(), edges: new Set(), current: null };

export const trailOfTrace = (trace: Trace): Trail => {
  const nodes = new Set<string>();
  const edges = new Set<string>();
  let last: string | null = null;
  for (const step of trace.steps) {
    if (step.kind === "entered") {
      nodes.add(step.node);
      last = step.node;
    } else if (step.kind === "moved") edges.add(step.edge);
  }
  return { nodes, edges, current: trace.end.kind === "waiting" ? trace.end.node : last };
};

export const trailOfRun = (events: ReadonlyArray<RecordedEvent>): Trail => {
  const nodes = new Set<string>();
  const edges = new Set<string>();
  let last: string | null = null;
  for (const event of events) {
    if (event.event === "entered") {
      nodes.add(event.node);
      last = event.node;
    } else if (event.event === "moved") edges.add(event.edge);
  }
  return { nodes, edges, current: last };
};

/** Traversals per edge in a run's record, as the simulation's trace counts them. */
export const takenOfRun = (events: ReadonlyArray<RecordedEvent>): Record<string, number> => {
  const taken: Record<string, number> = {};
  for (const event of events) {
    if (event.event === "moved") taken[event.edge] = (taken[event.edge] ?? 0) + 1;
  }
  return taken;
};

export const problemCounts = (problems: ReadonlyArray<Problem>) => ({
  errors: problems.filter((problem) => problem.level === "error").length,
  warnings: problems.filter((problem) => problem.level === "warning").length,
});

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The outcome the happy path picks at a node of `kind`: the one that moves the work on. A pull
 * request's first port is feedback, which would loop back to the agent until its limit.
 */
const HAPPY_PORT: Partial<Record<Kind, string>> = {
  start: "next",
  agent: "done",
  verify: "pass",
  ask: "answered",
  pr: "merged",
  learn: "done",
};

export const happyPort = (kind: Kind | undefined, ports: ReadonlyArray<string>): string | null => {
  const wanted = kind === undefined ? undefined : HAPPY_PORT[kind];
  if (wanted !== undefined && ports.includes(wanted)) return wanted;
  return ports[0] ?? null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const hasIds = (value: unknown): boolean =>
  Array.isArray(value) && value.every((item) => isRecord(item) && typeof item["id"] === "string");

/**
 * A run's own copy of its pipeline, as the run record keeps it, or null when it does not look like
 * one. The server wrote it from a pipeline that decoded, so the check is only that it has the
 * shape the canvas reads.
 */
export const asPipeline = (snapshot: unknown): Pipeline | null =>
  isRecord(snapshot) &&
  typeof snapshot["id"] === "string" &&
  hasIds(snapshot["nodes"]) &&
  hasIds(snapshot["edges"])
    ? (snapshot as unknown as Pipeline)
    : null;

/**
 * A transition's label: its port, and its limit while editing ("max 3"). On a trail the count
 * taken shows instead, against the limit when there is one ("2/3"), else as "×2".
 */
export const edgeLabelText = (
  edge: PipelineEdge,
  taken: Readonly<Record<string, number>> | null,
): string => {
  if (taken !== null) {
    const n = taken[edge.id] ?? 0;
    if (edge.max !== undefined) return `${edge.port} ${n}/${edge.max}`;
    return n > 0 ? `${edge.port} ×${n}` : edge.port;
  }
  return edge.max === undefined ? edge.port : `${edge.port} · max ${edge.max}`;
};
