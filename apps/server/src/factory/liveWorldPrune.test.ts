// @effect-diagnostics nodeBuiltinImport:off - the prune runs in a real repository.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";

import { timeLimitOnlyProjectConfig, type MachineConfig } from "./config.ts";
import { liveWorld } from "./index.ts";
import { useTempDirs } from "./ledger/testSupport.ts";
import type { Repo } from "./pass.ts";
import * as Process from "./process.ts";
import { FactoryProcess, type RunResult } from "./process.ts";
import * as Sessions from "./t3/sessions.ts";

const tempDir = useTempDirs();

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW_MS = Date.UTC(2026, 9, 28, 12);
const REPO = "rawphp/softfac";

const git = (cwd: string, args: ReadonlyArray<string>, committedMs = NOW_MS): string => {
  const date = `@${Math.floor(committedMs / 1000)} +0000`;
  const result = NodeChildProcess.spawnSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    {
      cwd,
      encoding: "utf8",
      env: { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date },
    },
  );
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
};

const refExists = (cwd: string, ref: string) =>
  NodeChildProcess.spawnSync("git", ["show-ref", "--verify", "--quiet", ref], { cwd }).status === 0;

const machine: MachineConfig = {
  ghConfigDir: "/gh/rawphp",
  pollSeconds: 60,
  maxConcurrentRuns: 1,
  maxConcurrentGates: 1,
  feedbackSeconds: 600,
  notify: true,
  minFreeGib: 0,
  maxLoadPerCore: 0,
  deployWaitMinutes: 120,
  modelFallbacks: {},
  pruneBranchesAfterDays: 14,
  pruneBranchesDryRun: false,
};

const stubSessions = Sessions.FactorySessions.of({
  findProject: () => Effect.succeed(null),
  launch: () => Effect.die("not launched"),
  status: () => Effect.die("no status"),
  thread: () => Effect.die("no thread"),
  send: () => Effect.die("not sent"),
  archive: () => Effect.die("not archived"),
  removeWorktree: () => Effect.die("not removed"),
  worktreeCheckout: () => Effect.die("no worktree head"),
  brokenWorktrees: Effect.succeed([]),
  runningThreads: Effect.succeed(0),
  liveBranches: Effect.succeed(new Set()),
  lastActivity: () => Effect.succeed(null),
  worktreesDirectory: (defaultDir) => Effect.succeed(defaultDir),
});

const answer = (stdout: string | null, stderr = ""): RunResult => ({
  exitCode: stdout === null ? 1 : 0,
  timedOut: false,
  tail: stdout ?? "",
  stderrTail: stderr,
  truncated: false,
});

describe("liveWorld.pruneBranches", () => {
  it.effect("prunes the watched checkout against the project's base, the age and GitHub", () =>
    Effect.gen(function* () {
      const root = tempDir("prune-world");
      const dataDir = tempDir("prune-data");
      const origin = NodePath.join(root, "origin.git");
      const work = NodePath.join(root, "work");
      NodeFS.mkdirSync(work);
      // The project's base is `develop`; there is no `main` to fall back on.
      git(root, ["init", "-q", "--bare", "-b", "develop", origin]);
      git(work, ["init", "-q", "-b", "develop"]);
      git(work, ["remote", "add", "origin", origin]);
      git(work, ["commit", "-q", "--allow-empty", "-m", "initial"], NOW_MS - 30 * DAY_MS);
      git(work, ["push", "-q", "origin", "develop"]);
      const unmerged = (name: string, committedMs: number) => {
        git(work, ["switch", "-q", "-c", name, "develop"]);
        git(work, ["commit", "-q", "--allow-empty", "-m", name], committedMs);
        git(work, ["switch", "-q", "develop"]);
      };
      unmerged("t3/old", NOW_MS - 15 * DAY_MS);
      unmerged("t3/young", NOW_MS - 13 * DAY_MS);
      for (const name of ["t3/gone", "t3/refused"]) {
        unmerged(name, NOW_MS);
        git(work, ["push", "-q", "origin", name]);
        git(work, ["branch", "-q", "-D", name]);
      }
      git(work, ["fetch", "-q", "origin"]);
      const tips = Object.fromEntries(
        ["t3/gone", "t3/refused"].map((name) => [
          name,
          git(work, ["rev-parse", `origin/${name}`]).trim(),
        ]),
      );

      const gh: Array<ReadonlyArray<string>> = [];
      const real = yield* Effect.provide(Effect.service(FactoryProcess), Process.layer);
      const factoryProcess = FactoryProcess.of({
        run: (input) => {
          if (input.command !== "gh") return real.run(input);
          const args = input.args ?? [];
          gh.push(args);
          if (args[1] === "graphql") {
            const heads = args.filter((arg) => /^h\d+=/.test(arg)).map((arg) => arg.split("=")[1]!);
            const repository = Object.fromEntries(
              heads.flatMap((head, i) => [
                [`o${i}`, { totalCount: 0 }],
                [`b${i}`, { totalCount: 0 }],
                [
                  `e${i}`,
                  {
                    nodes:
                      tips[head] === undefined
                        ? []
                        : [{ state: "CLOSED", headRefOid: tips[head], isCrossRepository: false }],
                  },
                ],
              ]),
            );
            return Effect.succeed(answer(JSON.stringify({ data: { repository } })));
          }
          if (args[1] === `repos/${REPO}/git/ref/heads/t3/gone`) {
            return Effect.succeed(answer(null, "gh: Not Found (HTTP 404)"));
          }
          return Effect.succeed(
            answer(null, "gh: Resource not accessible by integration (HTTP 403)"),
          );
        },
      });

      const world = liveWorld(
        machine,
        dataDir,
        factoryProcess,
        NodeServices.layer,
        stubSessions,
        () => NOW_MS,
        "mac-mini",
        { list: () => Effect.succeed([]), raise: () => Effect.void, clear: () => Effect.void },
        {
          gate: { run: () => Effect.die("no gate") },
          wake: Effect.void,
          scope: yield* Scope.make(),
        },
      );
      const repo: Repo = {
        watched: { repo: REPO, path: work },
        project: { ...timeLimitOnlyProjectConfig(), base: "develop" },
        trackerUser: "rawphp",
      };
      const report = yield* world.pruneBranches(repo);

      assert.deepStrictEqual(
        report.pruned.map((p) => [p.ref, p.reason]),
        [
          ["refs/heads/t3/old", "stale"],
          ["refs/remotes/origin/t3/gone", "pr-closed"],
        ],
      );
      assert.isTrue(refExists(work, "refs/heads/t3/young"));
      // A branch GitHub no longer has loses only its tracking ref; any other failure keeps it.
      assert.isFalse(gh.some((args) => args.includes("DELETE")));
      assert.isTrue(refExists(work, "refs/remotes/origin/t3/refused"));
      assert.deepStrictEqual(
        report.failed.map((f) => [f.ref, f.kind]),
        [["refs/remotes/origin/t3/refused", "github"]],
      );
      const logged = NodeFS.readFileSync(NodePath.join(dataDir, "branch-prune.jsonl"), "utf8")
        .trimEnd()
        .split("\n")
        .map((line) => (JSON.parse(line) as { ref: string }).ref);
      assert.deepStrictEqual(logged, ["refs/heads/t3/old", "refs/remotes/origin/t3/gone"]);
    }),
  );
});
