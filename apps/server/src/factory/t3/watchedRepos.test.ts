// @effect-diagnostics nodeBuiltinImport:off - the tests lay out real checkouts and read them back.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  ProjectId,
  type RepositoryIdentity,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProcessRunner from "../../processRunner.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { useTempDirs } from "../ledger/testSupport.ts";
import { FactoryPaths } from "./paths.ts";
import * as WatchedRepos from "./watchedRepos.ts";

const tempDir = useTempDirs();

const FACTORY_CONFIG = "factory:\n  base: main\n";

const github = (owner: string, name: string): RepositoryIdentity => ({
  canonicalKey: `github.com/${owner}/${name}`,
  locator: {
    source: "git-remote",
    remoteName: "origin",
    remoteUrl: `https://github.com/${owner}/${name}.git`,
  },
  provider: SourceControlProviderKind.make("github"),
  owner,
  name,
});

const WIDGETS = github("acme", "widgets");
const GADGETS = github("acme", "gadgets");

const projectEvent = (
  type: "project.created" | "project.deleted",
  id: string,
  workspaceRoot: string,
  sequence: number,
) =>
  type === "project.created"
    ? ({
        sequence,
        eventId: EventId.make(`event:${id}:created`),
        aggregateKind: "project",
        aggregateId: ProjectId.make(id),
        occurredAt: "2026-10-03T00:00:00.000Z",
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "project.created",
        payload: {
          projectId: ProjectId.make(id),
          title: `Title of ${id}`,
          workspaceRoot,
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-10-03T00:00:00.000Z",
          updatedAt: "2026-10-03T00:00:00.000Z",
        },
      } as const)
    : ({
        sequence,
        eventId: EventId.make(`event:${id}:deleted`),
        aggregateKind: "project",
        aggregateId: ProjectId.make(id),
        occurredAt: "2026-10-03T00:00:00.000Z",
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "project.deleted",
        payload: { projectId: ProjectId.make(id), deletedAt: "2026-10-03T00:00:00.000Z" },
      } as const);

/** A checkout directory; `config` is the text of its `.dw/config.yml`, or null for none. */
const checkout = (name: string, config: string | null): string => {
  const dir = tempDir(name);
  if (config !== null) {
    NodeFS.mkdirSync(NodePath.join(dir, ".dw"));
    NodeFS.writeFileSync(NodePath.join(dir, ".dw", "config.yml"), config);
  }
  return dir;
};

/** Runs the real `git` in `cwd` for a test and returns what it printed. */
const git = (cwd: string, ...args: Array<string>): string => {
  const result = NodeChildProcess.spawnSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
};

/**
 * A clone of a local "origin" whose default branch `main` holds `committed` as `.dw/config.yml`
 * (nothing when null), checked out on an older branch that has no `.dw` at all. The clone has
 * `origin/HEAD`, as `git clone` leaves it.
 */
const clonedCheckout = (name: string, committed: string | null): string => {
  const root = tempDir(name);
  const source = NodePath.join(root, "source");
  NodeFS.mkdirSync(source);
  git(source, "init", "-q", "-b", "main");
  NodeFS.writeFileSync(NodePath.join(source, "README.md"), "before the opt-in\n");
  git(source, "add", "README.md");
  git(source, "commit", "-q", "-m", "before");
  if (committed !== null) {
    NodeFS.mkdirSync(NodePath.join(source, ".dw"));
    NodeFS.writeFileSync(NodePath.join(source, ".dw", "config.yml"), committed);
    git(source, "add", ".dw/config.yml");
    git(source, "commit", "-q", "-m", "opt in");
  }
  git(root, "clone", "-q", "source", "clone");
  const clone = NodePath.join(root, "clone");
  git(clone, "switch", "-q", "-c", "old", git(clone, "rev-list", "--max-parents=0", "HEAD").trim());
  return clone;
};

/** A ProcessRunner that records the commands it is given and answers each with no output: timed out, or ended with no code. */
const runnerAnswering = (calls: Array<string>, timedOut = false) =>
  Layer.mock(ProcessRunner.ProcessRunner)({
    run: (input) =>
      Effect.sync((): ProcessRunner.ProcessRunOutput => {
        calls.push([input.command, ...input.args].join(" "));
        return {
          stdout: "",
          stderr: "",
          code: null,
          timedOut,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        };
      }),
  });

interface Fixture {
  /** Projects in creation order: id and workspace root. */
  readonly projects: ReadonlyArray<readonly [string, string]>;
  /** What the resolver answers per workspace root; a missing root answers null. */
  readonly identities: ReadonlyMap<string, RepositoryIdentity>;
  readonly scratch?: string;
  readonly deleted?: ReadonlyArray<string>;
  /** The git the reader runs for a checkout with no `.dw/config.yml` on disk; the real one by default. */
  readonly runner?: Layer.Layer<ProcessRunner.ProcessRunner>;
  /** Where the reader keeps its memory; a fresh directory by default. Pass one to read it twice. */
  readonly factoryDir?: string;
  /** Read as the settings page does, writing nothing; by default the pass's read, which remembers. */
  readonly readOnly?: boolean;
}

const pathsAt = (factoryDir: string) =>
  Layer.succeed(FactoryPaths, {
    baseDir: factoryDir,
    worktreesDir: NodePath.join(factoryDir, "worktrees"),
    factoryDir,
    machineConfigPath: NodePath.join(factoryDir, "config.yml"),
  });

const listed = (fixture: Fixture) => {
  const layerProjects = ProjectStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory));
  const layer = Layer.effect(WatchedRepos.FactoryWatchedRepos, WatchedRepos.make).pipe(
    Layer.provide(fixture.runner ?? ProcessRunner.layer),
    Layer.provide(pathsAt(fixture.factoryDir ?? tempDir("factory"))),
    Layer.provideMerge(layerProjects),
    Layer.provide(
      Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
        resolve: (cwd) => Effect.succeed(fixture.identities.get(cwd) ?? null),
      }),
    ),
    Layer.provide(
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/unused",
        scratchRoot: Effect.succeed(Option.fromUndefinedOr(fixture.scratch)),
      }),
    ),
    Layer.provide(NodeServices.layer),
  );
  return Effect.gen(function* () {
    const store = yield* ProjectStore.ProjectStoreV2;
    let sequence = 0;
    for (const [id, root] of fixture.projects) {
      yield* store.apply(projectEvent("project.created", id, root, (sequence += 1)));
    }
    for (const id of fixture.deleted ?? []) {
      yield* store.apply(projectEvent("project.deleted", id, "", (sequence += 1)));
    }
    const watched = yield* WatchedRepos.FactoryWatchedRepos;
    return yield* fixture.readOnly === true ? watched.list : watched.listAndRemember;
  }).pipe(Effect.provide(layer));
};

describe("FactoryWatchedRepos.list", () => {
  it.effect("lists a project whose checkout opts in, with its GitHub repo and title", () =>
    Effect.gen(function* () {
      const root = checkout("widgets", FACTORY_CONFIG);
      const list = yield* listed({
        projects: [["p-widgets", root]],
        identities: new Map([[root, WIDGETS]]),
      });
      assert.deepStrictEqual(list.repos, [
        { repo: "acme/widgets", path: root, title: "Title of p-widgets" },
      ]);
    }),
  );

  it.effect("reports an opted-in checkout T3 could not identify as unresolved, not as absent", () =>
    Effect.gen(function* () {
      const root = checkout("no-identity", FACTORY_CONFIG);
      const list = yield* listed({ projects: [["p-none", root]], identities: new Map() });
      assert.deepStrictEqual(list.repos, []);
      assert.deepStrictEqual(list.unresolved, [root]);
    }),
  );

  it.effect("reports a config file that cannot be read as unresolved", () =>
    Effect.gen(function* () {
      // A directory where the file should be: a read error that is not "not found".
      const root = checkout("unreadable", null);
      NodeFS.mkdirSync(NodePath.join(root, ".dw", "config.yml"), { recursive: true });
      const list = yield* listed({
        projects: [["p-unreadable", root]],
        identities: new Map([[root, WIDGETS]]),
      });
      assert.deepStrictEqual(list.repos, []);
      assert.deepStrictEqual(list.unresolved, [root]);
    }),
  );

  it.effect("leaves a project that is certainly not opted in out of both lists", () =>
    Effect.gen(function* () {
      const bare = checkout("bare", null);
      const noBlock = checkout("no-block-either", "tracker:\n  backend: do-work-io\n");
      const gitlab = checkout("gitlab-either", FACTORY_CONFIG);
      const list = yield* listed({
        projects: [
          ["p-bare", bare],
          ["p-no-block-either", noBlock],
          ["p-gitlab-either", gitlab],
        ],
        identities: new Map<string, RepositoryIdentity>([
          [bare, WIDGETS],
          [noBlock, WIDGETS],
          [gitlab, { ...WIDGETS, provider: SourceControlProviderKind.make("gitlab") }],
        ]),
      });
      assert.deepStrictEqual(list, { repos: [], departed: [], unresolved: [] });
    }),
  );

  it.effect("skips a project whose checkout has no .dw/config.yml", () =>
    Effect.gen(function* () {
      const root = checkout("no-config", null);
      const list = yield* listed({
        projects: [["p-bare", root]],
        identities: new Map([[root, WIDGETS]]),
      });
      assert.deepStrictEqual(list.repos, []);
    }),
  );

  it.effect("skips a project whose .dw/config.yml has no factory block", () =>
    Effect.gen(function* () {
      const root = checkout("no-block", "tracker:\n  backend: do-work-io\n");
      const list = yield* listed({
        projects: [["p-no-block", root]],
        identities: new Map([[root, WIDGETS]]),
      });
      assert.deepStrictEqual(list.repos, []);
    }),
  );

  it.effect("reports a .dw/config.yml that does not parse as unresolved, not as absent", () =>
    Effect.gen(function* () {
      const broken = checkout("broken", "factory: [unclosed\n");
      const conflicted = checkout(
        "conflicted",
        "<<<<<<< HEAD\nfactory: {}\n=======\nfactory: {}\n>>>>>>> main\n",
      );
      const list = yield* listed({
        projects: [
          ["p-broken", broken],
          ["p-conflicted", conflicted],
        ],
        identities: new Map([
          [broken, WIDGETS],
          [conflicted, WIDGETS],
        ]),
      });
      assert.deepStrictEqual(list.repos, []);
      assert.deepStrictEqual(list.unresolved, [broken, conflicted]);
    }),
  );

  it.effect("skips the scratch project even when it holds a config and an identity", () =>
    Effect.gen(function* () {
      const scratch = checkout("scratch", FACTORY_CONFIG);
      const list = yield* listed({
        projects: [["p-scratch", scratch]],
        identities: new Map([[scratch, WIDGETS]]),
        scratch,
      });
      assert.deepStrictEqual(list.repos, []);
    }),
  );

  it.effect("skips a project whose repository is not on GitHub", () =>
    Effect.gen(function* () {
      const root = checkout("gitlab", FACTORY_CONFIG);
      const gitlab: RepositoryIdentity = {
        canonicalKey: "gitlab.com/acme/widgets",
        locator: {
          source: "git-remote",
          remoteName: "origin",
          remoteUrl: "https://gitlab.com/acme/widgets.git",
        },
        provider: SourceControlProviderKind.make("gitlab"),
        owner: "acme",
        name: "widgets",
      };
      const list = yield* listed({
        projects: [["p-gitlab", root]],
        identities: new Map([[root, gitlab]]),
      });
      assert.deepStrictEqual(list.repos, []);
    }),
  );

  it.effect("skips a clone T3 names by its upstream remote, and does not call it unresolved", () =>
    Effect.gen(function* () {
      const root = checkout("fork", FACTORY_CONFIG);
      // T3 prefers `upstream` over `origin`, so the identity is the parent's, not the fork's.
      const fork: RepositoryIdentity = {
        ...WIDGETS,
        locator: { ...WIDGETS.locator, remoteName: "upstream" },
        origin: { canonicalKey: "github.com/me/widgets", displayName: "me/widgets" },
      };
      const list = yield* listed({
        projects: [["p-fork", root]],
        identities: new Map([[root, fork]]),
      });
      assert.deepStrictEqual(list, { repos: [], departed: [], unresolved: [] });
    }),
  );

  it.effect("reports a GitHub identity that lacks an owner or a name as unresolved", () =>
    Effect.gen(function* () {
      const root = checkout("half", FACTORY_CONFIG);
      const { owner: _owner, ...noOwner } = WIDGETS;
      const list = yield* listed({
        projects: [["p-half", root]],
        identities: new Map([[root, noOwner]]),
      });
      assert.deepStrictEqual(list, { repos: [], departed: [], unresolved: [root] });
    }),
  );

  it.effect("lists two projects at different roots, in creation order", () =>
    Effect.gen(function* () {
      const first = checkout("first", FACTORY_CONFIG);
      const second = checkout("second", FACTORY_CONFIG);
      const list = yield* listed({
        projects: [
          ["p-first", first],
          ["p-second", second],
        ],
        identities: new Map([
          [first, WIDGETS],
          [second, GADGETS],
        ]),
      });
      assert.deepStrictEqual(list.repos, [
        { repo: "acme/widgets", path: first, title: "Title of p-first" },
        { repo: "acme/gadgets", path: second, title: "Title of p-second" },
      ]);
    }),
  );

  it.effect("lists two projects that resolve to one repo, once each: the pass decides", () =>
    Effect.gen(function* () {
      const mine = checkout("mine", FACTORY_CONFIG);
      const clone = checkout("clone", FACTORY_CONFIG);
      const list = yield* listed({
        projects: [
          ["p-1-mine", mine],
          ["p-2-clone", clone],
        ],
        identities: new Map([
          [mine, WIDGETS],
          [clone, WIDGETS],
        ]),
      });
      assert.deepStrictEqual(list.repos, [
        { repo: "acme/widgets", path: mine, title: "Title of p-1-mine" },
        { repo: "acme/widgets", path: clone, title: "Title of p-2-clone" },
      ]);
    }),
  );

  it.effect("leaves out a deleted project and keeps the rest", () =>
    Effect.gen(function* () {
      const gone = checkout("gone", FACTORY_CONFIG);
      const kept = checkout("kept", FACTORY_CONFIG);
      const list = yield* listed({
        projects: [
          ["p-gone", gone],
          ["p-kept", kept],
        ],
        identities: new Map([
          [gone, WIDGETS],
          [kept, GADGETS],
        ]),
        deleted: ["p-gone"],
      });
      assert.deepStrictEqual(list.repos, [
        { repo: "acme/gadgets", path: kept, title: "Title of p-kept" },
      ]);
    }),
  );

  it.effect(
    "does not ask for the identity of a checkout that did not opt in, nor run git where there is no .git",
    () =>
      Effect.gen(function* () {
        const root = checkout("unopted", null);
        const asked: Array<string> = [];
        const spawned: Array<string> = [];
        const layer = Layer.effect(WatchedRepos.FactoryWatchedRepos, WatchedRepos.make).pipe(
          Layer.provide(runnerAnswering(spawned)),
          Layer.provide(pathsAt(tempDir("factory"))),
          Layer.provideMerge(ProjectStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
          Layer.provide(
            Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
              resolve: (cwd) => Effect.sync(() => void asked.push(cwd)).pipe(Effect.as(WIDGETS)),
            }),
          ),
          Layer.provide(
            Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
              namedProjectsRoot: "/unused",
              scratchRoot: Effect.succeedNone,
            }),
          ),
          Layer.provide(NodeServices.layer),
        );
        const list = yield* Effect.gen(function* () {
          const store = yield* ProjectStore.ProjectStoreV2;
          yield* store.apply(projectEvent("project.created", "p-unopted", root, 1));
          const watched = yield* WatchedRepos.FactoryWatchedRepos;
          return yield* watched.list;
        }).pipe(Effect.provide(layer));
        assert.deepStrictEqual(list.repos, []);
        assert.deepStrictEqual(asked, []);
        assert.deepStrictEqual(spawned, []);
      }),
  );

  describe("a checkout whose working tree has no .dw/config.yml", () => {
    it.effect(
      "is watched when origin's default branch holds the opt-in: a branch switch is not a repo leaving",
      () =>
        Effect.gen(function* () {
          const clone = clonedCheckout("switched", FACTORY_CONFIG);
          assert.isFalse(NodeFS.existsSync(NodePath.join(clone, ".dw")));
          const list = yield* listed({
            projects: [["p-switched", clone]],
            identities: new Map([[clone, WIDGETS]]),
          });
          assert.deepStrictEqual(list, {
            repos: [{ repo: "acme/widgets", path: clone, title: "Title of p-switched" }],
            departed: [],
            unresolved: [],
          });
        }),
    );

    it.effect("is not opted in when origin's default branch has no .dw/config.yml either", () =>
      Effect.gen(function* () {
        const clone = clonedCheckout("never", null);
        const list = yield* listed({
          projects: [["p-never", clone]],
          identities: new Map([[clone, WIDGETS]]),
        });
        assert.deepStrictEqual(list, { repos: [], departed: [], unresolved: [] });
      }),
    );

    it.effect("is not opted in when the committed copy has no factory block", () =>
      Effect.gen(function* () {
        const clone = clonedCheckout("plain", "tracker:\n  backend: do-work-io\n");
        const list = yield* listed({
          projects: [["p-plain", clone]],
          identities: new Map([[clone, WIDGETS]]),
        });
        assert.deepStrictEqual(list, { repos: [], departed: [], unresolved: [] });
      }),
    );

    it.effect("is unresolved when git times out reading the committed copy", () =>
      Effect.gen(function* () {
        const root = checkout("slow-git", null);
        NodeFS.mkdirSync(NodePath.join(root, ".git"));
        const calls: Array<string> = [];
        const list = yield* listed({
          projects: [["p-slow", root]],
          identities: new Map([[root, WIDGETS]]),
          runner: runnerAnswering(calls, true),
        });
        assert.deepStrictEqual(list, { repos: [], departed: [], unresolved: [root] });
        assert.deepStrictEqual(calls, [`git -C ${root} show origin/HEAD:.dw/config.yml`]);
      }),
    );

    it.effect("is unresolved when git cannot run at all", () =>
      Effect.gen(function* () {
        const root = checkout("no-git", null);
        NodeFS.mkdirSync(NodePath.join(root, ".git"));
        const list = yield* listed({
          projects: [["p-no-git", root]],
          identities: new Map([[root, WIDGETS]]),
          runner: Layer.mock(ProcessRunner.ProcessRunner)({
            run: (input) =>
              Effect.fail(
                new ProcessRunner.ProcessSpawnError({
                  command: input.command,
                  argumentCount: input.args.length,
                  cause: new Error("spawn git ENOENT"),
                }),
              ),
          }),
        });
        assert.deepStrictEqual(list, { repos: [], departed: [], unresolved: [root] });
      }),
    );
  });

  describe("the repos that departed", () => {
    const watchedOnce = (name: string) => {
      const root = checkout(name, FACTORY_CONFIG);
      const factoryDir = tempDir(`${name}-factory`);
      const identities = new Map([[root, WIDGETS]]);
      return { root, factoryDir, identities };
    };

    it.effect("names a watched repo once the T3 project it was watched from is deleted", () =>
      Effect.gen(function* () {
        const { root, factoryDir, identities } = watchedOnce("deleted");
        const before = yield* listed({ projects: [["p-w", root]], identities, factoryDir });
        assert.deepStrictEqual(before.departed, []);
        // A later pass, or a restart: the memory is on disk.
        const after = yield* listed({
          projects: [["p-w", root]],
          identities,
          factoryDir,
          deleted: ["p-w"],
        });
        assert.deepStrictEqual(after, { repos: [], departed: ["acme/widgets"], unresolved: [] });
      }),
    );

    it.effect("keeps a repo whose project stays though its checkout no longer opts in", () =>
      Effect.gen(function* () {
        const { root, factoryDir, identities } = watchedOnce("opted-out");
        yield* listed({ projects: [["p-w", root]], identities, factoryDir });
        NodeFS.writeFileSync(NodePath.join(root, ".dw", "config.yml"), "tracker: {}\n");
        const after = yield* listed({ projects: [["p-w", root]], identities, factoryDir });
        assert.deepStrictEqual(after, { repos: [], departed: [], unresolved: [] });
      }),
    );

    it.effect("keeps a repo whose checkout has gone missing, as an unmounted volume's has", () =>
      Effect.gen(function* () {
        const { root, factoryDir, identities } = watchedOnce("unmounted");
        yield* listed({ projects: [["p-w", root]], identities, factoryDir });
        NodeFS.rmSync(root, { recursive: true, force: true });
        const after = yield* listed({ projects: [["p-w", root]], identities, factoryDir });
        assert.deepStrictEqual(after.departed, []);
      }),
    );

    it.effect(
      "follows a repo to the project it is added from next, and departs when that goes",
      () =>
        Effect.gen(function* () {
          const { root, factoryDir, identities } = watchedOnce("moved");
          yield* listed({ projects: [["p-old", root]], identities, factoryDir });
          const both: ReadonlyArray<readonly [string, string]> = [
            ["p-old", root],
            ["p-new", root],
          ];
          const moved = yield* listed({
            projects: both,
            identities,
            factoryDir,
            deleted: ["p-old"],
          });
          assert.deepStrictEqual(moved.departed, []);
          assert.deepStrictEqual(
            moved.repos.map((r) => r.repo),
            ["acme/widgets"],
          );
          const gone = yield* listed({
            projects: both,
            identities,
            factoryDir,
            deleted: ["p-old", "p-new"],
          });
          assert.deepStrictEqual(gone.departed, ["acme/widgets"]);
        }),
    );

    it.effect("leaves a memory it cannot read as it is, so a repo in it still departs later", () =>
      Effect.gen(function* () {
        // Root reads a file whatever its mode.
        if (globalThis.process.getuid?.() === 0) return;
        const a = checkout("memory-a", FACTORY_CONFIG);
        const b = checkout("memory-b", FACTORY_CONFIG);
        const factoryDir = tempDir("memory-factory");
        const identities = new Map([
          [a, WIDGETS],
          [b, GADGETS],
        ]);
        const both: ReadonlyArray<readonly [string, string]> = [
          ["p-a", a],
          ["p-b", b],
        ];
        yield* listed({ projects: [["p-a", a]], identities, factoryDir });
        const file = NodePath.join(factoryDir, WatchedRepos.MEMORY_FILE);
        NodeFS.chmodSync(file, 0o000);
        const unreadable = yield* listed({
          projects: both,
          identities,
          factoryDir,
          deleted: ["p-a"],
        });
        NodeFS.chmodSync(file, 0o600);
        assert.deepStrictEqual(unreadable.departed, []);
        const later = yield* listed({ projects: both, identities, factoryDir, deleted: ["p-a"] });
        assert.deepStrictEqual(later.departed, ["acme/widgets"]);
      }),
    );

    it.effect("keeps a repo two projects watched while one of them is still in T3", () =>
      Effect.gen(function* () {
        const one = checkout("clone-one", FACTORY_CONFIG);
        const two = checkout("clone-two", FACTORY_CONFIG);
        const factoryDir = tempDir("clones-factory");
        const identities = new Map([
          [one, WIDGETS],
          [two, WIDGETS],
        ]);
        const both: ReadonlyArray<readonly [string, string]> = [
          ["p-one", one],
          ["p-two", two],
        ];
        yield* listed({ projects: both, identities, factoryDir });
        // One clone goes to a branch without the opt-in; a pass remembers only the other as watching.
        NodeFS.writeFileSync(NodePath.join(one, ".dw", "config.yml"), "tracker: {}\n");
        yield* listed({ projects: both, identities, factoryDir });
        const twoGone = yield* listed({
          projects: both,
          identities,
          factoryDir,
          deleted: ["p-two"],
        });
        assert.deepStrictEqual(twoGone.departed, []);
        const bothGone = yield* listed({
          projects: both,
          identities,
          factoryDir,
          deleted: ["p-two", "p-one"],
        });
        assert.deepStrictEqual(bothGone.departed, ["acme/widgets"]);
      }),
    );

    it.effect("leaves a memory that does not parse as it is and says nothing departed", () =>
      Effect.gen(function* () {
        const { root, factoryDir, identities } = watchedOnce("garbled-memory");
        const file = NodePath.join(factoryDir, WatchedRepos.MEMORY_FILE);
        NodeFS.writeFileSync(file, '{"repos": {"acme/paused": ["p-paused"]');
        const after = yield* listed({ projects: [["p-w", root]], identities, factoryDir });
        assert.deepStrictEqual(after.departed, []);
        assert.strictEqual(
          NodeFS.readFileSync(file, "utf8"),
          '{"repos": {"acme/paused": ["p-paused"]',
        );
      }),
    );

    it.effect("writes nothing on the settings page's read", () =>
      Effect.gen(function* () {
        const { root, factoryDir, identities } = watchedOnce("read-only");
        const list = yield* listed({
          projects: [["p-w", root]],
          identities,
          factoryDir,
          readOnly: true,
        });
        assert.deepStrictEqual(
          list.repos.map((r) => r.repo),
          ["acme/widgets"],
        );
        assert.isFalse(NodeFS.existsSync(NodePath.join(factoryDir, WatchedRepos.MEMORY_FILE)));
      }),
    );

    it.effect("writes the memory as repos folded to lower case, each with its project ids", () =>
      Effect.gen(function* () {
        const root = checkout("mixed-case", FACTORY_CONFIG);
        const factoryDir = tempDir("mixed-case-factory");
        const identities = new Map([[root, github("Acme", "Widgets")]]);
        const list = yield* listed({ projects: [["p-w", root]], identities, factoryDir });
        assert.deepStrictEqual(
          list.repos.map((r) => r.repo),
          ["Acme/Widgets"],
        );
        const file = NodePath.join(factoryDir, WatchedRepos.MEMORY_FILE);
        // Read back by the next version: the shape on disk is part of the contract.
        assert.strictEqual(
          NodeFS.readFileSync(file, "utf8"),
          '{"repos":{"acme/widgets":["p-w"]}}\n',
        );
        const gone = yield* listed({
          projects: [["p-w", root]],
          identities,
          factoryDir,
          deleted: ["p-w"],
        });
        assert.deepStrictEqual(gone.departed, ["acme/widgets"]);
        assert.strictEqual(NodeFS.readFileSync(file, "utf8"), '{"repos":{"acme/widgets":[]}}\n');
      }),
    );

    it.effect("still lists the watched repos when the memory cannot be written", () =>
      Effect.gen(function* () {
        // Root writes into a directory whatever its mode.
        if (globalThis.process.getuid?.() === 0) return;
        const { root, factoryDir, identities } = watchedOnce("unwritable-memory");
        yield* listed({ projects: [["p-old", root]], identities, factoryDir });
        // The memory reads, but the directory takes no new file, so its next write fails.
        NodeFS.chmodSync(factoryDir, 0o555);
        const both: ReadonlyArray<readonly [string, string]> = [
          ["p-old", root],
          ["p-new", root],
        ];
        const list = yield* listed({ projects: both, identities, factoryDir }).pipe(
          Effect.ensuring(Effect.sync(() => NodeFS.chmodSync(factoryDir, 0o755))),
        );
        assert.deepStrictEqual(
          list.repos.map((r) => r.repo),
          ["acme/widgets", "acme/widgets"],
        );
        assert.deepStrictEqual(list.departed, []);
      }),
    );

    it.effect("never names a repo it did not watch", () =>
      Effect.gen(function* () {
        const root = checkout("personal-project", null);
        const factoryDir = tempDir("personal-factory");
        yield* listed({ projects: [["p-personal", root]], identities: new Map(), factoryDir });
        const after = yield* listed({
          projects: [["p-personal", root]],
          identities: new Map(),
          factoryDir,
          deleted: ["p-personal"],
        });
        assert.deepStrictEqual(after, { repos: [], departed: [], unresolved: [] });
      }),
    );
  });
});
