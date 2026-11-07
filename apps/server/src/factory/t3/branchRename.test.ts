// @effect-diagnostics nodeBuiltinImport:off - the tests rename branches in real repositories.
import * as NodeChildProcess from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../../config.ts";
import { makeGitVcsDriverCore } from "../../vcs/GitVcsDriverCore.ts";
import { useTempDirs } from "../ledger/testSupport.ts";

const tempDir = useTempDirs();

/** Runs the real `git` in `cwd` for a test and returns what it printed. */
const git = (cwd: string, args: ReadonlyArray<string>, input?: string): string => {
  const result = NodeChildProcess.spawnSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8", ...(input === undefined ? {} : { input }) },
  );
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
};

/** A repository checked out on `main`, with a branch for every name in `taken`. */
const repoWithBranches = (taken: ReadonlyArray<string>): string => {
  const cwd = tempDir("branch-rename");
  git(cwd, ["init", "-q", "-b", "main"]);
  git(cwd, ["commit", "-q", "--allow-empty", "-m", "initial"]);
  const head = git(cwd, ["rev-parse", "HEAD"]).trim();
  git(
    cwd,
    ["update-ref", "--stdin"],
    taken.map((name) => `create refs/heads/${name} ${head}\n`).join(""),
  );
  return cwd;
};

const numbered = (name: string, last: number) =>
  Array.from({ length: last }, (_, index) => `${name}-${index + 1}`);

/** Random bytes that count up, so the n-th random suffix is n as eight hex digits. */
const countingCrypto = () => {
  let draws = 0;
  return SecureRandom.make((size) => {
    draws += 1;
    const bytes = new Uint8Array(size);
    bytes[size - 1] = draws;
    return bytes;
  });
};

/** Renames `main` the way a thread's worktree branch is renamed, and returns the name it got. */
const renameMainTo = (cwd: string, newBranch: string) =>
  makeGitVcsDriverCore().pipe(
    Effect.flatMap((driver) => driver.renameBranch({ cwd, oldBranch: "main", newBranch })),
    Effect.map((renamed) => renamed.branch),
    Effect.provide(
      Layer.mergeAll(
        NodeCrypto.layerDigest,
        Layer.succeed(SecureRandom.SecureRandom, countingCrypto()),
        ServerConfig.layerTest(cwd, tempDir("server-config")),
      ),
    ),
    Effect.scoped,
    Effect.provide(NodeServices.layer),
  );

describe("worktree branch rename", () => {
  it.effect("keeps a free name as it is", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* renameMainTo(repoWithBranches([]), "t3/feature"), "t3/feature");
    }),
  );

  it.effect("takes the first free numeric suffix, up to -100", () =>
    Effect.gen(function* () {
      const gap = repoWithBranches(["t3/taken", "t3/taken-2"]);
      assert.strictEqual(yield* renameMainTo(gap, "t3/taken"), "t3/taken-1");
      const last = repoWithBranches(["t3/taken", ...numbered("t3/taken", 99)]);
      assert.strictEqual(yield* renameMainTo(last, "t3/taken"), "t3/taken-100");
    }),
  );

  it.effect("takes a free random suffix once the name and -1 to -100 are taken", () =>
    Effect.gen(function* () {
      const cwd = repoWithBranches([
        "t3/placeholder",
        ...numbered("t3/placeholder", 100),
        "t3/placeholder-00000001",
      ]);
      const renamed = yield* renameMainTo(cwd, "t3/placeholder");
      assert.strictEqual(renamed, "t3/placeholder-00000002");
      assert.strictEqual(git(cwd, ["branch", "--show-current"]).trim(), renamed);
    }),
  );
});
