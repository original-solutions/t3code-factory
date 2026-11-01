import { describe, expect, it } from "vite-plus/test";

import { foldSignedOut, signInCommand, signedOut } from "./gitHubSignIn";

const GH_SIGNED_OUT =
  "cannot read .dw/config.yml from GitHub: `gh api repos/acme/web` exited with status 4: To get started with GitHub CLI, please run: gh auth login Alternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.";

describe("signedOut", () => {
  it.each([
    ["gh's signed-out text", GH_SIGNED_OUT, true],
    [
      "the pass-errors wrapper around it",
      `the pass has failed 3 times in a row, last: ${GH_SIGNED_OUT}`,
      true,
    ],
    ["a config error", "factory.gate: expected a list", false],
    ["a missing file", "cannot read .dw/config.yml from GitHub: not found", false],
  ])("%s", (_name, message, expected) => {
    expect(signedOut(message)).toBe(expected);
  });
});

describe("signInCommand", () => {
  it.each([
    ["/Users/tom/.config/gh-factory", "GH_CONFIG_DIR=/Users/tom/.config/gh-factory gh auth login"],
    ["~/.config/gh", "GH_CONFIG_DIR=~/.config/gh gh auth login"],
    ["/Users/tom/My Drive/gh", "GH_CONFIG_DIR='/Users/tom/My Drive/gh' gh auth login"],
    ["/tmp/it's", `GH_CONFIG_DIR='/tmp/it'\\''s' gh auth login`],
    ["", "gh auth login"],
  ])("%s", (dir, expected) => {
    expect(signInCommand(dir)).toBe(expected);
  });
});

describe("foldSignedOut", () => {
  const item = (id: string, repo: string | null, message: string, first_seen: string) => ({
    environmentId: "env-a",
    item: { id, repo, message, first_seen },
  });

  it("folds one environment's signed-out items into one entry where the first stood", () => {
    const entries = [
      item("1", null, "a run is stuck", "2026-11-01T10:00:00Z"),
      item("2", "acme/web", GH_SIGNED_OUT, "2026-11-01T09:00:00Z"),
      item("3", "acme/api", GH_SIGNED_OUT, "2026-11-01T08:00:00Z"),
      item(
        "4",
        null,
        `the pass has failed 3 times, last: ${GH_SIGNED_OUT}`,
        "2026-11-01T11:00:00Z",
      ),
      item("5", "acme/web", "factory.gate: expected a list", "2026-11-01T12:00:00Z"),
    ];
    const folded = foldSignedOut(entries);
    expect(folded.map((row) => row.kind)).toEqual(["one", "signed-out", "one"]);
    const group = folded[1]!;
    expect(group.kind === "signed-out" && group.repos).toEqual(["acme/web", "acme/api"]);
    expect(group.kind === "signed-out" && group.entries.map(({ item }) => item.id)).toEqual([
      "2",
      "3",
      "4",
    ]);
    expect(group.kind === "signed-out" && group.firstSeen).toBe("2026-11-01T08:00:00Z");
  });

  it("keeps each environment's sign-in apart", () => {
    const folded = foldSignedOut([
      item("1", "acme/web", GH_SIGNED_OUT, "2026-11-01T09:00:00Z"),
      { ...item("2", "acme/web", GH_SIGNED_OUT, "2026-11-01T09:00:00Z"), environmentId: "env-b" },
    ]);
    expect(folded.map((row) => row.kind)).toEqual(["signed-out", "signed-out"]);
  });
});
