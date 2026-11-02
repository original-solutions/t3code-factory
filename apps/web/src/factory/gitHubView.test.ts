import { describe, expect, it } from "vite-plus/test";

import type { FactoryRunGitHub } from "./api";
import { gitHubView, isLongText, splitPath, topFiles } from "./gitHubView";

const ISSUE = {
  kind: "ok" as const,
  number: 158,
  title: "Watchers",
  body: "Show avatars.",
  body_cut: false,
  author: "tom",
  labels: [],
  closed: false,
};
const SIGNED_OUT = { kind: "signed-out" as const, message: "not signed in" };
const FAILED = { kind: "failed" as const, message: "HTTP 502" };
const answer = (
  issue: FactoryRunGitHub["issue"],
  pr: FactoryRunGitHub["pr"],
): FactoryRunGitHub => ({
  id: "o__r__158__1",
  issue,
  pr,
});

describe("gitHubView", () => {
  it.each([
    ["nothing on GitHub", answer(null, null), { kind: "none" }],
    [
      "one line when every part failed",
      answer(SIGNED_OUT, SIGNED_OUT),
      { kind: "unread", reason: SIGNED_OUT },
    ],
    [
      "signed out wins over another failure",
      answer(FAILED, SIGNED_OUT),
      { kind: "unread", reason: SIGNED_OUT },
    ],
    [
      "the failure when the only part failed",
      answer(FAILED, null),
      { kind: "unread", reason: FAILED },
    ],
    [
      "what was read, beside what was not",
      answer(ISSUE, FAILED),
      { kind: "read", issue: ISSUE, pr: FAILED },
    ],
    [
      "a deleted pull request is read, not a failure",
      answer({ kind: "gone" }, null),
      { kind: "read", issue: { kind: "gone" }, pr: null },
    ],
  ] as const)("%s", (_name, given, expected) => {
    expect(gitHubView(given)).toEqual(expected);
  });
});

describe("topFiles", () => {
  it("takes the files that changed most, keeping GitHub's order on a tie", () => {
    const files = [
      { path: "a", additions: 1, deletions: 0 },
      { path: "b", additions: 10, deletions: 5 },
      { path: "c", additions: 1, deletions: 0 },
      { path: "d", additions: 0, deletions: 30 },
    ];
    expect(topFiles(files, 3).map((file) => file.path)).toEqual(["d", "b", "a"]);
  });
});

it("isLongText folds many lines or many characters", () => {
  expect(isLongText("short")).toBe(false);
  expect(isLongText("x\n".repeat(20))).toBe(true);
  expect(isLongText("x".repeat(1000))).toBe(true);
});

it("splitPath keeps the folder's slash", () => {
  expect(splitPath("apps/web/a.ts")).toEqual({ dir: "apps/web/", name: "a.ts" });
  expect(splitPath("README.md")).toEqual({ dir: "", name: "README.md" });
});
