// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

const realScript = NodePath.resolve(import.meta.dirname, "../../../../factory/scripts/sync.sh");

const OLD = "v0.0.9-nightly.20261013.1";
const MIDDLE = "v0.0.10-nightly.20261014.2950";
const NEWEST = "v0.0.10-nightly.20261015.3145";
const ROUTE_TREE = "apps/web/src/routeTree.gen.ts";

// Each stub appends its invocation to $SYNC_TEST_LOG (plus .env, .repo and .main siblings for
// GH_TOKEN, GH_REPO and origin's main). `gh` answers the reads sync.sh makes from SYNC_TEST_*
// variables, `vp`, the generator and `check.sh` fail on request, and `check.sh` can push
// $SYNC_TEST_MOVE_MAIN's HEAD to origin's main as if another pull request landed.
const ghStub = `#!/usr/bin/env bash
echo "gh $*" >> "$SYNC_TEST_LOG"
echo "gh \${GH_TOKEN-unset}" >> "$SYNC_TEST_LOG.env"
echo "\${GH_REPO-unset}" >> "$SYNC_TEST_LOG.repo"
for ((i = 1; i <= $#; i++)); do
  j=$((i + 1))
  [[ \${!i} == --body-file ]] && cp "\${!j}" "$SYNC_TEST_LOG.body"
done
case "$1 $2" in
  "pr create") echo "https://example.test/pr/1" ;;
  "pr list") echo "\${SYNC_TEST_PR_URL:-}" ;;
  "issue list")
    node -e '
      for (const issue of JSON.parse(process.env.SYNC_TEST_ISSUES || "[]")) {
        console.log(issue.number + "\\t" + issue.title + "\\t" + (issue.labels || []).join(","));
      }
    '
    ;;
  "workflow run")
    git ls-remote origin refs/heads/main | cut -f 1 >> "$SYNC_TEST_LOG.main"
    [[ $3 != "\${SYNC_TEST_DISPATCH_FAIL:-}" ]] || exit 1
    ;;
esac
exit 0
`;

const vpStub = `#!/usr/bin/env bash
echo "vp $*" >> "$SYNC_TEST_LOG"
echo "vp \${GH_TOKEN-unset}" >> "$SYNC_TEST_LOG.env"
if [[ -n \${SYNC_TEST_VP_FAIL:-} ]]; then
  echo "$SYNC_TEST_VP_FAIL"
  exit 3
fi
exit 0
`;

const checkStub = `#!/usr/bin/env bash
echo "check.sh" >> "$SYNC_TEST_LOG"
echo "check.sh \${GH_TOKEN-unset}" >> "$SYNC_TEST_LOG.env"
if [[ -n \${SYNC_TEST_MOVE_MAIN:-} ]]; then
  git -C "$SYNC_TEST_MOVE_MAIN" push -q origin HEAD:main
fi
if [[ -n \${SYNC_TEST_CHECK_OUTPUT:-} ]]; then
  cat "$SYNC_TEST_CHECK_OUTPUT"
  exit 1
fi
echo "check: factory/scripts/check-seams.sh"
exit 0
`;

const regenerateStub = `#!/usr/bin/env bash
echo "regenerate-routes.sh" >> "$SYNC_TEST_LOG"
echo "regenerate-routes.sh \${GH_TOKEN-unset}" >> "$SYNC_TEST_LOG.env"
if [[ -n \${SYNC_TEST_REGENERATE_FAIL:-} ]]; then
  echo "$SYNC_TEST_REGENERATE_FAIL"
  exit 4
fi
echo "regenerated route tree" > "$(git rev-parse --show-toplevel)/${ROUTE_TREE}"
`;

// Runs the real git, and for every `git push` appends to $SYNC_TEST_LOG.push the
// password the last `-c credential.helper=!...` would hand git, run as git
// runs it, or "git's own" when the push brings no helper of its own.
const gitStub = (realGit: string) => `#!/usr/bin/env bash
helper= pushing=
for ((i = 1; i <= $#; i++)); do
  j=$((i + 1))
  [[ \${!i} == push ]] && pushing=1
  [[ \${!i} == -c && \${!j:-} == credential.helper=* ]] && helper=\${!j#credential.helper=}
done
if [[ -n $pushing ]]; then
  if [[ $helper == '!'* ]]; then
    sh -c "\${helper#!} get" | sed -n 's/^password=//p' >> "$SYNC_TEST_LOG.push"
  else
    echo "git's own" >> "$SYNC_TEST_LOG.push"
  fi
fi
exec ${realGit} "$@"
`;

let dir: string;
let upstream: string;
let fork: string;
let origin: string;
let oldSha: string;
let newestSha: string;

const git = (cwd: string, ...args: Array<string>) => {
  const result = NodeChildProcess.spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

const write = (cwd: string, file: string, content: string, mode = 0o644) => {
  const full = NodePath.join(cwd, file);
  NodeFS.mkdirSync(NodePath.dirname(full), { recursive: true });
  NodeFS.writeFileSync(full, content, { mode });
};

const commit = (cwd: string, message: string) => {
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
};

const initRepo = (cwd: string) => {
  git(cwd, "init", "-q", "-b", "main");
  git(cwd, "config", "user.name", "Test");
  git(cwd, "config", "user.email", "test@example.com");
  git(cwd, "config", "commit.gpgsign", "false");
};

let runs = 0;

// The fork's origin as gh sees it; git rewrites it to the local bare repo.
const ORIGIN_URL = "https://github.com/acme/fork.git";

// A fresh fork for every test: upstream at OLD plus the factory files, with a
// bare `origin` holding the same main. `upstreamLine` goes into factory/UPSTREAM.
const makeFork = (upstreamLine: string, forkChanges: Record<string, string> = {}) => {
  NodeFS.rmSync(fork, { recursive: true, force: true });
  NodeFS.rmSync(origin, { recursive: true, force: true });
  git(dir, "clone", "-q", "--no-tags", upstream, fork);
  git(fork, "checkout", "-q", oldSha);
  git(fork, "checkout", "-q", "-B", "main");
  git(fork, "config", "user.name", "Test");
  git(fork, "config", "user.email", "test@example.com");
  git(fork, "config", "commit.gpgsign", "false");
  write(fork, "factory/UPSTREAM", `${upstreamLine}\n`);
  write(fork, "factory/scripts/sync.sh", NodeFS.readFileSync(realScript, "utf8"), 0o755);
  write(fork, "factory/scripts/check.sh", checkStub, 0o755);
  write(fork, "factory/scripts/regenerate-routes.sh", regenerateStub, 0o755);
  for (const [file, content] of Object.entries(forkChanges)) write(fork, file, content);
  commit(fork, "factory files");
  git(dir, "init", "-q", "--bare", "-b", "main", origin);
  git(fork, "remote", "set-url", "origin", ORIGIN_URL);
  git(fork, "config", `url.${origin}.insteadOf`, ORIGIN_URL);
  git(fork, "push", "-q", "-u", "origin", "main");
};

// The environment both phases share; prepare gets no token, as in the workflow.
// GITHUB_ACTIONS is empty unless a test sets it, since the suite itself runs
// under Factory CI, where it is set.
const phaseEnv = (log: string, env: Record<string, string>, token: boolean) => {
  const {
    GH_TOKEN: _ghToken,
    GITHUB_TOKEN: _githubToken,
    SYNC_APP_CONFIGURED: _syncAppConfigured,
    SYNC_APP_TOKEN: _syncAppToken,
    SYNC_TOKEN: _syncToken,
    ...rest
  } = process.env;
  return {
    ...rest,
    PATH: `${NodePath.join(dir, "bin")}:${process.env.PATH}`,
    SYNC_UPSTREAM: upstream,
    SYNC_TEST_LOG: log,
    GITHUB_ACTIONS: "",
    ...(token ? { GH_TOKEN: "secret" } : {}),
    ...env,
  };
};

const readLines = (file: string) =>
  NodeFS.existsSync(file) ? NodeFS.readFileSync(file, "utf8").trim().split("\n") : [];

const prepareIn = (out: string, log: string, env: Record<string, string> = {}) =>
  NodeChildProcess.spawnSync("bash", ["factory/scripts/sync.sh", "prepare", out], {
    cwd: fork,
    encoding: "utf8",
    env: phaseEnv(log, env, false),
  });

// publish runs in a fresh clone of origin's main, like the workflow's second
// job, with only the prepared directory carried over.
const publishFrom = (
  out: string,
  log: string,
  env: Record<string, string> = {},
  originUrl = ORIGIN_URL,
) => {
  const clone = NodePath.join(dir, `publish-${runs}`);
  git(dir, "clone", "-q", origin, clone);
  git(clone, "remote", "set-url", "origin", originUrl);
  git(clone, "config", `url.${origin}.insteadOf`, ORIGIN_URL);
  return NodeChildProcess.spawnSync("bash", ["factory/scripts/sync.sh", "publish", out], {
    cwd: clone,
    encoding: "utf8",
    env: phaseEnv(log, env, true),
  });
};

const results = (log: string, prepared: number) => {
  const calls = readLines(log);
  return {
    calls,
    prepareCalls: calls.slice(0, prepared),
    publishCalls: calls.slice(prepared),
    tokens: readLines(`${log}.env`),
    repos: readLines(`${log}.repo`),
    dispatchedOn: readLines(`${log}.main`),
    pushes: readLines(`${log}.push`),
    body: NodeFS.existsSync(`${log}.body`) ? NodeFS.readFileSync(`${log}.body`, "utf8") : "",
  };
};

// Both phases in turn, publish only when prepare succeeds, as the workflow runs them.
const run = (env: Record<string, string> = {}, originUrl = ORIGIN_URL) => {
  const log = NodePath.join(dir, `log-${runs++}`);
  const out = NodePath.join(dir, `out-${runs}`);
  const prepared = prepareIn(out, log, env);
  const preparedCalls = readLines(log).length;
  const published = prepared.status === 0 ? publishFrom(out, log, env, originUrl) : undefined;
  return {
    status: published ? published.status : prepared.status,
    stdout: prepared.stdout + (published?.stdout ?? ""),
    stderr: prepared.stderr + (published?.stderr ?? ""),
    ...results(log, preparedCalls),
  };
};

const originBranches = () =>
  git(origin, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n");

const originFile = (ref: string, file: string) => git(origin, "show", `${ref}:${file}`);

describe("sync.sh", () => {
  beforeAll(() => {
    dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sync-"));
    upstream = NodePath.join(dir, "upstream");
    fork = NodePath.join(dir, "fork");
    origin = NodePath.join(dir, "origin.git");
    write(dir, "bin/gh", ghStub, 0o755);
    write(dir, "bin/vp", vpStub, 0o755);
    const realGit = NodeChildProcess.execFileSync("sh", ["-c", "command -v git"], {
      encoding: "utf8",
    }).trim();
    write(dir, "bin/git", gitStub(realGit), 0o755);

    // Three nightly tags whose version order differs from their lexical order,
    // plus release tags the pattern must skip, one of them newer than every nightly.
    NodeFS.mkdirSync(upstream);
    initRepo(upstream);
    write(upstream, "README.md", "upstream\n");
    write(upstream, ROUTE_TREE, "routes v9\n");
    write(upstream, "apps/server/src/server.ts", "server v9\n");
    write(upstream, "docs/old.md", "removed in v10\n");
    oldSha = commit(upstream, "v9");
    git(upstream, "tag", OLD);
    write(upstream, "README.md", "upstream, later\n");
    write(upstream, ROUTE_TREE, "routes v10\n");
    NodeFS.rmSync(NodePath.join(upstream, "docs/old.md"));
    commit(upstream, "v10 middle");
    git(upstream, "tag", MIDDLE);
    write(upstream, "apps/server/src/server.ts", "server v10\n");
    newestSha = commit(upstream, "v10 newest");
    git(upstream, "tag", "-a", "-m", NEWEST, NEWEST);
    git(upstream, "tag", "v0.0.10");
    git(upstream, "tag", "v0.0.11");
  });

  afterAll(() => {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  });

  it("picks the newest nightly tag by version order and stops when UPSTREAM names it", () => {
    makeFork(`${NEWEST} ${newestSha}`);
    const { status, stdout, calls } = run();
    expect(status).toBe(0);
    expect(stdout).toContain(`newest nightly: ${NEWEST}`);
    expect(stdout.trim().split("\n").at(-1)).toBe("up to date");
    expect(calls).toEqual([]);
    expect(originBranches()).toEqual(["main"]);
  });

  it("reads UPSTREAM from origin's main, not from the checkout", () => {
    makeFork(`${OLD} ${oldSha}`);
    git(fork, "checkout", "-q", "-b", "stale");
    write(fork, "factory/UPSTREAM", `${NEWEST} ${newestSha}\n`);
    commit(fork, "checkout names the newest tag");
    const { status, stdout } = run();
    expect(status).toBe(0);
    expect(stdout).not.toContain("up to date");
    expect(originFile(`sync/${NEWEST}`, "factory/UPSTREAM")).toBe(`${NEWEST} ${newestSha}`);
    expect(git(origin, "rev-parse", "main")).toBe(git(origin, "rev-parse", `sync/${NEWEST}`));
  });

  it("is up to date when origin's main names the tag, whatever the checkout says", () => {
    makeFork(`${NEWEST} ${newestSha}`);
    git(fork, "checkout", "-q", "-b", "stale");
    write(fork, "factory/UPSTREAM", `${OLD} ${oldSha}\n`);
    commit(fork, "checkout names an older tag");
    const { status, stdout, calls } = run();
    expect(status).toBe(0);
    expect(stdout.trim().split("\n").at(-1)).toBe("up to date");
    expect(calls).toEqual([]);
    expect(originBranches()).toEqual(["main"]);
  });

  it("merges the newest tag, records it, runs the checks and lands the pull request", () => {
    makeFork(`${OLD} ${oldSha}`);
    const { status, stdout, calls, prepareCalls, publishCalls, tokens, repos } = run();
    expect(status).toBe(0);
    expect(stdout).toContain(`newest nightly: ${NEWEST}`);
    // Upstream's code runs only in prepare, and gh only in publish.
    expect(prepareCalls).toEqual(["vp i", "check.sh"]);
    expect(publishCalls.every((call) => call.startsWith("gh "))).toBe(true);
    expect(stdout.trim().split("\n").at(-1)).toBe(
      `sync: ${NEWEST} merged into main through https://example.test/pr/1`,
    );
    expect(calls.slice(0, 2)).toEqual(["vp i", "check.sh"]);
    expect(tokens).toEqual(["vp unset", "check.sh unset", "gh secret"]);
    expect(repos).toEqual(["acme/fork"]);
    expect(calls.slice(2)).toEqual([
      expect.stringMatching(
        new RegExp(
          `^gh pr create --base main --head sync/${NEWEST} --title sync: ${NEWEST} --body-file `,
        ),
      ),
    ]);
    const branch = `sync/${NEWEST}`;
    expect(originBranches()).toEqual(["main", branch]);
    // main is the checked merge commit itself, not a new merge of it.
    expect(git(origin, "rev-parse", "main")).toBe(git(origin, "rev-parse", branch));
    expect(originFile(branch, "factory/UPSTREAM")).toBe(`${NEWEST} ${newestSha}`);
    expect(originFile(branch, "apps/server/src/server.ts")).toBe("server v10");
    expect(originFile(branch, "factory/scripts/check.sh")).toBe(checkStub.trim());
    expect(git(origin, "rev-list", "--count", `${branch}^1..${branch}`)).toBe("3");
    expect(git(origin, "log", "-1", "--format=%P", branch).split(" ")).toHaveLength(2);
  });

  it("dispatches Factory CI and desktop on the landed commit inside the workflow", () => {
    makeFork(`${OLD} ${oldSha}`);
    const { status, stdout, calls, dispatchedOn } = run({ GITHUB_ACTIONS: "true" });
    expect(status).toBe(0);
    expect(stdout.trim().split("\n").at(-1)).toBe(
      `sync: ${NEWEST} merged into main through https://example.test/pr/1; dispatched factory-ci.yml, factory-desktop.yml`,
    );
    // Each dispatch sees main already landed on the sync merge.
    const landed = git(origin, "rev-parse", `sync/${NEWEST}`);
    expect(dispatchedOn).toEqual([landed, landed]);
    expect(calls.slice(2)).toEqual([
      expect.stringMatching(/^gh pr create /),
      "gh workflow run factory-ci.yml --ref main",
      "gh workflow run factory-desktop.yml --ref main",
    ]);
    expect(git(origin, "rev-parse", "main")).toBe(git(origin, "rev-parse", `sync/${NEWEST}`));
  });

  it("pushes with git's own credentials when no sync secret is set", () => {
    makeFork(`${OLD} ${oldSha}`);
    const { status, pushes } = run({ GITHUB_ACTIONS: "true" });
    expect(status).toBe(0);
    expect(pushes).toEqual(["git's own", "git's own"]);
  });

  it.each([
    { secret: "SYNC_TOKEN", env: { SYNC_TOKEN: "pat" }, password: "pat" },
    {
      secret: "the App",
      env: { SYNC_APP_CONFIGURED: "true", SYNC_APP_TOKEN: "app", SYNC_TOKEN: "pat" },
      password: "app",
    },
  ])(
    "pushes the branch and the landing with $secret and dispatches nothing, since that push starts them",
    ({ env, password }) => {
      makeFork(`${OLD} ${oldSha}`);
      const { status, stdout, calls, pushes } = run({ GITHUB_ACTIONS: "true", ...env });
      expect(status).toBe(0);
      expect(stdout.trim().split("\n").at(-1)).toBe(
        `sync: ${NEWEST} merged into main through https://example.test/pr/1`,
      );
      expect(pushes).toEqual([password, password]);
      expect(calls).not.toContainEqual(expect.stringMatching(/^gh workflow run/));
      expect(git(origin, "rev-parse", "main")).toBe(git(origin, "rev-parse", `sync/${NEWEST}`));
    },
  );

  it.each([
    { file: "apps/mobile/App.tsx", pushedWith: "GITHUB_TOKEN", env: {} },
    { file: "packages/shared/index.ts", pushedWith: "GITHUB_TOKEN", env: {} },
    // GitHub can skip Factory mobile's paths filter on a push that big.
    { file: "apps/mobile/App.tsx", pushedWith: "SYNC_TOKEN", env: { SYNC_TOKEN: "pat" } },
  ])(
    "also dispatches Factory mobile when the merge touches $file, pushed with $pushedWith",
    ({ file, pushedWith, env }) => {
      const tag = "v0.0.11-nightly.20261016.1";
      git(upstream, "checkout", "-q", "--detach", newestSha);
      write(upstream, file, "changed\n");
      git(upstream, "tag", tag, commit(upstream, `touches ${file}`));
      git(upstream, "checkout", "-q", "main");
      try {
        makeFork(`${OLD} ${oldSha}`);
        const { status, stdout, calls } = run({ GITHUB_ACTIONS: "true", ...env });
        const workflows = [
          ...(pushedWith === "GITHUB_TOKEN" ? ["factory-ci.yml", "factory-desktop.yml"] : []),
          "factory-mobile.yml",
        ];
        expect(status).toBe(0);
        expect(stdout.trim().split("\n").at(-1)).toBe(
          `sync: ${tag} merged into main through https://example.test/pr/1; dispatched ${workflows.join(", ")}`,
        );
        expect(calls.filter((call) => call.startsWith("gh workflow "))).toEqual(
          workflows.map((workflow) => `gh workflow run ${workflow} --ref main`),
        );
      } finally {
        git(upstream, "tag", "-d", tag);
      }
    },
  );

  it("leaves the landing in place and files nothing when a dispatch fails", () => {
    makeFork(`${OLD} ${oldSha}`);
    const { status, stdout, stderr, calls } = run({
      GITHUB_ACTIONS: "true",
      SYNC_TEST_DISPATCH_FAIL: "factory-ci.yml",
    });
    expect(status).toBe(1);
    expect(stderr).toContain(
      `sync: ${NEWEST} merged into main through https://example.test/pr/1; dispatch of factory-ci.yml failed`,
    );
    expect(stderr).not.toContain("dispatch of factory-desktop.yml failed");
    expect(stdout).not.toContain("merged into main");
    // A failed dispatch does not keep the others from being tried.
    expect(calls.filter((call) => call.startsWith("gh workflow "))).toEqual([
      "gh workflow run factory-ci.yml --ref main",
      "gh workflow run factory-desktop.yml --ref main",
    ]);
    expect(calls.some((call) => call.startsWith("gh issue "))).toBe(false);
    expect(git(origin, "rev-parse", "main")).toBe(git(origin, "rev-parse", `sync/${NEWEST}`));
  });

  it("runs both phases from one checkout when given no arguments", () => {
    makeFork(`${OLD} ${oldSha}`);
    const log = NodePath.join(dir, `log-${runs++}`);
    const result = NodeChildProcess.spawnSync("bash", ["factory/scripts/sync.sh"], {
      cwd: fork,
      encoding: "utf8",
      env: phaseEnv(log, {}, true),
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`sync: ${NEWEST} merged into main`);
    expect(git(origin, "rev-parse", "main")).toBe(git(origin, "rev-parse", `sync/${NEWEST}`));
    expect(originFile("main", "factory/UPSTREAM")).toBe(`${NEWEST} ${newestSha}`);
  });

  it("regenerates a conflicting route tree but leaves landing it to a person", () => {
    makeFork(`${OLD} ${oldSha}`, { [ROUTE_TREE]: "routes, fork edit\n" });
    const mainBefore = git(origin, "rev-parse", "main");
    const { status, stderr, calls, tokens, body } = run();
    expect(status).toBe(1);
    expect(calls.slice(0, 3)).toEqual(["vp i", "regenerate-routes.sh", "check.sh"]);
    expect(tokens[1]).toBe("regenerate-routes.sh unset");
    const branch = `sync/${NEWEST}`;
    expect(originFile(branch, ROUTE_TREE)).toBe("regenerated route tree");
    expect(originFile(branch, "factory/UPSTREAM")).toBe(`${NEWEST} ${newestSha}`);
    // The regenerated file is the first job's word, so main does not move.
    expect(git(origin, "rev-parse", "main")).toBe(mainBefore);
    expect(stderr).toContain(
      `sync: ${NEWEST} regenerated ${ROUTE_TREE}; https://example.test/pr/1 waits for a person`,
    );
    expect(calls.slice(3)).toEqual([
      expect.stringMatching(
        new RegExp(
          `^gh pr create --base main --head ${branch} --title sync: ${NEWEST} --body-file `,
        ),
      ),
      expect.stringMatching(/^gh issue list /),
      expect.stringMatching(
        new RegExp(
          `^gh issue create --title Sync to ${NEWEST} needs a route-tree review --body-file `,
        ),
      ),
    ]);
    expect(body).toContain("Pull request: https://example.test/pr/1");
    expect(body).toContain(`\`${ROUTE_TREE}\``);

    // The next run waits on that pull request instead of filing again.
    const second = run({ SYNC_TEST_PR_URL: "https://example.test/pr/1" });
    expect(second.status).toBe(0);
    expect(second.stdout).toContain(`sync: ${NEWEST} waits on https://example.test/pr/1`);
    expect(git(origin, "rev-parse", "main")).toBe(mainBefore);
  });

  it("aborts on any other conflict, pushes nothing and opens an issue naming the paths", () => {
    makeFork(`${OLD} ${oldSha}`, { "README.md": "fork edit\n", [ROUTE_TREE]: "fork edit\n" });
    const { status, calls, body } = run();
    expect(status).toBe(1);
    expect(originBranches()).toEqual(["main"]);
    expect(git(fork, "status", "--porcelain")).toBe("");
    expect(NodeFS.existsSync(NodePath.join(fork, ".git/MERGE_HEAD"))).toBe(false);
    expect(calls.filter((call) => call.startsWith("gh issue list"))).toEqual([
      'gh issue list --state open --search "conflicts" in:title --json number,title,labels --jq .[] | "\\(.number)\\t\\(.title)\\t\\([.labels[].name] | join(","))"',
    ]);
    expect(calls.at(-1)).toMatch(
      new RegExp(`^gh issue create --title Sync to ${NEWEST} conflicts --body-file `),
    );
    expect(calls).not.toContainEqual(expect.stringMatching(/^(vp|check\.sh|gh pr)/));
    expect(body).toContain("- README.md");
    expect(body).not.toContain(`- ${ROUTE_TREE}`);
  });

  it("aborts on a file the fork edited and the tag deleted", () => {
    makeFork(`${OLD} ${oldSha}`, { "docs/old.md": "fork edit\n" });
    const { status, calls, body } = run();
    expect(status).toBe(1);
    expect(originBranches()).toEqual(["main"]);
    expect(git(fork, "status", "--porcelain")).toBe("");
    expect(calls.at(-1)).toMatch(
      new RegExp(`^gh issue create --title Sync to ${NEWEST} conflicts --body-file `),
    );
    expect(body).toContain("- docs/old.md");
  });

  it("comments on the open conflicts issue instead of opening another", () => {
    makeFork(`${OLD} ${oldSha}`, { "README.md": "fork edit\n" });
    const { status, calls, body } = run({
      SYNC_TEST_ISSUES: JSON.stringify([
        { number: 5, title: `Sync to ${NEWEST} conflicts, resolved by hand` },
        { number: 6, title: `Sync to ${NEWEST} fails checks` },
        { number: 7, title: `Sync to ${NEWEST} conflicts` },
      ]),
    });
    expect(status).toBe(1);
    expect(calls.slice(-2)).toEqual([
      `gh issue edit 7 --title Sync to ${NEWEST} conflicts`,
      expect.stringMatching(/^gh issue comment 7 --body-file /),
    ]);
    expect(calls).not.toContainEqual(expect.stringMatching(/^gh issue create/));
    expect(body).toContain("- README.md");
  });

  it("keeps one conflicts issue across tags, retitled to the newest", () => {
    makeFork(`${OLD} ${oldSha}`, { "README.md": "fork edit\n" });
    const { status, calls } = run({
      SYNC_TEST_ISSUES: JSON.stringify([{ number: 3, title: `Sync to ${MIDDLE} conflicts` }]),
    });
    expect(status).toBe(1);
    expect(calls.slice(-2)).toEqual([
      `gh issue edit 3 --title Sync to ${NEWEST} conflicts`,
      expect.stringMatching(/^gh issue comment 3 --body-file /),
    ]);
    expect(calls).not.toContainEqual(expect.stringMatching(/^gh issue create/));
  });

  it("only comments on a conflicts issue the factory is building", () => {
    makeFork(`${OLD} ${oldSha}`, { "README.md": "fork edit\n" });
    const { status, calls } = run({
      SYNC_TEST_ISSUES: JSON.stringify([
        { number: 4, title: `Sync to ${MIDDLE} conflicts`, labels: ["factory:building"] },
      ]),
    });
    expect(status).toBe(1);
    expect(calls.at(-1)).toMatch(/^gh issue comment 4 --body-file /);
    expect(calls).not.toContainEqual(expect.stringMatching(/^gh issue (edit|create)/));
  });

  it("only comments on a conflicts issue the factory is about to claim", () => {
    makeFork(`${OLD} ${oldSha}`, { "README.md": "fork edit\n" });
    const { status, calls } = run({
      SYNC_TEST_ISSUES: JSON.stringify([
        { number: 4, title: `Sync to ${MIDDLE} conflicts`, labels: ["bug", "factory:ready"] },
      ]),
    });
    expect(status).toBe(1);
    expect(calls.at(-1)).toMatch(/^gh issue comment 4 --body-file /);
    expect(calls).not.toContainEqual(expect.stringMatching(/^gh issue (edit|create)/));
  });

  it("still retitles a conflicts issue the factory has not taken", () => {
    makeFork(`${OLD} ${oldSha}`, { "README.md": "fork edit\n" });
    const { status, calls } = run({
      SYNC_TEST_ISSUES: JSON.stringify([
        { number: 4, title: `Sync to ${MIDDLE} conflicts`, labels: ["factory:stuck"] },
      ]),
    });
    expect(status).toBe(1);
    expect(calls.slice(-2)).toEqual([
      `gh issue edit 4 --title Sync to ${NEWEST} conflicts`,
      expect.stringMatching(/^gh issue comment 4 --body-file /),
    ]);
  });

  it("failing checks open a draft pull request and a factory:proposed issue with the failing step", () => {
    makeFork(`${OLD} ${oldSha}`);
    const lines = Array.from({ length: 250 }, (_, i) => `line ${i + 1}`);
    const checkOutput = NodePath.join(dir, "check-output");
    NodeFS.writeFileSync(
      checkOutput,
      [
        "check: factory/scripts/check-seams.sh",
        "seams ok",
        "check: vp test run apps/server/src/factory",
        ...lines,
        "",
      ].join("\n"),
    );
    const { status, calls, body } = run({ SYNC_TEST_CHECK_OUTPUT: checkOutput });
    expect(status).toBe(1);
    expect(originBranches()).toEqual(["main", `sync/${NEWEST}`]);
    expect(calls).toContainEqual(
      expect.stringMatching(
        new RegExp(
          `^gh pr create --draft --base main --head sync/${NEWEST} --title sync: ${NEWEST} --body-file `,
        ),
      ),
    );
    expect(calls).not.toContainEqual(expect.stringMatching(/^gh pr merge/));
    expect(calls.at(-1)).toMatch(
      new RegExp(
        `^gh issue create --title Sync to ${NEWEST} fails checks --label factory:proposed --body-file `,
      ),
    );
    expect(body).toContain("`vp test run apps/server/src/factory`");
    expect(body).toContain("https://example.test/pr/1");
    expect(body).toContain("line 51\n");
    expect(body).toContain("line 250\n");
    expect(body).not.toContain("line 50\n");
    expect(body).not.toContain("seams ok");

    // The next run waits on the draft rather than rebuilding the branch.
    const branchSha = git(origin, "rev-parse", `sync/${NEWEST}`);
    const second = run({ SYNC_TEST_PR_URL: "https://example.test/pr/1" });
    expect(second.status).toBe(0);
    expect(second.stdout).toContain(`sync: ${NEWEST} waits on https://example.test/pr/1`);
    expect(second.calls).toHaveLength(1);
    expect(git(origin, "rev-parse", `sync/${NEWEST}`)).toBe(branchSha);
  });

  it("comments on the open fails-checks issue instead of opening another", () => {
    makeFork(`${OLD} ${oldSha}`);
    const checkOutput = NodePath.join(dir, "check-output-short");
    NodeFS.writeFileSync(checkOutput, "check: vp run --filter t3 typecheck\ntype error\n");
    const { status, calls, body } = run({
      SYNC_TEST_CHECK_OUTPUT: checkOutput,
      SYNC_TEST_ISSUES: JSON.stringify([{ number: 9, title: `Sync to ${MIDDLE} fails checks` }]),
    });
    expect(status).toBe(1);
    expect(calls.slice(-2)).toEqual([
      `gh issue edit 9 --title Sync to ${NEWEST} fails checks`,
      expect.stringMatching(/^gh issue comment 9 --body-file /),
    ]);
    expect(calls).not.toContainEqual(expect.stringMatching(/^gh issue create/));
    expect(body).toContain("`vp run --filter t3 typecheck` failed with exit 1");
    expect(body).toContain("type error\n");
  });

  it("aborts and files the output when vp i fails, pushing nothing", () => {
    makeFork(`${OLD} ${oldSha}`);
    const { status, stderr, calls, body } = run({ SYNC_TEST_VP_FAIL: "lockfile out of date" });
    expect(status).toBe(1);
    expect(stderr).toContain(`sync: vp i failed with exit 3; ${NEWEST} is not synced`);
    expect(originBranches()).toEqual(["main"]);
    expect(git(fork, "status", "--porcelain")).toBe("");
    expect(NodeFS.existsSync(NodePath.join(fork, ".git/MERGE_HEAD"))).toBe(false);
    expect(calls).not.toContainEqual(expect.stringMatching(/^(check\.sh|gh pr)/));
    expect(calls.at(-1)).toMatch(
      new RegExp(
        `^gh issue create --title Sync to ${NEWEST} fails checks --label factory:proposed --body-file `,
      ),
    );
    expect(body).toContain("`vp i` failed with exit 3, so nothing was pushed");
    expect(body).toContain("lockfile out of date\n");
  });

  it("aborts and files the output when the route generator fails, pushing nothing", () => {
    makeFork(`${OLD} ${oldSha}`, { [ROUTE_TREE]: "routes, fork edit\n" });
    const { status, stderr, calls, body } = run({ SYNC_TEST_REGENERATE_FAIL: "generator broke" });
    expect(status).toBe(1);
    expect(stderr).toContain("sync: factory/scripts/regenerate-routes.sh failed with exit 4");
    expect(originBranches()).toEqual(["main"]);
    expect(git(fork, "status", "--porcelain")).toBe("");
    expect(calls).not.toContainEqual(expect.stringMatching(/^(check\.sh|gh pr)/));
    expect(calls.at(-1)).toMatch(
      new RegExp(`^gh issue create --title Sync to ${NEWEST} fails checks `),
    );
    expect(body).toContain("generator broke\n");
  });

  it("leaves a pull request waiting for a person when main moves during the checks", () => {
    makeFork(`${OLD} ${oldSha}`);
    const other = NodePath.join(dir, "other");
    NodeFS.rmSync(other, { recursive: true, force: true });
    git(dir, "clone", "-q", origin, other);
    git(other, "config", "user.name", "Test");
    git(other, "config", "user.email", "test@example.com");
    git(other, "config", "commit.gpgsign", "false");
    write(other, "OTHER.md", "another pull request\n");
    const moved = commit(other, "another pull request");
    const first = run({ SYNC_TEST_MOVE_MAIN: other, GITHUB_ACTIONS: "true" });
    expect(first.status).toBe(1);
    expect(first.stderr).toContain(
      `sync: main could not be fast-forwarded to sync/${NEWEST}; https://example.test/pr/1 waits for a person`,
    );
    expect(git(origin, "rev-parse", "main")).toBe(moved);
    expect(originBranches()).toEqual(["main", `sync/${NEWEST}`]);
    expect(first.calls).not.toContainEqual(expect.stringMatching(/^gh pr merge/));
    expect(first.calls).not.toContainEqual(expect.stringMatching(/^gh workflow /));
    expect(first.calls.at(-1)).toMatch(
      new RegExp(`^gh issue create --title Sync to ${NEWEST} cannot land --body-file `),
    );
    expect(first.body).toContain("moved while the checks ran");
    expect(first.body).toContain("Pull request: https://example.test/pr/1");

    // The next run finds the branch and its open pull request, which the issue
    // already points a person at, and waits without filing again.
    const second = run({ SYNC_TEST_PR_URL: "https://example.test/pr/1" });
    expect(second.status).toBe(0);
    expect(second.stdout).toContain(`sync: ${NEWEST} waits on https://example.test/pr/1`);
    expect(second.calls).toEqual([
      `gh pr list --head sync/${NEWEST} --state open --json url --jq .[0].url // empty`,
    ]);
  });

  it("waits on the open pull request of a sync branch already on origin", () => {
    makeFork(`${OLD} ${oldSha}`);
    git(fork, "push", "-q", "origin", `main:refs/heads/sync/${NEWEST}`);
    const { status, stdout, calls } = run({ SYNC_TEST_PR_URL: "https://example.test/pr/4" });
    expect(status).toBe(0);
    expect(stdout).toContain(`sync: ${NEWEST} waits on https://example.test/pr/4`);
    expect(calls).toEqual([
      `gh pr list --head sync/${NEWEST} --state open --json url --jq .[0].url // empty`,
    ]);
    expect(git(origin, "rev-parse", `sync/${NEWEST}`)).toBe(git(origin, "rev-parse", "main"));
  });

  it("files an issue when a sync branch on origin has no open pull request", () => {
    makeFork(`${OLD} ${oldSha}`);
    git(fork, "push", "-q", "origin", `main:refs/heads/sync/${NEWEST}`);
    const { status, stderr, calls, body } = run();
    expect(status).toBe(1);
    expect(stderr).toContain(`sync: sync/${NEWEST} is on origin with no open pull request`);
    expect(calls).not.toContainEqual(expect.stringMatching(/^(vp|check\.sh|gh pr create)/));
    expect(calls.at(-1)).toMatch(
      new RegExp(`^gh issue create --title Sync to ${NEWEST} is stuck --body-file `),
    );
    expect(body).toContain("Delete the branch to sync the tag again");
    expect(git(origin, "rev-parse", `sync/${NEWEST}`)).toBe(git(origin, "rev-parse", "main"));
  });

  it("refuses an origin that is not on GitHub before calling gh", () => {
    makeFork(`${OLD} ${oldSha}`);
    const { status, stderr, calls } = run({}, origin);
    expect(status).toBe(1);
    expect(stderr).toContain("sync: origin is not a GitHub repository");
    expect(calls).toEqual(["vp i", "check.sh"]);
    expect(originBranches()).toEqual(["main"]);
  });

  it("stops with the merge's own error when the merge fails without a conflict", () => {
    makeFork(`${OLD} ${oldSha}`);
    // An uncommitted edit to a file the tag changes makes git refuse the merge.
    write(fork, "apps/server/src/server.ts", "uncommitted edit\n");
    const { status, stderr, calls } = run();
    expect(status).toBe(1);
    expect(stderr).toContain("sync: git merge");
    expect(stderr).toContain("apps/server/src/server.ts");
    expect(calls).toEqual([]);
    expect(originBranches()).toEqual(["main"]);
  });

  it("stops and files an issue when the branch cannot be pushed", () => {
    makeFork(`${OLD} ${oldSha}`);
    write(origin, "hooks/pre-receive", "#!/usr/bin/env bash\necho 'refusing' >&2\nexit 1\n", 0o755);
    const { status, stderr, calls, body } = run({ GITHUB_ACTIONS: "true" });
    expect(status).toBe(1);
    expect(stderr).toContain(`sync: push of sync/${NEWEST} failed`);
    expect(calls.slice(0, 2)).toEqual(["vp i", "check.sh"]);
    expect(calls).not.toContainEqual(expect.stringMatching(/^gh pr/));
    expect(calls.at(-1)).toMatch(
      new RegExp(`^gh issue create --title Sync to ${NEWEST} cannot be pushed --body-file `),
    );
    expect(body).toContain("refusing");
    expect(body).toContain(".github/workflows/");
    // Pushed with GITHUB_TOKEN, the issue names the secrets that fix it.
    expect(body).toContain("`SYNC_APP_ID` and `SYNC_APP_PRIVATE_KEY`");
    expect(body).toContain("`SYNC_TOKEN`");
    expect(originBranches()).toEqual(["main"]);

    // Nothing reached origin, so the next run tries again and comments on the
    // issue the first one filed.
    const second = run({
      SYNC_TEST_ISSUES: JSON.stringify([
        { number: 8, title: `Sync to ${NEWEST} cannot be pushed` },
      ]),
    });
    expect(second.status).toBe(1);
    expect(second.calls.slice(-2)).toEqual([
      `gh issue edit 8 --title Sync to ${NEWEST} cannot be pushed`,
      expect.stringMatching(/^gh issue comment 8 --body-file /),
    ]);
    // Run locally, it names no secrets, which only the workflow reads.
    expect(second.body).toContain("needs a token with the");
    expect(second.body).not.toContain("SYNC_APP_PRIVATE_KEY");
    expect(originBranches()).toEqual(["main"]);
  });

  it("names the push token, not missing secrets, when a sync token is refused", () => {
    makeFork(`${OLD} ${oldSha}`);
    write(origin, "hooks/pre-receive", "#!/usr/bin/env bash\necho 'refusing' >&2\nexit 1\n", 0o755);
    const { status, body } = run({ GITHUB_ACTIONS: "true", SYNC_TOKEN: "pat" });
    expect(status).toBe(1);
    expect(body).toContain("refusing");
    expect(body).toContain("pushed with `SYNC_TOKEN`");
    expect(body).not.toContain("SYNC_APP_PRIVATE_KEY");
  });

  it("files cannot be pushed, not falling back to another token, when the App token was not minted", () => {
    makeFork(`${OLD} ${oldSha}`);
    const { status, calls, body, pushes } = run({
      GITHUB_ACTIONS: "true",
      SYNC_APP_CONFIGURED: "true",
      SYNC_TOKEN: "pat",
    });
    expect(status).toBe(1);
    expect(pushes).toEqual([]);
    expect(calls.at(-1)).toMatch(
      new RegExp(`^gh issue create --title Sync to ${NEWEST} cannot be pushed --body-file `),
    );
    expect(body).toContain("no SYNC_APP_ID token was minted");
    expect(body).toContain("pushed with `SYNC_APP_ID`");
    expect(originBranches()).toEqual(["main"]);
  });

  it("publishes nothing when the prepared branch is not the merge it claims", () => {
    makeFork(`${OLD} ${oldSha}`);
    const log = NodePath.join(dir, `log-${runs++}`);
    const out = NodePath.join(dir, `out-${runs}`);
    expect(prepareIn(out, log).status).toBe(0);
    // A compromised prepare slips a change to a fork file into the merge commit.
    write(fork, "factory/scripts/check.sh", "#!/usr/bin/env bash\nexit 0\n", 0o755);
    git(fork, "commit", "-q", "-a", "--amend", "--no-edit");
    git(fork, "bundle", "create", "-q", NodePath.join(out, "sync.bundle"), `main..sync/${NEWEST}`);
    const published = publishFrom(out, log);
    expect(published.status).toBe(1);
    expect(published.stderr).toContain(
      `sync: the prepared sync/${NEWEST} is not the merge of main and ${NEWEST}; not publishing it: it changes factory/scripts/check.sh`,
    );
    expect(readLines(log)).toEqual(["vp i", "check.sh"]);
    expect(originBranches()).toEqual(["main"]);
  });

  it("publishes nothing when the prepared UPSTREAM names another commit", () => {
    makeFork(`${OLD} ${oldSha}`);
    const log = NodePath.join(dir, `log-${runs++}`);
    const out = NodePath.join(dir, `out-${runs}`);
    expect(prepareIn(out, log).status).toBe(0);
    write(fork, "factory/UPSTREAM", `${NEWEST} ${oldSha}\n`);
    git(fork, "commit", "-q", "-a", "--amend", "--no-edit");
    git(fork, "bundle", "create", "-q", NodePath.join(out, "sync.bundle"), `main..sync/${NEWEST}`);
    const published = publishFrom(out, log);
    expect(published.status).toBe(1);
    expect(published.stderr).toContain(`factory/UPSTREAM does not name ${NEWEST} ${newestSha}`);
    expect(originBranches()).toEqual(["main"]);
  });

  it("publishes nothing when the prepared commit is not a merge of the tag", () => {
    makeFork(`${OLD} ${oldSha}`);
    const log = NodePath.join(dir, `log-${runs++}`);
    const out = NodePath.join(dir, `out-${runs}`);
    expect(prepareIn(out, log).status).toBe(0);
    // The same tree as one plain commit on main, so the tag is not a parent.
    git(fork, "reset", "-q", "--soft", "main");
    git(fork, "commit", "-q", "-m", "not a merge");
    git(fork, "bundle", "create", "-q", NodePath.join(out, "sync.bundle"), `main..sync/${NEWEST}`);
    const published = publishFrom(out, log);
    expect(published.status).toBe(1);
    expect(published.stderr).toContain("is not the merge of main and");
    expect(originBranches()).toEqual(["main"]);
  });

  // Points the prepared branch at a forged commit, rebundles it as a green
  // outcome, and publishes.
  const publishForged = (out: string, log: string, forged: string) => {
    git(fork, "update-ref", `refs/heads/sync/${NEWEST}`, forged);
    git(fork, "bundle", "create", "-q", NodePath.join(out, "sync.bundle"), `main..sync/${NEWEST}`);
    NodeFS.writeFileSync(NodePath.join(out, "outcome"), "green\n");
    return publishFrom(out, log);
  };

  it("publishes nothing when the prepared merge's first parent is not on main", () => {
    makeFork(`${OLD} ${oldSha}`);
    const log = NodePath.join(dir, `log-${runs++}`);
    const out = NodePath.join(dir, `out-${runs}`);
    expect(prepareIn(out, log).status).toBe(0);
    const prepared = git(fork, "rev-parse", `sync/${NEWEST}`);
    // Same tree as main but not on it, so merge-tree of it and the tag matches.
    const offMain = git(fork, "commit-tree", "main^{tree}", "-p", "main", "-m", "off main");
    const forged = git(
      fork,
      "commit-tree",
      `${prepared}^{tree}`,
      "-p",
      offMain,
      "-p",
      newestSha,
      "-m",
      "forged",
    );
    const published = publishForged(out, log, forged);
    expect(published.status).toBe(1);
    expect(published.stderr).toContain(`is not the merge of main and ${NEWEST}; not publishing it`);
    expect(originBranches()).toEqual(["main"]);
  });

  it("publishes nothing when the prepared merge has a third parent", () => {
    makeFork(`${OLD} ${oldSha}`);
    const log = NodePath.join(dir, `log-${runs++}`);
    const out = NodePath.join(dir, `out-${runs}`);
    expect(prepareIn(out, log).status).toBe(0);
    const prepared = git(fork, "rev-parse", `sync/${NEWEST}`);
    const forged = git(
      fork,
      "commit-tree",
      `${prepared}^{tree}`,
      "-p",
      "main",
      "-p",
      newestSha,
      "-p",
      oldSha,
      "-m",
      "octopus",
    );
    const published = publishForged(out, log, forged);
    expect(published.status).toBe(1);
    expect(published.stderr).toContain(`is not the merge of main and ${NEWEST}; not publishing it`);
    expect(originBranches()).toEqual(["main"]);
  });

  it("publishes nothing when main and the tag conflict outside the route tree", () => {
    makeFork(`${OLD} ${oldSha}`, { "README.md": "fork edit\n" });
    const log = NodePath.join(dir, `log-${runs++}`);
    const out = NodePath.join(dir, `out-${runs}`);
    expect(prepareIn(out, log).status).toBe(0);
    // git's own merge, conflict markers and all, plus the UPSTREAM line: the
    // tree matches merge-tree exactly, so only the conflict itself refuses it.
    const merged = NodeChildProcess.spawnSync(
      "git",
      ["merge-tree", "--write-tree", "--name-only", "--no-messages", "main", newestSha],
      { cwd: fork, encoding: "utf8" },
    );
    expect(merged.status).toBe(1);
    const [markedTree, conflicted] = merged.stdout.trim().split("\n");
    expect(conflicted).toBe("README.md");
    const index = NodePath.join(dir, `index-${runs}`);
    const withIndex = { ...process.env, GIT_INDEX_FILE: index };
    const upstreamBlob = NodeChildProcess.spawnSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: fork,
      encoding: "utf8",
      input: `${NEWEST} ${newestSha}\n`,
    }).stdout.trim();
    for (const args of [
      ["read-tree", markedTree!],
      ["update-index", "--cacheinfo", `100644,${upstreamBlob},factory/UPSTREAM`],
    ]) {
      NodeChildProcess.spawnSync("git", args, { cwd: fork, env: withIndex });
    }
    const tree = NodeChildProcess.spawnSync("git", ["write-tree"], {
      cwd: fork,
      encoding: "utf8",
      env: withIndex,
    }).stdout.trim();
    const forged = git(fork, "commit-tree", tree, "-p", "main", "-p", newestSha, "-m", "markers");
    const published = publishForged(out, log, forged);
    expect(published.status).toBe(1);
    expect(published.stderr).toContain(
      `is not the merge of main and ${NEWEST}; not publishing it\n`,
    );
    expect(originBranches()).toEqual(["main"]);
  });

  it("refuses a prepared directory with an unknown outcome or tag", () => {
    makeFork(`${OLD} ${oldSha}`);
    const out = NodePath.join(dir, "out-tampered");
    NodeFS.mkdirSync(out, { recursive: true });
    const log = NodePath.join(dir, `log-${runs++}`);
    NodeFS.writeFileSync(NodePath.join(out, "outcome"), "merged\n");
    const unknown = publishFrom(out, log);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain("sync: unknown outcome: merged");
    NodeFS.writeFileSync(NodePath.join(out, "outcome"), "conflicts\n");
    NodeFS.writeFileSync(NodePath.join(out, "tag"), "v1.0.0-nightly.1.1 --repo other/repo\n");
    runs++;
    const badTag = publishFrom(out, log);
    expect(badTag.status).toBe(1);
    expect(badTag.stderr).toContain("sync: unexpected tag name");
    expect(readLines(log)).toEqual([]);
  });

  it("refuses a tag outside the nightly pattern", () => {
    git(upstream, "tag", 'v0.0.11-nightly."x', newestSha);
    try {
      makeFork(`${OLD} ${oldSha}`);
      const { status, stderr, calls } = run();
      expect(status).toBe(1);
      expect(stderr).toContain("sync: unexpected tag name");
      expect(calls).toEqual([]);
      expect(originBranches()).toEqual(["main"]);
    } finally {
      git(upstream, "tag", "-d", 'v0.0.11-nightly."x');
    }
  });
});
