// @effect-diagnostics nodeBuiltinImport:off - a run record is appended a line at a time, like the ledger.
/**
 * A run's record: `<factory dir>/pipelines/runs/<run id>.jsonl`, one `RecordedEvent` per line,
 * only ever appended to. The page reads it live and it survives the process, so it is the only
 * state a run keeps on disk.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";

import { formatTs } from "../ledger/time.ts";
import {
  PipelineRunError,
  type RecordedEvent,
  type RunEvent,
  type RunStatus,
  type RunSummary,
} from "./runsService.ts";

/** A run id: `<pipeline id>-<yyyyMMdd-HHmmss>-<4 hex>`, which is safe as a file name. */
const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}-(\d{8}-\d{6})-[0-9a-f]{4}$/;

export const isRunId = (value: string): boolean => RUN_ID_PATTERN.test(value);

/** The id of a run of `pipelineId` that starts at `ms` (UTC), with `hex` as its four random digits. */
export const runIdFor = (pipelineId: string, ms: number, hex: string): string => {
  const ts = formatTs(ms);
  const stamp = `${ts.slice(0, 4)}${ts.slice(5, 7)}${ts.slice(8, 10)}-${ts.slice(11, 13)}${ts.slice(14, 16)}${ts.slice(17, 19)}`;
  return `${pipelineId}-${stamp}-${hex}`;
};

export const recordPath = (dir: string, id: string): string => NodePath.join(dir, `${id}.jsonl`);

const io = <A>(what: string, run: () => A) =>
  Effect.try({
    try: run,
    catch: (cause) =>
      new PipelineRunError({
        kind: "io",
        message: `${what}: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });

const line = (ms: number, event: RunEvent) => `${JSON.stringify({ ms, ...event })}\n`;

/** Whether the file at `path` has bytes and its last one is not a newline: a torn last write. */
const endsTorn = (path: string): boolean => {
  const size = NodeFS.statSync(path, { throwIfNoEntry: false })?.size ?? 0;
  if (size === 0) return false;
  const fd = NodeFS.openSync(path, "r");
  try {
    const last = Buffer.alloc(1);
    NodeFS.readSync(fd, last, 0, 1, size - 1);
    return last[0] !== 0x0a;
  } finally {
    NodeFS.closeSync(fd);
  }
};

/**
 * Appends one event, with its time, as a line. Creates the record and its folder when missing.
 * After a torn last write the event starts on a line of its own, so it is not lost with it.
 */
export const appendEvent = (path: string, ms: number, event: RunEvent) =>
  io(`cannot write the run record ${path}`, () => {
    NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
    NodeFS.appendFileSync(path, `${endsTorn(path) ? "\n" : ""}${line(ms, event)}`);
  });

/**
 * Writes a new record's first line. Answers false, and writes nothing, when a record by that
 * path already exists.
 */
export const createRecord = (path: string, ms: number, event: RunEvent) =>
  io(`cannot write the run record ${path}`, () => {
    NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
    try {
      NodeFS.writeFileSync(path, line(ms, event), { flag: "wx" });
      return true;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw cause;
    }
  });

const isRecorded = (value: unknown): value is RecordedEvent =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { ms?: unknown }).ms === "number" &&
  typeof (value as { event?: unknown }).event === "string";

/** The events of the record, in order. A line that does not parse (a torn last write) is skipped. */
export const parseRecord = (text: string): ReadonlyArray<RecordedEvent> =>
  text.split("\n").flatMap((line) => {
    if (line.trim() === "") return [];
    try {
      const value: unknown = JSON.parse(line);
      return isRecorded(value) ? [value] : [];
    } catch {
      return [];
    }
  });

/** The record's events; `not-found` when there is no record at `path`. */
export const readRecord = (path: string) =>
  Effect.suspend(() =>
    NodeFS.existsSync(path)
      ? io(`cannot read the run record ${path}`, () =>
          parseRecord(NodeFS.readFileSync(path, "utf8")),
        )
      : Effect.fail(new PipelineRunError({ kind: "not-found", message: `no run record ${path}` })),
  );

/** The run's summary as its record tells it. A record with no `started` line has empty fields. */
export const summarize = (id: string, events: ReadonlyArray<RecordedEvent>): RunSummary => {
  let started: Extract<RecordedEvent, { event: "started" }> | undefined;
  let ended: Extract<RecordedEvent, { event: "ended" }> | undefined;
  let node: string | null = null;
  for (const event of events) {
    if (event.event === "started") started ??= event;
    else if (event.event === "entered") node = event.node;
    else if (event.event === "ended") ended ??= event;
  }
  const pipeline = started?.pipeline ?? {};
  const status: RunStatus = ended?.result ?? "running";
  return {
    id,
    pipelineId: typeof pipeline["id"] === "string" ? pipeline["id"] : "",
    pipelineName: typeof pipeline["name"] === "string" ? pipeline["name"] : "",
    projectRoot: started?.projectRoot ?? "",
    repo: started?.repo ?? null,
    issue: started?.issue ?? null,
    startedAt: formatTs(started?.ms ?? events[0]?.ms ?? 0),
    endedAt: ended === undefined ? null : formatTs(ended.ms),
    status,
    node,
    reason: ended?.reason ?? null,
  };
};

/** The ids of the records in `dir`, newest first by the time in the id. None when `dir` is missing. */
export const listRecords = (dir: string) =>
  io(`cannot list the run records in ${dir}`, () => {
    if (!NodeFS.existsSync(dir)) return [];
    const ids = NodeFS.readdirSync(dir)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => name.slice(0, -".jsonl".length))
      .filter(isRunId);
    const stamp = (id: string) => RUN_ID_PATTERN.exec(id)?.[1] ?? "";
    return ids.toSorted((a, b) =>
      stamp(a) === stamp(b) ? (a < b ? 1 : -1) : stamp(a) < stamp(b) ? 1 : -1,
    );
  });

/** The reason a run that was under way when the server stopped is given at the next start. */
export const RESTARTED = "the server restarted";

/**
 * Ends every record in `dir` that has not ended as `interrupted`: a run is a fiber, and nothing
 * resumes one the process lost. Answers the ids it ended.
 */
export const markInterrupted = Effect.fn("PipelineRecord.markInterrupted")(function* (
  dir: string,
  ms: number,
) {
  const marked: Array<string> = [];
  for (const id of yield* listRecords(dir)) {
    const path = recordPath(dir, id);
    const events = yield* readRecord(path);
    if (events.some((event) => event.event === "ended")) continue;
    yield* appendEvent(path, ms, { event: "ended", result: "interrupted", reason: RESTARTED });
    marked.push(id);
  }
  return marked;
});
