/**
 * Pipelines on disk: `<factory dir>/pipelines/<id>.yml`, one file per pipeline, in the form
 * `encodePipeline` gives. A file is read back through `decodePipeline`, so a file edited by hand
 * into something the model refuses is listed as unreadable with its errors rather than dropped.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import { parse, stringify } from "yaml";

import { decodePipeline, encodePipeline, isId, type DecodeError, type Pipeline } from "./model.ts";

/** A pipeline as stored, with the file's modification time (ISO), or null when the system has none. */
export type StoredPipeline = Pipeline & {
  readonly updatedAt: string | null;
  readonly unreadable?: undefined;
};

/** A file under `pipelines/` that does not decode: invalid YAML, or a body the model refuses. */
export type UnreadablePipeline = {
  readonly id: string;
  readonly updatedAt: string | null;
  readonly unreadable: true;
  readonly errors: ReadonlyArray<DecodeError>;
};

export type ListedPipeline = StoredPipeline | UnreadablePipeline;

const EXTENSION = ".yml";

/** `<dir>/pipelines`, and the file of the pipeline `id` in it. */
const locate = Effect.fn("PipelineStore.locate")(function* (dir: string, id?: string) {
  const path = yield* Path.Path;
  const root = path.join(dir, "pipelines");
  return { root, file: id === undefined ? root : path.join(root, `${id}${EXTENSION}`) };
});

const isNotFound = (error: PlatformError) => error.reason._tag === "NotFound";

/** The text of a file, or null when it does not exist. */
const readIfPresent = Effect.fn("PipelineStore.readIfPresent")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs
    .readFileString(file)
    .pipe(Effect.catchIf(isNotFound, () => Effect.succeed(null)));
});

const modifiedAt = Effect.fn("PipelineStore.modifiedAt")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(file);
  return Option.getOrNull(Option.map(info.mtime, (date) => date.toISOString()));
});

/** What a stored file's text decodes to, for the pipeline whose file name is `id`. */
const decodeFile = (id: string, text: string, updatedAt: string | null): ListedPipeline => {
  let body: unknown;
  try {
    body = parse(text);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { id, updatedAt, unreadable: true, errors: [{ path: "", message }] };
  }
  const decoded = decodePipeline(body);
  if (!decoded.ok) return { id, updatedAt, unreadable: true, errors: decoded.errors };
  // The file name is the id the routes address it by; a file whose body names another would be
  // saved back under that other name.
  if (decoded.pipeline.id !== id) {
    return {
      id,
      updatedAt,
      unreadable: true,
      errors: [{ path: "id", message: `is ${decoded.pipeline.id}, not the file name ${id}` }],
    };
  }
  return { ...decoded.pipeline, updatedAt };
};

/** Every pipeline file, sorted by id. A missing `pipelines/` dir is an empty list. */
export const listPipelines = Effect.fn("PipelineStore.listPipelines")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { root } = yield* locate(dir);
  const names = yield* fs
    .readDirectory(root)
    .pipe(Effect.catchIf(isNotFound, () => Effect.succeed<ReadonlyArray<string>>([])));
  const ids = names
    .filter((name) => name.endsWith(EXTENSION))
    .map((name) => name.slice(0, -EXTENSION.length))
    .filter(isId)
    .toSorted();
  const listed: Array<ListedPipeline> = [];
  for (const id of ids) {
    const file = path.join(root, `${id}${EXTENSION}`);
    const text = yield* readIfPresent(file);
    // Removed between the listing and the read.
    if (text === null) continue;
    listed.push(decodeFile(id, text, yield* modifiedAt(file)));
  }
  return listed;
});

/** The pipeline stored as `id`, or null when there is none or `id` is not a pipeline id. */
export const readPipeline = Effect.fn("PipelineStore.readPipeline")(function* (
  dir: string,
  id: string,
) {
  if (!isId(id)) return null;
  const { file } = yield* locate(dir, id);
  const text = yield* readIfPresent(file);
  if (text === null) return null;
  return decodeFile(id, text, yield* modifiedAt(file));
});

/** The YAML a pipeline is stored as. A multi-line brief is a block scalar; nothing is folded. */
export const pipelineYaml = (pipeline: Pipeline): string =>
  stringify(encodePipeline(pipeline), { lineWidth: 0 });

/**
 * Writes the pipeline to `<id>.yml` through a temp file and a rename, so a reader never sees half
 * a file, and answers it as stored.
 */
export const writePipeline = Effect.fn("PipelineStore.writePipeline")(function* (
  dir: string,
  pipeline: Pipeline,
) {
  if (!isId(pipeline.id)) {
    return yield* Effect.die(new Error(`not a pipeline id: ${pipeline.id}`));
  }
  const fs = yield* FileSystem.FileSystem;
  const { root, file } = yield* locate(dir, pipeline.id);
  yield* fs.makeDirectory(root, { recursive: true });
  const temp = `${file}.tmp`;
  yield* fs.writeFileString(temp, pipelineYaml(pipeline));
  yield* fs.rename(temp, file);
  const stored: StoredPipeline = { ...pipeline, updatedAt: yield* modifiedAt(file) };
  return stored;
});

/** Removes the pipeline stored as `id`; false when there was none. */
export const deletePipeline = Effect.fn("PipelineStore.deletePipeline")(function* (
  dir: string,
  id: string,
) {
  if (!isId(id)) return false;
  const fs = yield* FileSystem.FileSystem;
  const { file } = yield* locate(dir, id);
  return yield* fs.remove(file).pipe(
    Effect.as(true),
    Effect.catchIf(isNotFound, () => Effect.succeed(false)),
  );
});
