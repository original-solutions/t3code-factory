// @effect-diagnostics nodeBuiltinImport:off - the broken-worktree tests lay out a real ledger.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import { describe, vi } from "vite-plus/test";

import { timeLimitOnlyProjectConfig, type MachineConfig } from "./config.ts";
import { liveWorld } from "./index.ts";
import { makeCause } from "./ledger/events.ts";
import { Ledger } from "./ledger/ledger.ts";
import { newRunId } from "./ledger/runId.ts";
import { T0, ticking, useTempDirs } from "./ledger/testSupport.ts";
import type { Repo } from "./pass.ts";
import { FactoryProcess } from "./process.ts";
import * as Sessions from "./t3/sessions.ts";

/**
 * The base each step's context carries, as `<step> <base>`. The steps are wrapped, not run: this
 * test is about the one thing `liveWorld` does for a step of a run, which is to build its context
 * for the base the pass hands it. What a step does with `ctx.project.base` is its own tests'.
 */
const { bases, wrapped } = vi.hoisted(() => {
  const bases: Array<string> = [];
  const wrapped = <F>(name: string): F =>
    ((ctx: { readonly project: { readonly base: string } }) => {
      bases.push(`${name} ${ctx.project.base}`);
      return Effect.void;
    }) as unknown as F;
  return { bases, wrapped };
});

vi.mock("./runner/building.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./runner/building.ts")>();
  return {
    ...actual,
    timeLimit: wrapped<typeof actual.timeLimit>("timeLimit"),
    watch: wrapped<typeof actual.watch>("watch"),
    forward: wrapped<typeof actual.forward>("forward"),
    advance: wrapped<typeof actual.advance>("advance"),
    interrupted: wrapped<typeof actual.interrupted>("interrupted"),
  };
});

vi.mock("./runner/feedback.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./runner/feedback.ts")>();
  return { ...actual, feedback: wrapped<typeof actual.feedback>("feedback") };
});

const machine: MachineConfig = {
  ghConfigDir: "/gh/rawphp",
  pollSeconds: 60,
  maxConcurrentRuns: 1,
  maxConcurrentGates: 1,
  feedbackSeconds: 600,
  notify: true,
  minFreeGib: 0,
  maxLoadPerCore: 0,
  deployWaitMinutes: 120,
};

const repo: Repo = {
  watched: { repo: "rawphp/softfac", path: "/p" },
  project: { ...timeLimitOnlyProjectConfig(), base: "main" },
  trackerUser: "rawphp",
};

const stubSessions = Sessions.FactorySessions.of({
  findProject: () => Effect.succeed(null),
  launch: () => Effect.die("not launched"),
  status: () => Effect.die("no status"),
  thread: () => Effect.die("no thread"),
  send: () => Effect.die("not sent"),
  archive: () => Effect.die("not archived"),
  removeWorktree: () => Effect.die("not removed"),
  brokenWorktrees: Effect.succeed([]),
  runningThreads: Effect.succeed(0),
  worktreesDirectory: (defaultDir) => Effect.succeed(defaultDir),
});

describe("liveWorld: a step of a run is built for the base the pass hands it", () => {
  it.effect("each step's context has that base, or the repo's when the run recorded none", () =>
    Effect.gen(function* () {
      const world = liveWorld(
        machine,
        "/factory-test/data",
        FactoryProcess.of({ run: () => Effect.die("no gh") }),
        NodeServices.layer,
        stubSessions,
        () => 0,
        "mac-mini",
        { list: () => Effect.succeed([]), raise: () => Effect.void, clear: () => Effect.void },
        {
          gate: { run: () => Effect.die("no gate") },
          wake: Effect.void,
          scope: yield* Scope.make(),
        },
      );
      const run = newRunId("rawphp/softfac", "10", 1);
      const evidence = { t3Error: null, endedInPass: 1, t3Starts: [], t3Stops: [] };
      for (const base of ["feature/x", null]) {
        yield* world.timeLimit(repo, run, base);
        yield* world.watch(repo, run, base);
        yield* world.forward(repo, run, base);
        yield* world.advance(repo, run, base);
        yield* world.interrupted(repo, run, base, evidence);
        yield* world.feedback(repo, run, base);
      }
      assert.deepStrictEqual(bases, [
        "timeLimit feature/x",
        "watch feature/x",
        "forward feature/x",
        "advance feature/x",
        "interrupted feature/x",
        "feedback feature/x",
        "timeLimit main",
        "watch main",
        "forward main",
        "advance main",
        "interrupted main",
        "feedback main",
      ]);
    }),
  );
});

describe("liveWorld: the sessions of runs, for threads on a broken worktree", () => {
  const tempDir = useTempDirs();

  const worldOver = (dataDir: string) =>
    Effect.gen(function* () {
      return liveWorld(
        machine,
        dataDir,
        FactoryProcess.of({ run: () => Effect.die("no gh") }),
        NodeServices.layer,
        stubSessions,
        () => 0,
        "mac-mini",
        { list: () => Effect.succeed([]), raise: () => Effect.void, clear: () => Effect.void },
        {
          gate: { run: () => Effect.die("no gate") },
          wake: Effect.void,
          scope: yield* Scope.make(),
        },
      );
    });

  /** A run whose session is `threadId`, launched before T3 had made its worktree. */
  const launched = (dataDir: string, issue: string, threadId: string, finish: boolean) => {
    const run = newRunId("rawphp/softfac", issue, 1);
    const ledger = Ledger.create(dataDir, run, { clock: ticking(T0, 1000) });
    ledger.append(
      {
        event: "session_launched",
        data: {
          thread_id: threadId,
          worktree: null,
          branch: null,
          model_instance: null,
          model: null,
          model_options: null,
          resumed_from: null,
        },
      },
      makeCause("start", "session-launched"),
    );
    if (finish) ledger.finish("stuck", null, null, makeCause("start", "stuck"));
    ledger.close();
    return run;
  };

  it.effect("reads which run each session thread was launched for, and whether it is stopped", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const finished = launched(dataDir, "187", "session-1", true);
      const going = launched(dataDir, "188", "session-2", false);
      const world = yield* worldOver(dataDir);
      const { runs, complete } = yield* world.sessionRuns();
      assert.isTrue(complete);
      assert.deepStrictEqual(
        [...runs],
        [
          ["session-1", { run: finished, stopped: true }],
          ["session-2", { run: going, stopped: false }],
        ],
      );
    }),
  );

  it.effect("fails as a ledger error when the ledger cannot be read", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      NodeFS.writeFileSync(NodePath.join(dataDir, "runs"), "not a folder");
      const world = yield* worldOver(dataDir);
      const error = yield* Effect.flip(world.sessionRuns());
      assert.strictEqual(error.kind, "ledger");
    }),
  );
});
