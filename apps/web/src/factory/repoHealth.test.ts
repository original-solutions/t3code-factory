import { describe, expect, it } from "vite-plus/test";

import type { FactoryRunRow, FactoryStatus } from "./api";
import { repoBoard, repoOfRun } from "./repoHealth";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = new Date(2026, 9, 28, 8, 0).getTime();
const iso = (ms: number) => new Date(ms).toISOString();

const row = (
  repo: string,
  issue: number,
  overrides: Partial<FactoryRunRow> = {},
  attempt = 1,
): FactoryRunRow => ({
  id: `${repo.replace("/", "__")}__${issue}__${attempt}`,
  started_ts: iso(NOW - 2 * HOUR),
  state: "building",
  last_event: "step_changed",
  step: null,
  status: "running",
  pr_url: null,
  finished: false,
  total_ms: null,
  unreadable: false,
  ...overrides,
});

/** A run that ended at `endMs` after an hour. */
const ended = (
  repo: string,
  issue: number,
  endMs: number,
  more: Partial<FactoryRunRow>,
  attempt = 1,
): FactoryRunRow =>
  row(
    repo,
    issue,
    {
      started_ts: iso(endMs - HOUR),
      finished: true,
      status: "finished",
      total_ms: HOUR,
      ...more,
    },
    attempt,
  );

const merged = { state: "pr-open", pr_end: "merged" } as const;

const active = (
  repo: string,
  issue: number,
  state = "building",
): FactoryStatus["runs"][number] => ({
  id: `${repo.replace("/", "__")}__${issue}__1`,
  state,
  user: null,
  for_ms: HOUR,
  pr_url: null,
  thread_id: null,
  unreadable: false,
});

describe("repoOfRun", () => {
  it("is owner/name from a run id, null for an id that does not parse", () => {
    expect(repoOfRun("acme__widgets__12__1")).toBe("acme/widgets");
    expect(repoOfRun("not-a-run")).toBeNull();
  });
});

describe("repoBoard", () => {
  it("calls a repo stuck, needing info, moving, flowing or quiet, and puts the ones that need a person first", () => {
    const board = repoBoard(
      [
        {
          active: [active("acme/moving", 5)],
          recent: [
            row("acme/moving", 5),
            ended("acme/flowing", 1, NOW - HOUR, merged),
            ended("acme/stuck", 2, NOW - DAY, { state: "stuck" }),
            ended("acme/stuck", 3, NOW - 2 * HOUR, merged),
            ended("acme/info", 4, NOW - DAY, { state: "needs-info" }),
            ended("acme/quiet", 6, NOW - DAY, { state: "pr-open", pr_end: "closed" }),
          ],
        },
      ],
      NOW,
    );
    expect(board.map(({ repo, verdict }) => [repo, verdict])).toEqual([
      ["acme/stuck", "stuck"],
      ["acme/info", "info"],
      ["acme/moving", "moving"],
      ["acme/flowing", "flowing"],
      ["acme/quiet", "quiet"],
    ]);
    expect(board[0]).toMatchObject({ stuck: 1, info: 0, inFlight: 0, merged: 1 });
    expect(board[0]!.lastMergeMs).toBe(NOW - 2 * HOUR);
    expect(board[2]).toMatchObject({ inFlight: 1, merged: 0, lastMergeMs: null });
  });

  it("counts only an issue's newest attempt, so a retried stuck run no longer makes its repo stuck", () => {
    const [repo] = repoBoard(
      [
        {
          active: [],
          recent: [
            ended("acme/widgets", 7, NOW - DAY, { state: "stuck" }, 1),
            ended("acme/widgets", 7, NOW - HOUR, merged, 2),
          ],
        },
      ],
      NOW,
    );
    expect(repo).toMatchObject({ verdict: "flowing", stuck: 0, merged: 1 });
  });

  it("is quiet once its last merge is older than the seven days, and still says when that was", () => {
    const [repo] = repoBoard(
      [{ active: [], recent: [ended("acme/widgets", 1, NOW - 9 * DAY, merged)] }],
      NOW,
    );
    expect(repo).toMatchObject({ verdict: "quiet", merged: 0, lastMergeMs: NOW - 9 * DAY });
  });

  it("joins one repo across environments without regard to case", () => {
    const board = repoBoard(
      [
        { active: [], recent: [ended("Acme/Widgets", 1, NOW - HOUR, merged)] },
        { active: [active("acme/widgets", 2)], recent: [row("acme/widgets", 2)] },
      ],
      NOW,
    );
    expect(board).toHaveLength(1);
    expect(board[0]).toMatchObject({ verdict: "moving", merged: 1, inFlight: 1 });
  });

  it("leaves out a run on no post and an unreadable one from what is in flight", () => {
    const [repo] = repoBoard(
      [
        {
          active: [
            { ...active("acme/widgets", 1), unreadable: true },
            active("acme/widgets", 2, "stuck"),
          ],
          recent: [ended("acme/widgets", 3, NOW - HOUR, merged)],
        },
      ],
      NOW,
    );
    expect(repo).toMatchObject({ verdict: "flowing", inFlight: 0 });
  });

  it("draws the last seven local days, oldest first, with what merged and what stopped on each", () => {
    const [repo] = repoBoard(
      [
        {
          active: [],
          recent: [
            ended("acme/widgets", 1, NOW - HOUR, merged),
            ended("acme/widgets", 2, NOW - 2 * HOUR, merged),
            ended("acme/widgets", 3, NOW - DAY, { state: "stuck" }),
            ended("acme/widgets", 4, NOW - DAY, { state: "needs-info" }),
            ended("acme/widgets", 5, NOW - 6 * DAY, merged),
            // Older than the strip: counted in the week, not drawn.
            ended("acme/widgets", 6, NOW - 9 * DAY, merged),
          ],
        },
      ],
      NOW,
    );
    expect(repo!.days).toHaveLength(7);
    expect(repo!.days.map(({ merged, stopped }) => [merged, stopped])).toEqual([
      [1, 0],
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 2],
      [2, 0],
    ]);
    expect(repo!.days[6]!.startMs).toBe(new Date(2026, 9, 28).getTime());
    expect(repo).toMatchObject({ merged: 3, lastMergeMs: NOW - HOUR });
  });

  it("is empty without runs, and leaves out a run whose id names no repo", () => {
    expect(repoBoard([], NOW)).toEqual([]);
    expect(repoBoard([{ active: [], recent: [{ ...row("acme/x", 1), id: "odd" }] }], NOW)).toEqual(
      [],
    );
  });
});
