import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { FactoryReadyQueue, FactoryRunRow } from "./api";
import { newIssueUrl, queueView, type QueueSource } from "./queueView";

const ENV = "env-1" as EnvironmentId;

const queue = (over: Partial<FactoryReadyQueue> = {}): FactoryReadyQueue => ({
  last_pass_at: "2026-10-31T14:00:00.000Z",
  holds: [],
  checked_at: "2026-10-31T14:00:00.000Z",
  waiting: [],
  turned_away: [],
  skipped_repos: [],
  ...over,
});

const run = (id: string, started: string, extra: Partial<FactoryRunRow> = {}): FactoryRunRow => ({
  id,
  started_ts: started,
  state: "stuck",
  last_event: "finished",
  step: null,
  status: "finished",
  pr_url: null,
  finished: true,
  total_ms: null,
  unreadable: false,
  ...extra,
});

const source = (q: FactoryReadyQueue, runs: ReadonlyArray<FactoryRunRow> = []): QueueSource => ({
  environmentId: ENV,
  label: "Mac",
  queue: q,
  runs,
});

const wait = (repo: string, issue: string, reason: string, since: string, passes = 3) => ({
  repo,
  issue,
  reason,
  since,
  passes,
});

describe("queueView", () => {
  it("groups the waits a person can lift first, longest waiting first within each", () => {
    const view = queueView(
      [
        source(
          queue({
            waiting: [
              wait("acme/app", "9", "limit", "2026-10-31T10:00:00.000Z"),
              wait("acme/app", "7", "blocked", "2026-10-31T12:00:00.000Z"),
              wait("acme/app", "8", "blocked", "2026-10-30T12:00:00.000Z"),
              wait("acme/app", "4", "postponed", "2026-10-31T13:00:00.000Z"),
              wait("acme/app", "5", "someday", "2026-10-31T13:00:00.000Z"),
            ],
          }),
        ),
      ],
      null,
    );
    expect(view.waiting).toBe(5);
    expect(view.groups.map(({ reason, issues }) => [reason, issues.map((i) => i.issue)])).toEqual([
      ["postponed", ["4"]],
      ["blocked", ["8", "7"]],
      ["limit", ["9"]],
      ["other", ["5"]],
    ]);
  });

  it("drops an issue claimed since the read, and titles one that ran before from its newest run", () => {
    const view = queueView(
      [
        source(
          queue({
            waiting: [
              wait("acme/app", "7", "blocked", "2026-10-31T12:00:00.000Z"),
              wait("Acme/App", "8", "blocked", "2026-10-31T12:00:00.000Z"),
            ],
            turned_away: [
              { repo: "acme/app", issue: "3", at: "2026-10-31T09:00:00.000Z" },
              { repo: "acme/app", issue: "2", at: "2026-10-31T08:00:00.000Z" },
            ],
          }),
          [
            run("acme__app__7__2", "2026-10-31T15:00:00.000Z"),
            run("acme__app__8__1", "2026-10-29T10:00:00.000Z", { title: "old" }),
            run("acme__app__8__2", "2026-10-30T10:00:00.000Z", { title: "Add export" }),
            run("acme__app__2__1", "2026-10-31T10:00:00.000Z"),
          ],
        ),
      ],
      null,
    );
    expect(
      view.groups[0]!.issues.map(({ issue, title, lastRun }) => [issue, title, lastRun?.id]),
    ).toEqual([["8", "Add export", "acme__app__8__2"]]);
    expect(view.turnedAway.map(({ issue }) => issue)).toEqual(["3"]);
  });

  it("keeps only the repo filtered to, and says why a held environment's list is old", () => {
    const view = queueView(
      [
        source(
          queue({
            last_pass_at: "2026-11-01T14:00:00.000Z",
            holds: ["low-disk", "paused", "new-thing"],
            checked_at: "2026-10-31T14:00:00.000Z",
            waiting: [
              wait("acme/app", "7", "blocked", "2026-10-31T12:00:00.000Z"),
              wait("acme/web", "1", "limit", "2026-10-31T12:00:00.000Z"),
            ],
            skipped_repos: [
              { repo: "acme/app", reason: "config-not-loaded" },
              { repo: "acme/web", reason: "not-owner" },
            ],
          }),
        ),
      ],
      "ACME/app",
    );
    expect(view.waiting).toBe(1);
    expect(view.holds).toEqual([
      {
        environmentId: ENV,
        label: "Mac",
        words: ["free disk space is below min_free_gib", "claims are paused by hand", "new-thing"],
        checkedMs: Date.parse("2026-10-31T14:00:00.000Z"),
      },
    ]);
    expect(view.skipped.map(({ repo, words }) => [repo, words])).toEqual([
      ["acme/app", "its .dw/config.yml could not be read"],
    ]);
  });

  it("links GitHub's new-issue page with the four headings as its body", () => {
    const url = new URL(newIssueUrl("acme/app"));
    expect(url.origin + url.pathname).toBe("https://github.com/acme/app/issues/new");
    expect(url.searchParams.get("body")).toContain("## Acceptance criteria");
    expect(url.searchParams.has("labels")).toBe(false);
  });
});
