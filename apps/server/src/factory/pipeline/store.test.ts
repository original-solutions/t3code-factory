// @effect-diagnostics nodeBuiltinImport:off - the tests lay out and read back real pipeline files.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe } from "vite-plus/test";

import { useTempDirs } from "../ledger/testSupport.ts";
import { buildAndGate, buildAndLearn } from "./fixtures.ts";
import type { Pipeline } from "./model.ts";
import { deletePipeline, listPipelines, readPipeline, writePipeline } from "./store.ts";

const tempDir = useTempDirs();

const pipelineFile = (dir: string, id: string) => NodePath.join(dir, "pipelines", `${id}.yml`);

const writeRaw = (dir: string, name: string, text: string) => {
  NodeFS.mkdirSync(NodePath.join(dir, "pipelines"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(dir, "pipelines", name), text);
};

const BRIEF = "Fix the gate.\n\nThen:\n  1. run it again\n  2. end with a result line\n";

const withBrief: Pipeline = {
  ...buildAndGate,
  edges: buildAndGate.edges.map((edge) =>
    edge.id === "e3" ? { ...edge, instructions: { brief: BRIEF } } : edge,
  ),
};

describe("the pipeline store", () => {
  it.effect("writes a pipeline and reads it back as it was", () =>
    Effect.gen(function* () {
      const dir = tempDir("store");
      const written = yield* writePipeline(dir, buildAndLearn);
      assert.isNotNull(written.updatedAt);
      const read = yield* readPipeline(dir, buildAndLearn.id);
      assert.deepStrictEqual(read, { ...buildAndLearn, updatedAt: written.updatedAt });
      assert.isFalse(NodeFS.existsSync(`${pipelineFile(dir, buildAndLearn.id)}.tmp`));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps a multi-line brief as a block scalar that round-trips exactly", () =>
    Effect.gen(function* () {
      const dir = tempDir("store");
      yield* writePipeline(dir, withBrief);
      const text = NodeFS.readFileSync(pipelineFile(dir, withBrief.id), "utf8");
      assert.match(text, /brief: \|\n\s+Fix the gate\.\n\n\s+Then:\n/);
      const read = yield* readPipeline(dir, withBrief.id);
      const edge = read !== null && read.unreadable === undefined ? read.edges[2] : undefined;
      assert.deepStrictEqual(edge?.instructions, { brief: BRIEF });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("overwrites a pipeline saved again", () =>
    Effect.gen(function* () {
      const dir = tempDir("store");
      yield* writePipeline(dir, buildAndGate);
      yield* writePipeline(dir, { ...buildAndGate, name: "Renamed" });
      const read = yield* readPipeline(dir, buildAndGate.id);
      assert.strictEqual(
        read !== null && read.unreadable === undefined ? read.name : null,
        "Renamed",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "lists every pipeline file by id, with the ones that do not decode marked unreadable",
    () =>
      Effect.gen(function* () {
        const dir = tempDir("store");
        yield* writePipeline(dir, buildAndLearn);
        yield* writePipeline(dir, buildAndGate);
        writeRaw(dir, "broken.yml", "id: broken\nname: Broken\nnodes: 3\nedges: []\n");
        writeRaw(dir, "not-yaml.yml", "id: [unclosed\n");
        writeRaw(dir, "other.yml", "id: elsewhere\nname: Moved\nnodes: []\nedges: []\n");
        writeRaw(dir, "notes.txt", "not a pipeline");
        writeRaw(dir, "Bad Name.yml", "id: x\n");
        NodeFS.mkdirSync(NodePath.join(dir, "pipelines", "runs"));

        const listed = yield* listPipelines(dir);
        assert.deepStrictEqual(
          listed.map((entry) => [entry.id, entry.unreadable === true]),
          [
            ["broken", true],
            ["build-and-gate", false],
            ["build-and-learn", false],
            ["not-yaml", true],
            ["other", true],
          ],
        );
        const broken = listed[0]!;
        assert.deepStrictEqual(broken.unreadable ? broken.errors : null, [
          { path: "nodes", message: "must be a list" },
        ]);
        const other = listed[4]!;
        assert.deepStrictEqual(other.unreadable ? other.errors.map((error) => error.path) : null, [
          "id",
        ]);
        const learn = listed[2]!;
        assert.strictEqual(learn.unreadable === undefined ? learn.nodes.length : 0, 8);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("lists nothing when no pipeline was ever saved", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* listPipelines(tempDir("store")), []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reads null for a missing pipeline and for an id that is not a pipeline id", () =>
    Effect.gen(function* () {
      const dir = tempDir("store");
      writeRaw(dir, "x.yml", "id: x\n");
      assert.isNull(yield* readPipeline(dir, "missing"));
      assert.isNull(yield* readPipeline(dir, "../pipelines/x"));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("deletes a pipeline, and answers false for one that is not there", () =>
    Effect.gen(function* () {
      const dir = tempDir("store");
      yield* writePipeline(dir, buildAndGate);
      assert.isTrue(yield* deletePipeline(dir, buildAndGate.id));
      assert.isFalse(NodeFS.existsSync(pipelineFile(dir, buildAndGate.id)));
      assert.isFalse(yield* deletePipeline(dir, buildAndGate.id));
      assert.isFalse(yield* deletePipeline(dir, "../config"));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
