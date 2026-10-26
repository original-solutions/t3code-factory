// @effect-diagnostics nodeBuiltinImport:off - the tests lay out real config files and read them back.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { describe } from "vite-plus/test";

import {
  parseMachineConfig,
  type RepoConfigReading,
  type WatchedListing,
  type WatchedProject,
} from "./config.ts";
import { useTempDirs } from "./ledger/testSupport.ts";
import { editMachineConfig, isJsonObject, readMachineConfigReport } from "./settings.ts";
import { WatchedReposError } from "./t3/watchedRepos.ts";

const tempDir = useTempDirs();

const FILE = "/factory/config.yml";

const COMMENTED = `# The factory on this machine.
# Edited by hand; keep the comments.

# where gh keeps its login
gh_config_dir: /gh # trailing note
# how often a pass runs
poll_seconds: 60
# runs at once
max_concurrent_runs: 1
# notifications stay a hand edit
notify: false
# the repos (retired by #106; a hand-written block stays as it is)
repos:
  # the main repo
  - repo: a/b # primary
    path: /b
# end of file
`;

const commentLines = (text: string) =>
  text.split("\n").filter((line) => line.trimStart().startsWith("#") || line.includes(" # "));

const edited = (existing: string | null, body: Record<string, unknown>) => {
  const result = editMachineConfig(existing, body, FILE);
  if (Result.isFailure(result)) assert.fail(JSON.stringify(result.failure));
  return result.success;
};

describe("editMachineConfig", () => {
  it("keeps every comment and the keys the form does not edit", () => {
    const text = edited(COMMENTED, {
      gh_config_dir: "/other",
      poll_seconds: 90,
      max_concurrent_runs: 3,
    });
    const after = text.split("\n");
    for (const line of commentLines(COMMENTED).map((l) => l.trim())) {
      // A comment that sat after a value stays after it; the value on its line may have changed.
      const comment = line.includes(" # ") ? `# ${line.split(" # ")[1]}` : line;
      assert.ok(
        after.some((l) => l.includes(comment)),
        `lost: ${comment}\n${text}`,
      );
    }
    const parsed = parseMachineConfig(text, FILE);
    assert.deepStrictEqual(Result.isSuccess(parsed) && parsed.success.config, {
      ghConfigDir: "/other",
      pollSeconds: 90,
      maxConcurrentRuns: 3,
      maxConcurrentGates: 2,
      feedbackSeconds: 600,
      notify: false,
      minFreeGib: 10,
      maxLoadPerCore: 1,
      deployWaitMinutes: 120,
    });
  });

  it("writes feedback_seconds and keeps the other keys and every comment", () => {
    const text = edited(COMMENTED, { feedback_seconds: 30 });
    for (const line of commentLines(COMMENTED).map((l) => l.trim())) {
      const comment = line.includes(" # ") ? `# ${line.split(" # ")[1]}` : line;
      assert.ok(
        text.split("\n").some((l) => l.includes(comment)),
        `lost: ${comment}\n${text}`,
      );
    }
    const parsed = parseMachineConfig(text, FILE);
    assert.deepStrictEqual(Result.isSuccess(parsed) && parsed.success.config, {
      ghConfigDir: "/gh",
      pollSeconds: 60,
      maxConcurrentRuns: 1,
      maxConcurrentGates: 2,
      feedbackSeconds: 30,
      notify: false,
      minFreeGib: 10,
      maxLoadPerCore: 1,
      deployWaitMinutes: 120,
    });
  });

  it("leaves keys absent from the body untouched", () => {
    const text = edited(COMMENTED, { poll_seconds: 120 });
    // The yaml printer may add a blank line before a trailing comment; nothing else moves.
    const unblank = (value: string) => value.replace(/\n{2,}/g, "\n");
    assert.strictEqual(
      unblank(text),
      unblank(COMMENTED.replace("poll_seconds: 60", "poll_seconds: 120")),
    );
    assert.strictEqual(edited(text, { poll_seconds: 120 }), text);
  });

  // The key was retired. The page no longer sends it; an edit leaves a hand-written block as is.
  it("keeps a hand-written repos block and its comments through an edit", () => {
    const text = edited(COMMENTED, { poll_seconds: 120 });
    for (const kept of [
      "repos:",
      "- repo: a/b # primary",
      "path: /b",
      "# the repos (retired by #106; a hand-written block stays as it is)",
      "# the main repo",
    ]) {
      assert.include(text, kept);
    }
    const unblank = (value: string) => value.replace(/\n{2,}/g, "\n");
    assert.strictEqual(
      unblank(text),
      unblank(COMMENTED.replace("poll_seconds: 60", "poll_seconds: 120")),
    );
  });

  it("ignores a repos key in the body: neither adds nor changes the file's", () => {
    const withBlock = edited(COMMENTED, {
      poll_seconds: 120,
      repos: [{ repo: "x/y", path: "/y" }],
    });
    assert.strictEqual(withBlock, edited(COMMENTED, { poll_seconds: 120 }));
    assert.notInclude(withBlock, "x/y");
    assert.notInclude(
      edited(null, { gh_config_dir: "/gh", max_concurrent_runs: 1, repos: [] }),
      "repos",
    );
  });

  // The two keys are retired. A save keeps them as written, so a rollback to a version that
  // still requires them loads the file; the current loader only warns about them.
  it("keeps the retired model_instance and model keys through a save, with every other key and comment", () => {
    const retired = COMMENTED.replace(
      "# notifications stay a hand edit",
      "# the model\nmodel_instance: claudeAgent # old\nmodel: claude-sonnet-5-5\n# notifications stay a hand edit",
    );
    const text = edited(retired, { poll_seconds: 60 });
    // The YAML library may add a blank line before a trailing comment; the keys and comments are the point.
    const unblank = (value: string) => value.replace(/\n{2,}/g, "\n");
    assert.strictEqual(unblank(text), unblank(retired));
  });

  describe("files the page could not fix before", () => {
    const BODY = {
      gh_config_dir: "/gh",
      poll_seconds: 60,
      max_concurrent_runs: 1,
    };

    it("keeps a hand-written min_free_gib through an edit", () => {
      const text = edited(COMMENTED + "min_free_gib: 25\n", { poll_seconds: 90 });
      assert.include(text, "min_free_gib: 25");
    });

    it("keeps a hand-written deploy_wait_minutes through an edit", () => {
      const text = edited(COMMENTED + "deploy_wait_minutes: 240\n", { poll_seconds: 90 });
      assert.include(text, "deploy_wait_minutes: 240");
    });

    it("keeps a hand-written max_load_per_core through an edit", () => {
      const text = edited(COMMENTED + "max_load_per_core: 2\n", { poll_seconds: 90 });
      assert.include(text, "max_load_per_core: 2");
    });

    it("drops an unknown top-level key, keeps notify and the comments", () => {
      const text = edited(COMMENTED + "pol_seconds: 5\n", { poll_seconds: 90 });
      assert.notInclude(text, "pol_seconds");
      assert.include(text, "notify: false");
      assert.include(text, "# notifications stay a hand edit");
      assert.include(text, "poll_seconds: 90");
    });

    it("keeps keep_versions, which autodeploy.sh reads", () => {
      const text = edited(COMMENTED + "keep_versions: 1\n", { poll_seconds: 90 });
      assert.include(text, "keep_versions: 1");
    });

    it("starts from an empty document when the existing file is not YAML", () => {
      const text = edited("poll_seconds: [unclosed\n  - : :\n", BODY);
      const parsed = parseMachineConfig(text, FILE);
      assert.ok(Result.isSuccess(parsed), text);
    });
  });

  it("refuses an invalid body with the parser's fields", () => {
    const result = editMachineConfig(COMMENTED, { poll_seconds: 5, gh_config_dir: "" }, FILE);
    assert.ok(Result.isFailure(result));
    const errors = Result.isFailure(result) ? result.failure : [];
    assert.deepStrictEqual(errors.map((e) => e.field).sort(), ["gh_config_dir", "poll_seconds"]);
    assert.ok(errors.every((e) => e.file === FILE));
  });

  it("gives a float and a string the parser's own messages", () => {
    const result = editMachineConfig(
      COMMENTED,
      { poll_seconds: 60.5, max_concurrent_runs: "two" },
      FILE,
    );
    assert.ok(Result.isFailure(result));
    const errors = Result.isFailure(result) ? result.failure : [];
    assert.deepStrictEqual(
      errors.map((e) => [e.field, e.message]),
      [
        ["poll_seconds", "must be an integer of at least 10"],
        ["max_concurrent_runs", "must be an integer"],
      ],
    );
  });

  it("makes a new file from nothing", () => {
    const text = edited(null, {
      gh_config_dir: "/gh",
      poll_seconds: 60,
      max_concurrent_runs: 1,
      max_concurrent_gates: 2,
    });
    const parsed = parseMachineConfig(text, FILE);
    assert.ok(Result.isSuccess(parsed), text);
  });

  it("recognises a JSON object and nothing else", () => {
    assert.ok(isJsonObject({}));
    assert.ok(!isJsonObject([]));
    assert.ok(!isJsonObject(null));
    assert.ok(!isJsonObject("x"));
  });
});

const DEFAULTS = {
  gh_config_dir: "",
  poll_seconds: 60,
  max_concurrent_runs: 1,
  max_concurrent_gates: 2,
  feedback_seconds: 600,
};

describe("readMachineConfigReport", () => {
  /** A listing of these watched projects, none unresolved. */
  const of = (repos: ReadonlyArray<WatchedProject>) =>
    Result.succeed<WatchedListing>({ repos, departed: [], unresolved: [] });

  const report = (
    text: string | null,
    watched: Result.Result<WatchedListing, WatchedReposError> = of([]),
    readings: ReadonlyMap<string, RepoConfigReading> = new Map(),
  ) =>
    Effect.gen(function* () {
      const file = NodePath.join(tempDir("report"), "config.yml");
      if (text !== null) NodeFS.writeFileSync(file, text);
      return { file, report: yield* readMachineConfigReport(file, watched, readings) };
    }).pipe(Effect.provide(NodeServices.layer));

  it.effect("reports the defaults for a missing file", () =>
    Effect.gen(function* () {
      const { file, report: r } = yield* report(null);
      assert.deepStrictEqual(r, {
        file,
        exists: false,
        config: DEFAULTS,
        defaults: DEFAULTS,
        errors: [],
        repos: [],
        unresolved: [],
        watch_error: null,
      });
    }),
  );

  it.effect(
    "names the opted-in checkouts the reader could not settle, beside the watched ones",
    () =>
      Effect.gen(function* () {
        const { report: r } = yield* report(
          COMMENTED,
          Result.succeed({
            repos: [{ repo: "a/b", path: "/b", title: "Bee" }],
            departed: [],
            unresolved: ["/slow", "/conflicted"],
          }),
        );
        assert.deepStrictEqual(
          r.repos.map((block) => block.repo),
          ["a/b"],
        );
        assert.deepStrictEqual(r.unresolved, ["/slow", "/conflicted"]);
        assert.strictEqual(r.watch_error, null);
      }),
  );

  it.effect(
    "reports a listing the reader could not make as its error, not as no project watched",
    () =>
      Effect.gen(function* () {
        const { report: r } = yield* report(
          COMMENTED,
          Result.fail(new WatchedReposError({ cause: new Error("store down") })),
        );
        assert.deepStrictEqual(r.config?.poll_seconds, 60);
        assert.deepStrictEqual(r.repos, []);
        assert.deepStrictEqual(r.unresolved, []);
        assert.strictEqual(r.watch_error, "cannot list the T3 projects: store down");
      }),
  );

  it.effect("reports an invalid file as errors with no config", () =>
    Effect.gen(function* () {
      const { report: r } = yield* report("poll_seconds: 1\n");
      assert.strictEqual(r.exists, true);
      assert.strictEqual(r.config, null);
      assert.ok(r.errors.length > 0);
      assert.deepStrictEqual(r.repos, []);
    }),
  );

  const WATCHED: ReadonlyArray<WatchedProject> = [
    { repo: "a/b", path: "/b", title: "Bee" },
    { repo: "c/d", path: "/d", title: "Dee" },
  ];

  it.effect("lists the watched projects for a missing file and for an invalid one", () =>
    Effect.gen(function* () {
      const expected = WATCHED.map((w) => ({ ...w, factory: null, errors: null }));
      const missing = yield* report(null, of(WATCHED));
      assert.deepStrictEqual(missing.report.repos, expected);
      const invalid = yield* report("poll_seconds: 1\n", of(WATCHED));
      assert.deepStrictEqual(invalid.report.repos, expected);
    }),
  );

  it.effect("marks every block of a repo that two projects name, whatever the case", () =>
    Effect.gen(function* () {
      const watched: ReadonlyArray<WatchedProject> = [
        { repo: "Acme/Widgets", path: "/one", title: "One" },
        { repo: "c/d", path: "/d", title: "Dee" },
        { repo: "acme/widgets", path: "/two", title: "Two" },
      ];
      // A reading of the repo does not matter: nothing was loaded for it from either checkout.
      const readings = new Map<string, RepoConfigReading>([
        ["Acme/Widgets", { kind: "errors", errors: [{ file: ".dw/config.yml", message: "old" }] }],
      ]);
      const { report: r } = yield* report(COMMENTED, of(watched), readings);
      const ambiguous = [
        {
          file: ".dw/config.yml",
          message:
            "2 T3 projects have this repo as their origin (/one, /two); the factory watches none of them",
        },
      ];
      assert.deepStrictEqual(r.repos, [
        { repo: "Acme/Widgets", path: "/one", title: "One", factory: null, errors: ambiguous },
        { repo: "c/d", path: "/d", title: "Dee", factory: null, errors: null },
        { repo: "acme/widgets", path: "/two", title: "Two", factory: null, errors: ambiguous },
      ]);
    }),
  );

  it.effect("reports feedback_seconds from the file, and the default for a file without it", () =>
    Effect.gen(function* () {
      const without = yield* report(COMMENTED);
      assert.strictEqual(without.report.config?.feedback_seconds, 600);
      const set = yield* report(`${COMMENTED}feedback_seconds: 0\n`);
      assert.strictEqual(set.report.config?.feedback_seconds, 0);
    }),
  );

  it.effect("gives the form its draft: the values an invalid file holds, as written", () =>
    Effect.gen(function* () {
      const { report: r } = yield* report(COMMENTED.replace("poll_seconds: 60", "poll_seconds: 5"));
      assert.strictEqual(r.config, null);
      assert.deepStrictEqual(r.defaults, DEFAULTS);
      assert.deepStrictEqual(r.draft, {
        gh_config_dir: "/gh",
        poll_seconds: 5,
        max_concurrent_runs: 1,
      });
    }),
  );

  it.effect("copies only what is a string or a number into the draft, and not repos", () =>
    Effect.gen(function* () {
      const { report: r } = yield* report(
        "poll_seconds: [1]\ngh_config_dir: /x\nrepos:\n  - repo: a/b\n    path: 7\n",
      );
      assert.deepStrictEqual(r.draft, { gh_config_dir: "/x" });
    }),
  );

  it.effect("gives an empty draft for a file that is not YAML, and none for a good file", () =>
    Effect.gen(function* () {
      const broken = yield* report("poll_seconds: [unclosed\n");
      assert.strictEqual(broken.report.config, null);
      assert.deepStrictEqual(broken.report.draft, {});
      const good = yield* report(COMMENTED);
      assert.isFalse("draft" in good.report);
      assert.deepStrictEqual(good.report.defaults, DEFAULTS);
    }),
  );

  it.effect("joins the last reading of each watched project", () =>
    Effect.gen(function* () {
      const readings = new Map<string, RepoConfigReading>([
        ["a/b", { kind: "errors", errors: [{ file: ".dw/config.yml", message: "bad" }] }],
      ]);
      const { report: r } = yield* report(COMMENTED, of(WATCHED), readings);
      assert.strictEqual(r.exists, true);
      assert.deepStrictEqual(r.errors, []);
      assert.deepStrictEqual(r.repos, [
        {
          repo: "a/b",
          path: "/b",
          title: "Bee",
          factory: null,
          errors: [{ file: ".dw/config.yml", message: "bad" }],
        },
        { repo: "c/d", path: "/d", title: "Dee", factory: null, errors: null },
      ]);
    }),
  );

  it.effect("shows the project config a reading holds", () =>
    Effect.gen(function* () {
      const project = {
        instructors: ["tk"],
        base: "main",
        provision: [],
        gate: ["true"],
        requiredChecks: ["ci"],
        limits: {
          minutes: 90,
          gateRetries: 1,
          checksMinutes: 30,
          interruptionResumes: 2,
        },
        autonomy: "pr" as const,
      };
      const readings = new Map<string, RepoConfigReading>([["a/b", { kind: "ok", project }]]);
      const { report: r } = yield* report(COMMENTED, of(WATCHED.slice(0, 1)), readings);
      assert.strictEqual(r.repos[0]?.factory?.base, "main");
      assert.deepStrictEqual(r.repos[0]?.factory?.required_checks, ["ci"]);
      assert.strictEqual(r.repos[0]?.errors, null);
    }),
  );
});
