import { describe, expect, it } from "vite-plus/test";

import { buildAndGate, buildAndLearn } from "./fixtures.ts";
import { decodePipeline, encodePipeline, KINDS, portsOf } from "./model.ts";

const decodeOk = (body: unknown) => {
  const decoded = decodePipeline(body);
  if (!decoded.ok) throw new Error(JSON.stringify(decoded.errors));
  return decoded.pipeline;
};

const errorsOf = (body: unknown) => {
  const decoded = decodePipeline(body);
  if (decoded.ok) throw new Error("decoded");
  return decoded.errors;
};

describe("decodePipeline", () => {
  it("round-trips the fixtures through encode", () => {
    for (const pipeline of [buildAndGate, buildAndLearn]) {
      expect(decodeOk(encodePipeline(pipeline))).toEqual(pipeline);
    }
  });

  it("round-trips through JSON", () => {
    expect(decodeOk(JSON.parse(JSON.stringify(encodePipeline(buildAndLearn))))).toEqual(
      buildAndLearn,
    );
  });

  it("names the field of each problem", () => {
    const errors = errorsOf({
      id: "Bad Id",
      name: "",
      nodes: [
        { id: "a", kind: "agent", x: 0, y: 0, instructions: { skill: 7 } },
        { id: "b", kind: "verify", x: 0, y: 1, check: { commands: "ls" } },
        { id: "c", kind: "end", x: 0, y: 0, result: "maybe" },
        { id: "d", kind: "robot", x: 0, y: 0 },
        { id: "e", kind: "agent", x: 0, y: 0, instructions: { skill: "x", brief: "y" } },
      ],
      edges: [
        { id: "e1", from: "a", port: "done", to: "b", max: 0 },
        { id: "e2", from: "a", to: "b" },
      ],
    });
    expect(errors.map((error) => error.path)).toEqual([
      "id",
      "name",
      "nodes.0.instructions.skill",
      "nodes.1.check.commands",
      "nodes.2.result",
      "nodes.3.kind",
      "nodes.4.instructions",
      "edges.0.max",
      "edges.1.port",
    ]);
  });

  it("refuses an agent node's fresh: true, which an earlier prototype honoured, and drops false", () => {
    const node = (fresh: boolean) => ({
      id: "a",
      kind: "agent",
      x: 0,
      y: 0,
      instructions: { brief: "Do it." },
      fresh,
    });
    const body = (fresh: boolean) => ({
      id: "p",
      name: "P",
      nodes: [{ id: "s", kind: "start", x: 0, y: 0 }, node(fresh)],
      edges: [],
    });
    const refused = decodePipeline(body(true));
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.errors.map((error) => error.path)).toEqual(["nodes.1.fresh"]);
      expect(refused.errors[0]!.message).toContain("no longer supported");
    }
    expect(decodeOk(body(false)).nodes[1]).toEqual({
      id: "a",
      kind: "agent",
      x: 0,
      y: 0,
      instructions: { brief: "Do it." },
    });
  });

  it("keeps a brief's text as written and trims names", () => {
    const pipeline = decodeOk({
      id: "p",
      name: "  P  ",
      nodes: [
        { id: "s", kind: "start", x: 0, y: 0 },
        {
          id: "a",
          kind: "agent",
          label: " A ",
          x: 0,
          y: 0,
          instructions: { brief: "Do it.\n\nThen stop.\n" },
        },
        { id: "v", kind: "verify", x: 0, y: 0, check: { skill: " review-gate " } },
        { id: "e", kind: "end", result: "done", x: 0, y: 0 },
      ],
      edges: [{ id: "x", from: "a", port: "done", to: "e", max: null, instructions: null }],
    });
    expect(pipeline.name).toBe("P");
    expect(pipeline.nodes[1]).toEqual({
      id: "a",
      kind: "agent",
      label: "A",
      x: 0,
      y: 0,
      instructions: { brief: "Do it.\n\nThen stop.\n" },
    });
    expect(pipeline.nodes[2]).toEqual({
      id: "v",
      kind: "verify",
      x: 0,
      y: 0,
      check: { skill: "review-gate" },
    });
    expect(pipeline.edges[0]).toEqual({ id: "x", from: "a", port: "done", to: "e" });
  });

  it("decodes an empty skill, brief or command list: validation names those", () => {
    const pipeline = decodeOk({
      id: "p",
      name: "P",
      nodes: [
        { id: "a", kind: "agent", x: 0, y: 0, instructions: { skill: "" } },
        { id: "b", kind: "learn", x: 0, y: 0, instructions: { brief: "" } },
        { id: "c", kind: "verify", x: 0, y: 0, check: { commands: ["", "  "] } },
      ],
      edges: [],
    });
    expect(
      pipeline.nodes.map((node) =>
        "instructions" in node ? node.instructions : "check" in node ? node.check : null,
      ),
    ).toEqual([{ skill: "" }, { brief: "" }, { commands: [] }]);
  });

  it("refuses commands anywhere but a verify's check", () => {
    const errors = errorsOf({
      id: "p",
      name: "P",
      nodes: [{ id: "a", kind: "agent", x: 0, y: 0, instructions: { commands: ["ls"] } }],
      edges: [{ id: "e", from: "a", port: "done", to: "a", instructions: { commands: ["ls"] } }],
    });
    expect(errors.map((error) => error.path)).toEqual([
      "nodes.0.instructions.commands",
      "edges.0.instructions.commands",
    ]);
  });

  it("rejects a body that is not an object", () => {
    expect(errorsOf("nope")).toEqual([{ path: "", message: "must be an object" }]);
  });
});

describe("KINDS", () => {
  it("gives every kind but end at least one port, and end none", () => {
    for (const info of KINDS) {
      expect(portsOf(info.kind).length > 0).toBe(info.kind !== "end");
    }
  });
});
