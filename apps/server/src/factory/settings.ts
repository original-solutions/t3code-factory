/**
 * The machine config as the settings page edits it: a report of the file, the watched projects and
 * what the loop last read of each one's project config, and an edit that changes only the keys the
 * form sends, so comments and unknown keys (`notify`, `keep_versions`, a retired `repos`) stay as
 * written. The result is checked with `parseMachineConfig`.
 */
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { isMap, isScalar, parseDocument, YAMLMap } from "yaml";

import {
  ambiguousMessage,
  ambiguousRepos,
  DEFAULT_FEEDBACK_SECONDS,
  DEFAULT_MAX_CONCURRENT_GATES,
  DEFAULT_POLL_SECONDS,
  loadMachineConfig,
  parseMachineConfig,
  PROJECT_CONFIG_PATH,
  RETIRED_MACHINE_KEYS,
  type ConfigError,
  type MachineConfig,
  type ProjectConfig,
  type RepoConfigReading,
  type WatchedListing,
} from "./config.ts";
import { asciiLower } from "./ledger/runId.ts";
import type { WatchedReposError } from "./t3/watchedRepos.ts";
import { writeFileAtomically } from "./t3/files.ts";

/** A project config as the report shows it: the YAML field names. */
export interface ProjectBlock {
  readonly instructors: ReadonlyArray<string>;
  readonly base: string;
  readonly provision: ReadonlyArray<string>;
  readonly gate: ReadonlyArray<string>;
  readonly required_checks: ReadonlyArray<string>;
  readonly limits: {
    readonly minutes: number;
    readonly gate_retries: number;
    readonly checks_minutes: number;
    readonly interruption_resumes: number;
  };
  readonly autonomy: "pr";
}

/** The editable part of the machine config, under the YAML field names. */
export interface MachineConfigFields {
  readonly gh_config_dir: string;
  readonly poll_seconds: number;
  readonly max_concurrent_runs: number;
  readonly max_concurrent_gates: number;
  readonly feedback_seconds: number;
}

/** `MachineConfigFields` as a file that does not load holds them: any may be missing. */
export type MachineConfigDraft = Partial<MachineConfigFields>;

/**
 * The report of the machine config file. `config` is the file's values (defaults with no file, null
 * when it does not load). `defaults` is what a new file starts from, so the form needs no copy.
 * `draft`, when the file exists and does not load, holds the form's top-level string and number
 * keys unvalidated, so a person fixes one field; `errors` say which have the wrong type.
 */
export interface MachineConfigReport {
  readonly file: string;
  readonly exists: boolean;
  readonly config: MachineConfigFields | null;
  readonly defaults: MachineConfigFields;
  readonly draft?: MachineConfigDraft;
  readonly errors: ReadonlyArray<ConfigError>;
  /** One per watched T3 project, with what the loop last read of its project config. */
  readonly repos: ReadonlyArray<{
    readonly repo: string;
    readonly path: string;
    readonly title: string;
    readonly factory: ProjectBlock | null;
    readonly errors: ReadonlyArray<ConfigError> | null;
  }>;
  /** Workspace roots of projects the reader could not settle this time (`WatchedListing.unresolved`). */
  readonly unresolved: ReadonlyArray<string>;
  /** Why the T3 projects could not be listed at all, else null; `repos` and `unresolved` are then empty. */
  readonly watch_error: string | null;
}

const EDITABLE_KEYS = [
  "gh_config_dir",
  "poll_seconds",
  "max_concurrent_runs",
  "max_concurrent_gates",
  "feedback_seconds",
] as const;

/**
 * The keys an edit keeps: the form's, `notify`, `keep_versions`, `min_free_gib`,
 * `max_load_per_core` and `deploy_wait_minutes` (hand edits), and the retired keys (the model keys
 * and `repos`). Those stay so that a rollback to a version that still requires them loads the
 * file; a key that is not here is dropped by an edit.
 */
const KNOWN_KEYS: ReadonlySet<string> = new Set([
  ...EDITABLE_KEYS,
  "notify",
  "keep_versions",
  "min_free_gib",
  "deploy_wait_minutes",
  "max_load_per_core",
  ...RETIRED_MACHINE_KEYS,
]);

/** `max_concurrent_runs` has no default in the file (it is required); the form starts at one. */
const FORM_MAX_CONCURRENT_RUNS = 1;

const defaults = (): MachineConfigFields => ({
  gh_config_dir: "",
  poll_seconds: DEFAULT_POLL_SECONDS,
  max_concurrent_runs: FORM_MAX_CONCURRENT_RUNS,
  max_concurrent_gates: DEFAULT_MAX_CONCURRENT_GATES,
  feedback_seconds: DEFAULT_FEEDBACK_SECONDS,
});

const fieldsOf = (machine: MachineConfig): MachineConfigFields => ({
  gh_config_dir: machine.ghConfigDir,
  poll_seconds: machine.pollSeconds,
  max_concurrent_runs: machine.maxConcurrentRuns,
  max_concurrent_gates: machine.maxConcurrentGates,
  feedback_seconds: machine.feedbackSeconds,
});

const projectBlock = (project: ProjectConfig): ProjectBlock => ({
  instructors: project.instructors,
  base: project.base,
  provision: project.provision,
  gate: project.gate,
  required_checks: project.requiredChecks,
  limits: {
    minutes: project.limits.minutes,
    gate_retries: project.limits.gateRetries,
    checks_minutes: project.limits.checksMinutes,
    interruption_resumes: project.limits.interruptionResumes,
  },
  autonomy: project.autonomy,
});

const scalarOf = (value: unknown): string | number | undefined =>
  typeof value === "string"
    ? value
    : typeof value === "number" || typeof value === "bigint"
      ? Number(value)
      : undefined;

/** The values of the form's keys in `text`, as written; see `MachineConfigReport.draft`. */
const draftOf = (text: string): MachineConfigDraft => {
  const doc = parseDocument(text, { intAsBigInt: true });
  if (doc.errors.length > 0) return {};
  const root: unknown = doc.toJS();
  if (!isJsonObject(root)) return {};
  const draft: Record<string, unknown> = {};
  for (const key of EDITABLE_KEYS) {
    const value = scalarOf(root[key]);
    if (value !== undefined) draft[key] = value;
  }
  return draft;
};

/** The watched part of the report: every block, or why there is none, so an empty page is never a lie. */
const watchedReport = (
  watched: Result.Result<WatchedListing, WatchedReposError>,
  readings: ReadonlyMap<string, RepoConfigReading>,
): Pick<MachineConfigReport, "repos" | "unresolved" | "watch_error"> => {
  if (Result.isFailure(watched)) {
    return { repos: [], unresolved: [], watch_error: watched.failure.message };
  }
  const ambiguous = ambiguousRepos(watched.success.repos);
  const repos = watched.success.repos.map(({ repo, path, title }) => {
    const paths = ambiguous.get(asciiLower(repo));
    if (paths !== undefined) {
      // The pass loaded neither checkout, so there is no reading to show.
      return {
        repo,
        path,
        title,
        factory: null,
        errors: [{ file: PROJECT_CONFIG_PATH, message: ambiguousMessage(paths) }],
      };
    }
    const reading = readings.get(repo);
    return {
      repo,
      path,
      title,
      factory: reading?.kind === "ok" ? projectBlock(reading.project) : null,
      errors: reading?.kind === "errors" ? reading.errors : null,
    };
  });
  return { repos, unresolved: watched.success.unresolved, watch_error: null };
};

/**
 * The report of the machine config file, with the watched projects joined to the loop's last
 * reading of each one's project config. What is watched does not depend on the machine file, so
 * every report lists it, and a listing the reader could not make is reported as such rather
 * than as no project watched.
 */
export const readMachineConfigReport = Effect.fn("FactorySettings.readMachineConfigReport")(
  function* (
    file: string,
    watched: Result.Result<WatchedListing, WatchedReposError>,
    readings: ReadonlyMap<string, RepoConfigReading>,
  ): Effect.fn.Return<MachineConfigReport, never, FileSystem.FileSystem> {
    const fs = yield* FileSystem.FileSystem;
    const repos = watchedReport(watched, readings);
    const loaded = yield* Effect.result(loadMachineConfig(file));
    if (Result.isFailure(loaded)) {
      const text = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
      return {
        file,
        exists: true,
        config: null,
        defaults: defaults(),
        draft: draftOf(text),
        errors: loaded.failure.errors,
        ...repos,
      } satisfies MachineConfigReport;
    }
    if (Option.isNone(loaded.success)) {
      return {
        file,
        exists: false,
        config: defaults(),
        defaults: defaults(),
        errors: [],
        ...repos,
      } satisfies MachineConfigReport;
    }
    const machine = loaded.success.value.config;
    return {
      file,
      exists: true,
      config: fieldsOf(machine),
      defaults: defaults(),
      errors: [],
      ...repos,
    } satisfies MachineConfigReport;
  },
);

/** A request body the edit can read: a JSON object. */
export const isJsonObject = (body: unknown): body is Readonly<Record<string, unknown>> =>
  typeof body === "object" && body !== null && !Array.isArray(body);

/**
 * The machine config text with the body's keys applied, or the errors `parseMachineConfig` finds
 * in it. Keys the body does not have (and a `repos` key it has: the form no longer sends one),
 * and every comment, stay as they were; a key the factory does not know is dropped, and a file that is not YAML is started again.
 */
export const editMachineConfig = (
  existingText: string | null,
  body: Readonly<Record<string, unknown>>,
  file = "config.yml",
): Result.Result<string, ReadonlyArray<ConfigError>> => {
  const parsedDoc = parseDocument(existingText ?? "", { intAsBigInt: true });
  // A file that is not YAML cannot keep its comments: the edit replaces it.
  const doc = parsedDoc.errors.length > 0 ? parseDocument("") : parsedDoc;
  const root = isMap(doc.contents) ? doc.contents : new YAMLMap(doc.schema);
  if (doc.contents !== root) doc.contents = root as typeof doc.contents;
  // Keys the form does not know and the parser rejects (a typo) would make the file invalid for good.
  root.items = root.items.filter((pair) => {
    const key = isScalar(pair.key) ? pair.key.value : pair.key;
    return typeof key === "string" && KNOWN_KEYS.has(key);
  });
  for (const key of EDITABLE_KEYS) {
    if (Object.hasOwn(body, key)) root.set(key, body[key]);
  }
  const text = doc.toString();
  const parsed = parseMachineConfig(text, file);
  return Result.isSuccess(parsed) ? Result.succeed(text) : Result.fail(parsed.failure);
};

/** What `saveMachineConfig` made of a request body. */
export type SaveResult =
  | { readonly kind: "ok"; readonly report: MachineConfigReport }
  | { readonly kind: "invalid"; readonly errors: ReadonlyArray<ConfigError> }
  | { readonly kind: "invalid-body" };

/** The file could not be read or written; the file is as it was or whole, never half written. */
export class SaveError extends Data.TaggedError("SaveError")<{ readonly cause: unknown }> {}

/**
 * Saves a request body into the machine config file: reads the file (none is an empty start),
 * applies the body (`editMachineConfig`), writes the text whole only when the parser accepts it,
 * then `reload`s the loop and reports the file as it is now. A body that is not a JSON object is
 * `invalid-body`, and an edit the parser refuses is `invalid`, with the file untouched.
 */
export const saveMachineConfig = Effect.fn("FactorySettings.saveMachineConfig")(
  function* (
    file: string,
    body: unknown,
    loop: {
      readonly reload: Effect.Effect<void>;
      readonly repoConfigs: Effect.Effect<ReadonlyMap<string, RepoConfigReading>>;
      readonly watchedRepos: Effect.Effect<WatchedListing, WatchedReposError>;
    },
  ) {
    if (!isJsonObject(body)) return { kind: "invalid-body" } as const;
    const fs = yield* FileSystem.FileSystem;
    const existing = yield* fs
      .readFileString(file)
      .pipe(
        Effect.catch((cause) =>
          cause.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(cause),
        ),
      );
    const edited = editMachineConfig(existing, body, file);
    if (Result.isFailure(edited)) return { kind: "invalid", errors: edited.failure } as const;
    yield* writeFileAtomically(file, edited.success);
    yield* loop.reload;
    const report = yield* readMachineConfigReport(
      file,
      yield* Effect.result(loop.watchedRepos),
      yield* loop.repoConfigs,
    );
    return { kind: "ok", report } as const;
  },
  Effect.mapError((cause) => new SaveError({ cause })),
);
