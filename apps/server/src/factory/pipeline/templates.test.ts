// @effect-diagnostics nodeBuiltinImport:off - reads the design doc beside the repo to pin its example.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";
import { parse } from "yaml";

import { buildAndLearn } from "./fixtures.ts";
import { simulate } from "./interpret.ts";
import { encodePipeline, decodePipeline, type Pipeline } from "./model.ts";
import { learningLoop, TEMPLATES } from "./templates.ts";
import { validate } from "./validate.ts";

const DESIGN_DOC = new URL("../../../../../factory/docs/pipelines.md", import.meta.url);

/** The skills a template names, so the graph rules are checked and the machine's skills are not. */
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

describe("the templates", () => {
  it("are three, simplest first", () => {
    expect(TEMPLATES.map((template) => template.pipeline.id)).toEqual([
      "brief-and-gate",
      "build-review-ship",
      "learning-loop",
    ]);
  });

  it.each(TEMPLATES)(
    "$pipeline.id validates without problems and survives encoding",
    ({ pipeline }) => {
      expect(validate(pipeline, namedSkills(pipeline))).toEqual([]);
      const decoded = decodePipeline(JSON.parse(JSON.stringify(encodePipeline(pipeline))));
      expect(decoded).toEqual({ ok: true, pipeline });
    },
  );

  it("the design doc's example is the buildAndLearn fixture the executor's tests run", () => {
    const doc = NodeFS.readFileSync(DESIGN_DOC, "utf8");
    const yaml = /```yaml\n([\s\S]*?)```/.exec(doc)?.[1];
    expect(yaml).toBeDefined();
    const decoded = decodePipeline(parse(yaml!));
    expect(decoded).toEqual({ ok: true, pipeline: buildAndLearn });
  });

  it("the learning loop reaches Capture lessons on a merge and Postmortem on a close", () => {
    const { pipeline } = learningLoop;
    const merged = simulate(pipeline, ["next", "done", "pass", "pass", "merged", "done"]);
    expect(merged.end).toEqual({ kind: "ended", result: "done" });
    expect(merged.steps.filter((s) => s.kind === "entered").map((s) => s.node)).toContain("learn");
    const closed = simulate(pipeline, ["next", "done", "pass", "pass", "closed", "done"]);
    expect(closed.end).toEqual({ kind: "ended", result: "stuck" });
    expect(closed.steps.filter((s) => s.kind === "entered").map((s) => s.node)).toContain(
      "postmortem",
    );
  });
});
