import { describe, expect, it } from "vite-plus/test";

import {
  causeCount,
  groupByCause,
  isCondition,
  signedOutLine,
  signedOutCause,
  splitDismissed,
  stillTrue,
} from "./attentionCauses";

const GH_SIGNED_OUT =
  "cannot read .dw/config.yml from GitHub: `gh api repos/acme/web` exited with status 4: To get started with GitHub CLI, please run: gh auth login Alternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.";

const raw = (id: string, repo: string | null, message: string) => ({
  id,
  repo,
  message,
  first_seen: "2026-11-01T09:00:00Z",
});

describe("groupByCause", () => {
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
    const folded = groupByCause(entries);
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
    const folded = groupByCause([
      item("1", "acme/web", GH_SIGNED_OUT, "2026-11-01T09:00:00Z"),
      { ...item("2", "acme/web", GH_SIGNED_OUT, "2026-11-01T09:00:00Z"), environmentId: "env-b" },
    ]);
    expect(folded.map((row) => row.kind)).toEqual(["signed-out", "signed-out"]);
  });
});

describe("causeCount and signedOutCause", () => {
  const items = [
    raw("config-not-loaded:acme/web", "acme/web", GH_SIGNED_OUT),
    raw("config-not-loaded:acme/api", "acme/api", GH_SIGNED_OUT),
    raw("pass-errors", null, `the pass has failed 3 times in a row, last: ${GH_SIGNED_OUT}`),
    raw("low-disk", null, "low disk: free space is below min_free_gib 10"),
  ];

  it("counts a signed-out gh once however many items it raised", () => {
    expect(causeCount(items)).toBe(2);
    expect(causeCount([])).toBe(0);
  });

  it("names the repos a signed-out gh cannot read, and null while it is signed in", () => {
    expect(signedOutCause(items)).toEqual({
      repos: ["acme/web", "acme/api"],
      firstSeen: "2026-11-01T09:00:00Z",
    });
    expect(signedOutCause(items.slice(3))).toBeNull();
  });

  it.each([
    [[], "The factory's gh is signed out, so its passes cannot read GitHub."],
    [["acme/web"], "The factory's gh is signed out, so it cannot read acme/web."],
    [
      ["acme/a", "acme/b", "acme/c", "acme/d"],
      "The factory's gh is signed out, so it cannot read any of its 4 repos: a, b, c and 1 more.",
    ],
  ])("words %j as one sentence", (repos, line) => {
    expect(signedOutLine(repos)).toBe(line);
  });
});

describe("dismissing", () => {
  const entry = (id: string, run: string | null = null) => ({
    environmentId: "env-a",
    item: { ...raw(id, null, id), run },
  });
  const key = (e: { readonly item: { readonly id: string } }) => e.item.id;

  it("calls an item about one run, or an archived worktree, an event, and the rest conditions", () => {
    expect(isCondition(entry("config").item)).toBe(true);
    expect(isCondition(entry("low-disk").item)).toBe(true);
    expect(isCondition(entry("run:a:stuck", "a").item)).toBe(false);
    expect(isCondition(entry("worktree:/w/a").item)).toBe(false);
  });

  it("holds read the dismissed items too, and an older server's report without them", () => {
    const open = [raw("a", null, "a")];
    const dismissed = [raw("b", null, "b")];
    expect(stillTrue({ attention: open, dismissed }).map(({ id }) => id)).toEqual(["a", "b"]);
    expect(stillTrue({ attention: open }).map(({ id }) => id)).toEqual(["a"]);
  });

  it("moves an item the page dismissed or restored before the server's next status says so", () => {
    const split = splitDismissed(
      [entry("a"), entry("b")],
      [entry("c"), entry("d")],
      new Map([
        ["b", true],
        ["c", false],
        ["d", true],
      ]),
      key,
    );
    expect(split.open.map(key)).toEqual(["a", "c"]);
    expect(split.dismissed.map(key)).toEqual(["b", "d"]);
  });
});
