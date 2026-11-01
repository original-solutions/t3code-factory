// @effect-diagnostics nodeBuiltinImport:off - the tests write a real machine log in a temp data dir.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { T0, useTempDirs } from "./ledger/testSupport.ts";
import { formatTs } from "./ledger/time.ts";
import { readReadyQueue } from "./readyQueue.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = T0 + 2 * 86_400_000;

const tempDir = useTempDirs();

const line = (ms: number, event: string, data: unknown) =>
  `${JSON.stringify({ ts: formatTs(ms), ms, event, data })}\n`;

type Skip = readonly [repo: string, issue: number | string | null, reason: string];

/** A finished pass at `ms` whose claim step skipped `skips`; `[null, null, reason]` holds the machine. */
const pass = (ms: number, skips: ReadonlyArray<Skip | string> = []) =>
  line(ms, "pass_started", {}) +
  skips
    .map((skip) =>
      typeof skip === "string"
        ? line(ms + 1, "claim_skipped", { reason: skip })
        : line(
            ms + 1,
            "claim_skipped",
            skip[1] === null
              ? { repo: skip[0], reason: skip[2] }
              : { repo: skip[0], issue: skip[1], reason: skip[2] },
          ),
    )
    .join("") +
  line(ms + 2, "pass_finished", { runs: 0, claimed: 0, errors: 0, attention: 0 });

const logOf = (text: string) => {
  const dir = tempDir();
  NodeFS.writeFileSync(NodePath.join(dir, "events.jsonl"), text);
  return dir;
};

describe("readReadyQueue", () => {
  it("is empty with no log", () => {
    expect(readReadyQueue(tempDir(), NOW)).toEqual({
      last_pass_at: null,
      holds: [],
      checked_at: null,
      waiting: [],
      turned_away: [],
      skipped_repos: [],
    });
  });

  it("lists the issues the newest pass that read the ready list held back, each since its streak began", () => {
    const dir = logOf(
      pass(NOW - 4 * HOUR, [["acme/app", 7, "limit"]]) +
        pass(NOW - 3 * HOUR, [
          ["acme/app", 7, "blocked"],
          ["acme/app", 9, "limit"],
        ]) +
        // Paused passes read no issue, so they neither list nor end a streak.
        pass(NOW - 2 * HOUR, ["paused"]) +
        pass(NOW - HOUR, [
          ["acme/app", 7, "blocked"],
          ["acme/app", 9, "postponed"],
          ["acme/web", "ENG-4", "limit"],
        ]) +
        pass(NOW - 10 * MIN, ["paused"]),
    );
    const queue = readReadyQueue(dir, NOW);
    expect(queue.holds).toEqual(["paused"]);
    expect(queue.last_pass_at).toBe(formatTs(NOW - 10 * MIN + 2));
    expect(queue.checked_at).toBe(formatTs(NOW - HOUR + 2));
    expect(queue.waiting).toEqual([
      {
        repo: "acme/app",
        issue: "7",
        reason: "blocked",
        since: formatTs(NOW - 4 * HOUR + 1),
        passes: 3,
      },
      {
        repo: "acme/app",
        issue: "9",
        reason: "postponed",
        since: formatTs(NOW - 3 * HOUR + 1),
        passes: 2,
      },
      {
        repo: "acme/web",
        issue: "ENG-4",
        reason: "limit",
        since: formatTs(NOW - HOUR + 1),
        passes: 1,
      },
    ]);
  });

  it("ends a streak at a pass that read the list without the issue", () => {
    const dir = logOf(
      pass(NOW - 3 * HOUR, [["acme/app", 7, "blocked"]]) +
        pass(NOW - 2 * HOUR) +
        pass(NOW - HOUR, [["acme/app", 7, "blocked"]]),
    );
    expect(readReadyQueue(dir, NOW).waiting[0]?.since).toBe(formatTs(NOW - HOUR + 1));
  });

  it("is empty when the newest pass that read the list held nothing back", () => {
    const dir = logOf(pass(NOW - 2 * HOUR, [["acme/app", 7, "blocked"]]) + pass(NOW - HOUR));
    const queue = readReadyQueue(dir, NOW);
    expect(queue.waiting).toEqual([]);
    expect(queue.checked_at).toBe(formatTs(NOW - HOUR + 2));
  });

  it("ignores a pass still running, and says which repos the newest pass skipped", () => {
    const dir = logOf(
      line(NOW - HOUR, "pass_started", {}) +
        line(NOW - HOUR, "repo_skipped", {
          repo: "acme/web",
          reason: "config-not-loaded",
          message: "gh auth login",
        }) +
        pass(NOW - HOUR, [
          ["acme/app", 7, "blocked"],
          ["acme/ops", null, "not-owner"],
        ]).replace(line(NOW - HOUR, "pass_started", {}), "") +
        line(NOW - 5, "pass_started", {}) +
        line(NOW - 4, "claim_skipped", { repo: "acme/app", issue: 8, reason: "blocked" }),
    );
    const queue = readReadyQueue(dir, NOW);
    expect(queue.waiting.map(({ issue }) => issue)).toEqual(["7"]);
    expect(queue.skipped_repos).toEqual([
      { repo: "acme/ops", reason: "not-owner" },
      { repo: "acme/web", reason: "config-not-loaded" },
    ]);
  });

  it("lists an issue sent back to proposed in the last three days, newest first", () => {
    const dir = logOf(
      pass(NOW - 4 * 86_400_000 + HOUR, [["acme/app", 1, "unapproved"]]) +
        pass(NOW - 3 * HOUR, [["acme/app", 2, "unapproved"]]) +
        pass(NOW - HOUR, [["acme/app", 3, "unapproved"]]),
    );
    expect(readReadyQueue(dir, NOW).turned_away).toEqual([
      { repo: "acme/app", issue: "3", at: formatTs(NOW - HOUR + 1) },
      { repo: "acme/app", issue: "2", at: formatTs(NOW - 3 * HOUR + 1) },
    ]);
  });
});
