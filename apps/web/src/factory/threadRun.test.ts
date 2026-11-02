import { describe, expect, it } from "vite-plus/test";

import { FactoryApiError, type FactoryEntry, type FactoryRunDetail } from "./api";
import { findThreadRun, issueOfThreadTitle, threadRunOfStatus } from "./threadRun";

const entry = (event: string, data: unknown): FactoryEntry => ({
  ts: "2026-11-01T08:00:00.000Z",
  ms: 0,
  event,
  data,
  cause: null,
});

const detail = (id: string, entries: ReadonlyArray<FactoryEntry>): FactoryRunDetail => ({
  id,
  entries,
  truncated: false,
  skipped: 0,
});

describe("issueOfThreadTitle", () => {
  it.each([
    ["original-solutions/watchalong#158 feat: avatars", "original-solutions__watchalong__158__"],
    ["Rawphp/My.Repo_x#7 Fix it", "rawphp__my.repo_x__7__"],
    ["acme/app#ENG-42 Linear issue", "acme__app__eng-42__"],
  ])("reads the run prefix of the factory's launch title %s", (title, prefix) => {
    expect(issueOfThreadTitle(title)?.prefix).toBe(prefix);
  });

  it.each([
    "New thread",
    "Fix #158 in watchalong",
    "original-solutions/watchalong#158",
    "original-solutions/watchalong #158 feat",
  ])("is null for a title the factory did not write: %s", (title) => {
    expect(issueOfThreadTitle(title)).toBeNull();
  });
});

describe("threadRunOfStatus", () => {
  it("finds the unfinished run whose session is the thread", () => {
    const run = threadRunOfStatus(
      {
        runs: [
          { id: "a__b__1__1", state: "building", thread_id: "t-1", pr_url: null, title: "One" },
          {
            id: "a__b__2__1",
            state: "building",
            last_event: "gate_command",
            thread_id: "t-2",
            pr_url: "https://x/pull/3",
            title: null,
          },
        ],
      },
      "t-2",
    );
    expect(run).toEqual({
      id: "a__b__2__1",
      state: "building",
      place: "gate",
      prUrl: "https://x/pull/3",
      title: null,
      finished: false,
    });
  });

  it("is null when no unfinished run has the thread", () => {
    expect(threadRunOfStatus({ runs: [] }, "t-1")).toBeNull();
    expect(threadRunOfStatus(null, "t-1")).toBeNull();
  });
});

describe("findThreadRun", () => {
  const launched = (thread: string) =>
    entry("session_launched", { thread_id: thread, title: "The issue" });
  const files: Record<string, ReadonlyArray<FactoryEntry>> = {
    a__b__9__1: [
      entry("state_changed", { to: "building" }),
      launched("t-old"),
      entry("finished", {}),
    ],
    a__b__9__2: [
      entry("state_changed", { to: "pr-open" }),
      launched("t-new"),
      entry("finished", { pr_end: "merged", pr_url: "https://github.com/a/b/pull/12" }),
    ],
  };
  const reader = () => {
    const asked: Array<string> = [];
    const read = async (id: string) => {
      asked.push(id);
      const entries = files[id];
      if (entries === undefined) throw new FactoryApiError(404, "not_found", "no such run");
      return detail(id, entries);
    };
    return { asked, read };
  };

  it("reads the issue's attempts in turn until one launched the thread", async () => {
    const { asked, read } = reader();
    const run = await findThreadRun(read, "a__b__9__", "t-new");
    expect(asked).toEqual(["a__b__9__1", "a__b__9__2"]);
    expect(run).toEqual({
      id: "a__b__9__2",
      state: "merged",
      place: "done",
      prUrl: "https://github.com/a/b/pull/12",
      title: "The issue",
      finished: true,
    });
  });

  it.each([
    ["stuck", null, "stuck"],
    ["needs-info", null, "info"],
    ["pr-open", "closed", null],
  ])("a finished %s run (pr %s) sits at %s", async (state, prEnd, place) => {
    const read = async (id: string) =>
      detail(id, [
        entry("state_changed", { to: state }),
        launched("t-1"),
        entry("finished", prEnd === null ? {} : { pr_end: prEnd }),
      ]);
    expect((await findThreadRun(read, "a__b__9__", "t-1"))?.place).toBe(place);
  });

  it("stops at the first attempt that does not exist", async () => {
    const { asked, read } = reader();
    expect(await findThreadRun(read, "a__b__9__", "t-other")).toBeNull();
    expect(asked).toEqual(["a__b__9__1", "a__b__9__2", "a__b__9__3"]);
  });

  it("fails on a read that fails for any other reason, so the caller can ask again", async () => {
    const read = async (): Promise<FactoryRunDetail> => {
      throw new FactoryApiError(0, "timeout", "timed out");
    };
    await expect(findThreadRun(read, "a__b__9__", "t-new")).rejects.toThrow("timed out");
  });
});
