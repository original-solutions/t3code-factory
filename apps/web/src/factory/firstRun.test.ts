import { describe, expect, it } from "vite-plus/test";

import { firstRunOf, firstRunSteps, neverBuilt, type FirstRunConfig } from "./firstRun";
import type { RepoBlock } from "./settings/api";

const factory: NonNullable<RepoBlock["factory"]> = {
  instructors: ["tom"],
  base: "main",
  provision: [],
  gate: ["vp test"],
  required_checks: [],
  limits: { minutes: 90, gate_retries: 1, checks_minutes: 30, interruption_resumes: 2 },
  autonomy: "pr",
};

const block = (title: string, overrides: Partial<RepoBlock> = {}): RepoBlock => ({
  title,
  repo: `acme/${title.toLowerCase()}`,
  path: `/work/${title.toLowerCase()}`,
  factory,
  errors: null,
  ...overrides,
});

const broken = { errors: [{ file: ".dw/config.yml", message: "bad" }] };
const ok = (repos: ReadonlyArray<RepoBlock>, watchError: string | null = null): FirstRunConfig => ({
  kind: "ok",
  repos,
  watchError,
});

describe("neverBuilt", () => {
  it.each([
    ["no environment answered", [], false],
    ["every environment has no run ever", [{ active: 0, ever: 0 }], true],
    [
      "one environment has an old run",
      [
        { active: 0, ever: 0 },
        { active: 0, ever: 3 },
      ],
      false,
    ],
    ["a run is in flight", [{ active: 1, ever: 0 }], false],
    // Not known until every list of every run has answered.
    ["a list is still loading", [{ active: 0, ever: null }], false],
  ] as const)("is %s → %s", (_, environments, expected) => {
    expect(neverBuilt(environments)).toBe(expected);
  });
});

describe("firstRunOf", () => {
  it.each([
    ["not quiet", false, [{ active: 1, ever: null, loading: false }], false],
    [
      "quiet, every run still loading",
      true,
      [{ active: 0, ever: null, loading: true }],
      "checking",
    ],
    ["quiet, never ran anything", true, [{ active: 0, ever: 0, loading: false }], true],
    // A failed read of every run shows the belt rather than a skeleton that never resolves.
    [
      "quiet, the read of every run failed",
      true,
      [{ active: 0, ever: null, loading: false }],
      false,
    ],
  ] as const)("is %s → %s", (_, quiet, environments, expected) => {
    expect(firstRunOf(quiet, environments)).toBe(expected);
  });
});

describe("firstRunSteps", () => {
  it("starts on watching a repo when none is watched", () => {
    const steps = firstRunSteps(ok([]), true);
    expect(steps.states).toEqual(["current", "todo", "todo", "todo"]);
    expect(steps.current).toBe(1);
  });

  it("blocks the first step when the projects could not be listed", () => {
    const steps = firstRunSteps(ok([], "gh: not logged in"), false);
    expect(steps.states.slice(0, 2)).toEqual(["blocked", "todo"]);
  });

  it("blocks the read when every watched repo has an error, naming the first", () => {
    const steps = firstRunSteps(ok([block("A", broken), block("B", broken)]), false);
    // Claims are on whatever else is wrong, so that step says so.
    expect(steps.states).toEqual(["done", "blocked", "done", "todo"]);
    expect(steps.broken?.title).toBe("A");
    expect(steps.current).toBe(2);
    expect(steps.signedOut).toBe(false);
  });

  it("names a signed-out gh as the block when it is every broken repo's error", () => {
    const out = {
      errors: [
        { file: ".dw/config.yml", message: "exited with status 4: please run: gh auth login" },
      ],
    };
    expect(firstRunSteps(ok([block("A", out), block("B", out)]), false).signedOut).toBe(true);
    expect(firstRunSteps(ok([block("A", out), block("B", broken)]), false).signedOut).toBe(false);
  });

  it("waits on the next pass for a repo not read yet", () => {
    const steps = firstRunSteps(ok([block("A", { factory: null })]), true);
    expect(steps.states).toEqual(["done", "current", "todo", "todo"]);
  });

  it("asks for claims once a repo can take work and claims are paused", () => {
    const steps = firstRunSteps(ok([block("A", broken), block("B")]), true);
    expect(steps.states).toEqual(["done", "done", "current", "todo"]);
    expect(steps.ready.map(({ title }) => title)).toEqual(["B"]);
  });

  it("ends on labelling an issue, with the ready repos default config included", () => {
    const steps = firstRunSteps(ok([block("A"), block("B", { default_config: true })]), false);
    expect(steps.states).toEqual(["done", "done", "done", "current"]);
    expect(steps.current).toBe(4);
    expect(steps.ready).toHaveLength(2);
  });

  it("never counts claims as on where they are not read", () => {
    const steps = firstRunSteps(ok([block("A", broken), block("B", { factory: null })]), null);
    expect(steps.states).toEqual(["done", "current", "todo", "todo"]);
    expect(steps.errors).toBe(1);
    expect(firstRunSteps(ok([block("A")]), null).states[2]).toBe("current");
  });

  it("knows only the claims step while the config is loading or failed", () => {
    expect(firstRunSteps({ kind: "loading" }, true).states).toEqual([
      "todo",
      "todo",
      "todo",
      "todo",
    ]);
    expect(firstRunSteps({ kind: "failed", message: "nope" }, false).states).toEqual([
      "blocked",
      "todo",
      "done",
      "todo",
    ]);
  });
});
