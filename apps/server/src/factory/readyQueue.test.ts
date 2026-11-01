// @effect-diagnostics nodeBuiltinImport:off - the tests write a real machine log in a temp data dir.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { T0, useTempDirs } from "./ledger/testSupport.ts";
import { formatTs } from "./ledger/time.ts";
import { MAX_LINES, readReadyQueue } from "./readyQueue.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = T0 + 2 * 86_400_000;

const tempDir = useTempDirs();

const line = (ms: number, event: string, data: unknown) =>
  `${JSON.stringify({ ts: formatTs(ms), ms, event, data })}\n`;

type Skip = readonly [repo: string, issue: number | string | null, reason: string];

/**
 * A finished pass at `ms` whose claim step skipped `skips`; `[null, null, reason]` holds the machine.
 * `listed` writes the marker of a claim step that read the ready lists.
 */
const pass = (ms: number, skips: ReadonlyArray<Skip | string> = [], listed = true) =>
  line(ms, "pass_started", {}) +
  (listed ? line(ms + 1, "ready_listed", { repos: 1 }) : "") +
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
        since_cut: false,
      },
      {
        repo: "acme/app",
        issue: "9",
        reason: "postponed",
        since: formatTs(NOW - 3 * HOUR + 1),
        passes: 2,
        since_cut: false,
      },
      {
        repo: "acme/web",
        issue: "ENG-4",
        reason: "limit",
        since: formatTs(NOW - HOUR + 1),
        passes: 1,
        since_cut: false,
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

  it("keeps the queue over a pass that never read the ready lists", () => {
    const dir = logOf(
      pass(NOW - 3 * HOUR, [["acme/app", 7, "blocked"]]) +
        // A model cooling down with no fallback empties every queue before any issue is read.
        pass(NOW - 2 * HOUR, ["cooling-down"]) +
        // The runs ledger or every repo failed to load: no claim step, no marker.
        pass(NOW - HOUR, [], false),
    );
    const queue = readReadyQueue(dir, NOW);
    expect(queue.waiting).toEqual([
      expect.objectContaining({ issue: "7", passes: 1, since: formatTs(NOW - 3 * HOUR + 1) }),
    ]);
    expect(queue.checked_at).toBe(formatTs(NOW - 3 * HOUR + 2));
  });

  it("carries a repo or an issue the pass could not read from the pass before, and ignores a late pass", () => {
    const dir = logOf(
      pass(NOW - 4 * HOUR, [
        ["acme/app", 7, "blocked"],
        ["acme/web", 3, "limit"],
        ["acme/web", 4, "limit"],
      ]) +
        // acme/app's list failed and acme/web#4's blocker read failed; acme/web#3 was claimed.
        pass(NOW - 3 * HOUR, [
          ["acme/app", null, "list-failed"],
          ["acme/web", 4, "read-failed"],
        ]) +
        // The project's model could not be read during a cooldown.
        pass(NOW - 2 * HOUR, [
          ["acme/app", null, "model-unread"],
          ["acme/web", 4, "limit"],
        ]) +
        pass(NOW - HOUR, ["late"]),
    );
    const queue = readReadyQueue(dir, NOW);
    expect(queue.checked_at).toBe(formatTs(NOW - 2 * HOUR + 2));
    expect(
      queue.waiting.map(({ repo, issue, reason, passes }) => [repo, issue, reason, passes]),
    ).toEqual([
      ["acme/app", "7", "blocked", 1],
      ["acme/web", "4", "limit", 2],
    ]);
    expect(queue.waiting[0]!.since).toBe(formatTs(NOW - 4 * HOUR + 1));
  });

  it("counts a pass from before the marker that skipped an issue as one that read the list", () => {
    const dir = logOf(
      pass(NOW - 2 * HOUR, [["acme/app", 7, "blocked"]], false) +
        pass(NOW - HOUR, [["acme/app", 7, "blocked"]]),
    );
    expect(readReadyQueue(dir, NOW).waiting[0]?.passes).toBe(2);
  });

  it("reads at most MAX_LINES lines, and marks a streak still open there as cut", () => {
    const passes = Math.ceil(MAX_LINES / 4) + 10;
    let log = "";
    for (let at = passes; at >= 1; at -= 1)
      log += pass(NOW - at * MIN, [["acme/app", 7, "blocked"]]);
    const queue = readReadyQueue(logOf(log), NOW);
    expect(queue.waiting).toHaveLength(1);
    expect(queue.waiting[0]!.since_cut).toBe(true);
    expect(queue.waiting[0]!.passes).toBeLessThan(passes);
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
