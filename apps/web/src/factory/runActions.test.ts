import { describe, expect, it } from "vite-plus/test";

import { runActions, type RunFacts } from "./runActions";

const run = (overrides: Partial<RunFacts> = {}): RunFacts => ({
  id: "acme__widgets__20__1",
  state: "building",
  finished: false,
  prUrl: null,
  threadId: null,
  ...overrides,
});

const kinds = (facts: RunFacts) => runActions(facts).map((action) => action.kind);

describe("runActions", () => {
  it("offers Stop only on an unfinished building run", () => {
    expect(kinds(run())).toContain("stop");
    expect(kinds(run({ finished: true }))).not.toContain("stop");
    for (const state of ["pr-open", "stuck", "needs-info", "triage", null]) {
      expect(kinds(run({ state }))).not.toContain("stop");
    }
  });

  it("is a merged run's issue and pull request, with no Stop", () => {
    expect(
      runActions(
        run({ state: "pr-open", finished: true, prUrl: "https://github.com/acme/widgets/pull/30" }),
      ),
    ).toEqual([
      {
        kind: "issue",
        ref: { text: "#20", href: "https://github.com/acme/widgets/issues/20" },
      },
      { kind: "pr", ref: { text: "#30", href: "https://github.com/acme/widgets/pull/30" } },
    ]);
  });

  it("puts the thread first and Stop last", () => {
    expect(
      kinds(run({ threadId: "t-1", prUrl: "https://github.com/acme/widgets/pull/30" })),
    ).toEqual(["thread", "issue", "pr", "stop"]);
  });

  it("shows the agent's state on the thread only while the run is unfinished", () => {
    expect(runActions(run({ threadId: "t-1" }))[0]).toEqual({
      kind: "thread",
      threadId: "t-1",
      live: true,
    });
    expect(runActions(run({ threadId: "t-1", finished: true }))[0]).toMatchObject({ live: false });
  });

  it("points a run stopped for a person at its next step", () => {
    expect(runActions(run({ state: "stuck" }))).toContainEqual({ kind: "next", tone: "stuck" });
    expect(runActions(run({ state: "needs-info" }))).toContainEqual({ kind: "next", tone: "info" });
  });

  it("has no next step for an attempt a later one replaced", () => {
    expect(kinds(run({ state: "stuck", finished: true, superseded: true }))).not.toContain("next");
    expect(kinds(run({ state: "needs-info", superseded: true }))).not.toContain("next");
  });

  it("keeps a reference with no GitHub link, as text", () => {
    expect(
      runActions(
        run({ id: "acme__widgets__draft__1", prUrl: "https://example.com/pr/3", state: null }),
      ),
    ).toEqual([
      { kind: "issue", ref: { text: "draft", href: null } },
      { kind: "pr", ref: { text: "https://example.com/pr/3", href: null } },
    ]);
  });
});
