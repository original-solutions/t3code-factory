// @effect-diagnostics nodeBuiltinImport:off - joins the record folder and the project config path.
/**
 * `PipelineRuns`: a run is a fiber in the factory layer's scope, walking the pipeline with
 * `execute.ts` over the live ports, and its record on disk is all the state it keeps. Nothing
 * resumes a run the process lost, so the layer ends those records `interrupted` when it starts.
 */
import * as NodePath from "node:path";

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Random from "effect/Random";

import { loadMachineConfig, loadProjectConfig, PROJECT_CONFIG_PATH } from "../config.ts";
import { asciiLower } from "../ledger/runId.ts";
import { FactoryProcess } from "../process.ts";
import { FactoryPaths } from "../t3/paths.ts";
import { FactorySessions } from "../t3/sessions.ts";
import { FactoryWatchedRepos } from "../t3/watchedRepos.ts";
import { bindProcess, makeGitHub } from "../tracker/github.ts";
import { execute } from "./execute.ts";
import { livePorts, liveTracker } from "./live.ts";
import { encodePipeline } from "./model.ts";
import {
  appendEvent,
  isRunId,
  listRecords,
  markInterrupted,
  readRecord,
  recordPath,
  runIdFor,
  summarize,
} from "./record.ts";
import { PipelineRunError, PipelineRuns, type RecordedEvent } from "./runsService.ts";

export const STOPPED = "stopped by a person";

const threadsIn = (events: ReadonlyArray<RecordedEvent>): ReadonlyArray<string> => [
  ...new Set(events.flatMap((event) => (event.event === "thread" ? [event.threadId] : []))),
];

export const make = Effect.gen(function* () {
  const { factoryDir, machineConfigPath } = yield* FactoryPaths;
  const sessions = yield* FactorySessions;
  const process = yield* FactoryProcess;
  const watched = yield* FactoryWatchedRepos;
  const fs = yield* FileSystem.FileSystem;
  const scope = yield* Effect.scope;
  const runsDir = NodePath.join(factoryDir, "pipelines", "runs");
  const fibers = new Map<string, Fiber.Fiber<unknown, unknown>>();

  const marked = yield* markInterrupted(runsDir, yield* Clock.currentTimeMillis).pipe(
    Effect.catch((error) => Effect.as(Effect.logError(error.message), [])),
  );
  if (marked.length > 0) yield* Effect.logInfo(`pipeline runs interrupted: ${marked.join(", ")}`);

  const io = (error: { readonly message: string }) =>
    new PipelineRunError({ kind: "io", message: error.message });

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
      const config = yield* loadProjectConfig(NodePath.join(projectRoot, PROJECT_CONFIG_PATH)).pipe(
        Effect.option,
        Effect.provideService(FileSystem.FileSystem, fs),
      );
      const base = Option.isSome(config) ? config.value.base : yield* checkedOut(projectRoot);
      const machine = yield* loadMachineConfig(machineConfigPath).pipe(
        Effect.map(Option.map((loaded) => loaded.config)),
        Effect.catch(() => Effect.succeed(Option.none())),
        Effect.provideService(FileSystem.FileSystem, fs),
      );
      const tracker =
        repo === null || issue === null || Option.isNone(machine)
          ? null
          : liveTracker({
              github: bindProcess(
                makeGitHub({ repo, ghConfigDir: machine.value.ghConfigDir }),
                process,
              ),
              issue,
              instructors: Option.isSome(config) ? config.value.instructors : [],
            });

      const now = yield* Clock.currentTimeMillis;
      const hex = (yield* Random.nextIntBetween(0, 0xffff)).toString(16).padStart(4, "0");
      const id = runIdFor(pipeline.id, now, hex);
      const path = recordPath(runsDir, id);
      yield* appendEvent(path, now, {
        event: "started",
        pipeline: encodePipeline(pipeline),
        projectRoot,
        repo,
        issue,
      });
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
      const fiber = yield* execute(pipeline, ports, { repo, issue }).pipe(
        Effect.tap((end) => Effect.logInfo(`pipeline run ${id} ended ${end.result}`)),
        Effect.catch((error) => Effect.logError(`pipeline run ${id}: ${error.message}`)),
        Effect.ensuring(Effect.sync(() => fibers.delete(id))),
        Effect.forkIn(scope),
      );
      fibers.set(id, fiber);
      return summarize(id, yield* readRecord(path));
    },
  );

  const recordOf = (id: string) =>
    isRunId(id)
      ? readRecord(recordPath(runsDir, id))
      : Effect.fail(new PipelineRunError({ kind: "not-found", message: `no run ${id}` }));

  const stop: PipelineRuns["Service"]["stop"] = Effect.fn("PipelineRuns.stop")(function* (id) {
    yield* recordOf(id);
    const fiber = fibers.get(id);
    if (fiber !== undefined) yield* Fiber.interrupt(fiber);
    const events = yield* recordOf(id);
    if (!events.some((event) => event.event === "ended")) {
      for (const threadId of threadsIn(events)) {
        yield* sessions
          .archive(threadId)
          .pipe(Effect.catch((error) => Effect.logWarning(error.message)));
      }
      yield* appendEvent(recordPath(runsDir, id), yield* Clock.currentTimeMillis, {
        event: "ended",
        result: "stopped",
        reason: STOPPED,
      });
    }
    return summarize(id, yield* recordOf(id));
  });

  const list: PipelineRuns["Service"]["list"] = Effect.fn("PipelineRuns.list")(
    function* (pipelineId) {
      const summaries = [];
      for (const id of yield* listRecords(runsDir)) {
        const summary = summarize(id, yield* recordOf(id));
        if (pipelineId === undefined || summary.pipelineId === pipelineId) summaries.push(summary);
      }
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
