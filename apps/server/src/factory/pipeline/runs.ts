// @effect-diagnostics nodeBuiltinImport:off - joins the record folder and the project config path.
/**
 * `PipelineRuns`: a run is a fiber in the factory layer's scope, walking the pipeline with
 * `execute.ts` over the live ports, and its record on disk is all the state it keeps. Nothing
 * resumes a run the process lost: the layer ends its runs `interrupted` when it stops, and ends
 * any it could not at its next start.
 */
import * as NodePath from "node:path";

import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";

import {
  loadMachineConfig,
  loadProjectConfig,
  parseProjectConfig,
  PROJECT_CONFIG_PATH,
  type ProjectConfig,
} from "../config.ts";
import { asciiLower } from "../ledger/runId.ts";
import { FactoryProcess } from "../process.ts";
import { FactoryPaths } from "../t3/paths.ts";
import { FactorySessions } from "../t3/sessions.ts";
import { FactoryWatchedRepos } from "../t3/watchedRepos.ts";
import { bindProcess, makeGitHub, type BoundGitHub } from "../tracker/github.ts";
import { execute } from "./execute.ts";
import { livePorts, liveTracker } from "./live.ts";
import { encodePipeline } from "./model.ts";
import {
  appendEvent,
  createRecord,
  isRunId,
  listRecords,
  pipelineIdOf,
  readRecord,
  recordPath,
  runIdFor,
  summarize,
} from "./record.ts";
import {
  PipelineRunError,
  PipelineRuns,
  type RecordedEvent,
  type RunStatus,
} from "./runsService.ts";

export const STOPPED = "stopped by a person";
export const SERVER_STOPPED = "the server stopped";
/** The reason a run that was under way when the server died is given at the next start. */
export const RESTARTED = "the server restarted";
/** The newest runs a list answers: the page polls it while a run goes, so it reads a bounded set. */
export const RUNS_LISTED = 50;
/** How long a run may work, not counting its waits for a person; the factory's default limit. */
export const RUN_LIMIT_MINUTES = 180;
/** Run ids tried before a start gives up; four random hex digits a second rarely collide. */
const ID_ATTEMPTS = 5;

const threadsIn = (events: ReadonlyArray<RecordedEvent>): ReadonlyArray<string> => [
  ...new Set(events.flatMap((event) => (event.event === "thread" ? [event.threadId] : []))),
];

const causeMessage = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : String(error);
};

/** The project config on the repo's default branch, which the factory's own loop reads. */
const configOnBase = (github: BoundGitHub) =>
  github.baseConfig().pipe(
    Effect.map((found) =>
      found.text === null
        ? Option.none<ProjectConfig>()
        : Result.match(parseProjectConfig(found.text, `${found.branch}:${PROJECT_CONFIG_PATH}`), {
            onSuccess: Option.some,
            onFailure: () => Option.none<ProjectConfig>(),
          }),
    ),
    Effect.catch((error) => Effect.as(Effect.logWarning(error.message), Option.none())),
  );

/**
 * The repo's factory config, whose `instructors` say whose answers and feedback a run trusts:
 * the checkout's `.dw/config.yml`, else the default branch's read through `github`, else none.
 */
export const projectConfigFor = Effect.fn("PipelineRuns.projectConfigFor")(function* (
  projectRoot: string,
  github: BoundGitHub | null,
) {
  const inCheckout = yield* loadProjectConfig(NodePath.join(projectRoot, PROJECT_CONFIG_PATH)).pipe(
    Effect.option,
  );
  if (Option.isSome(inCheckout) || github === null) return inCheckout;
  return yield* configOnBase(github);
});

export const make = Effect.gen(function* () {
  const { factoryDir, machineConfigPath } = yield* FactoryPaths;
  const sessions = yield* FactorySessions;
  const process = yield* FactoryProcess;
  const watched = yield* FactoryWatchedRepos;
  const fs = yield* FileSystem.FileSystem;
  // Runs live in a scope of their own, closed after the finalizer below: a stopping server
  // ends each run's record and archives its threads while the run is still in the map.
  const runScope = yield* Scope.fork(yield* Effect.scope, "parallel");
  const runsDir = NodePath.join(factoryDir, "pipelines", "runs");
  const fibers = new Map<string, Fiber.Fiber<unknown, unknown>>();

  const io = (error: { readonly message: string }) =>
    new PipelineRunError({ kind: "io", message: error.message });

  const recordOf = (id: string) =>
    isRunId(id)
      ? readRecord(recordPath(runsDir, id))
      : Effect.fail(new PipelineRunError({ kind: "not-found", message: `no run ${id}` }));

  /**
   * Ends a run's record as `result`, unless it already ended, and archives every thread it
   * names; answers whether it ended it. The record first: archiving is cleanup, and a thread
   * that cannot be archived is logged and left.
   */
  const close = Effect.fn("PipelineRuns.close")(function* (
    id: string,
    result: Exclude<RunStatus, "running">,
    reason: string,
  ) {
    const events = yield* recordOf(id);
    if (events.some((event) => event.event === "ended")) return false;
    yield* appendEvent(recordPath(runsDir, id), yield* Clock.currentTimeMillis, {
      event: "ended",
      result,
      reason,
    });
    for (const threadId of threadsIn(events)) {
      yield* sessions
        .archive(threadId)
        .pipe(Effect.catch((error) => Effect.logWarning(error.message)));
    }
    return true;
  });

  // A record a crash left open ends as a stop would have ended it, threads included: a run is a
  // fiber, and nothing resumes one the process lost.
  const lost: Array<string> = [];
  const left = yield* listRecords(runsDir).pipe(
    Effect.catch((error) => Effect.as(Effect.logError(error.message), [])),
  );
  for (const id of left) {
    const ended = yield* close(id, "interrupted", RESTARTED).pipe(
      Effect.catch((error) =>
        Effect.as(Effect.logError(`pipeline run ${id}: ${error.message}`), false),
      ),
    );
    if (ended) lost.push(id);
  }
  if (lost.length > 0) yield* Effect.logInfo(`pipeline runs interrupted: ${lost.join(", ")}`);

  yield* Effect.addFinalizer(() =>
    Effect.forEach(
      [...fibers],
      ([id, fiber]) =>
        Fiber.interrupt(fiber).pipe(
          Effect.andThen(close(id, "interrupted", SERVER_STOPPED)),
          Effect.catch((error) => Effect.logError(`pipeline run ${id}: ${error.message}`)),
        ),
      { discard: true },
    ),
  );

  /** The watched repo whose checkout is `root`, or null; a listing that fails is null too. */
  const repoAt = (root: string) =>
    watched.list.pipe(
      Effect.map(
        (listing) =>
          listing.repos.find((repo) => asciiLower(repo.path) === asciiLower(root))?.repo ?? null,
      ),
      Effect.catch((error) => Effect.as(Effect.logWarning(error.message), null)),
    );

  /** The branch checked out at `root`, for a project that has no factory config to name a base. */
  const checkedOut = (root: string) =>
    process
      .run({
        command: "git",
        args: ["-C", root, "rev-parse", "--abbrev-ref", "HEAD"],
        separateStderr: true,
        timeoutMs: 30_000,
      })
      .pipe(
        Effect.map((result) => (result.exitCode === 0 ? result.tail.trim() : "")),
        Effect.catch(() => Effect.succeed("")),
        Effect.map((branch) => (branch === "" ? "HEAD" : branch)),
      );

  /** Writes the run's first line under a fresh id; answers the id. */
  const createRun = Effect.fn("PipelineRuns.createRun")(function* (
    pipelineId: string,
    ms: number,
    started: Parameters<typeof createRecord>[2],
  ) {
    for (let attempt = 0; attempt < ID_ATTEMPTS; attempt++) {
      const hex = (yield* Random.nextIntBetween(0, 0xffff)).toString(16).padStart(4, "0");
      const id = runIdFor(pipelineId, ms, hex);
      if (yield* createRecord(recordPath(runsDir, id), ms, started)) return id;
    }
    return yield* new PipelineRunError({
      kind: "io",
      message: `no free run id for ${pipelineId} after ${ID_ATTEMPTS} tries`,
    });
  });

  const start: PipelineRuns["Service"]["start"] = Effect.fn("PipelineRuns.start")(
    function* (request) {
      const { pipeline, projectRoot, issue } = request;
      const project = yield* sessions.findProject(projectRoot).pipe(Effect.mapError(io));
      if (project === null) {
        return yield* new PipelineRunError({
          kind: "no-project",
          message: `no T3 project has the root ${projectRoot}`,
        });
      }
      if (project.model === null) {
        return yield* new PipelineRunError({
          kind: "no-project",
          message: "the T3 project names no default model: set one on the project or in Settings",
        });
      }
      const repo = yield* repoAt(projectRoot);
      const machine = yield* loadMachineConfig(machineConfigPath).pipe(
        Effect.map(Option.map((loaded) => loaded.config)),
        Effect.catch(() => Effect.succeed(Option.none())),
        Effect.provideService(FileSystem.FileSystem, fs),
      );
      const github =
        repo === null || issue === null || Option.isNone(machine)
          ? null
          : bindProcess(makeGitHub({ repo, ghConfigDir: machine.value.ghConfigDir }), process);
      // A parsed config always names instructors. Without one, nobody's answers or feedback can
      // be trusted, so the run gets no tracker and its `ask` and `pr` nodes end it stuck.
      const config = yield* projectConfigFor(projectRoot, github).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
      );
      if (github !== null && Option.isNone(config)) {
        yield* Effect.logWarning(
          `pipeline run on ${repo}#${issue}: no readable ${PROJECT_CONFIG_PATH}, so no tracker`,
        );
      }
      const tracker =
        github === null || issue === null || Option.isNone(config)
          ? null
          : liveTracker({ github, issue, instructors: config.value.instructors });
      const base = Option.isSome(config) ? config.value.base : yield* checkedOut(projectRoot);

      const now = yield* Clock.currentTimeMillis;
      const id = yield* createRun(pipeline.id, now, {
        event: "started",
        pipeline: encodePipeline(pipeline),
        projectRoot,
        repo,
        issue,
      });
      const path = recordPath(runsDir, id);
      const ports = livePorts({
        runId: id,
        projectId: project.id,
        model: project.model,
        base,
        recordPath: path,
        sessions,
        process,
        tracker,
      });
      const fiber = yield* execute(pipeline, ports, {
        repo,
        issue,
        limitMinutes: RUN_LIMIT_MINUTES,
      }).pipe(
        Effect.tap((end) => Effect.logInfo(`pipeline run ${id} ended ${end.result}`)),
        // A failure (the record could not be written) or a defect still ends the record.
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logError(`pipeline run ${id}`, cause).pipe(
                Effect.andThen(close(id, "error", causeMessage(cause))),
                Effect.catch((error) => Effect.logError(`pipeline run ${id}: ${error.message}`)),
              ),
        ),
        Effect.ensuring(Effect.sync(() => fibers.delete(id))),
        Effect.forkIn(runScope),
      );
      fibers.set(id, fiber);
      return summarize(id, yield* readRecord(path));
    },
  );

  const stop: PipelineRuns["Service"]["stop"] = Effect.fn("PipelineRuns.stop")(function* (id) {
    yield* recordOf(id);
    const fiber = fibers.get(id);
    if (fiber !== undefined) yield* Fiber.interrupt(fiber);
    yield* close(id, "stopped", STOPPED);
    return summarize(id, yield* recordOf(id));
  });

  const list: PipelineRuns["Service"]["list"] = Effect.fn("PipelineRuns.list")(
    function* (pipelineId) {
      // The id names the pipeline, so another pipeline's record is never read.
      const ids = (yield* listRecords(runsDir))
        .filter((id) => pipelineId === undefined || pipelineIdOf(id) === pipelineId)
        .slice(0, RUNS_LISTED);
      const summaries = [];
      for (const id of ids) summaries.push(summarize(id, yield* recordOf(id)));
      return summaries;
    },
  );

  const get: PipelineRuns["Service"]["get"] = Effect.fn("PipelineRuns.get")(function* (id) {
    const events = yield* recordOf(id);
    const started = events.find((event) => event.event === "started");
    return {
      ...summarize(id, events),
      pipeline: started?.event === "started" ? started.pipeline : {},
      events,
    };
  });

  return PipelineRuns.of({ start, stop, list, get });
});

/** Needs FactoryPaths, FactorySessions, FactoryProcess, FactoryWatchedRepos and FileSystem. */
export const layer = Layer.effect(PipelineRuns, make);
