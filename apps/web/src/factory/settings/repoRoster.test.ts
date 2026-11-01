import { describe, expect, it } from "vite-plus/test";

import type { RepoBlock } from "./api";
import { repoHealth, repoRoster, setupProgress } from "./repoRoster";

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

describe("repoHealth", () => {
  it.each([
    ["ready", block("A")],
    ["default", block("A", { default_config: true })],
    ["unread", block("A", { factory: null })],
    ["error", block("A", broken)],
    // An error outranks a block the factory could still resolve.
    ["error", block("A", { ...broken, default_config: true })],
    ["unread", block("A", { factory: null, errors: [] })],
  ] as const)("is %s", (health, repo) => {
    expect(repoHealth(repo)).toBe(health);
  });
});

describe("repoRoster", () => {
  it("puts the repos that need a person first, then by title", () => {
    const roster = repoRoster([
      block("Zeta"),
      block("beta", { default_config: true }),
      block("Alpha"),
      block("Gamma", { factory: null }),
      block("Delta", broken),
    ]);
    expect(roster.rows.map((row) => [row.health, row.block.title])).toEqual([
      ["error", "Delta"],
      ["unread", "Gamma"],
      ["ready", "Alpha"],
      ["default", "beta"],
      ["ready", "Zeta"],
    ]);
  });

  it("sums the roster in a line, naming only what is there", () => {
    expect(repoRoster([]).summary).toBe("");
    expect(repoRoster([block("A")]).summary).toBe("1 watched");
    expect(
      repoRoster([
        block("A"),
        block("B", broken),
        block("C", broken),
        block("D", { factory: null }),
      ]).summary,
    ).toBe("4 watched · 2 with errors · 1 not read yet");
  });
});

describe("setupProgress", () => {
  it("walks a fresh machine to its first watched repo, then steps aside", () => {
    // Nothing watched: adding a repo is the step.
    expect(setupProgress([], null)).toEqual({
      watch: "current",
      read: "todo",
      errors: 0,
      firstError: null,
    });
    // The list could not be made: the first step is blocked, not undone.
    expect(setupProgress([], "git not found")?.watch).toBe("blocked");
    // Watched, but nothing the factory can build yet: reading the config is the step.
    expect(setupProgress([block("A", { factory: null }), block("B", broken)], null)).toEqual({
      watch: "done",
      read: "current",
      errors: 1,
      firstError: { title: "B", message: "bad" },
    });
    // One repo can take work: setup is over, whatever the others say.
    expect(setupProgress([block("A", broken), block("B")], null)).toBeNull();
    expect(setupProgress([block("A", { default_config: true })], null)).toBeNull();
  });
});
