import { describe, expect, it } from "vite-plus/test";

import type { RepoBlock } from "./api";
import { duration, factoryBlockYaml, repoPlan } from "./repoPlan";

const factory: NonNullable<RepoBlock["factory"]> = {
  instructors: ["alice", "bob"],
  base: "main",
  provision: ["npm ci"],
  gate: ["npm test", "npm run lint"],
  required_checks: [],
  limits: { minutes: 180, gate_retries: 2, checks_minutes: 30, interruption_resumes: 2 },
  autonomy: "pr",
  owner: null,
};

const says = (block: typeof factory) => repoPlan(block).map((step) => step.says);

describe("repoPlan", () => {
  it("says what the factory does with an issue, from claim to hand-off", () => {
    expect(repoPlan(factory).map((step) => step.title)).toEqual([
      "Claim",
      "Build",
      "Gate",
      "Checks",
      "Hand off",
    ]);
    expect(says(factory)).toEqual([
      "Takes an issue once @alice or @bob labels it factory:ready.",
      "An agent builds it on its own branch off main, for up to 3 hours. A session T3 itself drops is resumed up to 2 times.",
      "A fresh checkout of the pull request merged with main runs these, each for up to 30 minutes, and every one must exit 0. A failed gate goes back to the agent to fix, up to 2 times.",
      "No GitHub checks are required: the gate alone decides.",
      "Marks the pull request into main ready for review. A person merges it; the factory never does.",
    ]);
  });

  it("says when a limit of 0 means no second chance, and names the checks it waits for", () => {
    const strict = says({
      ...factory,
      required_checks: ["ci", "build"],
      limits: { minutes: 90, gate_retries: 0, checks_minutes: 45, interruption_resumes: 0 },
    });
    expect(strict[1]).toContain("for up to 90 minutes. A session T3 itself drops is not resumed.");
    expect(strict[2]).toContain("The first failed gate stops the run.");
    expect(strict[3]).toBe("Waits up to 45 minutes for ci and build to pass on GitHub.");
  });

  it("names the one machine that may claim when the block sets an owner", () => {
    const [claim] = repoPlan({ ...factory, owner: "studio-mac" });
    expect(claim?.says).toBe(
      "Takes an issue once @alice or @bob labels it factory:ready, and only on studio-mac: other machines leave it.",
    );
    expect(claim?.keys).toEqual(["instructors", "owner"]);
  });

  it.each([
    [1, "1 minute"],
    [60, "1 hour"],
    [150, "150 minutes"],
    [240, "4 hours"],
  ])("writes %i minutes as %s", (minutes, text) => {
    expect(duration(minutes)).toBe(text);
  });
});

describe("factoryBlockYaml", () => {
  it("writes the resolved block with its defaults, quoting only what YAML would misread", () => {
    expect(
      factoryBlockYaml({
        ...factory,
        base: "release/2.x",
        provision: [],
        gate: ["npm test", "vp run check:changed", "true", "007"],
        required_checks: ["ci / test"],
      }),
    ).toBe(
      [
        "factory:",
        "  instructors: [alice, bob]",
        "  base: release/2.x",
        "  provision: []",
        '  gate: ["npm test", "vp run check:changed", "true", "007"]',
        '  required_checks: ["ci / test"]',
        "  limits:",
        "    minutes: 180",
        "    gate_retries: 2",
        "    checks_minutes: 30",
        "    interruption_resumes: 2",
        "  autonomy: pr",
        "",
      ].join("\n"),
    );
  });

  it("keeps the owner, so the pinned block claims on the same machine", () => {
    expect(factoryBlockYaml({ ...factory, owner: "Studio-Mac.local" })).toContain(
      "\n  instructors: [alice, bob]\n  owner: Studio-Mac.local\n",
    );
    expect(factoryBlockYaml({ ...factory, owner: "yes" })).toContain('\n  owner: "yes"\n');
    expect(factoryBlockYaml(factory)).not.toContain("owner");
  });
});
