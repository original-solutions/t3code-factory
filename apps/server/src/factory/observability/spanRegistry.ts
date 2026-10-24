import * as Option from "effect/Option";
import type * as Tracer from "effect/Tracer";

export type TrackedKind = "span" | "sql";

/** The sqlite client's `db.connection`: the writer runs on the main thread, the reader on a worker. */
export type SqlConnection = "reader" | "writer";

export interface TrackedSpanReport {
  readonly name: string;
  readonly kind: TrackedKind;
  /** Time from the span's start to the end of the window asked about. */
  readonly ageMs: number;
  readonly open: boolean;
  /** A SQL span's statement, cut to QUERY_TEXT_MAX characters. */
  readonly query?: string;
  /** A SQL span's connection, once the client has acquired one. Only a SQL span reports it. */
  readonly connection?: SqlConnection;
}

/** Longest statement text kept per SQL span. */
export const QUERY_TEXT_MAX = 160;

interface Entry {
  readonly id: number;
  readonly name: string;
  kind: TrackedKind;
  query?: string;
  connection?: SqlConnection;
  readonly parentId: number | undefined;
  readonly startMs: number;
  endMs: number | undefined;
}

export interface SpanRegistry {
  /** `parentId` is the id `start` returned for the parent span, when it is tracked. */
  start(name: string, kind: TrackedKind, parentId?: number): number;
  end(id: number): void;
  /** Marks a span as a SQL statement, once its attributes say it is one. */
  markSql(id: number, query?: string): void;
  /**
   * Records which connection a SQL span ran on, once the client has acquired it. Every span
   * started under it afterwards carries the connection down to the statements among its
   * descendants: a transaction's statements run on the transaction's connection, which the
   * client names on the transaction span alone. Only SQL spans report it.
   */
  markConnection(id: number, connection: SqlConnection): void;
  /**
   * The spans most likely to have blocked the loop in [windowStartMs, windowEndMs]. A synchronous
   * block usually ends its span before a timer can notice the stall, so spans that ended inside
   * the window count too. Ranked by evidence of running in the window:
   *
   * 1. spans that ended or started inside it: SQL first, then by the window time the span spent
   *    on its own (its overlap minus its children's), then the most recently started;
   * 2. open spans that started before it, most recently started first. A span that has been open
   *    for hours is the caller of the blocker, not the blocker.
   */
  active(
    windowStartMs: number,
    windowEndMs: number,
    limit: number,
  ): ReadonlyArray<TrackedSpanReport>;
  /**
   * The root spans and SQL statements still open at `atMs`, oldest first: what the server was
   * in the middle of, as opposed to `active`'s likely blocker.
   */
  oldestInFlight(atMs: number, limit: number): ReadonlyArray<TrackedSpanReport>;
}

export interface SpanRegistryOptions {
  /** Open spans kept. The oldest is dropped past this, so a span that never ends cannot leak. */
  readonly maxInFlight?: number;
  /** Ended spans kept for the window check. */
  readonly maxRecent?: number;
  readonly now?: () => number;
}

/**
 * A bounded record of the server's spans. Every span goes through the tracer wrapper, so start
 * and end do one Map operation and a ring write.
 */
export const makeSpanRegistry = (options: SpanRegistryOptions = {}): SpanRegistry => {
  const maxInFlight = options.maxInFlight ?? 1024;
  const maxRecent = options.maxRecent ?? 1024;
  const now = options.now ?? (() => performance.now());
  // A Map iterates in insertion order, which is start order.
  const open = new Map<number, Entry>();
  const recent: Array<Entry | undefined> = Array.from({ length: maxRecent });
  let recentNext = 0;
  let nextId = 0;

  const report = (entry: Entry, atMs: number): TrackedSpanReport => ({
    name: entry.name,
    kind: entry.kind,
    ageMs: Math.round(atMs - entry.startMs),
    open: entry.endMs === undefined,
    ...(entry.query !== undefined && { query: entry.query }),
    ...(entry.kind === "sql" && entry.connection !== undefined && { connection: entry.connection }),
  });

  return {
    start(name, kind, parentId) {
      const id = nextId++;
      if (open.size >= maxInFlight) {
        const oldest = open.keys().next();
        if (!oldest.done) open.delete(oldest.value);
      }
      const connection = parentId === undefined ? undefined : open.get(parentId)?.connection;
      open.set(id, {
        id,
        name,
        kind,
        ...(connection !== undefined && { connection }),
        parentId,
        startMs: now(),
        endMs: undefined,
      });
      return id;
    },
    end(id) {
      const entry = open.get(id);
      if (entry === undefined) return;
      open.delete(id);
      entry.endMs = now();
      recent[recentNext] = entry;
      recentNext = (recentNext + 1) % maxRecent;
    },
    markSql(id, query) {
      const entry = open.get(id);
      if (entry === undefined) return;
      entry.kind = "sql";
      if (query !== undefined)
        entry.query = query.replaceAll(/\s+/g, " ").trim().slice(0, QUERY_TEXT_MAX);
    },
    markConnection(id, connection) {
      const entry = open.get(id);
      if (entry !== undefined) entry.connection = connection;
    },
    active(windowStartMs, windowEndMs, limit) {
      const inWindow: Array<Entry> = [];
      const earlier: Array<Entry> = [];
      for (const entry of recent) {
        if (
          entry !== undefined &&
          entry.startMs <= windowEndMs &&
          (entry.endMs ?? Infinity) >= windowStartMs
        ) {
          inWindow.push(entry);
        }
      }
      for (const entry of open.values()) {
        if (entry.startMs > windowEndMs) continue;
        (entry.startMs >= windowStartMs ? inWindow : earlier).push(entry);
      }

      const overlap = (entry: Entry) =>
        Math.min(entry.endMs ?? windowEndMs, windowEndMs) - Math.max(entry.startMs, windowStartMs);
      const childOverlap = new Map<number, number>();
      for (const entry of inWindow) {
        if (entry.parentId === undefined) continue;
        childOverlap.set(
          entry.parentId,
          (childOverlap.get(entry.parentId) ?? 0) + Math.max(0, overlap(entry)),
        );
      }
      const own = (entry: Entry) => overlap(entry) - (childOverlap.get(entry.id) ?? 0);

      inWindow.sort(
        (a, b) =>
          Number(b.kind === "sql") - Number(a.kind === "sql") ||
          own(b) - own(a) ||
          b.startMs - a.startMs,
      );
      earlier.sort((a, b) => b.startMs - a.startMs);
      return [...inWindow, ...earlier].slice(0, limit).map((entry) => report(entry, windowEndMs));
    },
    oldestInFlight(atMs, limit) {
      const found: Array<TrackedSpanReport> = [];
      for (const entry of open.values()) {
        if (found.length >= limit) break;
        if (entry.startMs > atMs) continue;
        if (entry.parentId === undefined || entry.kind === "sql") found.push(report(entry, atMs));
      }
      return found;
    },
  };
};

const ATTR_DB_SYSTEM_NAME = "db.system.name";
const ATTR_DB_QUERY_TEXT = "db.query.text";
const ATTR_DB_CONNECTION = "db.connection";
// effect's SqlClient opens this span around a transaction (not a client span in effect 4.0.5); the
// sqlite client names the connection on it, and the statements inside use that connection
// without saying so.
const TRANSACTION_SPAN = "sql.transaction";

const isSqlConnection = (value: unknown): value is SqlConnection =>
  value === "reader" || value === "writer";

/**
 * Delegates every span to `tracer` and records each in `registry`, wrapping its `end`. A client
 * span that sets `db.system.name` is a SQL statement (effect names those after the database, so
 * only the kind and attributes identify them), the `db.query.text` it sets next is kept for the
 * report, and the `db.connection` the sqlite client sets once it has a connection says whether
 * the statement ran on the main thread (writer) or the reader worker. A transaction span carries
 * that attribute for every statement inside it.
 */
export const wrapTracer = (tracer: Tracer.Tracer, registry: SpanRegistry): Tracer.Tracer => {
  const ids = new WeakMap<object, number>();
  return {
    span(options) {
      const span = tracer.span(options);
      const parentId = Option.isSome(options.parent) ? ids.get(options.parent.value) : undefined;
      const id = registry.start(options.name, "span", parentId);
      ids.set(span, id);
      const end = span.end;
      span.end = function (endTime, exit) {
        registry.end(id);
        return end.call(this, endTime, exit);
      };
      const client = options.kind === "client";
      if (client || options.name === TRANSACTION_SPAN) {
        const attribute = span.attribute;
        span.attribute = function (key, value) {
          if (key === ATTR_DB_CONNECTION && isSqlConnection(value)) {
            registry.markConnection(id, value);
          } else if (client && key === ATTR_DB_SYSTEM_NAME) registry.markSql(id);
          else if (client && key === ATTR_DB_QUERY_TEXT && typeof value === "string") {
            registry.markSql(id, value);
          }
          return attribute.call(this, key, value);
        };
      }
      return span;
    },
    context: tracer.context,
  };
};
