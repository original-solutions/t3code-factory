/**
 * A pipeline: the graph a run follows, as the editor saves it and the executor reads it. The
 * design is factory/docs/pipelines.md. This module is pure: the types, the kind table the
 * catalog serves, and `decodePipeline`, which turns an untrusted body into a pipeline or says
 * what is wrong with it, field by field.
 */

export type Kind = "start" | "agent" | "verify" | "ask" | "pr" | "learn" | "end";

export type Instructions = { readonly skill: string } | { readonly brief: string };

export type Check = Instructions | { readonly commands: ReadonlyArray<string> };

export type NodeBase = {
  readonly id: string;
  readonly label?: string;
  readonly x: number;
  readonly y: number;
};

export type Node = NodeBase &
  (
    | { readonly kind: "start" }
    | { readonly kind: "agent"; readonly instructions: Instructions; readonly fresh: boolean }
    | { readonly kind: "verify"; readonly check: Check }
    | { readonly kind: "ask" }
    | { readonly kind: "pr" }
    | { readonly kind: "learn"; readonly instructions: Instructions }
    | { readonly kind: "end"; readonly result: "done" | "stuck" }
  );

export type Edge = {
  readonly id: string;
  readonly from: string;
  readonly port: string;
  readonly to: string;
  /** The loop limit: how many times a run may take this edge. */
  readonly max?: number;
  readonly instructions?: Instructions;
};

export type Pipeline = {
  readonly id: string;
  readonly name: string;
  readonly nodes: ReadonlyArray<Node>;
  readonly edges: ReadonlyArray<Edge>;
};

export type PortInfo = { readonly name: string; readonly meaning: string };

export type KindInfo = {
  readonly kind: Kind;
  readonly label: string;
  readonly description: string;
  readonly ports: ReadonlyArray<PortInfo>;
  /** Which instruction field the kind carries, for the inspector. */
  readonly instructions: "none" | "instructions" | "check";
};

/** The kinds, in the order the editor's Add menu lists them. */
export const KINDS: ReadonlyArray<KindInfo> = [
  {
    kind: "start",
    label: "Start",
    description: "Where a run begins. One per pipeline.",
    ports: [{ name: "next", meaning: "the run begins" }],
    instructions: "none",
  },
  {
    kind: "agent",
    label: "Agent",
    description: "An agent turn in the run's session, with a brief or a skill.",
    ports: [
      { name: "done", meaning: "the agent ended with FACTORY-DONE" },
      { name: "questions", meaning: "the agent asked questions (FACTORY-STOP: needs-info)" },
      { name: "stop", meaning: "the agent gave up, or gave no result line twice" },
    ],
    instructions: "instructions",
  },
  {
    kind: "verify",
    label: "Verify",
    description: "Commands in the worktree, or a reviewer agent that answers pass or fail.",
    ports: [
      { name: "pass", meaning: "every command exited 0, or the reviewer said FACTORY-DONE" },
      { name: "fail", meaning: "a command failed, or the reviewer did not say FACTORY-DONE" },
    ],
    instructions: "check",
  },
  {
    kind: "ask",
    label: "Ask",
    description: "Posts the agent's questions on the issue and waits for a person to answer.",
    ports: [{ name: "answered", meaning: "a person answered and set factory:ready again" }],
    instructions: "none",
  },
  {
    kind: "pr",
    label: "Pull request",
    description: "Marks the pull request ready and waits for a person.",
    ports: [
      { name: "feedback", meaning: "a review or comment arrived" },
      { name: "base-moved", meaning: "the base branch moved" },
      { name: "merged", meaning: "it was merged" },
      { name: "closed", meaning: "it was closed without a merge" },
    ],
    instructions: "none",
  },
  {
    kind: "learn",
    label: "Learn",
    description: "A fresh agent reads the run's record and writes what it learned into a skill.",
    ports: [{ name: "done", meaning: "the learner finished" }],
    instructions: "instructions",
  },
  {
    kind: "end",
    label: "End",
    description: "The run ends, done or stuck.",
    ports: [],
    instructions: "none",
  },
];

const KIND_BY_NAME = new Map(KINDS.map((info) => [info.kind, info]));

export const kindInfo = (kind: Kind): KindInfo => KIND_BY_NAME.get(kind)!;

export const isKind = (value: unknown): value is Kind =>
  typeof value === "string" && KIND_BY_NAME.has(value as Kind);

/** The port names of a kind. */
export const portsOf = (kind: Kind): ReadonlyArray<string> =>
  kindInfo(kind).ports.map((port) => port.name);

/** A pipeline or node id: one to 64 of `a-z`, `0-9` and `-`. */
export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const isId = (value: unknown): value is string =>
  typeof value === "string" && ID_PATTERN.test(value);

/** A problem with one field of a body being decoded: `path` is dotted, e.g. `nodes.2.kind`. */
export type DecodeError = { readonly path: string; readonly message: string };

type Mapping = Record<string, unknown>;

const isMapping = (value: unknown): value is Mapping =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isText = (value: unknown): value is string => typeof value === "string";

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

class Errors {
  readonly list: Array<DecodeError> = [];
  add(path: string, message: string): void {
    this.list.push({ path, message });
  }
}

const decodeInstructions = (
  value: unknown,
  path: string,
  errors: Errors,
  commandsAllowed: boolean,
): Check | undefined => {
  if (!isMapping(value)) {
    errors.add(
      path,
      commandsAllowed ? "must be a skill, a brief or commands" : "must be a skill or a brief",
    );
    return undefined;
  }
  const keys = Object.keys(value).filter((key) => value[key] !== undefined);
  if (keys.length !== 1) {
    errors.add(
      path,
      commandsAllowed
        ? "must have exactly one of skill, brief or commands"
        : "must have exactly one of skill or brief",
    );
    return undefined;
  }
  const [key] = keys;
  if (key === "skill") {
    const skill = value["skill"];
    if (!isText(skill)) {
      errors.add(`${path}.skill`, "must be a skill name");
      return undefined;
    }
    // An empty name decodes: the editor saves drafts, and validation names the problem.
    return { skill: skill.trim() };
  }
  if (key === "brief") {
    const brief = value["brief"];
    if (!isText(brief)) {
      errors.add(`${path}.brief`, "must be text");
      return undefined;
    }
    return { brief };
  }
  if (key === "commands" && commandsAllowed) {
    const commands = value["commands"];
    if (!Array.isArray(commands) || !commands.every((command) => isText(command))) {
      errors.add(`${path}.commands`, "must be a list of command lines");
      return undefined;
    }
    // Blank lines are dropped; an empty list decodes and validation names the problem.
    return {
      commands: commands
        .map((command: string) => command.trim())
        .filter((command) => command !== ""),
    };
  }
  errors.add(`${path}.${key}`, "is not a known key");
  return undefined;
};

const decodeNode = (value: unknown, path: string, errors: Errors): Node | undefined => {
  if (!isMapping(value)) {
    errors.add(path, "must be an object");
    return undefined;
  }
  const before = errors.list.length;
  const id = value["id"];
  if (!isId(id)) errors.add(`${path}.id`, "must be 1 to 64 of a-z, 0-9 and -");
  const kind = value["kind"];
  if (!isKind(kind))
    errors.add(`${path}.kind`, `must be one of ${KINDS.map((k) => k.kind).join(", ")}`);
  const x = value["x"];
  const y = value["y"];
  if (!isFiniteNumber(x)) errors.add(`${path}.x`, "must be a number");
  if (!isFiniteNumber(y)) errors.add(`${path}.y`, "must be a number");
  const label = value["label"];
  if (label !== undefined && !isText(label)) errors.add(`${path}.label`, "must be text");
  if (
    errors.list.length > before ||
    !isId(id) ||
    !isKind(kind) ||
    !isFiniteNumber(x) ||
    !isFiniteNumber(y)
  ) {
    return undefined;
  }
  const base: NodeBase = {
    id,
    x,
    y,
    ...(isText(label) && label.trim() !== "" ? { label: label.trim() } : {}),
  };
  switch (kind) {
    case "start":
    case "ask":
    case "pr":
      return { ...base, kind };
    case "agent": {
      const instructions = decodeInstructions(
        value["instructions"],
        `${path}.instructions`,
        errors,
        false,
      );
      const fresh = value["fresh"];
      if (fresh !== undefined && typeof fresh !== "boolean")
        errors.add(`${path}.fresh`, "must be true or false");
      if (instructions === undefined || "commands" in instructions) return undefined;
      return { ...base, kind, instructions, fresh: fresh === true };
    }
    case "learn": {
      const instructions = decodeInstructions(
        value["instructions"],
        `${path}.instructions`,
        errors,
        false,
      );
      if (instructions === undefined || "commands" in instructions) return undefined;
      return { ...base, kind, instructions };
    }
    case "verify": {
      const check = decodeInstructions(value["check"], `${path}.check`, errors, true);
      if (check === undefined) return undefined;
      return { ...base, kind, check };
    }
    case "end": {
      const result = value["result"];
      if (result !== "done" && result !== "stuck") {
        errors.add(`${path}.result`, "must be done or stuck");
        return undefined;
      }
      return { ...base, kind, result };
    }
  }
};

const decodeEdge = (value: unknown, path: string, errors: Errors): Edge | undefined => {
  if (!isMapping(value)) {
    errors.add(path, "must be an object");
    return undefined;
  }
  const before = errors.list.length;
  const id = value["id"];
  if (!isId(id)) errors.add(`${path}.id`, "must be 1 to 64 of a-z, 0-9 and -");
  const from = value["from"];
  if (!isId(from)) errors.add(`${path}.from`, "must be a node id");
  const to = value["to"];
  if (!isId(to)) errors.add(`${path}.to`, "must be a node id");
  const port = value["port"];
  if (!isText(port) || port === "") errors.add(`${path}.port`, "must be a port name");
  const max = value["max"];
  if (max !== undefined && max !== null && (!Number.isInteger(max) || (max as number) < 1)) {
    errors.add(`${path}.max`, "must be a whole number of at least 1");
  }
  const instructions =
    value["instructions"] === undefined || value["instructions"] === null
      ? undefined
      : decodeInstructions(value["instructions"], `${path}.instructions`, errors, false);
  if (errors.list.length > before || !isId(id) || !isId(from) || !isId(to) || !isText(port)) {
    return undefined;
  }
  return {
    id,
    from,
    port,
    to,
    ...(typeof max === "number" ? { max } : {}),
    ...(instructions !== undefined && !("commands" in instructions) ? { instructions } : {}),
  };
};

/**
 * The pipeline a body describes, or every field-level problem with it. A body that decodes may
 * still be invalid as a graph: that is `validate.ts`, which needs the whole pipeline.
 */
export const decodePipeline = (
  body: unknown,
):
  | { readonly ok: true; readonly pipeline: Pipeline }
  | { readonly ok: false; readonly errors: ReadonlyArray<DecodeError> } => {
  const errors = new Errors();
  if (!isMapping(body)) return { ok: false, errors: [{ path: "", message: "must be an object" }] };
  const id = body["id"];
  if (!isId(id)) errors.add("id", "must be 1 to 64 of a-z, 0-9 and -");
  const name = body["name"];
  if (!isText(name) || name.trim() === "") errors.add("name", "must be a name");
  const rawNodes = body["nodes"];
  const rawEdges = body["edges"];
  const nodes: Array<Node> = [];
  const edges: Array<Edge> = [];
  if (!Array.isArray(rawNodes)) errors.add("nodes", "must be a list");
  else {
    rawNodes.forEach((node, index) => {
      const decoded = decodeNode(node, `nodes.${index}`, errors);
      if (decoded !== undefined) nodes.push(decoded);
    });
  }
  if (!Array.isArray(rawEdges)) errors.add("edges", "must be a list");
  else {
    rawEdges.forEach((edge, index) => {
      const decoded = decodeEdge(edge, `edges.${index}`, errors);
      if (decoded !== undefined) edges.push(decoded);
    });
  }
  if (errors.list.length > 0 || !isId(id) || !isText(name))
    return { ok: false, errors: errors.list };
  return { ok: true, pipeline: { id, name: name.trim(), nodes, edges } };
};

/** The pipeline as a plain object, for YAML and JSON. Undefined fields are left out. */
export const encodePipeline = (pipeline: Pipeline): Record<string, unknown> => ({
  id: pipeline.id,
  name: pipeline.name,
  nodes: pipeline.nodes.map((node) => {
    const { id, kind, label, x, y, ...rest } = node;
    return { id, kind, ...(label === undefined ? {} : { label }), x, y, ...rest };
  }),
  edges: pipeline.edges.map((edge) => ({
    id: edge.id,
    from: edge.from,
    port: edge.port,
    to: edge.to,
    ...(edge.max === undefined ? {} : { max: edge.max }),
    ...(edge.instructions === undefined ? {} : { instructions: edge.instructions }),
  })),
});
