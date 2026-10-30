// @effect-diagnostics nodeBuiltinImport:off - the broken-worktree tests lay out a real ledger.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import { describe, vi } from "vite-plus/test";

import { timeLimitOnlyProjectConfig, type MachineConfig } from "./config.ts";
import { cooldownKey, recordRateLimit, type Cooldown } from "./cooldown.ts";
import { liveWorld } from "./index.ts";
import { makeCause } from "./ledger/events.ts";
import { Ledger } from "./ledger/ledger.ts";
import { newRunId } from "./ledger/runId.ts";
import { T0, ticking, useTempDirs } from "./ledger/testSupport.ts";
import type { Repo } from "./pass.ts";
import { FactoryProcess } from "./process.ts";
import type { StartContext } from "./runner/start.ts";
import * as Sessions from "./t3/sessions.ts";
import { ClaimMemo } from "./tracker/github.ts";

/**
 * The base each step's context carries, as `<step> <base>`. The steps are wrapped, not run: this
 * test is about the one thing `liveWorld` does for a step of a run, which is to build its context
 * for the base the pass hands it. What a step does with `ctx.project.base` is its own tests'.
 */
const { bases, wrapped, startContexts } = vi.hoisted(() => {
  const bases: Array<string> = [];
  const wrapped = <F>(name: string): F =>
    ((ctx: { readonly project: { readonly base: string } }) => {
      bases.push(`${name} ${ctx.project.base}`);
      return Effect.void;
    }) as unknown as F;
  return { bases, wrapped, startContexts: [] as Array<unknown> };
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
    resumeAfterCooldown: wrapped<typeof actual.resumeAfterCooldown>("resumeAfterCooldown"),
  };
});

// The claim is not run: the test is about the context `liveWorld` builds for it.
vi.mock("./runner/start.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./runner/start.ts")>();
  const start = (ctx: unknown) => {
    startContexts.push(ctx);
    return Effect.succeed({ kind: "skipped", reason: "not run" });
  };
  return { ...actual, start: start as unknown as typeof actual.start };
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
  modelFallbacks: {},
  pruneBranchesAfterDays: 14,
  pruneBranchesDryRun: false,
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
  worktreeCheckout: () => Effect.die("no worktree head"),
  brokenWorktrees: Effect.succeed([]),
  runningThreads: Effect.succeed(0),
  liveBranches: Effect.succeed(new Set()),
  lastActivity: () => Effect.succeed(null),
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
        yield* world.resumeAfterCooldown(repo, run, base, null);
        yield* world.feedback(repo, run, base);
      }
      assert.deepStrictEqual(bases, [
        "timeLimit feature/x",
        "watch feature/x",
        "forward feature/x",
        "advance feature/x",
        "interrupted feature/x",
        "resumeAfterCooldown feature/x",
        "feedback feature/x",
        "timeLimit main",
        "watch main",
        "forward main",
        "advance main",
        "interrupted main",
        "resumeAfterCooldown main",
        "feedback main",
      ]);
    }),
  );
});

describe("liveWorld: a model that cools down", () => {
  const FABLE = { instanceId: "claudeAgent", model: "claude-fable-5-1" };
  const OPUS = { instanceId: "claudeAgent", model: "claude-opus-5-5" };

  it.effect(
    "new claims launch on its fallback until its window ends, from the shared cooldowns",
    () =>
      Effect.gen(function* () {
        const cooldowns = new Map<string, Cooldown>();
        let now = T0;
        const world = liveWorld(
          { ...machine, modelFallbacks: { "claude-fable-5-1": "claude-opus-5-5" } },
          "/factory-test/data",
          FactoryProcess.of({ run: () => Effect.die("no gh") }),
          NodeServices.layer,
          Sessions.FactorySessions.of({
            ...stubSessions,
            findProject: () => Effect.succeed({ id: "proj-1", model: FABLE }),
          }),
          () => now,
          "mac-mini",
          { list: () => Effect.succeed([]), raise: () => Effect.void, clear: () => Effect.void },
          {
            gate: { run: () => Effect.die("no gate") },
            wake: Effect.void,
            scope: yield* Scope.make(),
          },
          undefined,
          undefined,
          {
            gating: new Set(),
            claimMemo: new ClaimMemo(),
            stuckReads: new Map(),
            brokenThreads: { notFactory: new Set(), unsettled: new Map() },
            configSkips: new Map(),
            lastGood: new Map(),
            cooldowns,
            prunedAt: new Map(),
          },
        );
        assert.strictEqual(world.cooldowns, cooldowns);
        assert.deepStrictEqual(yield* world.projectModel(repo), FABLE);
        recordRateLimit(cooldowns, cooldownKey(FABLE), FABLE, T0, T0, null);
        yield* world.start(repo, 7);
        const ctx = startContexts.at(-1) as StartContext;
        assert.deepStrictEqual(ctx.launchModel?.(FABLE), OPUS);
        now = T0 + 5 * 60_000;
        assert.deepStrictEqual(ctx.launchModel?.(FABLE), FABLE);
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
