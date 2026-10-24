// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";

import { buildAndGate } from "./fixtures.ts";
import { encodePipeline } from "./model.ts";
import {
  appendEvent,
  isRunId,
  listRecords,
  markInterrupted,
  parseRecord,
  readRecord,
  recordPath,
  runIdFor,
  summarize,
} from "./record.ts";
import type { RunEvent } from "./runsService.ts";

// A temp dir that is removed however the test ends.
const withTempDir = <A, E, R>(body: (dir: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pipeline-record-"))),
    body,
    (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
  );

const started: RunEvent = {
  event: "started",
  pipeline: encodePipeline(buildAndGate),
  projectRoot: "/work/widgets",
  repo: "acme/widgets",
  issue: 12,
};

// 2026-10-25T01:02:03.000Z
const T0 = Date.UTC(2026, 9, 25, 1, 2, 3);

describe("runIdFor", () => {
  it("names the pipeline, the UTC second and the random digits", () => {
    const id = runIdFor("build-and-gate", T0, "0a9f");
    expect(id).toBe("build-and-gate-20261025-010203-0a9f");
    expect(isRunId(id)).toBe(true);
    expect(isRunId("../etc/passwd")).toBe(false);
  });
});

describe("summarize", () => {
  it("is running at the last node entered until the record ends", () => {
    const events = [
      { ms: T0, ...started },
      { ms: T0 + 1, event: "entered", node: "start", visit: 1 },
      { ms: T0 + 2, event: "entered", node: "build", visit: 1 },
    ] as const;
    expect(summarize("r", events)).toEqual({
      id: "r",
      pipelineId: "build-and-gate",
      pipelineName: "Build and gate",
      projectRoot: "/work/widgets",
      repo: "acme/widgets",
      issue: 12,
      startedAt: "2026-10-25T01:02:03.000Z",
      endedAt: null,
      status: "running",
      node: "build",
      reason: null,
    });
    const ended = summarize("r", [
      ...events,
      { ms: T0 + 1000, event: "ended", result: "stuck", reason: "Gate ended with fail" },
    ]);
    expect(ended).toMatchObject({
      status: "stuck",
      reason: "Gate ended with fail",
      endedAt: "2026-10-25T01:02:04.000Z",
      node: "build",
    });
  });
});

describe("parseRecord", () => {
  it("skips a torn last line", () => {
    const text = `${JSON.stringify({ ms: 1, event: "entered", node: "a", visit: 1 })}\n{"ms": 2, "ev`;
    expect(parseRecord(text)).toEqual([{ ms: 1, event: "entered", node: "a", visit: 1 }]);
  });
});

describe("the record on disk", () => {
  it.effect("appends events and reads them back", () =>
    withTempDir((temp) =>
      Effect.gen(function* () {
        const dir = NodePath.join(temp, "runs");
        const path = recordPath(dir, "a-20261025-010203-0000");
        yield* appendEvent(path, T0, started);
        yield* appendEvent(path, T0 + 5, { event: "entered", node: "start", visit: 1 });
        const events = yield* readRecord(path);
        assert.deepStrictEqual(events, [
          { ms: T0, ...started },
          { ms: T0 + 5, event: "entered", node: "start", visit: 1 },
        ]);
      }),
    ),
  );

  it.effect("fails not-found for a record that does not exist", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        readRecord(recordPath("/nonexistent", "x-20261025-010203-0000")),
      );
      assert.strictEqual(error.kind, "not-found");
    }),
  );

  it.effect("lists records newest first and ignores other files", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const older = runIdFor("zeta", T0, "0000");
        const newer = runIdFor("alpha", T0 + 60_000, "0000");
        yield* appendEvent(recordPath(dir, older), T0, started);
        yield* appendEvent(recordPath(dir, newer), T0, started);
        NodeFS.writeFileSync(NodePath.join(dir, "notes.txt"), "");
        assert.deepStrictEqual(yield* listRecords(dir), [newer, older]);
        assert.deepStrictEqual(yield* listRecords(NodePath.join(dir, "missing")), []);
      }),
    ),
  );

  it.effect("ends every unfinished record as interrupted, and leaves ended ones alone", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const open = runIdFor("a", T0, "0001");
        const closed = runIdFor("a", T0, "0002");
        yield* appendEvent(recordPath(dir, open), T0, started);
        yield* appendEvent(recordPath(dir, closed), T0, started);
        yield* appendEvent(recordPath(dir, closed), T0 + 1, {
          event: "ended",
          result: "done",
          reason: null,
        });
        assert.deepStrictEqual(yield* markInterrupted(dir, T0 + 10), [open]);
        const reopened = summarize(open, yield* readRecord(recordPath(dir, open)));
        assert.strictEqual(reopened.status, "interrupted");
        assert.strictEqual(reopened.reason, "the server restarted");
        const kept = yield* readRecord(recordPath(dir, closed));
        assert.strictEqual(kept.length, 2);
      }),
    ),
  );
});
