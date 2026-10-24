// @effect-diagnostics nodeBuiltinImport:off - the examples are files in the repo.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";
import { parse } from "yaml";

import { simulate } from "./interpret.ts";
import { decodePipeline, type Pipeline } from "./model.ts";
import { validate } from "./validate.ts";

/** The example pipelines in factory/pipelines, which the docs point at. */
const EXAMPLES_DIR = NodePath.resolve(import.meta.dirname, "../../../../../factory/pipelines");

const examples = NodeFS.readdirSync(EXAMPLES_DIR)
  .filter((name) => name.endsWith(".yml"))
  .map((name) => ({
    name,
    body: parse(NodeFS.readFileSync(NodePath.join(EXAMPLES_DIR, name), "utf8")),
  }));

/** The skills an example names, so the graph rules are checked and the machine's skills are not. */
const namedSkills = (pipeline: Pipeline): ReadonlySet<string> => {
  const skills = new Set<string>();
  for (const node of pipeline.nodes) {
    const value = "instructions" in node ? node.instructions : "check" in node ? node.check : null;
    if (value !== null && "skill" in value) skills.add(value.skill);
  }
  for (const edge of pipeline.edges) {
    if (edge.instructions !== undefined && "skill" in edge.instructions)
      skills.add(edge.instructions.skill);
  }
  return skills;
};

describe("the example pipelines", () => {
  it("exist, three of them", () => {
    expect(examples.map((example) => example.name).sort()).toEqual([
      "brief-and-gate.yml",
      "build-review-ship.yml",
      "learning-loop.yml",
    ]);
  });

  for (const { name, body } of examples) {
    it(`${name} decodes, validates without problems, and its file name is its id`, () => {
      const decoded = decodePipeline(body);
      if (!decoded.ok) throw new Error(JSON.stringify(decoded.errors));
      expect(`${decoded.pipeline.id}.yml`).toBe(name);
      expect(validate(decoded.pipeline, namedSkills(decoded.pipeline))).toEqual([]);
    });
  }

  it("the learning loop reaches Capture lessons on a merge and Postmortem on a close", () => {
    const decoded = decodePipeline(examples.find((e) => e.name === "learning-loop.yml")!.body);
    if (!decoded.ok) throw new Error("decode");
    const merged = simulate(decoded.pipeline, [
      "next",
      "done",
      "pass",
      "pass",
      "pass",
      "merged",
      "done",
    ]);
    expect(merged.end).toEqual({ kind: "ended", result: "done" });
    expect(merged.steps.filter((s) => s.kind === "entered").map((s) => s.node)).toContain("learn");
    const closed = simulate(decoded.pipeline, [
      "next",
      "done",
      "pass",
      "pass",
      "pass",
      "closed",
      "done",
    ]);
    expect(closed.end).toEqual({ kind: "ended", result: "stuck" });
    expect(closed.steps.filter((s) => s.kind === "entered").map((s) => s.node)).toContain(
      "postmortem",
    );
  });
});
