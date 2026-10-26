// @effect-diagnostics nodeBuiltinImport:off - the stop request is a file in the data dir.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { describe } from "vite-plus/test";

import { Attention, type NewItem } from "./attention.ts";
import {
  timeLimitOnlyProjectConfig,
  type MachineConfig,
  type RepoConfigReading,
  type WatchedListing,
  type WatchedProject,
} from "./config.ts";
import type { State } from "./domain/lifecycle.ts";
import {
  factoryRuntime,
  FactoryLoop,
  gateDecided,
  gateItem,
  regateWords,
  liveWorld,
  ownedThreads,
  type LiveShared,
  serverStartedMs,
  wakeOn,
  type RuntimeOptions,
} from "./index.ts";
import { isLedgerError } from "./ledger/errors.ts";
import { makeCause } from "./ledger/events.ts";
import { Ledger } from "./ledger/ledger.ts";
import { MachineLog, scanMachineLog } from "./ledger/machineLog.ts";
import { readRun } from "./ledger/read.ts";
import { newRunId, runIdToString, runPath, type RunId } from "./ledger/runId.ts";
import { useTempDirs } from "./ledger/testSupport.ts";
import type { PassWorld, Repo } from "./pass.ts";
import { CUT_SHORT_COMMENT } from "./runner/messages.ts";
import { stopRequestPath } from "./runner/stop.ts";
import { utcSecond } from "./runner/start.ts";
import { ClaimMemo, MARKER } from "./tracker/github.ts";
import { FactoryProcess, RunSpawnError, type RunInput, type RunResult } from "./process.ts";
import { FactoryGate, MERGE_COMMAND } from "./gate.ts";
import { EventsError, FactoryEvents } from "./t3/events.ts";
import * as Paths from "./t3/paths.ts";
import * as Sessions from "./t3/sessions.ts";
import { FactoryWatchedRepos, WatchedReposError } from "./t3/watchedRepos.ts";

/** A process runner on a machine with no `gh`: every call fails to start. */
const noGh = Layer.succeed(
  FactoryProcess,
  FactoryProcess.of({
    run: () => Effect.fail(new RunSpawnError({ shell: false, cause: new Error("gh not found") })),
  }),
);

/** A FactorySessions that finds no T3 project and dies on anything else. */
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
const noSessions = Layer.succeed(Sessions.FactorySessions, stubSessions);

const A_B: WatchedProject = { repo: "a/b", path: "/b", title: "B" };
const C_D: WatchedProject = { repo: "c/d", path: "/d", title: "D" };

/** The T3 projects the factory reads its watched repos from: a fixed list, or an effect that answers it afresh each pass. */
const watching = (
  list:
    | ReadonlyArray<WatchedProject>
    | Effect.Effect<ReadonlyArray<WatchedProject>, WatchedReposError>,
) => {
  const listing = (Effect.isEffect(list) ? list : Effect.succeed(list)).pipe(
    Effect.map((repos): WatchedListing => ({ repos, departed: [], unresolved: [] })),
  );
  return Layer.succeed(
    FactoryWatchedRepos,
    FactoryWatchedRepos.of({ list: listing, listAndRemember: listing }),
  );
};

/** A gate that never runs: the runtime is built without one. */
const noGate = Layer.succeed(
  FactoryGate,
  FactoryGate.of({ run: () => Effect.succeed({ _tag: "running" as const }) }),
);

/** Attention that keeps nothing: a world whose items are not under test. */
const noAttention: Pick<Attention["Service"], "list" | "raise" | "clear"> = {
  list: () => Effect.succeed([]),
  raise: () => Effect.void,
  clear: () => Effect.void,
};

/**
 * Shared state whose `gating` offers each run it frees to `freed`: the milestone of a background
 * gate that neither wakes the loop nor raises an item.
 */
const freeingShared = (freed: Queue.Queue<string>): LiveShared => {
  class Gating extends Set<string> {
    override delete(id: string): boolean {
      const had = super.delete(id);
      Queue.offerUnsafe(freed, id);
      return had;
    }
  }
  return {
    gating: new Gating(),
    claimMemo: new ClaimMemo(),
    stuckReads: new Map(),
    brokenThreads: { notFactory: new Set(), unsettled: new Map() },
    configSkips: new Map(),
    lastGood: new Map(),
  };
};

/** FactoryEvents that never says anything. */
const quietEvents = Layer.succeed(
  FactoryEvents,
  FactoryEvents.of({ runStatusChanges: Stream.never }),
);

const messageText = (message: unknown): string => {
  const first = Array.isArray(message) ? message[0] : message;
  return typeof first === "string" ? first : String(first);
};

/** A building run whose session reported its pull request: the gate reads the issue, then the thread. */
const seedReportedRun = (dataDir: string, repo: string): RunId => {
  const run = newRunId(repo, "10", 1);
  const ledger = Ledger.create(dataDir, run, { clock: () => 1_000 });
  ledger.append(
    {
      event: "session_launched",
      data: {
        thread_id: "thread-1",
        worktree: null,
        branch: null,
        model_instance: null,
        model: null,
        model_options: null,
        resumed_from: null,
      },
    },
    makeCause("start", "seed"),
  );
  ledger.append(
    { event: "state_changed", data: { from: "triage", to: "building" } },
    makeCause("start", "seed"),
  );
  ledger.append(
    { event: "pr_opened", data: { pr: 12, url: `https://github.com/${repo}/pull/12` } },
    makeCause("advance", "seed"),
  );
  ledger.close();
  return run;
};

// The free-space check is off, so a pass does not depend on the disk of the machine running it.
const VALID = `gh_config_dir: /gh
max_concurrent_runs: 1
min_free_gib: 0
`;

/** `VALID` with the one required key a file cannot do without taken out. */
const INVALID = VALID.replace("max_concurrent_runs: 1\n", "");
const MISSING = "max_concurrent_runs: is missing";

// The host's own load would hold claims on a busy machine, such as the gate's.
const idleLoad = () => ({ oneMinute: 0, cores: 1 });

/** Builds the factory runtime over a temp base dir whose factory dir holds `config` (or no file) and returns the log lines. */
const logsFor = (
  config: string | undefined,
  setup: (
    factoryDir: string,
  ) => Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> = () => Effect.void,
  gh: Layer.Layer<FactoryProcess> = noGh,
  watched: ReadonlyArray<WatchedProject> = [A_B],
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { join } = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "factory-index-" });
      const factoryDir = join(baseDir, "factory");
      yield* fs.makeDirectory(factoryDir);
      const machineConfigPath = join(factoryDir, "config.yml");
      if (config !== undefined) yield* fs.writeFileString(machineConfigPath, config);
      yield* setup(factoryDir);

      const logs: Array<string> = [];
      const capture = Logger.make(({ message }) => {
        logs.push(messageText(message));
      });

      const built = yield* Effect.scoped(
        Layer.build(
          factoryRuntime({ readLoad: idleLoad }).pipe(
            Layer.provide(
              Layer.succeed(Paths.FactoryPaths, {
                baseDir,
                worktreesDir: join(baseDir, "worktrees"),
                factoryDir,
                machineConfigPath,
              }),
            ),
            Layer.provide(gh),
            Layer.provide(noSessions),
            Layer.provide(watching(watched)),
            Layer.provide(quietEvents),
            Layer.provide(noGate),
          ),
        ),
      ).pipe(
        Effect.map((context) => Context.get(context, FactoryLoop).status),
        Effect.provide(Logger.layer([capture], { mergeWithExisting: false })),
      );

      const gates = yield* fs
        .readDirectory(join(factoryDir, "gates"))
        .pipe(Effect.orElseSucceed(() => []));
      const events = scanMachineLog(factoryDir).map((entry) => entry.event);
      return { logs, machineConfigPath, gates, events, status: built };
    }),
  ).pipe(Effect.provide(NodeServices.layer));

it.effect("logs that there is no config when the machine file does not exist", () =>
  Effect.gen(function* () {
    const { logs, machineConfigPath, events } = yield* logsFor(undefined);
    assert.deepStrictEqual(logs, [`no factory config at ${machineConfigPath}`]);
    assert.deepStrictEqual(events, []);
  }),
);

// The status goes to every client that can read, so its reason names no path and no error:
// those stay in the server log.
it.effect("reports itself idle, and why, when there is no config", () =>
  Effect.gen(function* () {
    const { status } = yield* logsFor(undefined);
    assert.deepStrictEqual(status, { state: "idle", reason: "no factory config" });
  }),
);

it.effect("logs factory started once for a valid machine file, then runs the first pass", () =>
  Effect.gen(function* () {
    const { logs, events, status } = yield* logsFor(VALID);
    assert.strictEqual(logs[0], "factory started");
    // The pass found no gh: the repo's config could not be read, and the pass said so and ended.
    assert.ok(
      logs.some((line) => line.startsWith("error: a/b: project config not loaded")),
      logs.join("\n"),
    );
    assert.strictEqual(logs.at(-1), "pass done: 0 runs, 0 claimed, 1 errors, 0 need attention");
    assert.deepStrictEqual(status, {
      state: "running",
      settings: { pollSeconds: 60, maxConcurrentRuns: 1, repos: ["a/b"] },
    });
    // The start is recorded before the first pass, and the stop as the scope closes, for
    // `interrupted` to weigh a run the restart cut off against.
    assert.deepStrictEqual(events, [
      "server_started",
      "pass_started",
      "repo_skipped",
      "pass_finished",
      "server_stopping",
    ]);
  }),
);

// A file from before #93 still names the model: the factory starts on it and says, once per key,
// that the key does nothing now.
it.effect("logs one warning per retired model key and still starts", () =>
  Effect.gen(function* () {
    const { logs, machineConfigPath, status } = yield* logsFor(
      `${VALID}model_instance: claudeAgent\nmodel: claude-sonnet-5-5\n`,
    );
    const retired =
      "is no longer used: the model comes from the T3 project's default model, then the T3 settings default";
    assert.deepStrictEqual(logs.slice(0, 3), [
      `${machineConfigPath}: model_instance: ${retired}`,
      `${machineConfigPath}: model: ${retired}`,
      "factory started",
    ]);
    assert.strictEqual(status.state, "running");
  }),
);

// The key is retired: a file that still has it starts the factory, which watches T3's projects.
it.effect("logs one warning for a repos key left in the file and still starts", () =>
  Effect.gen(function* () {
    const { logs, machineConfigPath, status } = yield* logsFor(
      `${VALID}repos:\n  - repo: x/y\n    path: /y\n`,
    );
    assert.deepStrictEqual(logs.slice(0, 2), [
      `${machineConfigPath}: repos: is no longer used: the factory watches the T3 projects of this environment whose checkout has a .dw/config.yml with a factory block`,
      "factory started",
    ]);
    // It watches what T3 lists, not what the file names.
    assert.deepStrictEqual(status, {
      state: "running",
      settings: { pollSeconds: 60, maxConcurrentRuns: 1, repos: ["a/b"] },
    });
  }),
);

it.effect("logs each config error and does not start for an invalid machine file", () =>
  Effect.gen(function* () {
    // The notification for the config item goes to a runner that accepts it, so it logs nothing.
    const { logs, machineConfigPath } = yield* logsFor(
      INVALID,
      () => Effect.void,
      Layer.succeed(FactoryProcess, recordingProcess().process),
    );
    assert.deepStrictEqual(logs, [`${machineConfigPath}: ${MISSING}`]);
  }),
);

it.effect("reports itself idle, without the config errors, when the machine file is invalid", () =>
  Effect.gen(function* () {
    const { status } = yield* logsFor(INVALID);
    assert.deepStrictEqual(status, { state: "idle", reason: "factory config failed to load" });
  }),
);

/** A process runner that records each call: osascript succeeds and every other command fails to start. */
const recordingProcess = () => {
  const calls: Array<RunInput> = [];
  const process = FactoryProcess.of({
    run: (input) => {
      calls.push(input);
      return input.command === "osascript"
        ? Effect.succeed({
            exitCode: 0,
            timedOut: false,
            tail: "",
            stderrTail: "",
            truncated: false,
          } satisfies RunResult)
        : Effect.fail(new RunSpawnError({ shell: false, cause: new Error("gh not found") }));
    },
  });
  return { calls, process };
};

describe("attention", () => {
  /** A base dir whose factory dir holds `config`, and the paths layer over it. */
  const dirWith = (config: string, seed?: string) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { join } = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "factory-attention-index-" });
      const factoryDir = join(baseDir, "factory");
      yield* fs.makeDirectory(factoryDir);
      const machineConfigPath = join(factoryDir, "config.yml");
      yield* fs.writeFileString(machineConfigPath, config);
      if (seed !== undefined) yield* fs.writeFileString(join(factoryDir, "attention.json"), seed);
      return { baseDir, factoryDir, machineConfigPath, worktreesDir: join(baseDir, "worktrees") };
    });

  /** Builds the runtime over `dirs`, and reads the open items while it runs. */
  const itemsAfterStart = (
    dirs: Effect.Success<ReturnType<typeof dirWith>>,
    process: FactoryProcess["Service"],
  ) =>
    Effect.scoped(
      Layer.build(
        factoryRuntime({ readLoad: idleLoad }).pipe(
          Layer.provide(Layer.succeed(Paths.FactoryPaths, dirs)),
          Layer.provide(Layer.succeed(FactoryProcess, process)),
          Layer.provide(noSessions),
          Layer.provide(watching([A_B])),
          Layer.provide(quietEvents),
          Layer.provide(noGate),
        ),
      ).pipe(Effect.flatMap((context) => Context.get(context, Attention).list())),
    );

  it.effect("a machine config that does not load raises one config item and one notification", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dirs = yield* dirWith(INVALID);
        const { calls, process } = recordingProcess();
        const items = yield* itemsAfterStart(dirs, process);
        assert.deepStrictEqual(
          items.map((item) => [item.id, item.kind, item.repo]),
          [["config", "config", null]],
        );
        assert.include(items[0]!.message, MISSING);
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0]!.command, "osascript");
        assert.strictEqual(calls[0]!.args![0], "-e");
        assert.include(calls[0]!.args![1]!, "on run argv");
        assert.strictEqual(calls[0]!.args![2], "factory");
        assert.strictEqual(calls[0]!.args![3], items[0]!.message);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("a config that loads clears the config item an earlier start left", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const seed = JSON.stringify({
          items: [
            {
              id: "config",
              kind: "config",
              repo: null,
              issue: null,
              run: null,
              message: "machine config not loaded: x",
              first_seen: "2026-10-07T13:33:20.000Z",
            },
          ],
        });
        const dirs = yield* dirWith(VALID, seed);
        const { calls, process } = recordingProcess();
        assert.deepStrictEqual(yield* itemsAfterStart(dirs, process), []);
        assert.strictEqual(calls.filter((call) => call.command === "osascript").length, 0);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("a restart over the same files notifies nothing again and still lists the item", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dirs = yield* dirWith(INVALID);
        const first = recordingProcess();
        const second = recordingProcess();
        yield* itemsAfterStart(dirs, first.process);
        const items = yield* itemsAfterStart(dirs, second.process);
        assert.strictEqual(first.calls.length, 1);
        assert.strictEqual(second.calls.length, 0);
        assert.deepStrictEqual(
          items.map((item) => item.id),
          ["config"],
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  /** Wakes the loop until a `pass-errors` item is open, for a config whose every pass errors (no gh). */
  const untilPassErrors = (config: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const dirs = yield* dirWith(config);
        const { calls, process } = recordingProcess();
        const context = yield* Layer.build(
          factoryRuntime({ readLoad: idleLoad }).pipe(
            Layer.provide(Layer.succeed(Paths.FactoryPaths, dirs)),
            Layer.provide(Layer.succeed(FactoryProcess, process)),
            Layer.provide(noSessions),
            Layer.provide(watching([A_B])),
            Layer.provide(quietEvents),
            Layer.provide(noGate),
          ),
        );
        const loop = Context.get(context, FactoryLoop);
        const attention = Context.get(context, Attention);
        const open = () =>
          attention
            .list()
            .pipe(Effect.map((items) => items.filter((item) => item.id === "pass-errors")));
        const openIds = () =>
          attention.list().pipe(Effect.map((items) => items.map((item) => item.id).sort()));
        // Each wake is one more pass, and each wait is bounded so a pass that never ends fails
        // the test instead of hanging it.
        const reached = yield* Effect.gen(function* () {
          while ((yield* open()).length === 0) {
            yield* loop.wake;
            yield* Effect.timeoutOption(loop.awaitPass, "1 second");
          }
        }).pipe(Effect.timeoutOption("30 seconds"), Effect.map(Option.isSome));
        assert.isTrue(reached, "no pass-errors item was raised");
        return {
          items: yield* open(),
          openIds: yield* openIds(),
          osascript: calls.filter((c) => c.command === "osascript"),
        };
      }),
    ).pipe(Effect.provide(NodeServices.layer));

  it.effect(
    "passes that keep erroring raise a pass-errors item and one notification per item",
    () =>
      Effect.gen(function* () {
        const { items, openIds, osascript } = yield* untilPassErrors(VALID);
        assert.include(items[0]!.message, "3 times in a row");
        assert.include(items[0]!.message, "a/b: project config not loaded");
        // The same three passes also raise the config-not-loaded item; each posts once.
        assert.deepStrictEqual(openIds, ["config-not-loaded:a/b", "pass-errors"]);
        assert.strictEqual(osascript.length, 2);
      }),
  );

  it.effect("notify: false keeps the item and posts nothing", () =>
    Effect.gen(function* () {
      const { items, osascript } = yield* untilPassErrors(`${VALID}notify: false\n`);
      assert.strictEqual(items.length, 1);
      assert.strictEqual(osascript.length, 0);
    }),
  );
});

it.effect("clears the gate locks a dead server left and nothing else under gates", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { join } = yield* Path.Path;
    const { logs, gates } = yield* logsFor(VALID, (factoryDir) =>
      Effect.gen(function* () {
        const gatesDir = join(factoryDir, "gates");
        yield* fs.makeDirectory(gatesDir);
        yield* fs.writeFileString(join(gatesDir, "a.lock"), "");
        yield* fs.writeFileString(join(gatesDir, "b.lock"), "");
        yield* fs.writeFileString(join(gatesDir, "notes.txt"), "keep");
      }),
    );
    assert.deepStrictEqual(logs.slice(0, 2), ["cleared 2 gate lock(s)", "factory started"]);
    assert.deepStrictEqual(gates, ["notes.txt"]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("logs each pass line as it is decided, so a pass that dies has said what it did", () =>
  Effect.gen(function* () {
    // The first repo's gh fails, which is a pass line; the second's call is a defect, which ends the pass.
    let calls = 0;
    const dying = Layer.succeed(
      FactoryProcess,
      FactoryProcess.of({
        run: () => {
          calls += 1;
          return calls === 1
            ? Effect.fail(new RunSpawnError({ shell: false, cause: new Error("gh not found") }))
            : Effect.die(new Error("boom"));
        },
      }),
    );
    const { logs } = yield* logsFor(VALID, () => Effect.void, dying, [A_B, C_D]);
    assert.ok(
      logs.some((line) => line.startsWith("error: a/b: project config not loaded")),
      logs.join("\n"),
    );
    assert.ok(logs.includes("factory pass failed"), logs.join("\n"));
  }),
);

describe("waking the pass when a factory thread's run changes status", () => {
  /** Writes an unfinished run of issue `issue` whose session is `threadId`. */
  const seedRun = (factoryDir: string, issue: number, threadId: string, finished = false) => {
    const out = Ledger.create(factoryDir, newRunId("a/b", String(issue), 1));
    try {
      out.append(
        { event: "claimed", data: { machine: "m", github_user: "u" } },
        makeCause("start", "seed"),
      );
      out.append(
        {
          event: "session_launched",
          data: {
            thread_id: threadId,
            worktree: "/t3/wt",
            branch: "t3code/abc",
            model_instance: "claudeAgent",
            model: "claude-sonnet-5-5",
            model_options: null,
            resumed_from: null,
          },
        },
        makeCause("start", "seed"),
      );
      if (finished) out.finish("stuck", null, null, makeCause("start", "seed"));
    } finally {
      out.close();
    }
  };

  /** A factory dir with a valid config and one unfinished run whose session is `thread-1`. */
  const seeded = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { join } = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "factory-wake-" });
    const factoryDir = join(baseDir, "factory");
    yield* fs.makeDirectory(factoryDir);
    const machineConfigPath = join(factoryDir, "config.yml");
    yield* fs.writeFileString(machineConfigPath, VALID);
    seedRun(factoryDir, 1, "thread-1");
    return { baseDir, factoryDir, machineConfigPath, worktreesDir: join(baseDir, "worktrees") };
  });

  it.effect("owns the threads of unfinished runs' sessions, and no finished run's", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { factoryDir } = yield* seeded;
        seedRun(factoryDir, 2, "thread-done", true);
        assert.deepStrictEqual([...(yield* ownedThreads(factoryDir))], ["thread-1"]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("a thread the factory does not own never wakes the pass", () =>
    Effect.gen(function* () {
      const owned = yield* Ref.make<ReadonlySet<string>>(new Set(["thread-1"]));
      const wakes = yield* Ref.make(0);
      yield* wakeOn(
        owned,
        Stream.fromIterable(["thread-other", "thread-1", "thread-other"]),
        Ref.update(wakes, (n) => n + 1),
      );
      assert.strictEqual(yield* Ref.get(wakes), 1);
    }),
  );

  /** The factory's loop over the seeded dir, with `events` as T3's run status changes. */
  const loopOver = (
    dirs: Effect.Success<typeof seeded>,
    events: Stream.Stream<string, EventsError>,
  ) =>
    Layer.build(
      factoryRuntime({ restartDelay: 0, readLoad: idleLoad }).pipe(
        Layer.provide(Layer.succeed(Paths.FactoryPaths, dirs)),
        Layer.provide(noGh),
        Layer.provide(noSessions),
        Layer.provide(watching([A_B])),
        Layer.provide(Layer.succeed(FactoryEvents, FactoryEvents.of({ runStatusChanges: events }))),
        Layer.provide(noGate),
      ),
    ).pipe(Effect.map((context) => Context.get(context, FactoryLoop)));

  const countOf = (factoryDir: string, event: string) => () =>
    scanMachineLog(factoryDir).filter((entry) => entry.event === event).length;

  it.effect("a thread launched after the start is owned once a pass has ended", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dirs = yield* seeded;
        const queue = yield* Queue.unbounded<string>();
        const loop = yield* loopOver(dirs, Stream.fromQueue(queue));
        const started = countOf(dirs.factoryDir, "pass_started");
        const finished = countOf(dirs.factoryDir, "pass_finished");
        // The poll is a minute away, so every pass here is the first or one a wake started. Each
        // wait is bounded so a wake that never comes fails the test instead of hanging it.
        const until = (done: () => boolean, each: Effect.Effect<unknown> = Effect.void) =>
          Effect.gen(function* () {
            while (!done()) {
              yield* each;
              yield* Effect.timeoutOption(loop.awaitPass, "1 second");
            }
          }).pipe(Effect.timeoutOption("30 seconds"), Effect.map(Option.isSome));
        assert.isTrue(yield* until(() => finished() >= 1), "the first pass never ended");
        seedRun(dirs.factoryDir, 2, "thread-2");
        const before = finished();
        yield* loop.wake;
        assert.isTrue(yield* until(() => finished() > before), "the woken pass never ended");
        // That pass read the new run's thread when it ended, so an event for the thread wakes the
        // next one. It is offered until it does: one offered before the read is not a wake.
        const after = started();
        const woke = yield* until(() => started() > after, Queue.offer(queue, "thread-2"));
        assert.isTrue(woke, "the new run's thread never woke the pass");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("an owned thread starts the next pass, and a stream that failed is run again", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { baseDir, factoryDir, machineConfigPath, worktreesDir } = yield* seeded;
        const queue = yield* Queue.unbounded<string>();
        // The first run of the stream fails; the one after it reads the queue.
        const failures = yield* Ref.make(1);
        const events = Layer.succeed(
          FactoryEvents,
          FactoryEvents.of({
            runStatusChanges: Stream.unwrap(
              Ref.modify(failures, (left): readonly [Stream.Stream<string, EventsError>, number] =>
                left > 0
                  ? [Stream.fail(new EventsError({ cause: new Error("gone") })), left - 1]
                  : [Stream.fromQueue(queue), 0],
              ),
            ),
          }),
        );
        const loop = yield* Layer.build(
          factoryRuntime({ restartDelay: 0, readLoad: idleLoad }).pipe(
            Layer.provide(
              Layer.succeed(Paths.FactoryPaths, {
                baseDir,
                worktreesDir,
                factoryDir,
                machineConfigPath,
              }),
            ),
            Layer.provide(noGh),
            Layer.provide(noSessions),
            Layer.provide(watching([A_B])),
            Layer.provide(events),
            Layer.provide(noGate),
          ),
        ).pipe(Effect.map((context) => Context.get(context, FactoryLoop)));
        const started = () =>
          scanMachineLog(factoryDir).filter((entry) => entry.event === "pass_started").length;
        yield* Queue.offer(queue, "thread-other");
        yield* Queue.offer(queue, "thread-1");
        // The first pass, then the one the owned thread woke; the poll is a minute away. The wait is
        // bounded so a wake that never comes fails here. The count stays `>=`: the offer can land
        // while the first pass still runs, and a wake then is coalesced into that pass's latch.
        const waited = yield* Effect.gen(function* () {
          while (started() < 2) yield* loop.awaitPass;
        }).pipe(Effect.timeoutOption("30 seconds"));
        assert.isTrue(Option.isSome(waited), "the owned thread never woke the pass");
        assert.isAtLeast(started(), 2);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("liveWorld", () => {
  const REPO = "rawphp/softfac";
  const NOW = Date.UTC(2026, 9, 8, 2, 0, 0);
  const MINUTE = 60 * 1000;
  const tempDir = useTempDirs();

  /** A process that answers gh by its arguments and records every call. */
  const ghWith = (answer: (args: ReadonlyArray<string>) => string | null) => {
    const calls: Array<ReadonlyArray<string>> = [];
    const process = FactoryProcess.of({
      run: (input: RunInput) => {
        const args = input.args ?? [];
        calls.push(args);
        const stdout = answer(args);
        return Effect.succeed({
          exitCode: stdout === null ? 1 : 0,
          timedOut: false,
          tail: stdout ?? "",
          stderrTail: stdout === null ? "gh: Server Error (HTTP 502)" : "",
          truncated: false,
        } satisfies RunResult);
      },
    });
    return { process, calls };
  };

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

  const worldOf = (process: FactoryProcess["Service"]) =>
    liveWorld(
      machine,
      "/factory-test/data",
      process,
      NodeServices.layer,
      stubSessions,
      () => NOW,
      "mac-mini",
      noAttention,
      {
        gate: { run: () => Effect.succeed({ _tag: "running" as const }) },
        wake: Effect.void,
        scope: Scope.makeUnsafe(),
      },
    );

  const repo: Repo = {
    watched: { repo: REPO, path: "/p" },
    project: timeLimitOnlyProjectConfig(),
    trackerUser: "rawphp",
  };

  const isList = (args: ReadonlyArray<string>, label: string) =>
    args[0] === "issue" && args[1] === "list" && args.includes(label);

  const ago = (ms: number) => utcSecond(NOW - ms);

  const SHA = "4f1c2d3e4a5b60718293a4b5c6d7e8f901234567";
  const pullView = (state: string, head: string, mergeable = "MERGEABLE") =>
    JSON.stringify({
      number: 12,
      isDraft: false,
      state,
      headRefName: "t3code/abc",
      isCrossRepository: false,
      baseRefName: "main",
      headRefOid: head,
      mergeable,
    });

  it.effect(
    "a step is built for the base the pass hands it: advance binds the PR to that base",
    () =>
      Effect.gen(function* () {
        const dataDir = tempDir();
        const run = newRunId(REPO, "10", 1);
        const ledger = Ledger.create(dataDir, run, { clock: () => 1_000 });
        ledger.append(
          { event: "state_changed", data: { from: "triage", to: "building" } },
          makeCause("start", "seed"),
        );
        ledger.append(
          {
            event: "session_launched",
            data: {
              thread_id: "thread-1",
              worktree: "/t3/wt",
              branch: "t3code/abc",
              model_instance: null,
              model: null,
              model_options: null,
              resumed_from: null,
              base: "feature/x",
            },
          },
          makeCause("start", "seed"),
        );
        ledger.close();
        // The session is done and reported a pull request against `feature/x`, not `main`.
        const sessions = Sessions.FactorySessions.of({
          ...stubSessions,
          status: () =>
            Effect.succeed({
              worktreePath: "/t3/wt",
              branch: "t3code/abc",
              archived: false,
              run: "completed" as const,
              runOrdinal: 1,
              runStartedAt: null,
              runCompletedAt: null,
              lastAssistantMessage:
                "Built it.\nFACTORY-DONE: https://github.com/rawphp/softfac/pull/12",
            }),
        });
        const { process, calls } = ghWith((args) => {
          if (args[0] === "issue" && args[1] === "view") {
            return JSON.stringify({
              number: 10,
              title: "Build step",
              body: "Build it.\n\n## Base\n\nfeature/x\n",
              labels: [{ name: "factory:building" }],
              assignees: [{ login: "rawphp" }],
              state: "OPEN",
              author: { login: "rawphp" },
            });
          }
          if (args[0] === "pr" && args[1] === "view") {
            return JSON.stringify({
              number: 12,
              isDraft: true,
              state: "OPEN",
              headRefName: "t3code/abc",
              isCrossRepository: false,
              baseRefName: "feature/x",
              headRefOid: SHA,
              mergeable: "MERGEABLE",
            });
          }
          return null;
        });
        const world = liveWorld(
          machine,
          dataDir,
          process,
          NodeServices.layer,
          sessions,
          () => NOW,
          "mac-mini",
          noAttention,
          {
            gate: { run: () => Effect.die("no gate") },
            wake: Effect.void,
            scope: yield* Scope.make(),
          },
        );
        // Built with the repo's base, the pull request would not bind and the run would go stuck,
        // which stops the session first: the stub's `archive` would die.
        assert.deepStrictEqual(yield* world.advance(repo, run, "feature/x"), {
          kind: "ready-for-gate",
          pr: 12,
          prUrl: "https://github.com/rawphp/softfac/pull/12",
        });
        assert.deepStrictEqual(
          calls.map((args) => args.slice(0, 2)),
          [
            ["issue", "view"],
            ["pr", "view"],
          ],
        );
      }),
  );

  it.effect(
    "an open pull request is read with its head in lower case and GitHub's mergeable state; one that ended is none",
    () =>
      Effect.gen(function* () {
        const open = ghWith(() => pullView("OPEN", SHA.toUpperCase()));
        assert.deepStrictEqual(yield* worldOf(open.process).openPull(repo, 12), {
          head: SHA,
          mergeable: "mergeable",
        });
        const conflicting = ghWith(() => pullView("OPEN", SHA, "CONFLICTING"));
        assert.deepStrictEqual(yield* worldOf(conflicting.process).openPull(repo, 12), {
          head: SHA,
          mergeable: "conflicting",
        });
        for (const state of ["MERGED", "CLOSED"]) {
          const ended = ghWith(() => pullView(state, SHA));
          assert.strictEqual(yield* worldOf(ended.process).openPull(repo, 12), null, state);
        }
      }),
  );

  it.effect("a pull request GitHub no longer has has no head, and a failed read is an error", () =>
    Effect.gen(function* () {
      const gone: FactoryProcess["Service"] = {
        run: () =>
          Effect.succeed({
            exitCode: 1,
            timedOut: false,
            tail: "",
            stderrTail: "GraphQL: Could not resolve to a PullRequest with the number of 12.",
            truncated: false,
          } satisfies RunResult),
      };
      assert.strictEqual(yield* worldOf(gone).openPull(repo, 12), null);
      const broken = ghWith(() => null);
      assert.strictEqual(
        (yield* Effect.flip(worldOf(broken.process).openPull(repo, 12))).kind,
        "tracker",
      );
    }),
  );

  it.effect("a ready issue anyone is assigned to is not listed", () =>
    Effect.gen(function* () {
      const { process } = ghWith((args) =>
        isList(args, "factory:ready")
          ? '[{"number":3,"title":"c","assignees":[]},{"number":2,"title":"b","assignees":[{"login":"eve"}]},{"number":1,"title":"a","assignees":[]}]'
          : null,
      );
      const listing = yield* worldOf(process).readyIssues(repo);
      assert.deepStrictEqual(listing, { items: [1, 3], cut: false });
    }),
  );

  it.effect(
    "a triage issue is listed only when the factory's login, in any case, is its only assignee",
    () =>
      Effect.gen(function* () {
        const { process } = ghWith((args) =>
          isList(args, "factory:triage")
            ? JSON.stringify([
                { number: 4, title: "d", assignees: [{ login: "RawPhp" }] },
                { number: 5, title: "e", assignees: [{ login: "rawphp" }, { login: "eve" }] },
                { number: 6, title: "f", assignees: [{ login: "eve" }] },
                { number: 7, title: "g", assignees: [] },
              ])
            : null,
        );
        const listing = yield* worldOf(process).triageIssues(repo);
        assert.deepStrictEqual(listing, { items: [4], cut: false });
      }),
  );

  /** The unassigned triage issue `updatedAt` ago; its history read fails, so a read shows as a failure. */
  const unassignedUpdated = (updated: number) =>
    Effect.gen(function* () {
      const { process, calls } = ghWith((args) =>
        isList(args, "factory:triage")
          ? JSON.stringify([{ number: 9, assignees: [], updatedAt: ago(updated) }])
          : isList(args, "factory:building")
            ? "[]"
            : null,
      );
      const result = yield* Effect.result(
        worldOf(process).unassignedClaims(repo, new Set<number>()),
      );
      const historyRead = calls.some((args) => args[0] === "api" && args[1] === "graphql");
      return { result, historyRead };
    });

  it.effect("a claim changed within the last 15 minutes is not looked at", () =>
    Effect.gen(function* () {
      const { result, historyRead } = yield* unassignedUpdated(14 * MINUTE);
      assert.ok(result._tag === "Success" && result.success.claims.length === 0);
      assert.isFalse(historyRead);
    }),
  );

  it.effect("a claim unchanged for more than 15 minutes has its history read", () =>
    Effect.gen(function* () {
      const { historyRead } = yield* unassignedUpdated(16 * MINUTE);
      assert.isTrue(historyRead);
    }),
  );

  /** The approval history call, as `readHistory` sends it. */
  const isHistory = (args: ReadonlyArray<string>) => args[0] === "api" && args[1] === "graphql";

  /** A label added to the issue: its name, when, and by whom. */
  type Labeled = { readonly label: string; readonly at: string; readonly by?: string };

  /** A history whose only entries are these label events, oldest first, as the history read answers it. */
  const historyOf = (labeled: ReadonlyArray<Labeled>) =>
    JSON.stringify({
      data: {
        repository: {
          issue: {
            timelineItems: {
              totalCount: labeled.length,
              nodes: labeled.map(({ label, at, by }) => ({
                __typename: "LabeledEvent",
                createdAt: at,
                actor: { __typename: "User", login: by ?? "rawphp" },
                label: { name: label },
              })),
            },
            lastEditedAt: null,
            editor: null,
            userContentEdits: { totalCount: 0, nodes: [] },
          },
        },
      },
    });

  /** A label history in which `by` applied `factory:triage`. */
  const labelledByReply = (by: string) =>
    historyOf([{ label: "factory:triage", at: "2026-10-04T10:00:00Z", by }]);

  it.effect("a judgement that an issue is not the factory's lasts across passes of one world", () =>
    Effect.gen(function* () {
      const { process, calls } = ghWith((args) =>
        isList(args, "factory:triage")
          ? JSON.stringify([{ number: 9, assignees: [], updatedAt: ago(16 * MINUTE) }])
          : isList(args, "factory:building")
            ? "[]"
            : isHistory(args)
              ? labelledByReply("eve")
              : null,
      );
      const world = worldOf(process);
      const first = yield* world.unassignedClaims(repo, new Set<number>());
      const second = yield* world.unassignedClaims(repo, new Set<number>());
      assert.deepStrictEqual(first.claims, []);
      assert.deepStrictEqual(second.claims, []);
      assert.strictEqual(calls.filter(isHistory).length, 1);
    }),
  );

  it.effect(
    "a history read that fails is reported to the pass with the issue and the message",
    () =>
      Effect.gen(function* () {
        const { process } = ghWith((args) =>
          isList(args, "factory:triage")
            ? JSON.stringify([{ number: 9, assignees: [], updatedAt: ago(16 * MINUTE) }])
            : isList(args, "factory:building")
              ? "[]"
              : null,
        );
        const result = yield* worldOf(process).unassignedClaims(repo, new Set<number>());
        assert.deepStrictEqual(result.claims, []);
        assert.strictEqual(result.unread.length, 1);
        const unread = result.unread[0]!;
        assert.strictEqual(unread.issue, 9);
        assert.isTrue(unread.message.length > 0);
      }),
  );

  const OLD = "2026-07-01T01:00:00Z";
  const LABEL_AT = "2026-10-08T00:30:00Z";
  const COMMENT_AT = "2026-10-08T01:00:00Z";

  /**
   * gh for a release from `from`: the issue's comments (its newest factory comment is `newest`,
   * created at `commentAt`), the label history (`labels`, or null when the history cannot be
   * read), and the `from` label, which moves unless `labelFails`.
   */
  const releaseGh = (
    newest: string | null,
    labelFails: boolean,
    commentAt: string = COMMENT_AT,
    labels: ReadonlyArray<Labeled> | null = [{ label: "factory:triage", at: LABEL_AT }],
    from: State = "triage",
  ) =>
    ghWith((args) => {
      if (args[0] === "api" && args[1] === `repos/${REPO}/issues/9/comments`) {
        return JSON.stringify(
          newest === null ? [] : [{ id: 1, body: `${newest}\n\n${MARKER}`, created_at: commentAt }],
        );
      }
      if (isHistory(args)) return labels === null ? null : historyOf(labels);
      if (args[0] === "issue" && args[1] === "comment") return "https://github.com/x/1";
      if (args[0] === "issue" && args[1] === "view") {
        return JSON.stringify({ labels: [{ name: `factory:${from}` }] });
      }
      if (args[0] === "issue" && args[1] === "edit") return labelFails ? null : "";
      return null;
    });

  const steps = (calls: ReadonlyArray<ReadonlyArray<string>>) =>
    calls.map((args) =>
      args[0] === "api"
        ? args[1] === "graphql"
          ? "history"
          : "comments"
        : args[1] === "comment"
          ? "comment"
          : `${args[1]}`,
    );

  it.effect("a cut-short claim is commented on, then moved to proposed", () =>
    Effect.gen(function* () {
      const { process, calls } = releaseGh(null, false);
      yield* worldOf(process).releaseClaim(repo, 9, "triage");
      assert.deepStrictEqual(steps(calls), ["comments", "comment", "view", "edit"]);
    }),
  );

  it.effect("a release whose label fails is tried again without a second comment", () =>
    Effect.gen(function* () {
      const first = releaseGh(null, true);
      const error = yield* Effect.flip(worldOf(first.process).releaseClaim(repo, 9, "triage"));
      assert.strictEqual(error.kind, "tracker");
      assert.deepStrictEqual(steps(first.calls), ["comments", "comment", "view", "edit"]);
      // The next pass finds the issue where it was: the comment is newer than the label event.
      const again = releaseGh(CUT_SHORT_COMMENT, false);
      yield* worldOf(again.process).releaseClaim(repo, 9, "triage");
      assert.deepStrictEqual(steps(again.calls), ["comments", "history", "view", "edit"]);
    }),
  );

  it.effect("an old cut-short comment from before the current label is said again", () =>
    Effect.gen(function* () {
      const { process, calls } = releaseGh(CUT_SHORT_COMMENT, false, OLD);
      yield* worldOf(process).releaseClaim(repo, 9, "triage");
      assert.deepStrictEqual(steps(calls), ["comments", "history", "comment", "view", "edit"]);
    }),
  );

  it.effect(
    "a newest comment that is not the cut-short text is followed by one, unread history",
    () =>
      Effect.gen(function* () {
        const { process, calls } = releaseGh("Something else the factory said.", false);
        yield* worldOf(process).releaseClaim(repo, 9, "triage");
        assert.deepStrictEqual(steps(calls), ["comments", "comment", "view", "edit"]);
      }),
  );

  it.effect("a history that cannot be read still gets the comment, then the move", () =>
    Effect.gen(function* () {
      const { process, calls } = releaseGh(CUT_SHORT_COMMENT, false, COMMENT_AT, null);
      yield* worldOf(process).releaseClaim(repo, 9, "triage");
      assert.deepStrictEqual(steps(calls), ["comments", "history", "comment", "view", "edit"]);
    }),
  );

  it.effect("a history with no label event of the state gets the comment", () =>
    Effect.gen(function* () {
      const { process, calls } = releaseGh(CUT_SHORT_COMMENT, false, COMMENT_AT, []);
      yield* worldOf(process).releaseClaim(repo, 9, "triage");
      assert.deepStrictEqual(steps(calls), ["comments", "history", "comment", "view", "edit"]);
    }),
  );

  it.effect("a cut-short comment made in the label's own second is said again", () =>
    Effect.gen(function* () {
      const { process, calls } = releaseGh(CUT_SHORT_COMMENT, false, LABEL_AT);
      yield* worldOf(process).releaseClaim(repo, 9, "triage");
      assert.deepStrictEqual(steps(calls), ["comments", "history", "comment", "view", "edit"]);
    }),
  );

  /** A claim begun in triage that moved on to building at LABEL_AT. */
  const triageThenBuilding: ReadonlyArray<Labeled> = [
    { label: "factory:triage", at: OLD },
    { label: "factory:building", at: LABEL_AT },
  ];

  it.effect("a release from building compares with the building label, not triage", () =>
    Effect.gen(function* () {
      // Newer than the triage label, older than the building one: it explained the triage claim.
      const between = "2026-07-01T02:00:00Z";
      const old = releaseGh(CUT_SHORT_COMMENT, false, between, triageThenBuilding, "building");
      yield* worldOf(old.process).releaseClaim(repo, 9, "building");
      assert.deepStrictEqual(steps(old.calls), ["comments", "history", "comment", "view", "edit"]);
      const fresh = releaseGh(CUT_SHORT_COMMENT, false, COMMENT_AT, triageThenBuilding, "building");
      yield* worldOf(fresh.process).releaseClaim(repo, 9, "building");
      assert.deepStrictEqual(steps(fresh.calls), ["comments", "history", "view", "edit"]);
    }),
  );

  it.effect(
    "a comment time that is not GitHub's UTC-second form never counts, history unread",
    () =>
      Effect.gen(function* () {
        // Text-sorts after LABEL_AT, so only the form check keeps it from counting.
        const { process, calls } = releaseGh(CUT_SHORT_COMMENT, false, "2026-10-08T09:00:00+10:00");
        yield* worldOf(process).releaseClaim(repo, 9, "triage");
        assert.deepStrictEqual(steps(calls), ["comments", "comment", "view", "edit"]);
      }),
  );

  const configText = (base: string) =>
    `factory:\n  instructors: [tomkaczocha]\n  base: ${base}\n  provision: []\n  gate: [make]\n  limits: { minutes: 1, gate_retries: 0 }\n  autonomy: pr\n`;

  /**
   * gh answers for `.dw/config.yml` on a default branch `main`: the file naming `base`, or the
   * contents call failing with `stderr` (a 404 is GitHub saying the file is not there). `ref`
   * fails the branch's tip call with a 404 instead.
   */
  const baseConfigGh = (
    file: { readonly base: string } | { readonly stderr: string },
    ref: "ok" | "missing" = "ok",
  ) => {
    const sha = "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432";
    const calls: Array<ReadonlyArray<string>> = [];
    const answer = (args: ReadonlyArray<string>): string | { readonly stderr: string } => {
      // The repo is matched in any case, as GitHub matches it, so a test can pass it mixed-case.
      const path = (args[1] ?? "").toLowerCase();
      if (args[0] === "api" && path === `repos/${REPO}`) return '{"default_branch":"main"}';
      if (args[0] === "api" && path === `repos/${REPO}/git/ref/heads/main`) {
        if (ref === "missing") return { stderr: "gh: Not Found (HTTP 404)" };
        return JSON.stringify({ ref: "refs/heads/main", object: { sha, type: "commit" } });
      }
      if (args[0] === "api" && path.startsWith(`repos/${REPO}/contents/`)) {
        if ("stderr" in file) return { stderr: file.stderr };
        const text = configText(file.base);
        return JSON.stringify({
          name: "config.yml",
          path: ".dw/config.yml",
          sha: "abc",
          size: text.length,
          type: "file",
          content: Buffer.from(text).toString("base64"),
          encoding: "base64",
        });
      }
      return { stderr: "gh: Server Error (HTTP 502)" };
    };
    const process = FactoryProcess.of({
      run: (input: RunInput) => {
        const args = input.args ?? [];
        calls.push(args);
        const reply = answer(args);
        const failed = typeof reply !== "string";
        return Effect.succeed({
          exitCode: failed ? 1 : 0,
          timedOut: false,
          tail: failed ? "" : reply,
          stderrTail: failed ? reply.stderr : "",
          truncated: false,
        } satisfies RunResult);
      },
    });
    return { process, calls };
  };

  const NOT_FOUND = { stderr: "gh: Not Found (HTTP 404)" };
  const projectDirs = useTempDirs();

  /** A checkout whose working tree holds `.dw/config.yml` naming `base`, or none. */
  const checkout = (base: string | null) => {
    const root = projectDirs("checkout");
    if (base !== null) {
      NodeFS.mkdirSync(NodePath.join(root, ".dw"));
      NodeFS.writeFileSync(NodePath.join(root, ".dw", "config.yml"), configText(base));
    }
    return { root, file: NodePath.join(root, ".dw", "config.yml") };
  };

  /** The project config of `REPO` at `root`, and what the settings page was told about it. */
  const readProject = (
    process: FactoryProcess["Service"],
    root: string,
    withLastGood = false,
    repo = REPO,
  ) => {
    const readings: Array<RepoConfigReading> = [];
    const world = liveWorld(
      machine,
      "/factory-test/data",
      process,
      NodeServices.layer,
      stubSessions,
      () => NOW,
      "mac-mini",
      noAttention,
      {
        gate: { run: () => Effect.succeed({ _tag: "running" as const }) },
        wake: Effect.void,
        scope: Scope.makeUnsafe(),
      },
      undefined,
      (_repo, reading) => readings.push(reading),
      {
        gating: new Set(),
        claimMemo: new ClaimMemo(),
        stuckReads: new Map(),
        brokenThreads: { notFactory: new Set(), unsettled: new Map() },
        configSkips: new Map(),
        lastGood: new Map(
          withLastGood ? [[REPO.toLowerCase(), { project: timeLimitOnlyProjectConfig() }]] : [],
        ),
      },
    );
    return Effect.result(world.project({ repo, path: root })).pipe(
      Effect.map((result) => ({ result, readings })),
    );
  };

  it.effect("a project config committed on its own base branch is loaded", () =>
    Effect.gen(function* () {
      const { process } = baseConfigGh({ base: "main" });
      const project = yield* worldOf(process).project({ repo: REPO, path: "/p" });
      assert.strictEqual(project.base, "main");
    }),
  );

  it.effect("a project config that names another base is a config error naming both", () =>
    Effect.gen(function* () {
      const { process } = baseConfigGh({ base: "develop" });
      const error = yield* Effect.flip(worldOf(process).project({ repo: REPO, path: "/p" }));
      assert.strictEqual(error.kind, "config");
      assert.include(error.message, "`develop`");
      assert.include(error.message, "`main`");
    }),
  );

  it.effect("the GitHub copy wins over a checkout copy that differs", () =>
    Effect.gen(function* () {
      const { process } = baseConfigGh({ base: "main" });
      // The checkout's copy would be refused: had it been read, the read would fail.
      const local = checkout("develop");
      const { result } = yield* readProject(process, local.root);
      assert.isTrue(Result.isSuccess(result));
      if (Result.isSuccess(result)) assert.strictEqual(result.success.base, "main");
    }),
  );

  it.effect("a config not on GitHub is read from the checkout's working tree", () =>
    Effect.gen(function* () {
      const { process } = baseConfigGh(NOT_FOUND);
      const local = checkout("main");
      const { result, readings } = yield* readProject(process, local.root);
      assert.isTrue(Result.isSuccess(result));
      if (Result.isSuccess(result)) assert.strictEqual(result.success.base, "main");
      assert.deepStrictEqual(
        readings.map((r) => r.kind),
        ["ok"],
      );
    }),
  );

  it.effect("a checkout config that names another base is skipped, naming the local file", () =>
    Effect.gen(function* () {
      const { process } = baseConfigGh(NOT_FOUND);
      const local = checkout("develop");
      const { result, readings } = yield* readProject(process, local.root);
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.strictEqual(result.failure.kind, "config");
        assert.include(result.failure.message, local.file);
        assert.include(result.failure.message, "`develop`");
        assert.include(result.failure.message, "`main`");
        assert.include(result.failure.message, "a checkout's config must name the default branch");
      }
      const reading = readings[0];
      assert.strictEqual(reading?.kind, "errors");
      if (reading?.kind === "errors") {
        assert.deepStrictEqual(
          reading.errors.map((e) => [e.file, e.field]),
          [[local.file, "factory.base"]],
        );
      }
    }),
  );

  it.effect("no config on GitHub and none in the checkout is one error saying both", () =>
    Effect.gen(function* () {
      const { process } = baseConfigGh(NOT_FOUND);
      const local = checkout(null);
      const { result, readings } = yield* readProject(process, local.root);
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.strictEqual(result.failure.kind, "config");
        assert.include(
          result.failure.message,
          `.dw/config.yml is not on main on GitHub, and cannot read ${local.file}: `,
        );
      }
      const reading = readings[0];
      assert.strictEqual(reading?.kind, "errors");
      if (reading?.kind === "errors") {
        assert.deepStrictEqual(
          reading.errors.map((e) => e.file),
          [local.file],
        );
      }
    }),
  );

  it.effect("any other GitHub failure is the pass error and the checkout is not read", () =>
    Effect.gen(function* () {
      // A good checkout copy: any fallback to it would load.
      const local = checkout("main");
      for (const gh of [
        baseConfigGh({ stderr: "gh: Server Error (HTTP 502)" }),
        baseConfigGh({ stderr: "API rate limit exceeded" }),
        baseConfigGh({ base: "main" }, "missing"),
      ]) {
        const { result, readings } = yield* readProject(gh.process, local.root);
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) {
          assert.include(result.failure.message, "cannot read .dw/config.yml from GitHub: ");
          assert.notInclude(result.failure.message, local.root);
        }
        const reading = readings[0];
        assert.strictEqual(reading?.kind, "errors");
        if (reading?.kind === "errors") {
          assert.deepStrictEqual(
            reading.errors.map((e) => e.file),
            [".dw/config.yml"],
          );
        }
      }
    }),
  );

  describe("a failed read is transient only when GitHub never received the call", () => {
    const TLS = `Get "https://api.github.com/repos/x/y/contents/.dw/config.yml": net/http: TLS handshake timeout`;
    // Past every wait between the gh attempts.
    const PAST_RETRIES = 60_000;

    /** A process whose every call fails with `stderr`. */
    const failing = (stderr: string) =>
      FactoryProcess.of({
        run: () =>
          Effect.succeed({
            exitCode: 1,
            timedOut: false,
            tail: "",
            stderrTail: stderr,
            truncated: false,
          } satisfies RunResult),
      });

    it.effect("a transient config read with a last good copy leaves the reading", () =>
      Effect.gen(function* () {
        const { process } = baseConfigGh({ stderr: TLS });
        // The copy is keyed lower-cased, as the pass keys it, whatever case the repo is watched in.
        const fiber = yield* Effect.forkChild(
          readProject(process, checkout("main").root, true, "RawPHP/Softfac"),
          { startImmediately: true },
        );
        yield* TestClock.adjust(PAST_RETRIES);
        const { result, readings } = yield* Fiber.join(fiber);
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) assert.strictEqual(result.failure.transient, true);
        // The pass runs on the copy, so the settings page is not told the config failed.
        assert.deepStrictEqual(readings, []);
      }),
    );

    it.effect("a transient config read with no last good copy reports the errors", () =>
      Effect.gen(function* () {
        const { process } = baseConfigGh({ stderr: TLS });
        const fiber = yield* Effect.forkChild(readProject(process, checkout("main").root), {
          startImmediately: true,
        });
        yield* TestClock.adjust(PAST_RETRIES);
        const { result, readings } = yield* Fiber.join(fiber);
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) assert.strictEqual(result.failure.transient, true);
        // The repo is skipped, and the reading says why.
        assert.strictEqual(readings[0]?.kind, "errors");
      }),
    );

    it.effect("a config read GitHub answered with an error is not transient", () =>
      Effect.gen(function* () {
        const { process } = baseConfigGh({ stderr: "gh: Server Error (HTTP 502)" });
        // With a last good copy too: the pass skips the repo on a failure GitHub answered, so
        // the settings page is told.
        const { result, readings } = yield* readProject(process, checkout("main").root, true);
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) assert.notStrictEqual(result.failure.transient, true);
        assert.strictEqual(readings[0]?.kind, "errors");
      }),
    );

    it.effect("a login read that GitHub never received is transient", () =>
      Effect.gen(function* () {
        const world = worldOf(failing(TLS));
        const fiber = yield* Effect.forkChild(
          Effect.result(world.trackerUser({ repo: REPO, path: "/p" })),
          { startImmediately: true },
        );
        yield* TestClock.adjust(PAST_RETRIES);
        const result = yield* Fiber.join(fiber);
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) assert.strictEqual(result.failure.transient, true);
      }),
    );

    it.effect("a login read GitHub refused is not transient", () =>
      Effect.gen(function* () {
        const world = worldOf(failing("gh: Bad credentials (HTTP 401)"));
        const result = yield* Effect.result(world.trackerUser({ repo: REPO, path: "/p" }));
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) assert.notStrictEqual(result.failure.transient, true);
      }),
    );
  });

  it.effect("a checkout config that does not parse names the local file in its errors", () =>
    Effect.gen(function* () {
      const { process } = baseConfigGh(NOT_FOUND);
      const local = checkout(null);
      NodeFS.mkdirSync(NodePath.join(local.root, ".dw"));
      NodeFS.writeFileSync(local.file, "factory:\n  instructors: [tomkaczocha]\n  base: main\n");
      const { result, readings } = yield* readProject(process, local.root);
      assert.isTrue(Result.isFailure(result));
      const reading = readings[0];
      assert.strictEqual(reading?.kind, "errors");
      if (reading?.kind === "errors") {
        assert.isAbove(reading.errors.length, 0);
        for (const error of reading.errors) assert.strictEqual(error.file, local.file);
      }
    }),
  );

  it.effect("a checkout config that cannot be read is one error saying both", () =>
    Effect.gen(function* () {
      const { process } = baseConfigGh(NOT_FOUND);
      const local = checkout(null);
      // A directory where the file should be.
      NodeFS.mkdirSync(local.file, { recursive: true });
      const { result } = yield* readProject(process, local.root);
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.include(
          result.failure.message,
          `.dw/config.yml is not on main on GitHub, and cannot read ${local.file}: `,
        );
      }
    }),
  );

  it.effect("a config read from GitHub names `<branch>:.dw/config.yml` in its errors", () =>
    Effect.gen(function* () {
      const { process } = baseConfigGh({ base: "develop" });
      const { readings } = yield* readProject(process, checkout(null).root);
      const reading = readings[0];
      assert.strictEqual(reading?.kind, "errors");
      if (reading?.kind === "errors") {
        assert.deepStrictEqual(
          reading.errors.map((e) => e.file),
          ["main:.dw/config.yml"],
        );
      }
    }),
  );

  const tempDirForLogs = useTempDirs();

  it.effect("T3 trouble is the newest t3 error in the machine log within ten minutes", () =>
    Effect.gen(function* () {
      const dataDir = tempDirForLogs();
      const { process } = ghWith(() => null);
      const world = liveWorld(
        machine,
        dataDir,
        process,
        NodeServices.layer,
        stubSessions,
        () => NOW,
        "mac-mini",
        noAttention,
        {
          gate: { run: () => Effect.succeed({ _tag: "running" as const }) },
          wake: Effect.void,
          scope: Scope.makeUnsafe(),
        },
      );
      // No machine log yet: no trouble.
      assert.strictEqual(yield* world.t3Trouble(), null);
      const log = MachineLog.open(dataDir, { clock: () => NOW - 20 * MINUTE });
      log.append({ event: "error", data: { step: "pass", kind: "t3", message: "too old" } });
      log.close();
      assert.strictEqual(yield* world.t3Trouble(), null);
      const recent = MachineLog.open(dataDir, { clock: () => NOW - 2 * MINUTE });
      recent.append({ event: "error", data: { step: "pass", kind: "t3", message: "timed out" } });
      recent.close();
      assert.strictEqual(yield* world.t3Trouble(), "timed out");
    }),
  );

  it.effect("the server starts are the machine log's server_started lines of the last day", () =>
    Effect.gen(function* () {
      const dataDir = tempDirForLogs();
      const { process } = ghWith(() => null);
      const world = liveWorld(
        machine,
        dataDir,
        process,
        NodeServices.layer,
        stubSessions,
        () => NOW,
        "mac-mini",
        noAttention,
        {
          gate: { run: () => Effect.succeed({ _tag: "running" as const }) },
          wake: Effect.void,
          scope: Scope.makeUnsafe(),
        },
      );
      assert.deepStrictEqual(yield* world.t3Starts(), []);
      for (const at of [NOW - 25 * 60 * MINUTE, NOW - 2 * MINUTE]) {
        const log = MachineLog.open(dataDir, { clock: () => at });
        log.append({ event: "server_started", data: { started_at: at } });
        log.close();
      }
      assert.deepStrictEqual(yield* world.t3Starts(), [NOW - 2 * MINUTE]);
      // The stop of the newest start is the newest stop before it: none is written yet.
      assert.deepStrictEqual(yield* world.t3Stops(), []);
      // A stop older than a day is read for the start of the last day it belongs to.
      const downDir = tempDirForLogs();
      for (const [event, at] of [
        ["server_stopping", NOW - 50 * 60 * MINUTE],
        ["server_started", NOW - 2 * MINUTE],
      ] as const) {
        const log = MachineLog.open(downDir, { clock: () => at });
        log.append(
          event === "server_stopping"
            ? { event, data: { stopping_at: at } }
            : { event, data: { started_at: at } },
        );
        log.close();
      }
      const downWorld = liveWorld(
        machine,
        downDir,
        process,
        NodeServices.layer,
        stubSessions,
        () => NOW,
        "mac-mini",
        noAttention,
        {
          gate: { run: () => Effect.succeed({ _tag: "running" as const }) },
          wake: Effect.void,
          scope: Scope.makeUnsafe(),
        },
      );
      assert.deepStrictEqual(yield* downWorld.t3Stops(), [NOW - 50 * 60 * MINUTE]);
      // A start is not T3 trouble in the log's sense: `interrupted` weighs it against the run.
      assert.strictEqual(yield* world.t3Trouble(), null);
    }),
  );

  it("serverStartedMs is this process's start, before now", () => {
    const started = serverStartedMs();
    // The time origin is when this process started, so it is before any now.
    assert.ok(
      Number.isInteger(started) && started > 0 && Math.abs(started - performance.timeOrigin) <= 0.5,
      `${started} vs ${performance.timeOrigin}`,
    );
  });
});

describe("the gate in the background", () => {
  const tempDir = useTempDirs();
  const REPO = "rawphp/softfac";

  /** What `gh pr view` answers for pull request 12 of `REPO`, as `state`, at `head`. */
  const PR_VIEW = (state: "OPEN" | "MERGED", head: string, mergeable = "MERGEABLE") =>
    JSON.stringify({
      number: 12,
      isDraft: false,
      state,
      headRefName: "t3code/abc",
      isCrossRepository: false,
      baseRefName: "main",
      headRefOid: head,
      mergeable,
    });
  const HEAD = "4f1c2d3e4a5b60718293a4b5c6d7e8f901234567";
  const BASE = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";

  /** A run whose gate passed at `HEAD` against `BASE`, whose worktree is removed and whose issue is `pr-open`. */
  const prOpenRun = (dataDir: string, issue = "10"): RunId => {
    const run = newRunId(REPO, issue, 1);
    const ledger = Ledger.create(dataDir, run, { clock: () => 1_000 });
    const cause = makeCause("gate", "seed", { attempt: 1 });
    for (const event of [
      {
        event: "session_launched",
        data: {
          thread_id: "thread-1",
          worktree: "/t3/wt",
          branch: null,
          model_instance: null,
          model: null,
          model_options: null,
          resumed_from: null,
        },
      },
      { event: "pr_opened", data: { pr: 12, url: "https://github.com/rawphp/softfac/pull/12" } },
      {
        event: "gate_checkout",
        data: { attempt: 1, dir: "/gone", sha: HEAD, base_sha: BASE },
      },
      {
        event: "gate_command",
        data: { attempt: 1, command: "cargo test", exit_code: 0, duration_ms: 5 },
      },
      { event: "step_changed", data: { step: `gate-passed ${HEAD} 1` } },
      { event: "worktree_removed", data: { path: "/t3/wt" } },
      { event: "state_changed", data: { from: "building", to: "pr-open" } },
    ] as const) {
      ledger.append(event, cause);
    }
    ledger.close();
    return run;
  };

  const background = {
    ghConfigDir: "/gh/rawphp",
    pollSeconds: 60,
    maxConcurrentRuns: 1,
    maxConcurrentGates: 1,
    feedbackSeconds: 600,
    notify: true,
    minFreeGib: 0,
    maxLoadPerCore: 0,
    deployWaitMinutes: 120,
  } satisfies MachineConfig;
  const backgroundRepo: Repo = {
    watched: { repo: REPO, path: "/p" },
    project: { ...timeLimitOnlyProjectConfig(), base: "main" },
    trackerUser: "rawphp",
  };

  it.effect("runs the gate step as a background fiber and wakes the loop once it decided", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      // A pr-open run whose pull request was merged: the re-gate ends the run at once, with no
      // command run and nothing written on GitHub.
      const run = prOpenRun(dataDir);
      const seen: Array<ReadonlyArray<string>> = [];
      const gh: FactoryProcess["Service"] = {
        run: (input) => {
          seen.push(input.args ?? []);
          return answered(PR_VIEW("MERGED", HEAD));
        },
      };
      const woken = yield* Deferred.make<void>();
      const archived: Array<string> = [];
      const world = liveWorld(
        background,
        dataDir,
        gh,
        NodeServices.layer,
        Sessions.FactorySessions.of({
          ...stubSessions,
          archive: (threadId) => Effect.sync(() => void archived.push(threadId)),
        }),
        () => 1_000,
        "mac-mini",
        noAttention,
        {
          gate: { run: () => Effect.die("no gate runs for a merged pull request") },
          wake: Deferred.succeed(woken, undefined).pipe(Effect.asVoid),
          scope: yield* Scope.make(),
        },
      );
      assert.deepStrictEqual(yield* world.gate(backgroundRepo, run), { kind: "started" });
      assert.strictEqual(world.gateRunning(run), true);
      // A second start while the first runs is queued at max_concurrent_gates 1.
      assert.deepStrictEqual(yield* world.gate(backgroundRepo, newRunId(REPO, "11", 1)), {
        kind: "queued",
        running: 1,
        max: 1,
      });
      yield* Deferred.await(woken);
      assert.strictEqual(world.gateRunning(run), false);
      assert.deepStrictEqual(archived, ["thread-1"]);
      assert.strictEqual(readRun(dataDir, run).entries.at(-1)?.event, "finished");
      // It read the pull request, for a re-gate; a gate of a pr-open run would have read nothing.
      assert.ok(
        seen.some((args) => args.includes("view")),
        JSON.stringify(seen),
      );
    }),
  );

  describe("under high load", () => {
    const loaded = { ...background, maxConcurrentGates: 2, maxLoadPerCore: 1 };
    const overloaded = () => ({ oneMinute: 55.2, cores: 12 });
    const merged: FactoryProcess["Service"] = { run: () => answered(PR_VIEW("MERGED", HEAD)) };
    // The re-gate of a merged pull request archives the run's thread and finishes the run.
    const sessions = Sessions.FactorySessions.of({ ...stubSessions, archive: () => Effect.void });
    const liveGate = (woken: Deferred.Deferred<void>, scope: Scope.Scope) => ({
      gate: { run: () => Effect.die("no gate runs for a merged pull request") },
      wake: Deferred.succeed(woken, undefined).pipe(Effect.asVoid),
      scope,
      readLoad: overloaded,
    });

    it.effect("a second gate answers queued and its run records no gate attempt", () =>
      Effect.gen(function* () {
        const dataDir = tempDir();
        const run = prOpenRun(dataDir);
        const other = prOpenRun(dataDir, "11");
        const before = NodeFS.readFileSync(runPath(dataDir, other), "utf8");
        const woken = yield* Deferred.make<void>();
        const world = liveWorld(
          loaded,
          dataDir,
          merged,
          NodeServices.layer,
          sessions,
          () => 1_000,
          "mac-mini",
          noAttention,
          liveGate(woken, yield* Scope.make()),
        );
        assert.deepStrictEqual(yield* world.gate(backgroundRepo, run), { kind: "started" });
        assert.deepStrictEqual(yield* world.gate(backgroundRepo, other), {
          kind: "high-load",
          oneMinute: 55.2,
          limit: 12,
        });
        assert.strictEqual(world.gateRunning(other), false);
        yield* Deferred.await(woken);
        assert.strictEqual(NodeFS.readFileSync(runPath(dataDir, other), "utf8"), before);
      }),
    );

    // Off the load, max_concurrent_gates is the only limit.
    it.effect.each([
      {
        name: "under the limit",
        machine: loaded,
        readLoad: () => ({ oneMinute: 2, cores: 12 }),
      },
      {
        name: "at max_load_per_core 0, which reads no load",
        machine: { ...loaded, maxLoadPerCore: 0 },
        readLoad: () => assert.fail("the load is not read at max_load_per_core 0"),
      },
    ])("$name a second gate starts", ({ machine, readLoad }) =>
      Effect.gen(function* () {
        const dataDir = tempDir();
        const run = prOpenRun(dataDir);
        const other = prOpenRun(dataDir, "11");
        const wakes = yield* Queue.unbounded<void>();
        const world = liveWorld(
          machine,
          dataDir,
          merged,
          NodeServices.layer,
          sessions,
          () => 1_000,
          "mac-mini",
          noAttention,
          {
            gate: { run: () => Effect.die("no gate runs for a merged pull request") },
            wake: Queue.offer(wakes, undefined).pipe(Effect.asVoid),
            scope: yield* Scope.make(),
            readLoad,
          },
        );
        assert.deepStrictEqual(yield* world.gate(backgroundRepo, run), { kind: "started" });
        assert.deepStrictEqual(yield* world.gate(backgroundRepo, other), { kind: "started" });
        yield* Queue.takeN(wakes, 2);
        assert.isFalse(world.gateRunning(run) || world.gateRunning(other));
      }),
    );

    it.effect("with no gate running the gate starts whatever the load", () =>
      Effect.gen(function* () {
        const dataDir = tempDir();
        const run = prOpenRun(dataDir);
        const woken = yield* Deferred.make<void>();
        const world = liveWorld(
          loaded,
          dataDir,
          merged,
          NodeServices.layer,
          sessions,
          () => 1_000,
          "mac-mini",
          noAttention,
          liveGate(woken, yield* Scope.make()),
        );
        assert.deepStrictEqual(yield* world.gate(backgroundRepo, run), { kind: "started" });
        yield* Deferred.await(woken);
      }),
    );
  });

  it.effect(
    "a pr-open run that nothing moved for is re-gated quietly: no decision, no wake, no write",
    () =>
      Effect.gen(function* () {
        const dataDir = tempDir();
        const run = prOpenRun(dataDir);
        const before = NodeFS.readFileSync(runPath(dataDir, run), "utf8");
        const woken = yield* Ref.make(0);
        const freed = yield* Queue.unbounded<string>();
        const gh: FactoryProcess["Service"] = {
          run: (input) =>
            answered(
              input.args?.includes("view") === true
                ? PR_VIEW("OPEN", HEAD)
                : JSON.stringify({ object: { type: "commit", sha: BASE } }),
            ),
        };
        const world = liveWorld(
          background,
          dataDir,
          gh,
          NodeServices.layer,
          stubSessions,
          () => 1_000,
          "mac-mini",
          noAttention,
          {
            gate: { run: () => Effect.die("nothing moved, so nothing is gated") },
            wake: Ref.update(woken, (n) => n + 1),
            scope: yield* Scope.make(),
          },
          undefined,
          undefined,
          freeingShared(freed),
        );
        assert.deepStrictEqual(yield* world.gate(backgroundRepo, run), { kind: "started" });
        yield* Queue.take(freed);
        assert.isFalse(world.gateRunning(run));
        assert.strictEqual(yield* Ref.get(woken), 0);
        assert.strictEqual(NodeFS.readFileSync(runPath(dataDir, run), "utf8"), before);
      }),
  );

  it.effect(
    "with every slot taken, a run GitHub says conflicts is gated at once and any other is queued",
    () =>
      Effect.gen(function* () {
        const dataDir = tempDir();
        const run = prOpenRun(dataDir);
        let mergeable = "MERGEABLE";
        let prState: "OPEN" | "MERGED" | "fails" = "OPEN";
        const prReads: Array<string> = [];
        const gh: FactoryProcess["Service"] = {
          run: (input) => {
            const args = input.args ?? [];
            if (args.includes("pr") && args.includes("view")) {
              prReads.push(`${prState} ${mergeable}`);
              if (prState === "fails") {
                return Effect.fail(
                  new RunSpawnError({ shell: false, cause: new Error("gh died") }),
                );
              }
              return answered(PR_VIEW(prState, HEAD, mergeable));
            }
            if (readsIssue(input)) return answered(OPEN_ISSUE);
            return answered(JSON.stringify({ object: { type: "commit", sha: BASE } }));
          },
        };
        let gateRuns = 0;
        const freed = yield* Queue.unbounded<string>();
        const shared = freeingShared(freed);
        // Another run's gate holds the only slot.
        shared.gating.add(runIdToString(newRunId(REPO, "99", 1)));
        const world = liveWorld(
          background,
          dataDir,
          gh,
          NodeServices.layer,
          stubSessions,
          () => 1_000,
          "mac-mini",
          noAttention,
          {
            gate: {
              run: () =>
                Effect.sync(() => {
                  gateRuns += 1;
                  return { _tag: "queued", running: 1, max: 1 } as const;
                }),
            },
            wake: Effect.void,
            scope: yield* Scope.make(),
          },
          undefined,
          undefined,
          shared,
        );
        const repo: Repo = {
          ...backgroundRepo,
          project: { ...backgroundRepo.project, gate: ["cargo test"] },
        };
        const before = NodeFS.readFileSync(runPath(dataDir, run), "utf8");
        // Mergeable: it waits for the slot, after one read of its pull request, and nothing is written.
        assert.deepStrictEqual(yield* world.gate(repo, run), {
          kind: "queued",
          running: 1,
          max: 1,
        });
        assert.deepStrictEqual(prReads, ["OPEN MERGEABLE"]);
        assert.isFalse(world.gateRunning(run));
        assert.strictEqual(NodeFS.readFileSync(runPath(dataDir, run), "utf8"), before);
        // A merged pull request that read as conflicting, and a read that fails, wait for the slot too.
        mergeable = "CONFLICTING";
        for (const state of ["MERGED", "fails"] as const) {
          prState = state;
          assert.deepStrictEqual(
            yield* world.gate(repo, run),
            { kind: "queued", running: 1, max: 1 },
            state,
          );
        }
        assert.deepStrictEqual(prReads.slice(1), ["MERGED CONFLICTING", "fails CONFLICTING"]);
        assert.strictEqual(NodeFS.readFileSync(runPath(dataDir, run), "utf8"), before);
        prState = "OPEN";
        // Conflicting: the gate starts though the slot is taken, and records the conflict with no
        // gate run, so no lock.
        mergeable = "CONFLICTING";
        assert.deepStrictEqual(yield* world.gate(repo, run), { kind: "started" });
        yield* Queue.take(freed);
        assert.isFalse(world.gateRunning(run));
        assert.strictEqual(gateRuns, 0);
        const conflictLines = readRun(dataDir, run).entries.filter(
          (e) =>
            e.event === "gate_command" &&
            (e.data as { command?: string }).command === MERGE_COMMAND,
        );
        assert.deepStrictEqual(
          conflictLines.map((e) => e.data),
          [{ attempt: 2, command: MERGE_COMMAND, exit_code: 1, duration_ms: 0 }],
        );
      }),
  );

  /** What `gh issue view` answers for the open `factory:building` issue the gate reads before anything else. */
  const OPEN_ISSUE = JSON.stringify({
    number: 10,
    title: "Build step",
    body: "",
    labels: [{ name: "factory:building" }],
    assignees: [{ login: "rawphp" }],
    state: "OPEN",
    author: { login: "tomkaczocha" },
  });
  const readsIssue = (input: RunInput) =>
    input.args?.includes("number,title,body,labels,assignees,state,author") === true;
  const answered = (tail: string) =>
    Effect.succeed({
      exitCode: 0,
      timedOut: false,
      tail,
      stderrTail: "",
      truncated: false,
    } satisfies RunResult);

  /** A building run whose session reported its pull request: the gate reads the issue, then the thread. */
  const reportedRun = (dataDir: string): RunId => seedReportedRun(dataDir, REPO);

  const gateMachine: MachineConfig = {
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
  const gateRepo: Repo = {
    watched: { repo: REPO, path: "/p" },
    project: timeLimitOnlyProjectConfig(),
    trackerUser: "rawphp",
  };
  /** `gh` answers the read of the open issue and is not found for anything else. */
  const deadGh: FactoryProcess["Service"] = {
    run: (input) =>
      readsIssue(input)
        ? answered(OPEN_ISSUE)
        : Effect.fail(new RunSpawnError({ shell: false, cause: new Error("gh not found") })),
  };

  it.effect(
    "a gate that fails records the error by kind, frees the run and does not wake the loop",
    () =>
      Effect.gen(function* () {
        const dataDir = tempDir();
        const run = reportedRun(dataDir);
        const freed = yield* Queue.unbounded<string>();
        const woken = yield* Ref.make(0);
        const sessions = Sessions.FactorySessions.of({
          ...stubSessions,
          status: () =>
            Effect.fail(new Sessions.SessionsError({ operation: "status", cause: "timeout" })),
        });
        const world = liveWorld(
          gateMachine,
          dataDir,
          deadGh,
          NodeServices.layer,
          sessions,
          () => 1_000,
          "mac-mini",
          noAttention,
          {
            gate: { run: () => Effect.die("the thread read fails first") },
            wake: Ref.update(woken, (n) => n + 1),
            scope: yield* Scope.make(),
          },
          undefined,
          undefined,
          freeingShared(freed),
        );
        assert.deepStrictEqual(yield* world.gate(gateRepo, run), { kind: "started" });
        yield* Queue.take(freed);
        assert.isFalse(world.gateRunning(run));
        const errors = readRun(dataDir, run).entries.filter((e) => e.event === "error");
        assert.strictEqual(errors.length, 1);
        assert.deepInclude(errors[0]!.data as object, { step: "gate", kind: "t3" });
        assert.strictEqual(yield* Ref.get(woken), 0);
        // The run is free for the next pass's gate.
        assert.deepStrictEqual(yield* world.gate(gateRepo, run), { kind: "started" });
      }),
  );

  it.effect("a world built on the same shared state sees the gates another world started", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const run = reportedRun(dataDir);
      const other = newRunId(REPO, "11", 1);
      const held = yield* Deferred.make<void>();
      const entered = yield* Deferred.make<void>();
      const sessions = Sessions.FactorySessions.of({
        ...stubSessions,
        status: () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(held)),
            Effect.andThen(Effect.die("released")),
          ),
      });
      const live = {
        gate: { run: () => Effect.die("never reached") },
        wake: Effect.void,
        scope: yield* Scope.make(),
      };
      const shared = {
        gating: new Set<string>(),
        claimMemo: new ClaimMemo(),
        stuckReads: new Map<string, number>(),
        brokenThreads: { notFactory: new Set<string>(), unsettled: new Map<string, number>() },
        configSkips: new Map<string, number>(),
        lastGood: new Map(),
      };
      const build = () =>
        liveWorld(
          gateMachine,
          dataDir,
          deadGh,
          NodeServices.layer,
          sessions,
          () => 1_000,
          "mac-mini",
          noAttention,
          live,
          undefined,
          undefined,
          shared,
        );
      const before = build();
      assert.deepStrictEqual(yield* before.gate(gateRepo, run), { kind: "started" });
      yield* Deferred.await(entered);
      // What a reload does: a new world, on the state the old one shares.
      const after = build();
      assert.strictEqual(after.gateRunning(run), true);
      // Nor does a reload read every stuck item's issue again at once.
      assert.strictEqual(after.stuckReads, before.stuckReads);
      assert.deepStrictEqual(yield* after.gate(gateRepo, other), {
        kind: "queued",
        running: 1,
        max: 1,
      });
      // Without shared state a world starts from nothing: that is the defect this guards.
      assert.strictEqual(
        liveWorld(
          gateMachine,
          dataDir,
          deadGh,
          NodeServices.layer,
          sessions,
          () => 1_000,
          "mac-mini",
          noAttention,
          live,
        ).gateRunning(run),
        false,
      );
      yield* Deferred.succeed(held, undefined);
    }),
  );

  it.effect("a gate that ends in stuck raises the run's stuck item, as a pass would", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const run = reportedRun(dataDir);
      const raised: Array<NewItem> = [];
      const woken = yield* Deferred.make<void>();
      // The thread is gone, so the gate stops the run; GitHub holds the issue as building and
      // answers every write.
      const quietGh: FactoryProcess["Service"] = {
        run: (input) =>
          answered(
            readsIssue(input)
              ? OPEN_ISSUE
              : input.args?.includes("labels")
                ? JSON.stringify({ labels: [{ name: "factory:building" }] })
                : input.args?.some((arg) => arg.endsWith("/comments"))
                  ? "[]"
                  : "",
          ),
      };
      const sessions = Sessions.FactorySessions.of({
        ...stubSessions,
        status: (threadId) => Effect.fail(new Sessions.ThreadNotFoundError({ threadId })),
        thread: (threadId) => Effect.fail(new Sessions.ThreadNotFoundError({ threadId })),
        archive: () => Effect.void,
        removeWorktree: () => Effect.void,
      });
      const world = liveWorld(
        gateMachine,
        dataDir,
        quietGh,
        NodeServices.layer,
        sessions,
        () => 1_000,
        "mac-mini",
        {
          list: () => Effect.succeed([]),
          raise: (item) => Effect.sync(() => void raised.push(item)),
          clear: () => Effect.void,
        },
        {
          gate: { run: () => Effect.die("no gate runs for a gone thread") },
          wake: Deferred.succeed(woken, undefined).pipe(Effect.asVoid),
          scope: yield* Scope.make(),
        },
      );
      assert.deepStrictEqual(yield* world.gate(gateRepo, run), { kind: "started" });
      yield* Deferred.await(woken);
      assert.isFalse(world.gateRunning(run));
      const id = runIdToString(run);
      assert.ok(readRun(dataDir, run).entries.some((e) => e.event === "finished"));
      assert.deepStrictEqual(raised, [
        {
          id: `run:${id}:stuck`,
          kind: "stuck",
          repo: REPO,
          issue: Number(run.issue),
          run: id,
          message: `${REPO}#${run.issue} stuck, the reason is in the ledger of run ${id}`,
        },
      ]);
    }),
  );

  it.effect("a gate still running when the factory's scope closes is interrupted", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const run = reportedRun(dataDir);
      const entered = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      const sessions = Sessions.FactorySessions.of({
        ...stubSessions,
        status: () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
          ),
      });
      const scope = yield* Scope.make();
      const world = liveWorld(
        gateMachine,
        dataDir,
        deadGh,
        NodeServices.layer,
        sessions,
        () => 1_000,
        "mac-mini",
        noAttention,
        {
          gate: { run: () => Effect.die("the thread read never ends") },
          wake: Effect.void,
          scope,
        },
      );
      assert.deepStrictEqual(yield* world.gate(gateRepo, run), { kind: "started" });
      // The gate is under way, waiting on T3, when the factory stops.
      yield* Deferred.await(entered);
      assert.strictEqual(world.gateRunning(run), true);
      yield* Scope.close(scope, Exit.void);
      yield* Deferred.await(interrupted);
      assert.strictEqual(world.gateRunning(run), false);
      assert.ok(!readRun(dataDir, run).entries.some((e) => e.event === "error"));
    }),
  );

  it("wakes the loop only for a gate that decided something", () => {
    assert.strictEqual(gateDecided({ kind: "passed", pr: 12 }), true);
    assert.strictEqual(gateDecided({ kind: "sent-back", attempt: 1 }), true);
    assert.strictEqual(gateDecided({ kind: "stuck", reason: "r" }), true);
    assert.strictEqual(gateDecided({ kind: "ended" }), true);
    assert.strictEqual(gateDecided({ kind: "abandoned" }), true);
    // Nothing changed: the normal poll carries the next try, so a session still at work or a
    // rate limit does not spin the loop.
    assert.strictEqual(gateDecided({ kind: "not-ready" }), false);
    assert.strictEqual(gateDecided({ kind: "unchanged" }), false);
    assert.strictEqual(gateDecided({ kind: "running" }), false);
    assert.strictEqual(gateDecided({ kind: "checks-pending" }), false);
    assert.strictEqual(gateDecided({ kind: "queued", running: 2, max: 2 }), false);
    assert.strictEqual(gateDecided(null), false);
  });

  it("says what a re-gate did in the words of softfac's run line, and nothing for an unchanged one", () => {
    const words = (
      step: Parameters<typeof regateWords>[2],
      moved: Parameters<typeof regateWords>[3],
    ) => regateWords("run-1", REPO, step, moved);
    assert.strictEqual(words({ kind: "unchanged" }, null), null);
    assert.strictEqual(
      words({ kind: "passed", pr: 12 }, "conflict"),
      "GitHub says the pull request conflicts with the base branch, the gate passed again, PR https://github.com/rawphp/softfac/pull/12 stays ready for review",
    );
    assert.strictEqual(
      words({ kind: "passed", pr: 12 }, "head"),
      "the pull request's head moved, the gate passed again, PR https://github.com/rawphp/softfac/pull/12 stays ready for review",
    );
    assert.strictEqual(
      words({ kind: "sent-back", attempt: 2 }, "both"),
      "the pull request's head and the base branch moved, the gate failed on attempt 2, the PR is a draft again and the session was told",
    );
    assert.strictEqual(
      words({ kind: "passed", pr: 12 }, null),
      "no pass was on record, the gate passed again, PR https://github.com/rawphp/softfac/pull/12 stays ready for review",
    );
    assert.strictEqual(
      words({ kind: "stuck", reason: "r" }, "head"),
      `stuck, the reason is in the ledger of run run-1`,
    );
    assert.strictEqual(
      words({ kind: "ended" }, null),
      "the pull request was merged or closed, the run is finished",
    );
    assert.strictEqual(
      words({ kind: "abandoned" }, null),
      "the issue is closed, the run is closed",
    );
    assert.strictEqual(
      words({ kind: "sent-back", attempt: 2 }, "conflict"),
      "GitHub says the pull request conflicts with the base branch, the gate failed on attempt 2, the PR is a draft again and the session was told",
    );
    assert.strictEqual(
      words({ kind: "passed", pr: 12 }, "earlier"),
      "an earlier version of the factory began this re-gate, the gate passed again, PR https://github.com/rawphp/softfac/pull/12 stays ready for review",
    );
    assert.strictEqual(words({ kind: "not-ready" }, null), "the gate waits for the session");
  });

  it("raises a stuck item for a gate that ended stuck, as the pass does, and nothing else", () => {
    assert.deepStrictEqual(gateItem(REPO, 10, "run-1", { kind: "stuck", reason: "r" }), {
      id: "run:run-1:stuck",
      kind: "stuck",
      repo: REPO,
      issue: 10,
      run: "run-1",
      message: `${REPO}#10 stuck, the reason is in the ledger of run run-1`,
    });
    assert.strictEqual(gateItem(REPO, 10, "run-1", { kind: "passed", pr: 12 }), null);
    assert.strictEqual(gateItem(REPO, 10, "run-1", { kind: "sent-back", attempt: 1 }), null);
    assert.strictEqual(gateItem(REPO, 10, "run-1", { kind: "ended" }), null);
    assert.strictEqual(gateItem(REPO, 10, "run-1", { kind: "checks-pending" }), null);
    assert.strictEqual(gateItem(REPO, 10, "run-1", null), null);
  });

  it("raises the abandoned item for a gate that found the issue closed, as the pass does", () => {
    assert.deepStrictEqual(gateItem(REPO, 10, "run-1", { kind: "abandoned" }), {
      id: "attention:run-1:abandoned",
      kind: "attention",
      repo: REPO,
      issue: 10,
      run: "run-1",
      message: `${REPO}#10 Abandoned: the issue was closed, so the factory stopped the session and closed the run`,
    });
  });

  it.effect("takes a stop request the operator left in the data dir", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const run = newRunId(REPO, "10", 1);
      const ledger = Ledger.create(dataDir, run, { clock: () => 1_000 });
      ledger.append(
        { event: "state_changed", data: { from: "triage", to: "building" } },
        makeCause("start", "seed"),
      );
      ledger.close();
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
      const world = liveWorld(
        machine,
        dataDir,
        { run: () => Effect.die("no gh") },
        NodeServices.layer,
        stubSessions,
        () => 2_000,
        "mac-mini",
        noAttention,
        {
          gate: { run: () => Effect.die("no gate") },
          wake: Effect.void,
          scope: yield* Scope.make(),
        },
      );
      assert.strictEqual(yield* world.takeStopRequest(run), "none");
      const path = stopRequestPath(dataDir, run);
      NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
      NodeFS.writeFileSync(path, "operator\n");
      assert.strictEqual(yield* world.takeStopRequest(run), "recorded");
      assert.strictEqual(readRun(dataDir, run).entries.at(-1)?.event, "stop_requested");
      assert.strictEqual(yield* world.takeStopRequest(run), "none");
    }),
  );

  it.effect(
    "says a gate send is pending from the run's ledger until the send-back is recorded",
    () =>
      Effect.gen(function* () {
        const dataDir = tempDir();
        const run = newRunId(REPO, "10", 1);
        const other = newRunId(REPO, "11", 1);
        const seed = (id: RunId, steps: ReadonlyArray<string>) => {
          const ledger = Ledger.create(dataDir, id, { clock: () => 1_000 });
          ledger.append(
            { event: "state_changed", data: { from: "triage", to: "building" } },
            makeCause("start", "seed"),
          );
          for (const step of steps) {
            ledger.append({ event: "step_changed", data: { step } }, makeCause("gate", "seed"));
          }
          ledger.close();
        };
        seed(run, ["gate-sending 1 1"]);
        // Another run with nothing pending: the answer is the asked run's.
        seed(other, []);
        const world = liveWorld(
          {
            ghConfigDir: "/gh/rawphp",
            pollSeconds: 60,
            maxConcurrentRuns: 1,
            maxConcurrentGates: 1,
            feedbackSeconds: 600,
            notify: true,
            minFreeGib: 0,
            maxLoadPerCore: 0,
            deployWaitMinutes: 120,
          },
          dataDir,
          { run: () => Effect.die("no gh") },
          NodeServices.layer,
          stubSessions,
          () => 2_000,
          "mac-mini",
          noAttention,
          {
            gate: { run: () => Effect.die("no gate") },
            wake: Effect.void,
            scope: yield* Scope.make(),
          },
        );
        assert.strictEqual(yield* world.hasPendingGateSend(run), true);
        assert.strictEqual(yield* world.hasPendingGateSend(other), false);

        const ledger = Ledger.open(dataDir, run, { clock: () => 1_500 });
        ledger.append(
          { event: "gate_sent_back", data: { attempt: 1, run_ordinal: 1 } },
          makeCause("gate", "seed"),
        );
        ledger.close();
        assert.strictEqual(yield* world.hasPendingGateSend(run), false);

        const missing = yield* Effect.flip(world.hasPendingGateSend(newRunId(REPO, "12", 1)));
        assert.ok(isLedgerError(missing), missing.message);
      }),
  );
});

describe("reloading the machine config", () => {
  /** A fake `gh` that records the argv of every call and holds the first call naming each of `repos` until released. */
  const holdingProcess = (repos: ReadonlyArray<string> = ["a/b"]) => {
    const calls: Array<string> = [];
    /** The `GH_CONFIG_DIR` of each call, in the order of `calls`. */
    const ghDirs: Array<string | undefined> = [];
    const holds = new Map(
      repos.map((repo) => [
        repo,
        { held: false, entered: Deferred.makeUnsafe<void>(), release: Deferred.makeUnsafe<void>() },
      ]),
    );
    const process = FactoryProcess.of({
      run: (input) =>
        Effect.gen(function* () {
          const call = [input.command, ...(input.args ?? [])].join(" ");
          calls.push(call);
          ghDirs.push(input.env?.["GH_CONFIG_DIR"]);
          const hold = [...holds].find(([repo]) => call.includes(repo))?.[1];
          if (hold !== undefined && !hold.held) {
            hold.held = true;
            yield* Deferred.succeed(hold.entered, undefined);
            yield* Deferred.await(hold.release);
          }
          return yield* Effect.fail(
            new RunSpawnError({ shell: false, cause: new Error("gh not found") }),
          );
        }),
    });
    const first = holds.get(repos[0]!)!;
    return { calls, ghDirs, process, holds, entered: first.entered, release: first.release };
  };

  /** The runtime over a temp base dir holding `config` (or no file); `write` replaces the file. */
  const started = (
    config: string | undefined,
    process: FactoryProcess["Service"],
    events: Layer.Layer<FactoryEvents> = quietEvents,
    options: RuntimeOptions = {},
    watched: Layer.Layer<FactoryWatchedRepos> = watching([A_B]),
    sessions: Layer.Layer<Sessions.FactorySessions> = noSessions,
  ) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { join } = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "factory-reload-" });
      const factoryDir = join(baseDir, "factory");
      yield* fs.makeDirectory(factoryDir);
      const machineConfigPath = join(factoryDir, "config.yml");
      if (config !== undefined) yield* fs.writeFileString(machineConfigPath, config);
      const context = yield* Layer.build(
        factoryRuntime({ readLoad: idleLoad, ...options }).pipe(
          Layer.provide(
            Layer.succeed(Paths.FactoryPaths, {
              baseDir,
              worktreesDir: join(baseDir, "worktrees"),
              factoryDir,
              machineConfigPath,
            }),
          ),
          Layer.provide(Layer.succeed(FactoryProcess, process)),
          Layer.provide(sessions),
          Layer.provide(watched),
          Layer.provide(events),
          Layer.provide(noGate),
        ),
      );
      return {
        loop: Context.get(context, FactoryLoop),
        factoryDir,
        file: machineConfigPath,
        write: (text: string) => fs.writeFileString(machineConfigPath, text),
      };
    });

  const OTHER = VALID.replace("gh_config_dir: /gh", "gh_config_dir: /gh2");

  it.effect("goes from idle to running when a valid file appears and is reloaded", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { calls, process, entered, release } = holdingProcess();
        const { loop, write } = yield* started(undefined, process);
        assert.deepStrictEqual(loop.status, { state: "idle", reason: "no factory config" });
        yield* write(VALID);
        yield* loop.reload;
        yield* Deferred.await(entered);
        const pass = yield* Effect.forkChild(loop.awaitPass, { startImmediately: true });
        yield* Deferred.succeed(release, undefined);
        assert.strictEqual((yield* Fiber.join(pass))?.errors, 1);
        assert.deepStrictEqual(loop.status, {
          state: "running",
          settings: { pollSeconds: 60, maxConcurrentRuns: 1, repos: ["a/b"] },
        });
        assert.ok(
          calls.some((call) => call.startsWith("gh ") && call.includes("a/b")),
          calls.join("\n"),
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("goes idle when the file turns invalid or is removed, and passes do nothing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { calls, process, entered, release } = holdingProcess();
        const { loop, write } = yield* started(VALID, process);
        yield* Deferred.await(entered);
        yield* Deferred.succeed(release, undefined);
        yield* write(INVALID);
        yield* loop.reload;
        assert.deepStrictEqual(loop.status, {
          state: "idle",
          reason: "factory config failed to load",
        });
        const seen = calls.length;
        const pass = yield* Effect.forkChild(loop.awaitPass, { startImmediately: true });
        yield* loop.wake;
        assert.deepStrictEqual(yield* Fiber.join(pass), {
          runs: 0,
          claimed: 0,
          errors: 0,
          attention: 0,
        });
        assert.strictEqual(calls.length, seen);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "a pass under way finishes on the config it started with, the next uses the new one",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { calls, ghDirs, process, holds, entered, release } = holdingProcess([
            "a/b",
            "c/d",
          ]);
          // T3's projects change between the passes: the next one is the first to see c/d.
          const projects = yield* Ref.make<ReadonlyArray<WatchedProject>>([A_B]);
          const { loop, write } = yield* started(
            VALID,
            process,
            quietEvents,
            {},
            watching(Ref.get(projects)),
          );
          yield* Deferred.await(entered);
          const first = yield* Effect.forkChild(loop.awaitPass, { startImmediately: true });
          yield* Ref.set(projects, [C_D]);
          yield* write(OTHER);
          yield* loop.reload;
          // The pass under way listed a/b, and what was listed last is what the status reports.
          assert.deepStrictEqual(loop.status, {
            state: "running",
            settings: { pollSeconds: 60, maxConcurrentRuns: 1, repos: ["a/b"] },
          });
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(first);
          // The next pass follows at once, on the new config: it is held at its first call.
          const second = holds.get("c/d")!;
          yield* Deferred.await(second.entered);
          const next = yield* Effect.forkChild(loop.awaitPass, { startImmediately: true });
          yield* Deferred.succeed(second.release, undefined);
          yield* Fiber.join(next);
          assert.deepStrictEqual(loop.status, {
            state: "running",
            settings: { pollSeconds: 60, maxConcurrentRuns: 1, repos: ["c/d"] },
          });
          const lastOld = calls.findLastIndex((call) => call.includes("a/b"));
          const firstNew = calls.findIndex((call) => call.includes("c/d"));
          assert.ok(lastOld >= 0 && firstNew > lastOld, calls.join("\n"));
          // The world follows the config too: the pass under way keeps its login, the next one has the new.
          calls.forEach((call, at) => {
            if (call.includes("a/b")) assert.strictEqual(ghDirs[at], "/gh", call);
            if (call.includes("c/d")) assert.strictEqual(ghDirs[at], "/gh2", call);
          });
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  // The sessions write where T3 makes worktrees now, which Settings → Storage can move off the
  // default folder; the gate writes under the factory dir.
  it.effect("free space is read where the sessions' worktrees and the gate's checkouts go", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const elsewhere = yield* fs.makeTempDirectoryScoped({ prefix: "factory-worktrees-" });
        for (const [setting, expected] of [
          [elsewhere, (factoryDir: string) => [elsewhere, factoryDir]],
          [null, (factoryDir: string) => [factoryDir]],
        ] as const) {
          const worlds: Array<PassWorld> = [];
          const read: Array<string> = [];
          const sessions = Layer.succeed(Sessions.FactorySessions, {
            ...stubSessions,
            worktreesDirectory: () => Effect.succeed(setting),
          });
          const { factoryDir } = yield* started(
            VALID,
            holdingProcess().process,
            quietEvents,
            {
              onWorld: (world) => worlds.push(world),
              readFreeSpace: (path) => {
                read.push(path);
                return { path, freeBytes: path === elsewhere ? 3 : 7 };
              },
            },
            watching([A_B]),
            sessions,
          );
          const space = yield* worlds[0]!.freeSpace();
          assert.deepStrictEqual(read, expected(factoryDir));
          assert.deepStrictEqual(
            space,
            setting === null
              ? { path: factoryDir, freeBytes: 7 }
              : { path: elsewhere, freeBytes: 3 },
          );
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("the world reads the deploy-pending marker from the factory dir", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const worlds: Array<PassWorld> = [];
        const { factoryDir } = yield* started(VALID, holdingProcess().process, quietEvents, {
          onWorld: (world) => worlds.push(world),
        });
        const commit = "7a70dadf1e2f3a4b5c6d7e8f901234567890abcd";
        const file = NodePath.join(factoryDir, "deploy-pending");
        assert.strictEqual(worlds[0]!.pendingDeploy(), null);
        NodeFS.writeFileSync(file, `1761400000 ${commit}\n`);
        assert.deepStrictEqual(worlds[0]!.pendingDeploy(), {
          sinceMs: 1761400000000,
          commit,
          writtenMs: Math.floor(NodeFS.statSync(file).mtimeMs),
        });
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("a reload's world sees the gates the world before it started", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const hold = yield* Deferred.make<void>();
        const process = FactoryProcess.of({
          run: () =>
            Deferred.await(hold).pipe(
              Effect.andThen(
                Effect.fail(new RunSpawnError({ shell: false, cause: new Error("gh not found") })),
              ),
            ),
        });
        const worlds: Array<PassWorld> = [];
        const oneGate = `${VALID}max_concurrent_gates: 1\n`;
        const { loop, factoryDir, write } = yield* started(oneGate, process, quietEvents, {
          onWorld: (world) => worlds.push(world),
        });
        const repo: Repo = {
          watched: { repo: "a/b", path: "/b" },
          project: timeLimitOnlyProjectConfig(),
          trackerUser: "rawphp",
        };
        const run = seedReportedRun(factoryDir, "a/b");
        const other = newRunId("a/b", "11", 1);
        const worldA = worlds[0]!;
        // The gate holds on its first gh call, so it is running when the file changes.
        assert.deepStrictEqual(yield* worldA.gate(repo, run), { kind: "started" });
        yield* write(oneGate.replace("gh_config_dir", "poll_seconds: 30\ngh_config_dir"));
        yield* loop.reload;
        const worldB = worlds[1]!;
        assert.notStrictEqual(worldB, worldA);
        assert.strictEqual(worldB.gateRunning(run), true);
        assert.deepStrictEqual(yield* worldB.gate(repo, other), {
          kind: "queued",
          running: 1,
          max: 1,
        });
        yield* Deferred.succeed(hold, undefined);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("repoConfigs holds the errors of a repo whose project config could not be read", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { process, entered, release } = holdingProcess();
        const { loop } = yield* started(VALID, process);
        yield* Deferred.await(entered);
        assert.strictEqual((yield* loop.repoConfigs).size, 0);
        const pass = yield* Effect.forkChild(loop.awaitPass, { startImmediately: true });
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(pass);
        const reading = (yield* loop.repoConfigs).get("a/b");
        assert.strictEqual(reading?.kind, "errors");
        const errors = reading?.kind === "errors" ? reading.errors : [];
        assert.strictEqual(errors.length, 1);
        assert.ok(
          errors[0]!.message.startsWith("cannot read .dw/config.yml from GitHub"),
          errors[0]!.message,
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "watchedRepos lists the T3 projects as they are now, and fails as the reader does",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { process } = holdingProcess();
          const projects = yield* Ref.make<ReadonlyArray<WatchedProject>>([A_B]);
          const listing = yield* started(
            VALID,
            process,
            quietEvents,
            {},
            watching(Ref.get(projects)),
          );
          assert.deepStrictEqual(yield* listing.loop.watchedRepos, {
            repos: [A_B],
            departed: [],
            unresolved: [],
          });
          yield* Ref.set(projects, [A_B, C_D]);
          assert.deepStrictEqual(yield* listing.loop.watchedRepos, {
            repos: [A_B, C_D],
            departed: [],
            unresolved: [],
          });
          const failing = yield* started(
            VALID,
            process,
            quietEvents,
            {},
            watching(Effect.fail(new WatchedReposError({ cause: new Error("store down") }))),
          );
          const error = yield* Effect.flip(failing.loop.watchedRepos);
          assert.strictEqual(error.message, "cannot list the T3 projects: store down");
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("a pass reads the T3 projects with listAndRemember, the settings page with list", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { process, entered, release } = holdingProcess();
        const calls = { list: 0, listAndRemember: 0 };
        const counted = (name: keyof typeof calls) =>
          Effect.sync((): WatchedListing => {
            calls[name] += 1;
            return { repos: [A_B], departed: [], unresolved: [] };
          });
        const { loop } = yield* started(
          VALID,
          process,
          quietEvents,
          {},
          Layer.succeed(
            FactoryWatchedRepos,
            FactoryWatchedRepos.of({
              list: counted("list"),
              listAndRemember: counted("listAndRemember"),
            }),
          ),
        );
        // The first pass has listed and is held at its first call.
        yield* Deferred.await(entered);
        assert.deepStrictEqual(calls, { list: 0, listAndRemember: 1 });
        yield* loop.watchedRepos;
        assert.deepStrictEqual(calls, { list: 1, listAndRemember: 1 });
        yield* Deferred.succeed(release, undefined);
        // A save's report reads as the settings page does; whatever passes the reload starts remember.
        const remembered = calls.listAndRemember;
        const saved = yield* loop.save({ poll_seconds: 60 });
        assert.strictEqual(saved.kind, "ok");
        assert.strictEqual(calls.list, 2);
        assert.ok(calls.listAndRemember >= remembered);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reading watchedRepos for the settings page leaves the status as the pass set it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { process, entered, release } = holdingProcess();
        const projects = yield* Ref.make<ReadonlyArray<WatchedProject>>([A_B]);
        const { loop } = yield* started(
          VALID,
          process,
          quietEvents,
          {},
          watching(Ref.get(projects)),
        );
        // The pass under way listed a/b; it is held at its first call.
        yield* Deferred.await(entered);
        yield* Ref.set(projects, [A_B, C_D]);
        assert.deepStrictEqual(yield* loop.watchedRepos, {
          repos: [A_B, C_D],
          departed: [],
          unresolved: [],
        });
        assert.deepStrictEqual(loop.status, {
          state: "running",
          settings: { pollSeconds: 60, maxConcurrentRuns: 1, repos: ["a/b"] },
        });
        yield* Deferred.succeed(release, undefined);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "a listing that fails after a pass keeps the last repos in the status and logs the error",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { process, entered, release } = holdingProcess();
          let fail = false;
          const logs: Array<string> = [];
          const capture = Logger.make(({ message }) => {
            logs.push(messageText(message));
          });
          const { loop } = yield* started(
            VALID,
            process,
            quietEvents,
            {},
            watching(
              Effect.suspend(() =>
                fail
                  ? Effect.fail(new WatchedReposError({ cause: new Error("store down") }))
                  : Effect.succeed([A_B]),
              ),
            ),
          ).pipe(Effect.provide(Logger.layer([capture], { mergeWithExisting: false })));
          yield* Deferred.await(entered);
          const first = yield* Effect.forkChild(loop.awaitPass, { startImmediately: true });
          fail = true;
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(first);
          const next = yield* Effect.forkChild(loop.awaitPass, { startImmediately: true });
          yield* loop.wake;
          yield* Fiber.join(next);
          // What the last listing named stands; the pass that could not list said so and worked nothing.
          assert.deepStrictEqual(loop.status, {
            state: "running",
            settings: { pollSeconds: 60, maxConcurrentRuns: 1, repos: ["a/b"] },
          });
          assert.ok(
            logs.some((line) => line.includes("cannot list the T3 projects: store down")),
            logs.join("\n"),
          );
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("two reloads at once from idle make one loop and one wake stream", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const logs: Array<string> = [];
        const capture = Logger.make(({ message }) => {
          logs.push(messageText(message));
        });
        const subscribed = yield* Deferred.make<void>();
        let subscriptions = 0;
        const events = Layer.succeed(
          FactoryEvents,
          FactoryEvents.of({
            runStatusChanges: Stream.suspend(() => {
              subscriptions += 1;
              Deferred.doneUnsafe(subscribed, Exit.void);
              return Stream.never;
            }),
          }),
        );
        const { process } = holdingProcess();
        const { loop, write } = yield* started(undefined, process, events);
        yield* write(VALID);
        yield* Effect.all([loop.reload, loop.reload], { concurrency: 2 }).pipe(
          Effect.provide(Logger.layer([capture], { mergeWithExisting: false })),
        );
        yield* Deferred.await(subscribed);
        for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
        assert.strictEqual(logs.filter((line) => line === "factory started").length, 1);
        assert.strictEqual(subscriptions, 1);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  describe("save", () => {
    it.effect(
      "creates a missing file from a valid body, reloads and leaves the factory running",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const { process } = holdingProcess();
            const { loop, file } = yield* started(undefined, process);
            assert.strictEqual(loop.status.state, "idle");
            const result = yield* loop.save({
              gh_config_dir: "/gh",
              max_concurrent_runs: 1,
              model: "claude-sonnet-5-5",
            });
            assert.strictEqual(result.kind, "ok");
            if (result.kind === "ok") {
              assert.strictEqual(result.report.exists, true);
              assert.strictEqual(result.report.config?.gh_config_dir, "/gh");
            }
            assert.strictEqual(loop.status.state, "running");
            assert.ok(
              (yield* (yield* FileSystem.FileSystem).readFileString(file)).includes(
                "gh_config_dir",
              ),
            );
          }),
        ).pipe(Effect.provide(NodeServices.layer)),
    );

    it.effect("answers an invalid body with the errors and a non-object body as invalid-body", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { process } = holdingProcess();
          const { loop, file } = yield* started(undefined, process);
          const invalid = yield* loop.save({ poll_seconds: 5 });
          assert.strictEqual(invalid.kind, "invalid");
          assert.strictEqual(yield* (yield* FileSystem.FileSystem).exists(file), false);
          for (const body of [null, [1], "x"]) {
            assert.deepStrictEqual(yield* loop.save(body), { kind: "invalid-body" });
          }
          assert.strictEqual(loop.status.state, "idle");
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  });
});
