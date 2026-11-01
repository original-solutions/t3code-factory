import { describe, expect, it } from "vite-plus/test";

import { signInCommand, signedOut } from "./gitHubSignIn";

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
