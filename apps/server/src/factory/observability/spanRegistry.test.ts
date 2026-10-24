import * as Option from "effect/Option";
import type * as Tracer from "effect/Tracer";
import { describe, expect, it } from "vite-plus/test";

import { makeSpanRegistry, wrapTracer } from "./spanRegistry.ts";

const clock = () => {
  let t = 0;
  return { now: () => t, set: (next: number) => void (t = next) };
};

describe("makeSpanRegistry.active", () => {
  it("reports a span still open at the end of the window, with its age", () => {
    const c = clock();
    const registry = makeSpanRegistry({ now: c.now });
    c.set(600);
    registry.start("ThreadLaunchService.prepare", "span");
    expect(registry.active(500, 3000, 10)).toEqual([
      { name: "ThreadLaunchService.prepare", kind: "span", ageMs: 2400, open: true },
    ]);
  });

  it("reports a span that ended inside the window, because a blocked loop cannot report it in time", () => {
    const c = clock();
    const registry = makeSpanRegistry({ now: c.now });
    c.set(600);
    const id = registry.start("sqlite", "sql");
    c.set(2500);
    registry.end(id);
    expect(registry.active(500, 3000, 10)).toEqual([
      { name: "sqlite", kind: "sql", ageMs: 2400, open: false },
    ]);
  });

  it("leaves out spans that ended before the window or started after it", () => {
    const c = clock();
    const registry = makeSpanRegistry({ now: c.now });
    c.set(10);
    registry.end(registry.start("early", "span"));
    c.set(600);
    registry.start("during", "span");
    c.set(3500);
    registry.start("late", "span");
    expect(registry.active(500, 3000, 10).map((s) => s.name)).toEqual(["during"]);
  });

  it("ranks SQL, then the span with the most window time of its own, ahead of open spans from before the window", () => {
    const c = clock();
    const registry = makeSpanRegistry({ now: c.now });
    c.set(1);
    registry.start("connection", "span");
    c.set(2);
    registry.start("worker", "span");
    c.set(600);
    const parent = registry.start("parent", "span");
    c.set(700);
    const child = registry.start("child", "span", parent);
    c.set(2700);
    registry.end(child);
    c.set(2800);
    registry.end(parent);
    c.set(2900);
    registry.end(registry.start("sqlite", "sql"));
    expect(registry.active(500, 3000, 10).map((s) => s.name)).toEqual([
      "sqlite",
      "child",
      "parent",
      "worker",
      "connection",
    ]);
    expect(registry.active(500, 3000, 2).map((s) => s.name)).toEqual(["sqlite", "child"]);
  });

  it("lists open spans from before the window most recently started first", () => {
    const c = clock();
    const registry = makeSpanRegistry({ now: c.now });
    for (const [t, name] of [
      [1, "a"],
      [2, "b"],
      [3, "c"],
    ] as const) {
      c.set(t);
      registry.start(name, "span");
    }
    expect(registry.active(500, 3000, 10).map((s) => s.name)).toEqual(["c", "b", "a"]);
  });

  it("stays bounded: the open map and the recent ring drop their oldest entries", () => {
    const c = clock();
    const registry = makeSpanRegistry({ now: c.now, maxInFlight: 3, maxRecent: 2 });
    for (let i = 0; i < 10; i++) {
      c.set(i);
      registry.start(`open-${i}`, "span");
    }
    expect(registry.active(0, 100, 100).map((s) => s.name)).toEqual(["open-7", "open-8", "open-9"]);
    for (let i = 0; i < 10; i++) {
      c.set(20 + i);
      registry.end(registry.start(`done-${i}`, "span"));
    }
    const names = registry.active(0, 100, 100).map((s) => s.name);
    expect(names).toContain("done-9");
    expect(names).toContain("done-8");
    expect(names).not.toContain("done-7");
    expect(names.length).toBeLessThanOrEqual(5);
  });

  it("reports the connection a SQL statement ran on", () => {
    const c = clock();
    const registry = makeSpanRegistry({ now: c.now });
    c.set(10);
    const sql = registry.start("sqlite", "span");
    registry.markSql(sql, "SELECT 1");
    registry.markConnection(sql, "reader");
    expect(registry.active(0, 100, 10)).toEqual([
      {
        name: "sqlite",
        kind: "sql",
        ageMs: 90,
        open: true,
        query: "SELECT 1",
        connection: "reader",
      },
    ]);
  });

  it("gives a SQL statement the connection of the transaction it runs in, through the spans between, and no other span", () => {
    const c = clock();
    const registry = makeSpanRegistry({ now: c.now });
    c.set(10);
    const tx = registry.start("sql.transaction", "span");
    registry.markConnection(tx, "writer");
    c.set(20);
    const repo = registry.start("EventSink.commit", "span", tx);
    c.set(30);
    const sql = registry.start("sqlite", "span", repo);
    registry.markSql(sql, "INSERT INTO t VALUES (1)");
    c.set(40);
    registry.start("decode rows", "span", repo);
    const byName = new Map(registry.active(0, 100, 10).map((s) => [s.name, s.connection]));
    expect(byName.get("sqlite")).toBe("writer");
    expect(byName.get("decode rows")).toBeUndefined();
    expect(byName.get("EventSink.commit")).toBeUndefined();
    expect(byName.get("sql.transaction")).toBeUndefined();
  });

  it("ignores an end for a span it already dropped", () => {
    const registry = makeSpanRegistry({ maxInFlight: 1 });
    const first = registry.start("first", "span");
    registry.start("second", "span");
    expect(() => registry.end(first)).not.toThrow();
  });
});

const fakeSpan = (name: string, parent: Option.Option<Tracer.AnySpan>) => {
  const ended: Array<bigint> = [];
  const span = {
    _tag: "Span",
    name,
    parent,
    end: (endTime: bigint) => void ended.push(endTime),
    attribute: () => {},
  } as unknown as Tracer.Span;
  return { span, ended };
};

const spanOptions = (
  name: string,
  parent: Option.Option<Tracer.AnySpan>,
  kind: "internal" | "client" = "internal",
) =>
  ({
    name,
    parent,
    annotations: undefined,
    links: [],
    startTime: 0n,
    kind,
    root: Option.isNone(parent),
    sampled: true,
  }) as unknown as Parameters<Tracer.Tracer["span"]>[0];

describe("makeSpanRegistry.oldestInFlight", () => {
  it("lists the open root spans and SQL statements, oldest first, with their age", () => {
    const c = clock();
    const registry = makeSpanRegistry({ now: c.now });
    c.set(10);
    const root = registry.start("http.server GET /ws", "span");
    c.set(20);
    registry.start("child of the socket", "span", root);
    c.set(30);
    const sql = registry.start("sqlite", "span", root);
    registry.markSql(sql, "SELECT 1");
    c.set(40);
    const ended = registry.start("ended", "span");
    registry.end(ended);
    c.set(50);
    registry.start("newer root", "span");
    c.set(60);
    registry.start("after the window", "span");
    expect(registry.oldestInFlight(1000, 10)).toEqual([
      { name: "http.server GET /ws", kind: "span", ageMs: 990, open: true },
      { name: "sqlite", kind: "sql", ageMs: 970, open: true, query: "SELECT 1" },
      { name: "newer root", kind: "span", ageMs: 950, open: true },
      { name: "after the window", kind: "span", ageMs: 940, open: true },
    ]);
    expect(registry.oldestInFlight(55, 2).map((s) => s.name)).toEqual([
      "http.server GET /ws",
      "sqlite",
    ]);
    expect(registry.oldestInFlight(55, 10).map((s) => s.name)).not.toContain("after the window");
  });
});

describe("wrapTracer", () => {
  const setup = () => {
    const c = clock();
    const registry = makeSpanRegistry({ now: c.now });
    const created = new Map<string, ReturnType<typeof fakeSpan>>();
    const base: Tracer.Tracer = {
      span(options) {
        const made = fakeSpan(options.name, options.parent);
        created.set(options.name, made);
        return made.span;
      },
    };
    return { c, registry, created, tracer: wrapTracer(base, registry) };
  };
  const parentSpan = { _tag: "Span" } as unknown as Tracer.AnySpan;
  const externalParent = { _tag: "ExternalSpan" } as unknown as Tracer.AnySpan;

  it("tracks every span until it ends, and still ends the delegate's span", () => {
    const { c, registry, created, tracer } = setup();
    c.set(5);
    const root = tracer.span(spanOptions("rpc.request", Option.none()));
    const sql = tracer.span(spanOptions("sqlite", Option.some(parentSpan), "client"));
    sql.attribute("db.system.name", "sqlite");
    sql.attribute("db.query.text", "SELECT 1");
    const external = tracer.span(spanOptions("http.server", Option.some(externalParent)));
    expect(registry.active(0, 10, 10).map((s) => [s.name, s.kind])).toEqual([
      ["sqlite", "sql"],
      ["rpc.request", "span"],
      ["http.server", "span"],
    ]);
    expect(registry.active(0, 10, 10)[0]?.query).toBe("SELECT 1");
    c.set(7);
    root.end(9n, undefined as never);
    sql.end(9n, undefined as never);
    external.end(9n, undefined as never);
    expect(registry.active(0, 10, 10).every((s) => !s.open)).toBe(true);
    expect(created.get("rpc.request")?.ended).toEqual([9n]);
    expect(created.get("sqlite")?.ended).toEqual([9n]);
  });

  it("does not take a client span for SQL until it sets db.system.name, and cuts long query text", () => {
    const { registry, tracer } = setup();
    const http = tracer.span(spanOptions("http.client", Option.some(parentSpan), "client"));
    http.attribute("http.method", "GET");
    const sql = tracer.span(spanOptions("sqlite", Option.some(parentSpan), "client"));
    sql.attribute("db.system.name", "sqlite");
    sql.attribute("db.query.text", "x".repeat(500));
    const spans = registry.active(0, 10, 10);
    expect(spans.map((s) => s.kind)).toEqual(["sql", "span"]);
    expect(spans[0]?.query).toHaveLength(160);
  });

  it("keeps the connection a client span's db.connection names, and ignores a value it does not know", () => {
    const { registry, tracer } = setup();
    const reader = tracer.span(spanOptions("sqlite", Option.some(parentSpan), "client"));
    reader.attribute("db.system.name", "sqlite");
    reader.attribute("db.connection", "reader");
    const writer = tracer.span(spanOptions("sqlite 2", Option.some(parentSpan), "client"));
    writer.attribute("db.system.name", "sqlite");
    writer.attribute("db.connection", "writer");
    const odd = tracer.span(spanOptions("sqlite 3", Option.some(parentSpan), "client"));
    odd.attribute("db.system.name", "sqlite");
    odd.attribute("db.connection", 42);
    const byName = new Map(registry.active(0, 10, 10).map((s) => [s.name, s.connection]));
    expect(byName.get("sqlite")).toBe("reader");
    expect(byName.get("sqlite 2")).toBe("writer");
    expect(byName.get("sqlite 3")).toBeUndefined();
  });

  it("takes the connection a sql.transaction span names, so the statements inside inherit it", () => {
    const { registry, tracer } = setup();
    const tx = tracer.span(spanOptions("sql.transaction", Option.some(parentSpan)));
    tx.attribute("db.connection", "writer");
    const body = tracer.span(spanOptions("EventSink.commit", Option.some(tx)));
    const sql = tracer.span(spanOptions("sqlite", Option.some(body), "client"));
    sql.attribute("db.system.name", "sqlite");
    const other = tracer.span(spanOptions("rpc.request", Option.some(parentSpan)));
    other.attribute("db.connection", "writer");
    const byName = new Map(registry.active(0, 10, 10).map((s) => [s.name, s.connection]));
    expect(byName.get("sqlite")).toBe("writer");
    expect(byName.get("EventSink.commit")).toBeUndefined();
    expect(byName.get("rpc.request")).toBeUndefined();
  });

  it("links a span to its parent, so the parent's own time excludes the child's", () => {
    const { c, registry, tracer } = setup();
    c.set(10);
    const parent = tracer.span(spanOptions("parent", Option.none()));
    const child = tracer.span(spanOptions("child", Option.some(parent)));
    c.set(900);
    child.end(1n, undefined as never);
    c.set(910);
    parent.end(1n, undefined as never);
    expect(registry.active(0, 1000, 10).map((s) => s.name)).toEqual(["child", "parent"]);
  });

  it("keeps the delegate's context hook", () => {
    const registry = makeSpanRegistry();
    const context = (() => undefined) as unknown as NonNullable<Tracer.Tracer["context"]>;
    const base: Tracer.Tracer = { span: () => fakeSpan("x", Option.none()).span, context };
    expect(wrapTracer(base, registry).context).toBe(context);
  });
});
