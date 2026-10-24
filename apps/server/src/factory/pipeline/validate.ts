/**
 * Whether a decoded pipeline is a graph a run can follow. Errors stop a run from starting;
 * warnings are things the editor points at. The rules are listed in factory/docs/pipelines.md
 * under "Validation", and the tests pin each one.
 */
import { kindInfo, portsOf, type Edge, type Node, type Pipeline } from "./model.ts";

export type Problem = {
  readonly level: "error" | "warning";
  readonly message: string;
  /** The node or edge the problem belongs to; none for a problem with the whole pipeline. */
  readonly node?: string;
  readonly edge?: string;
};

/** The skills a pipeline may name: those the catalog found on this machine. */
export type Skills = ReadonlySet<string>;

const nameOf = (node: Node) => node.label ?? kindInfo(node.kind).label;

const skillOf = (
  value:
    | { readonly skill: string }
    | { readonly brief: string }
    | { readonly commands: ReadonlyArray<string> },
) => ("skill" in value ? value.skill : null);

/** The edges whose removal must leave the graph acyclic: those without a limit. */
const unlimited = (edges: ReadonlyArray<Edge>) => edges.filter((edge) => edge.max === undefined);

/**
 * A cycle made only of unlimited edges, as the node ids along it, or null. Depth-first search over
 * the unlimited edges; the first back edge met closes the cycle it reports.
 */
export const unlimitedCycle = (pipeline: Pipeline): ReadonlyArray<string> | null => {
  const out = new Map<string, Array<string>>();
  for (const edge of unlimited(pipeline.edges)) {
    const list = out.get(edge.from) ?? [];
    list.push(edge.to);
    out.set(edge.from, list);
  }
  const state = new Map<string, "open" | "done">();
  const stack: Array<string> = [];
  const visit = (id: string): ReadonlyArray<string> | null => {
    state.set(id, "open");
    stack.push(id);
    for (const next of out.get(id) ?? []) {
      const seen = state.get(next);
      if (seen === "open") return [...stack.slice(stack.indexOf(next)), next];
      if (seen === undefined) {
        const found = visit(next);
        if (found !== null) return found;
      }
    }
    stack.pop();
    state.set(id, "done");
    return null;
  };
  for (const node of pipeline.nodes) {
    if (!state.has(node.id)) {
      const found = visit(node.id);
      if (found !== null) return found;
    }
  }
  return null;
};

/** The nodes a run can reach from `start`, over every edge. */
const reachable = (pipeline: Pipeline, start: string): ReadonlySet<string> => {
  const out = new Map<string, Array<string>>();
  for (const edge of pipeline.edges) {
    const list = out.get(edge.from) ?? [];
    list.push(edge.to);
    out.set(edge.from, list);
  }
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const next of out.get(id) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
};

/** Whether `edge` lies on some cycle of the whole graph: its target can reach its source. */
const onCycle = (pipeline: Pipeline, edge: Edge): boolean =>
  reachable(pipeline, edge.to).has(edge.from);

export const validate = (pipeline: Pipeline, skills: Skills): ReadonlyArray<Problem> => {
  const problems: Array<Problem> = [];
  const error = (message: string, where: { node?: string; edge?: string } = {}) =>
    problems.push({ level: "error", message, ...where });
  const warning = (message: string, where: { node?: string; edge?: string } = {}) =>
    problems.push({ level: "warning", message, ...where });

  const nodes = new Map<string, Node>();
  for (const node of pipeline.nodes) {
    if (nodes.has(node.id)) error(`two nodes have the id ${node.id}`, { node: node.id });
    nodes.set(node.id, node);
  }
  const edgeIds = new Set<string>();
  for (const edge of pipeline.edges) {
    if (edgeIds.has(edge.id)) error(`two transitions have the id ${edge.id}`, { edge: edge.id });
    edgeIds.add(edge.id);
  }

  const starts = pipeline.nodes.filter((node) => node.kind === "start");
  if (starts.length === 0) error("the pipeline has no start");
  for (const extra of starts.slice(1))
    error("the pipeline has more than one start", { node: extra.id });
  if (!pipeline.nodes.some((node) => node.kind === "end")) error("the pipeline has no end");

  for (const node of pipeline.nodes) {
    const check =
      node.kind === "agent" || node.kind === "learn"
        ? node.instructions
        : node.kind === "verify"
          ? node.check
          : null;
    if (check !== null) {
      const skill = skillOf(check);
      if (skill === "")
        error(`${nameOf(node)} needs a skill: pick one this machine has`, { node: node.id });
      else if (skill !== null && !skills.has(skill)) {
        error(`${nameOf(node)} names the skill ${skill}, which this machine does not have`, {
          node: node.id,
        });
      }
      if ("brief" in check && check.brief.trim() === "") {
        error(`${nameOf(node)}'s brief is empty: say what the agent should do`, { node: node.id });
      }
      if ("commands" in check && check.commands.length === 0) {
        error(`${nameOf(node)} has no commands: add at least one, one per line`, { node: node.id });
      }
    }
  }

  const taken = new Map<string, Edge>();
  for (const edge of pipeline.edges) {
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    if (from === undefined)
      error(`transition ${edge.id} leaves a node that does not exist`, { edge: edge.id });
    if (to === undefined)
      error(`transition ${edge.id} enters a node that does not exist`, { edge: edge.id });
    if (from === undefined || to === undefined) continue;
    if (from.kind === "end")
      error(`nothing leaves ${nameOf(from)}: it is an end`, { edge: edge.id });
    else if (!portsOf(from.kind).includes(edge.port)) {
      error(`${nameOf(from)} has no outcome ${edge.port}`, { edge: edge.id });
    }
    if (to.kind === "start")
      error(`nothing enters ${nameOf(to)}: it is the start`, { edge: edge.id });
    if (edge.instructions !== undefined) {
      const skill = skillOf(edge.instructions);
      if (skill === "")
        error(`transition ${edge.id} needs a skill: pick one this machine has`, { edge: edge.id });
      else if ("brief" in edge.instructions && edge.instructions.brief.trim() === "") {
        error(`transition ${edge.id}'s brief is empty`, { edge: edge.id });
      } else if (skill !== null && !skills.has(skill)) {
        error(`transition ${edge.id} names the skill ${skill}, which this machine does not have`, {
          edge: edge.id,
        });
      }
    }
    const key = `${edge.from}\u0000${edge.port}`;
    const other = taken.get(key);
    if (other !== undefined) {
      error(`${nameOf(from)} has two transitions on ${edge.port}`, { edge: edge.id });
    } else taken.set(key, edge);
    if (edge.max !== undefined && !onCycle(pipeline, edge)) {
      warning(`the limit on transition ${edge.id} has no effect: it is not in a loop`, {
        edge: edge.id,
      });
    }
  }

  const cycle = unlimitedCycle(pipeline);
  if (cycle !== null) {
    const names = cycle.map((id) => {
      const node = nodes.get(id);
      return node === undefined ? id : nameOf(node);
    });
    error(`the loop ${names.join(" → ")} has no limit on any of its transitions`);
  }

  for (const node of pipeline.nodes) {
    for (const port of portsOf(node.kind)) {
      if (!taken.has(`${node.id}\u0000${port}`)) {
        warning(`${nameOf(node)} has no transition on ${port}: a run taking it ends stuck`, {
          node: node.id,
        });
      }
    }
  }

  if (starts.length === 1) {
    const seen = reachable(pipeline, starts[0]!.id);
    for (const node of pipeline.nodes) {
      if (!seen.has(node.id))
        warning(`${nameOf(node)} cannot be reached from the start`, { node: node.id });
    }
  }

  return problems;
};

export const hasErrors = (problems: ReadonlyArray<Problem>): boolean =>
  problems.some((problem) => problem.level === "error");
