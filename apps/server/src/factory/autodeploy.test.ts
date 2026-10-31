// @effect-diagnostics nodeBuiltinImport:off - the script is run for real, against a temp clone, a stub status API and version directories whose real mtimes it compares.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";

import { formatTs } from "./ledger/time.ts";

const script = NodePath.resolve(import.meta.dirname, "../../../../factory/scripts/autodeploy.sh");
const TOKEN = "test-token";

// The stub status API answers each request with the next queued body, then the last one again.
let statusBodies: Array<unknown> = [];
let statusAuth: Array<string | undefined> = [];
let server: NodeHttp.Server;
let port = 0;

beforeAll(async () => {
  server = NodeHttp.createServer((req, res) => {
    statusAuth.push(req.headers.authorization);
    if (req.url !== "/api/factory/status" || req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401).end();
      return;
    }
    const body = statusBodies.length > 1 ? statusBodies.shift() : statusBodies[0];
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as NodeNet.AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const status = (
  runs: Array<{ state: string | null; unreadable?: boolean }>,
  running = false,
  threads: number | null = 0,
) => ({
  state: "running",
  passes: { running },
  threads: { running: threads },
  runs: runs.map((run, i) => ({ id: `o/r#${i}`, unreadable: false, ...run })),
});
const IDLE = status([]);

let tmp: string;
let home: string;
let origin: string;
let work: string;
let clone: string;
let deployLog: string;

const root = () => NodePath.join(home, ".local/share/t3fac");
const failedFile = () => NodePath.join(root(), "autodeploy.failed");
const holdFile = () => NodePath.join(root(), "autodeploy.hold");

const git = (cwd: string, ...args: Array<string>) => {
  const result = NodeChildProcess.spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

// A deploy.sh that records each call and, on an install, moves `current` to `previous` and to the
// commit, as install.sh would. Unlike install.sh it keeps an existing version directory's install
// time, so `current` can be the oldest. DEPLOY_FAIL, KILL_TICK, BACKDATE_PENDING, BUILD_HANG,
// HOLD_DURING_BUILD, SNOOZE_DURING_BUILD, INSTALL_FAIL and CURRENT_AT vary it.
const FAKE_DEPLOY = [
  "#!/usr/bin/env bash",
  "set -euo pipefail",
  "sha=$(git rev-parse --short HEAD)",
  'held=$(readlink "$HOME/.local/share/t3fac/deploy.lock" || true)',
  'locked=no-lock; [[ -n $held && $held == "${T3FAC_DEPLOY_LOCK:-}" ]] && locked=lock',
  'echo "${1:-install} $sha ${T3FAC_SKIP_RELOAD:-} $locked" >> "$DEPLOY_LOG"',
  '[[ -z ${DEPLOY_FAIL:-} ]] || { echo "build: boom" >&2; exit 1; }',
  '[[ -z ${KILL_TICK:-} ]] || kill -KILL "$(readlink "$HOME/.local/share/t3fac/autodeploy.lock")"',
  '[[ -z ${BACKDATE_PENDING:-} ]] || touch -t 200001010000 "$BACKDATE_PENDING"',
  'if [[ -n ${BUILD_HANG:-} ]]; then sleep 30 & echo $! > "$BUILD_HANG"; wait; fi',
  '[[ -z ${HOLD_DURING_BUILD:-} ]] || : > "$HOME/.local/share/t3fac/autodeploy.hold"',
  '[[ -z ${SNOOZE_DURING_BUILD:-} ]] || echo "$SNOOZE_DURING_BUILD 1" > "$HOME/.config/t3fac/factory/deploy-snoozed"',
  "[[ ${1:-} == --build-only ]] && exit 0",
  '[[ -z ${INSTALL_FAIL:-} ]] || { echo "health check failed; rolled back" >&2; exit 1; }',
  'r="$HOME/.local/share/t3fac"',
  'target="versions/0.0.1+fac.$sha"; [[ -z ${CURRENT_AT:-} ]] || target="$CURRENT_AT/0.0.1+fac.$sha"',
  'mkdir -p "$r/versions" && (cd "$r" && mkdir -p "$target")',
  'old=$(readlink "$r/current" || true)',
  '[[ -z $old || $old == "$target" ]] || ln -sfn "$old" "$r/previous"',
  'ln -sfn "$target" "$r/current"',
  "",
].join("\n");

const commitToOrigin = (message: string) => {
  NodeFS.writeFileSync(NodePath.join(work, "change.txt"), `${message}\n`);
  git(work, "add", "-A");
  // The server's test setup turns core.filemode off, which would commit deploy.sh without +x.
  git(work, "add", "--chmod=+x", "factory/scripts/deploy.sh");
  git(work, "commit", "-q", "-m", message);
  git(work, "push", "-q", "origin", "HEAD:main");
  return git(work, "rev-parse", "HEAD");
};

const setInstalled = (sha: string) => {
  NodeFS.mkdirSync(root(), { recursive: true });
  NodeFS.symlinkSync(`versions/0.0.1+fac.${sha.slice(0, 7)}`, NodePath.join(root(), "current"));
};

const writeEnv = (lines: Array<string>) => {
  NodeFS.mkdirSync(NodePath.join(home, ".config/t3fac"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(home, ".config/t3fac/env"), `${lines.join("\n")}\n`);
};

const setupSandbox = () => {
  tmp = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3fac-autodeploy-")),
  );
  home = NodePath.join(tmp, "home");
  origin = NodePath.join(tmp, "origin.git");
  work = NodePath.join(tmp, "work");
  clone = NodePath.join(tmp, "clone");
  deployLog = NodePath.join(tmp, "deploy.log");
  NodeFS.mkdirSync(home);
  NodeFS.writeFileSync(deployLog, "");
  git(tmp, "init", "-q", "--bare", "-b", "main", origin);
  git(tmp, "init", "-q", "-b", "main", work);
  git(work, "config", "user.name", "Test");
  git(work, "config", "user.email", "test@example.com");
  git(work, "config", "commit.gpgsign", "false");
  git(work, "remote", "add", "origin", origin);
  NodeFS.mkdirSync(NodePath.join(work, "factory/scripts"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(work, "factory/scripts/deploy.sh"), FAKE_DEPLOY, {
    mode: 0o755,
  });
  const first = commitToOrigin("first");
  git(tmp, "clone", "-q", origin, clone);
  setInstalled(first);
  writeEnv([`T3FAC_AUTODEPLOY_CLONE="${clone}"`, `T3FAC_AUTODEPLOY_TOKEN=${TOKEN}`]);
  statusBodies = [IDLE];
  statusAuth = [];
};

// Every process the tick starts inherits fd 3, so `close` waits until the last of them has exited:
// a loop the tick leaves running keeps the run from returning.
const runAutodeploy = (extraEnv: Record<string, string> = {}) =>
  new Promise<{ status: number | null; output: string; deploys: Array<string> }>((resolve) => {
    const child = NodeChildProcess.spawn("bash", [script], {
      stdio: ["pipe", "pipe", "pipe", "pipe"],
      env: {
        T3FAC_PLATFORM: "Darwin",
        HOME: home,
        PATH: "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin",
        DEPLOY_LOG: deployLog,
        T3FAC_PORT: String(port),
        ...extraEnv,
      },
    });
    let output = "";
    const inherited = child.stdio[3];
    if (inherited && "resume" in inherited) inherited.resume();
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("close", (code) => {
      const deploys = NodeFS.readFileSync(deployLog, "utf8").split("\n").filter(Boolean);
      NodeFS.writeFileSync(deployLog, "");
      resolve({ status: code, output, deploys });
    });
  });

const lines = (output: string) => output.split("\n").filter(Boolean);
const current = () => NodeFS.readlinkSync(NodePath.join(root(), "current"));

describe("autodeploy.sh", () => {
  beforeEach(() => {
    setupSandbox();
  });

  afterEach(() => {
    NodeFS.rmSync(tmp, { recursive: true, force: true });
  });

  it("exits 0 and prints nothing when origin/main is the installed commit", async () => {
    const result = await runAutodeploy();
    expect(result.status).toBe(0);
    expect(result.output).toBe("");
    expect(result.deploys).toEqual([]);
  });

  it("builds then installs a new origin/main, leaving its own job loaded", async () => {
    const sha = commitToOrigin("second");
    const short = git(clone, "rev-parse", "--short", sha);
    const result = await runAutodeploy();
    expect(result.status).toBe(0);
    expect(result.deploys).toEqual([
      `--build-only ${short} io.github.rawphp.t3fac.autodeploy no-lock`,
      `install ${short} io.github.rawphp.t3fac.autodeploy lock`,
    ]);
    expect(current()).toBe(`versions/0.0.1+fac.${short}`);
    expect(git(clone, "rev-parse", "HEAD")).toBe(sha);
    expect(lines(result.output)).toHaveLength(1);
    expect(result.output).toContain(`deployed ${short}`);
    expect(statusAuth.every((auth) => auth === `Bearer ${TOKEN}`)).toBe(true);
  });

  it("deploys on a machine with no version installed yet", async () => {
    NodeFS.rmSync(NodePath.join(root(), "current"));
    const sha = commitToOrigin("second");
    const short = git(clone, "rev-parse", "--short", sha);
    const result = await runAutodeploy();
    expect(result.status).toBe(0);
    expect(result.deploys).toHaveLength(2);
    expect(current()).toBe(`versions/0.0.1+fac.${short}`);
  });

  it("matches an installed short sha of any length", async () => {
    const sha = commitToOrigin("second");
    NodeFS.rmSync(NodePath.join(root(), "current"));
    NodeFS.symlinkSync(`versions/0.0.1+fac.${sha.slice(0, 10)}`, NodePath.join(root(), "current"));
    const result = await runAutodeploy();
    expect(result.status).toBe(0);
    expect(result.output).toBe("");
    expect(result.deploys).toEqual([]);
  });

  it.each([
    ["a building run", status([{ state: "building" }])],
    ["a run in triage", status([{ state: "triage" }])],
    ["a run with no state yet", status([{ state: null }])],
    ["a run whose file cannot be read", status([{ state: "pr-open", unreadable: true }])],
    ["a pass running", status([], true)],
  ])("waits without deploying while there is %s", async (_name, body) => {
    commitToOrigin("second");
    statusBodies = [body];
    const result = await runAutodeploy();
    expect(result.status).toBe(0);
    expect(result.deploys).toEqual([]);
    expect(lines(result.output)).toHaveLength(1);
    expect(result.output).toContain("in progress");
    expect(NodeFS.existsSync(failedFile())).toBe(false);
  });

  it.each([
    ["an agent at work in a thread", 2],
    ["a thread count T3 could not read", null],
  ])("waits without deploying while there is %s", async (_name, threads) => {
    commitToOrigin("second");
    statusBodies = [status([], false, threads)];
    const result = await runAutodeploy();
    expect(result.status).toBe(0);
    expect(result.deploys).toEqual([]);
    expect(lines(result.output)).toHaveLength(1);
    expect(result.output).toContain("an agent is at work in a thread");
  });

  it("deploys against a server from before the thread count", async () => {
    const sha = commitToOrigin("second");
    const { threads: _threads, ...older } = IDLE;
    statusBodies = [older];
    const result = await runAutodeploy();
    expect(result.status).toBe(0);
    expect(current()).toBe(`versions/0.0.1+fac.${git(clone, "rev-parse", "--short", sha)}`);
  });

  it("deploys when the only unfinished runs wait on people", async () => {
    const sha = commitToOrigin("second");
    statusBodies = [status([{ state: "pr-open" }, { state: "needs-info" }, { state: "stuck" }])];
    const result = await runAutodeploy();
    expect(result.status).toBe(0);
    expect(current()).toBe(`versions/0.0.1+fac.${git(clone, "rev-parse", "--short", sha)}`);
  });

  it("does not install when a run starts while it builds, and installs on the next tick", async () => {
    const sha = commitToOrigin("second");
    const short = git(clone, "rev-parse", "--short", sha);
    statusBodies = [IDLE, status([{ state: "building" }])];
    const first = await runAutodeploy();
    expect(first.status).toBe(0);
    expect(first.deploys).toEqual([
      `--build-only ${short} io.github.rawphp.t3fac.autodeploy no-lock`,
    ]);
    expect(current()).not.toContain(short);
    expect(lines(first.output)).toHaveLength(1);

    statusBodies = [IDLE];
    const second = await runAutodeploy();
    expect(second.status).toBe(0);
    expect(current()).toBe(`versions/0.0.1+fac.${short}`);
  });

  it("logs one line and does not deploy when the token is missing", async () => {
    commitToOrigin("second");
    writeEnv([`T3FAC_AUTODEPLOY_CLONE="${clone}"`]);
    const result = await runAutodeploy();
    expect(result.status).toBe(0);
    expect(result.deploys).toEqual([]);
    expect(lines(result.output)).toHaveLength(1);
    expect(result.output).toContain("T3FAC_AUTODEPLOY_TOKEN");
    expect(statusAuth).toEqual([]);
  });

  it("logs one line and does not deploy when the status API cannot be reached", async () => {
    commitToOrigin("second");
    // A port nothing listens on: bind one, then close it.
    const closed = NodeNet.createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const deadPort = (closed.address() as NodeNet.AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const result = await runAutodeploy({ T3FAC_PORT: String(deadPort) });
    expect(result.status).toBe(0);
    expect(result.deploys).toEqual([]);
    expect(lines(result.output)).toHaveLength(1);
    expect(result.output).toContain("/api/factory/status");
  });

  it("logs one line and does not deploy when the token is refused", async () => {
    commitToOrigin("second");
    writeEnv([`T3FAC_AUTODEPLOY_CLONE="${clone}"`, "T3FAC_AUTODEPLOY_TOKEN=wrong"]);
    const result = await runAutodeploy();
    expect(result.status).toBe(0);
    expect(result.deploys).toEqual([]);
    expect(lines(result.output)).toHaveLength(1);
    expect(result.output).toContain("/api/factory/status");
  });

  it("tries a failing build on three ticks, then gives the sha up until main moves", async () => {
    const before = current();
    const bad = commitToOrigin("bad");
    const badShort = git(clone, "rev-parse", "--short", bad);
    for (const attempt of [1, 2]) {
      const retried = await runAutodeploy({ DEPLOY_FAIL: "1" });
      expect(retried.status).not.toBe(0);
      expect(lines(retried.output)).toHaveLength(1);
      expect(retried.output).toContain(`build of ${badShort} failed (attempt ${attempt} of 3)`);
      expect(NodeFS.existsSync(failedFile())).toBe(false);
    }
    const failed = await runAutodeploy({ DEPLOY_FAIL: "1" });
    expect(failed.status).not.toBe(0);
    expect(lines(failed.output)).toHaveLength(1);
    expect(failed.output).toContain(`deploy of ${badShort} failed`);
    expect(failed.output).toContain("until main moves");
    expect(NodeFS.readFileSync(failedFile(), "utf8").trim()).toBe(bad);
    expect(current()).toBe(before);

    const again = await runAutodeploy();
    expect(again.status).toBe(0);
    expect(again.output).toBe("");
    expect(again.deploys).toEqual([]);

    const good = commitToOrigin("good");
    const next = await runAutodeploy();
    expect(next.status).toBe(0);
    expect(current()).toBe(`versions/0.0.1+fac.${git(clone, "rev-parse", "--short", good)}`);
  });

  // Two locks, each a symlink to its holder's pid: autodeploy.lock for a whole tick (the clone and
  // the build), and deploy.lock, shared with install.sh and rollback.sh, for the install only.
  const lockPath = (name = "deploy.lock") => NodePath.join(root(), name);
  const lockExists = (name?: string) => {
    try {
      NodeFS.readlinkSync(lockPath(name));
      return true;
    } catch {
      return false;
    }
  };
  const deadPid = () =>
    NodeChildProcess.spawnSync("bash", ["-c", "echo $$"], { encoding: "utf8" }).stdout.trim();

  it("deploys a sha whose build failed once and then passed", async () => {
    const sha = commitToOrigin("second");
    expect((await runAutodeploy({ DEPLOY_FAIL: "1" })).status).not.toBe(0);
    const next = await runAutodeploy();
    expect(next.status).toBe(0);
    expect(current()).toBe(`versions/0.0.1+fac.${git(clone, "rev-parse", "--short", sha)}`);
    expect(NodeFS.existsSync(NodePath.join(root(), "autodeploy.attempts"))).toBe(false);
  });

  it("records a sha whose install fails, releases both locks and does not retry it", async () => {
    const before = current();
    const bad = commitToOrigin("bad");
    const badShort = git(clone, "rev-parse", "--short", bad);
    const failed = await runAutodeploy({ INSTALL_FAIL: "1" });
    expect(failed.status).not.toBe(0);
    expect(failed.deploys).toHaveLength(2);
    expect(lines(failed.output)).toHaveLength(1);
    expect(failed.output).toContain(`deploy of ${badShort} failed`);
    expect(NodeFS.readFileSync(failedFile(), "utf8").trim()).toBe(bad);
    expect(current()).toBe(before);
    expect(lockExists()).toBe(false);
    expect(lockExists("autodeploy.lock")).toBe(false);

    const again = await runAutodeploy();
    expect(again.status).toBe(0);
    expect(again.output).toBe("");
    expect(again.deploys).toEqual([]);
  });

  it("stops a build that runs past its limit, with every process it started, and retries next tick", async () => {
    const sha = commitToOrigin("second");
    const short = git(clone, "rev-parse", "--short", sha);
    const hung = NodePath.join(tmp, "hung.pid");
    const result = await runAutodeploy({ BUILD_HANG: hung, T3FAC_BUILD_LIMIT: "1" });
    expect(result.status).toBe(1);
    expect(lines(result.output)).toHaveLength(1);
    expect(result.output).toContain(
      `build of ${short} took over 1s and was stopped (attempt 1 of 3)`,
    );
    expect(() => process.kill(Number(NodeFS.readFileSync(hung, "utf8")), 0)).toThrow();
    expect(NodeFS.existsSync(failedFile())).toBe(false);
    expect(lockExists("autodeploy.lock")).toBe(false);

    const next = await runAutodeploy();
    expect(next.status).toBe(0);
    expect(current()).toBe(`versions/0.0.1+fac.${short}`);
  });

  it("leaves a deploy or rollback by hand in place until main moves", async () => {
    const before = current();
    const sha = commitToOrigin("second");
    const short = git(clone, "rev-parse", "--short", sha);
    NodeFS.writeFileSync(holdFile(), "");
    const held = await runAutodeploy();
    expect(held.status).toBe(0);
    expect(held.deploys).toEqual([]);
    expect(lines(held.output)).toHaveLength(1);
    expect(held.output).toContain(`not deploying ${short} until main moves`);
    expect(NodeFS.existsSync(holdFile())).toBe(false);
    expect(current()).toBe(before);

    const again = await runAutodeploy();
    expect(again.status).toBe(0);
    expect(again.output).toBe("");
    expect(again.deploys).toEqual([]);

    const moved = commitToOrigin("third");
    const next = await runAutodeploy();
    expect(next.status).toBe(0);
    expect(current()).toBe(`versions/0.0.1+fac.${git(clone, "rev-parse", "--short", moved)}`);
  });

  it("does not install over a deploy by hand made during its build", async () => {
    const before = current();
    commitToOrigin("second");
    const result = await runAutodeploy({ HOLD_DURING_BUILD: "1" });
    expect(result.status).toBe(0);
    expect(result.deploys).toHaveLength(1);
    expect(lines(result.output)).toHaveLength(1);
    expect(result.output).toContain("until main moves");
    expect(current()).toBe(before);
    expect(lockExists()).toBe(false);
  });

  it("drops the hold silently when the version by hand is already origin/main", async () => {
    NodeFS.writeFileSync(holdFile(), "");
    const result = await runAutodeploy();
    expect(result.status).toBe(0);
    expect(result.output).toBe("");
    expect(NodeFS.existsSync(holdFile())).toBe(false);

    const sha = commitToOrigin("second");
    const next = await runAutodeploy();
    expect(next.status).toBe(0);
    expect(current()).toBe(`versions/0.0.1+fac.${git(clone, "rev-parse", "--short", sha)}`);
  });

  it("does nothing while another autodeploy holds its lock", async () => {
    commitToOrigin("second");
    NodeFS.symlinkSync(String(process.pid), lockPath("autodeploy.lock"));
    const result = await runAutodeploy();
    expect(result.status).toBe(0);
    expect(result.deploys).toEqual([]);
    expect(lines(result.output)).toHaveLength(1);
    expect(result.output).toContain(`pid ${process.pid}`);
    expect(NodeFS.readlinkSync(lockPath("autodeploy.lock"))).toBe(String(process.pid));
  });

  it("builds but waits to install while another deploy holds the deploy lock", async () => {
    const sha = commitToOrigin("second");
    const short = git(clone, "rev-parse", "--short", sha);
    NodeFS.symlinkSync(String(process.pid), lockPath());
    const result = await runAutodeploy();
    expect(result.status).toBe(0);
    expect(result.deploys).toEqual([
      `--build-only ${short} io.github.rawphp.t3fac.autodeploy no-lock`,
    ]);
    expect(lines(result.output)).toHaveLength(1);
    expect(result.output).toContain(`pid ${process.pid}`);
    expect(NodeFS.existsSync(failedFile())).toBe(false);
    expect(NodeFS.readlinkSync(lockPath())).toBe(String(process.pid));
    expect(lockExists("autodeploy.lock")).toBe(false);
  });

  it("takes over locks whose holders are gone, and releases them", async () => {
    const sha = commitToOrigin("second");
    NodeFS.symlinkSync(deadPid(), lockPath());
    NodeFS.symlinkSync(deadPid(), lockPath("autodeploy.lock"));
    const result = await runAutodeploy();
    expect(result.status).toBe(0);
    expect(current()).toBe(`versions/0.0.1+fac.${git(clone, "rev-parse", "--short", sha)}`);
    expect(lockExists()).toBe(false);
    expect(lockExists("autodeploy.lock")).toBe(false);
  });

  it("leaves a stale lock alone while another process is taking it over", async () => {
    commitToOrigin("second");
    NodeFS.symlinkSync(deadPid(), lockPath("autodeploy.lock"));
    NodeFS.mkdirSync(lockPath("autodeploy.lock.takeover"));
    const result = await runAutodeploy();
    expect(result.status).toBe(0);
    expect(result.deploys).toEqual([]);
    expect(lines(result.output)).toHaveLength(1);
    expect(result.output).toContain("another autodeploy is running");
    expect(NodeFS.existsSync(lockPath("autodeploy.lock.takeover"))).toBe(true);
  });

  it("clears a takeover guard left over a minute ago and takes the lock", async () => {
    const sha = commitToOrigin("second");
    NodeFS.symlinkSync(deadPid(), lockPath("autodeploy.lock"));
    const guard = lockPath("autodeploy.lock.takeover");
    NodeFS.mkdirSync(guard);
    // Five minutes before it was made, in seconds.
    const old = NodeFS.statSync(guard).mtimeMs / 1000 - 5 * 60;
    NodeFS.utimesSync(guard, old, old);
    const result = await runAutodeploy();
    expect(result.status).toBe(0);
    expect(current()).toBe(`versions/0.0.1+fac.${git(clone, "rev-parse", "--short", sha)}`);
    expect(NodeFS.existsSync(guard)).toBe(false);
    expect(lockExists("autodeploy.lock")).toBe(false);
  });

  it("releases its lock when it has nothing to do", async () => {
    const result = await runAutodeploy();
    expect(result.status).toBe(0);
    expect(lockExists("autodeploy.lock")).toBe(false);
  });

  it("does nothing and prints nothing when no clone is configured", async () => {
    commitToOrigin("second");
    writeEnv([`T3FAC_AUTODEPLOY_TOKEN=${TOKEN}`]);
    const result = await runAutodeploy();
    expect(result.status).toBe(0);
    expect(result.output).toBe("");
    expect(result.deploys).toEqual([]);
  });
});

describe("autodeploy.sh waiting behind runs", () => {
  const pendingFile = () => NodePath.join(home, ".config/t3fac/factory/deploy-pending");
  // The script's clock is `date` and file mtimes, so "now" is an mtime just stamped, in ms.
  const stampNow = () => {
    const stamp = NodePath.join(tmp, "now");
    NodeFS.writeFileSync(stamp, "");
    return NodeFS.statSync(stamp).mtimeMs;
  };
  const writePending = (secondsAgo: number, sha = "0".repeat(40)) => {
    NodeFS.mkdirSync(NodePath.dirname(pendingFile()), { recursive: true });
    const since = Math.floor(stampNow() / 1000) - secondsAgo;
    NodeFS.writeFileSync(pendingFile(), `${since} ${sha}\n`);
    return since;
  };
  const writeMachineConfig = (text: string) => {
    NodeFS.mkdirSync(NodePath.dirname(pendingFile()), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(NodePath.dirname(pendingFile()), "config.yml"), text);
  };
  const BUSY = status([{ state: "building" }]);

  beforeEach(() => {
    setupSandbox();
  });

  afterEach(() => {
    NodeFS.rmSync(tmp, { recursive: true, force: true });
  });

  it("marks the build pending and logs the wait so far", async () => {
    const sha = commitToOrigin("second");
    statusBodies = [BUSY];
    const result = await runAutodeploy();
    expect(result.deploys).toEqual([]);
    expect(NodeFS.readFileSync(pendingFile(), "utf8")).toMatch(new RegExp(`^\\d+ ${sha}\\n$`));
    expect(lines(result.output)).toHaveLength(1);
    expect(result.output).toContain("waited 0s of deploy_wait_minutes 120");
  });

  it("keeps the first time when main moves, and updates the sha", async () => {
    commitToOrigin("second");
    statusBodies = [BUSY];
    await runAutodeploy();
    const [since] = NodeFS.readFileSync(pendingFile(), "utf8").split(" ");
    const third = commitToOrigin("third");
    await runAutodeploy();
    expect(NodeFS.readFileSync(pendingFile(), "utf8")).toBe(`${since} ${third}\n`);
  });

  it("deploys although a run is in progress once the build has waited past the limit", async () => {
    const sha = commitToOrigin("second");
    const short = git(clone, "rev-parse", "--short", sha);
    writePending(3 * 3600);
    statusBodies = [BUSY];
    const result = await runAutodeploy();
    expect(result.status).toBe(0);
    expect(result.deploys).toHaveLength(2);
    expect(current()).toBe(`versions/0.0.1+fac.${short}`);
    expect(result.output).toContain(`deploying ${short} although a factory run is in progress`);
    expect(result.output).toContain("waited 3h00m");
    expect(result.output).toContain("past deploy_wait_minutes 120");
    expect(result.output.match(/deploying /g)).toHaveLength(1);
    expect(NodeFS.existsSync(pendingFile())).toBe(false);
  });

  // The status cannot tell a person's thread from a factory run's, so the limit ends the wait for
  // whatever is in the way.
  it.each([
    ["an agent is at work in a thread", "an agent is at work in a thread", status([], false, 2)],
    ["the thread count cannot be read", "an agent is at work in a thread", status([], false, null)],
  ])("deploys past the limit although %s", async (_name, busy, body) => {
    const sha = commitToOrigin("second");
    const short = git(clone, "rev-parse", "--short", sha);
    writePending(3 * 3600);
    statusBodies = [body];
    const result = await runAutodeploy();
    expect(result.deploys).toHaveLength(2);
    expect(current()).toBe(`versions/0.0.1+fac.${short}`);
    expect(result.output.match(/deploying /g)).toHaveLength(1);
    expect(result.output).toContain(`although ${busy}`);
    expect(result.output).toContain("a person's thread is interrupted");
    expect(NodeFS.existsSync(pendingFile())).toBe(false);
  });

  it("reads the limit from deploy_wait_minutes", async () => {
    const sha = commitToOrigin("second");
    writeMachineConfig("gh_config_dir: /gh\ndeploy_wait_minutes: 1\n");
    statusBodies = [BUSY];
    writePending(30);
    const waiting = await runAutodeploy();
    expect(waiting.deploys).toEqual([]);
    expect(lines(waiting.output)).toHaveLength(1);
    expect(waiting.output).toContain("of deploy_wait_minutes 1");

    writePending(120);
    const deployed = await runAutodeploy();
    expect(deployed.deploys).toHaveLength(2);
    expect(current()).toBe(`versions/0.0.1+fac.${git(clone, "rev-parse", "--short", sha)}`);
  });

  it("uses the default and says so when deploy_wait_minutes cannot be read", async () => {
    commitToOrigin("second");
    writeMachineConfig("deploy_wait_minutes: lots\n");
    statusBodies = [BUSY];
    const result = await runAutodeploy();
    expect(result.deploys).toEqual([]);
    expect(lines(result.output)).toHaveLength(1);
    expect(result.output).toContain("cannot read deploy_wait_minutes");
    expect(result.output).toContain("using 120");
  });

  it("removes the marker when nothing is pending", async () => {
    writePending(60);
    expect((await runAutodeploy()).output).toBe("");
    expect(NodeFS.existsSync(pendingFile())).toBe(false);
  });

  it("removes the marker after a deploy or rollback by hand", async () => {
    commitToOrigin("second");
    writePending(60);
    NodeFS.writeFileSync(holdFile(), "");
    const result = await runAutodeploy();
    expect(result.output).toContain("until main moves");
    expect(NodeFS.existsSync(pendingFile())).toBe(false);
  });

  it("removes the marker when the deploy fails", async () => {
    commitToOrigin("second");
    writePending(60);
    const result = await runAutodeploy({ INSTALL_FAIL: "1" });
    expect(result.output).toContain("failed");
    expect(NodeFS.existsSync(pendingFile())).toBe(false);
  });

  it("removes the marker when main is still the commit it gave up on", async () => {
    const sha = commitToOrigin("second");
    NodeFS.mkdirSync(root(), { recursive: true });
    NodeFS.writeFileSync(failedFile(), `${sha}\n`);
    writePending(60, sha);
    expect((await runAutodeploy()).output).toBe("");
    expect(NodeFS.existsSync(pendingFile())).toBe(false);
  });

  it("removes the marker when no clone is configured", async () => {
    commitToOrigin("second");
    writePending(60);
    writeEnv([`T3FAC_AUTODEPLOY_TOKEN=${TOKEN}`]);
    expect((await runAutodeploy()).output).toBe("");
    expect(NodeFS.existsSync(pendingFile())).toBe(false);
  });

  it("keeps the marker while a build is retried", async () => {
    commitToOrigin("second");
    const since = writePending(60);
    await runAutodeploy({ DEPLOY_FAIL: "1" });
    expect(NodeFS.readFileSync(pendingFile(), "utf8")).toMatch(new RegExp(`^${since} `));
  });

  // A tick that cannot ask leaves the marker as it is: the server ignores one that goes stale, and
  // a blip does not lose the first-wait time.
  const minutesAgo = (minutes: number) => {
    const time = stampNow() / 1000 - minutes * 60;
    NodeFS.utimesSync(pendingFile(), time, time);
    return NodeFS.statSync(pendingFile()).mtimeMs;
  };
  const hourAgo = () => minutesAgo(60);

  it("leaves the marker as it was when the token is missing", async () => {
    commitToOrigin("second");
    writePending(60);
    const before = NodeFS.readFileSync(pendingFile(), "utf8");
    const mtime = hourAgo();
    writeEnv([`T3FAC_AUTODEPLOY_CLONE="${clone}"`]);
    const result = await runAutodeploy();
    expect(result.output).toContain("T3FAC_AUTODEPLOY_TOKEN");
    expect(NodeFS.readFileSync(pendingFile(), "utf8")).toBe(before);
    expect(NodeFS.statSync(pendingFile()).mtimeMs).toBe(mtime);
  });

  it("leaves the marker as it was when the status API cannot be reached", async () => {
    commitToOrigin("second");
    writePending(60);
    const before = NodeFS.readFileSync(pendingFile(), "utf8");
    const mtime = hourAgo();
    const closed = NodeNet.createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const deadPort = (closed.address() as NodeNet.AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const result = await runAutodeploy({ T3FAC_PORT: String(deadPort) });
    expect(result.output).toContain("/api/factory/status");
    expect(NodeFS.readFileSync(pendingFile(), "utf8")).toBe(before);
    expect(NodeFS.statSync(pendingFile()).mtimeMs).toBe(mtime);
  });

  it("leaves the marker as it was when the status cannot be parsed", async () => {
    commitToOrigin("second");
    writePending(60);
    const before = NodeFS.readFileSync(pendingFile(), "utf8");
    const mtime = hourAgo();
    statusBodies = [{ runs: "nope" }];
    const result = await runAutodeploy();
    expect(result.output).toContain("cannot read the factory status");
    expect(NodeFS.readFileSync(pendingFile(), "utf8")).toBe(before);
    expect(NodeFS.statSync(pendingFile()).mtimeMs).toBe(mtime);
  });

  // A marker older than the server's staleness cutoff means the server was not draining, so that
  // time was not spent waiting. 31 and 29 minutes pin the script's limit to the server's 30.
  it("starts the wait again when the marker went stale", async () => {
    commitToOrigin("second");
    writePending(3 * 3600);
    minutesAgo(31);
    statusBodies = [BUSY];
    const before = stampNow();
    const result = await runAutodeploy();
    expect(result.deploys).toEqual([]);
    expect(lines(result.output)).toHaveLength(1);
    expect(result.output).toMatch(/waited [01]s of deploy_wait_minutes 120/);
    const [since] = NodeFS.readFileSync(pendingFile(), "utf8").split(" ");
    expect(Number(since)).toBeGreaterThanOrEqual(Math.floor(before / 1000));
  });

  it("keeps the first-wait time across a short blip", async () => {
    commitToOrigin("second");
    writePending(3 * 3600);
    minutesAgo(29);
    statusBodies = [BUSY];
    const result = await runAutodeploy();
    expect(result.output).toContain("deploying");
    expect(result.output).toContain("waited 3h00m");
  });

  it("keeps the marker fresh while a long build runs", async () => {
    commitToOrigin("second");
    const since = writePending(600);
    const hung = NodePath.join(tmp, "hung.pid");
    const before = stampNow();
    const result = await runAutodeploy({
      BUILD_HANG: hung,
      BACKDATE_PENDING: pendingFile(),
      T3FAC_BUILD_LIMIT: "3",
      T3FAC_PENDING_REFRESH: "1",
    });
    expect(result.output).toContain("took over 3s");
    expect(NodeFS.statSync(pendingFile()).mtimeMs).toBeGreaterThanOrEqual(before);
    expect(NodeFS.readFileSync(pendingFile(), "utf8")).toMatch(new RegExp(`^${since} `));
  });

  it("stops touching the marker once the tick is killed mid-build", async () => {
    commitToOrigin("second");
    const since = writePending(600);
    const before = stampNow();
    const result = await runAutodeploy({
      KILL_TICK: "1",
      BACKDATE_PENDING: pendingFile(),
      T3FAC_BUILD_LIMIT: "2",
      T3FAC_PENDING_REFRESH: "1",
    });
    expect(result.status).toBeNull();
    expect(NodeFS.statSync(pendingFile()).mtimeMs).toBeLessThan(before);
    expect(NodeFS.readFileSync(pendingFile(), "utf8")).toMatch(new RegExp(`^${since} `));
  });

  it("rewrites the marker on every tick it reads the status, so its mtime shows autodeploy is ticking", async () => {
    const sha = commitToOrigin("second");
    const since = writePending(600, sha);
    minutesAgo(20);
    statusBodies = [BUSY];
    const before = stampNow();
    await runAutodeploy();
    expect(NodeFS.readFileSync(pendingFile(), "utf8")).toMatch(new RegExp(`^${since} `));
    expect(NodeFS.statSync(pendingFile()).mtimeMs).toBeGreaterThanOrEqual(before);
  });

  it("marks the build pending on an idle tick too, so a run that starts during the build waits", async () => {
    const sha = commitToOrigin("second");
    statusBodies = [IDLE, BUSY];
    const result = await runAutodeploy();
    expect(result.deploys).toHaveLength(1);
    expect(result.output).toMatch(/waited [01]s of deploy_wait_minutes 120/);
    expect(NodeFS.readFileSync(pendingFile(), "utf8")).toMatch(new RegExp(`^\\d+ ${sha}\\n$`));
  });
});

describe("autodeploy.sh snoozed or asked to deploy now", () => {
  const dataDir = () => NodePath.join(home, ".config/t3fac/factory");
  const pendingFile = () => NodePath.join(dataDir(), "deploy-pending");
  const snoozeFile = () => NodePath.join(dataDir(), "deploy-snoozed");
  const nowFile = () => NodePath.join(dataDir(), "deploy-now");
  const nowSecs = () => {
    const stamp = NodePath.join(tmp, "now");
    NodeFS.writeFileSync(stamp, "");
    return Math.floor(NodeFS.statSync(stamp).mtimeMs / 1000);
  };
  const writePending = (secondsAgo: number, sha = "0".repeat(40)) => {
    NodeFS.mkdirSync(dataDir(), { recursive: true });
    const since = nowSecs() - secondsAgo;
    NodeFS.writeFileSync(pendingFile(), `${since} ${sha}\n`);
    return since;
  };
  const writeSnooze = (end: number) => {
    NodeFS.mkdirSync(dataDir(), { recursive: true });
    NodeFS.writeFileSync(snoozeFile(), `${end}\n`);
  };
  const askNow = (sha: string) => {
    NodeFS.mkdirSync(dataDir(), { recursive: true });
    NodeFS.writeFileSync(nowFile(), `${sha}\n`);
  };
  const BUSY = status([{ state: "building" }]);

  beforeEach(() => {
    setupSandbox();
  });

  afterEach(() => {
    NodeFS.rmSync(tmp, { recursive: true, force: true });
  });

  it("an active snooze skips a busy and an idle tick and keeps deploy-pending fresh", async () => {
    const sha = commitToOrigin("second");
    const short = git(clone, "rev-parse", "--short", sha);
    const since = writePending(3 * 3600, sha);
    const end = nowSecs() + 1800;
    writeSnooze(end);
    for (const body of [BUSY, IDLE]) {
      const old = nowSecs() - 20 * 60;
      NodeFS.utimesSync(pendingFile(), old, old);
      const before = nowSecs() * 1000;
      statusBodies = [body];
      const result = await runAutodeploy();
      expect(result.status).toBe(0);
      expect(result.deploys).toEqual([]);
      expect(lines(result.output)).toEqual([
        expect.stringContaining(
          `not deploying ${short}: snoozed until ${formatTs(end * 1000).replace(".000Z", "Z")}`,
        ),
      ]);
      expect(NodeFS.readFileSync(pendingFile(), "utf8")).toBe(`${since} ${sha}\n`);
      expect(NodeFS.statSync(pendingFile()).mtimeMs).toBeGreaterThanOrEqual(before);
      expect(NodeFS.readFileSync(snoozeFile(), "utf8")).toBe(`${end}\n`);
    }
  });

  it("an expired snooze starts the wait again from its end, and keeps its count", async () => {
    const sha = commitToOrigin("second");
    writePending(110 * 60, sha);
    const end = nowSecs() - 60;
    NodeFS.writeFileSync(snoozeFile(), `${end} 2\n`);
    statusBodies = [BUSY];
    const result = await runAutodeploy();
    expect(result.deploys).toEqual([]);
    expect(result.output).toMatch(/waited 1m of deploy_wait_minutes 120/);
    expect(NodeFS.readFileSync(pendingFile(), "utf8")).toBe(`${end} ${sha}\n`);
    expect(NodeFS.readFileSync(snoozeFile(), "utf8")).toBe(`${end} 2\n`);
  });

  it("a snooze that starts during the build stops the install", async () => {
    const sha = commitToOrigin("second");
    const short = git(clone, "rev-parse", "--short", sha);
    writePending(60, sha);
    const end = nowSecs() + 1800;
    const result = await runAutodeploy({ SNOOZE_DURING_BUILD: String(end) });
    expect(result.status).toBe(0);
    expect(result.deploys).toEqual([
      `--build-only ${short} io.github.rawphp.t3fac.autodeploy no-lock`,
    ]);
    expect(current()).not.toContain(short);
    expect(result.output).toContain(
      `not deploying ${short}: snoozed until ${formatTs(end * 1000).replace(".000Z", "Z")}`,
    );
    expect(NodeFS.existsSync(pendingFile())).toBe(true);
    expect(NodeFS.existsSync(snoozeFile())).toBe(true);
  });

  it("deploy-now for a build main has moved past is dropped, and the tick waits as normal", async () => {
    const old = commitToOrigin("second");
    const sha = commitToOrigin("third");
    const short = git(clone, "rev-parse", "--short", sha);
    writePending(60, old);
    askNow(old);
    statusBodies = [BUSY];
    const result = await runAutodeploy();
    expect(result.deploys).toEqual([]);
    expect(result.output).toContain(
      `not taking the update now asked for ${old.slice(0, 9)}: main has moved to ${short}`,
    );
    expect(result.output).toContain(`waiting to deploy ${short}`);
    expect(NodeFS.existsSync(nowFile())).toBe(false);
  });

  it("deploy-now installs while the status reports a run in progress", async () => {
    const sha = commitToOrigin("second");
    const short = git(clone, "rev-parse", "--short", sha);
    writePending(60, sha);
    askNow(sha);
    statusBodies = [BUSY];
    const result = await runAutodeploy();
    expect(result.status).toBe(0);
    expect(result.deploys).toHaveLength(2);
    expect(current()).toBe(`versions/0.0.1+fac.${short}`);
    expect(result.output.match(/deploying /g)).toHaveLength(1);
    expect(result.output).toContain(
      `deploying ${short} now, as asked from the Factory page, although a factory run is in progress`,
    );
  });

  it("deploy-now on an idle tick says so without a reason", async () => {
    const sha = commitToOrigin("second");
    const short = git(clone, "rev-parse", "--short", sha);
    askNow(sha);
    const result = await runAutodeploy();
    expect(result.deploys).toHaveLength(2);
    expect(lines(result.output)[0]).toMatch(
      new RegExp(`deploying ${short} now, as asked from the Factory page$`),
    );
  });

  it("both markers are gone after a deploy", async () => {
    const sha = commitToOrigin("second");
    writeSnooze(nowSecs() - 60);
    askNow(sha);
    const result = await runAutodeploy();
    expect(result.deploys).toHaveLength(2);
    expect(NodeFS.existsSync(pendingFile())).toBe(false);
    expect(NodeFS.existsSync(snoozeFile())).toBe(false);
    expect(NodeFS.existsSync(nowFile())).toBe(false);
  });

  it("both markers are gone when nothing is pending", async () => {
    writeSnooze(nowSecs() + 1800);
    askNow("0".repeat(40));
    const result = await runAutodeploy();
    expect(result.output).toBe("");
    expect(NodeFS.existsSync(snoozeFile())).toBe(false);
    expect(NodeFS.existsSync(nowFile())).toBe(false);
  });
});

describe("autodeploy.sh pruning old versions", () => {
  const versionsDir = () => NodePath.join(root(), "versions");
  const versions = () => NodeFS.readdirSync(versionsDir()).toSorted();
  const installedName = () => current().slice("versions/".length);

  // A version directory installed `minutesAgo` minutes ago: its mtime is its install time. The
  // offset is taken from the mtime mkdir just stamped, so it lines up with the directories the
  // deploy itself creates.
  const addVersion = (name: string, minutesAgo: number) => {
    const dir = NodePath.join(versionsDir(), name);
    NodeFS.mkdirSync(dir, { recursive: true });
    const time = (NodeFS.statSync(dir).mtimeMs - minutesAgo * 60_000) / 1000;
    NodeFS.utimesSync(dir, time, time);
  };

  const writeMachineConfig = (text: string) => {
    const dir = NodePath.join(home, ".config/t3fac/factory");
    NodeFS.mkdirSync(dir, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(dir, "config.yml"), text);
  };

  const pruned = (output: string) =>
    lines(output)
      .filter((line) => line.includes("pruned"))
      .map((line) => line.replace(/^.* autodeploy: /, ""));

  beforeEach(() => {
    setupSandbox();
  });

  afterEach(() => {
    NodeFS.rmSync(tmp, { recursive: true, force: true });
  });

  it("keeps current and the three versions installed last, by install time not name, logging each it deletes", async () => {
    // Name order is the reverse of install order for the older four.
    addVersion("0.0.1+fac.aaaaaaa", 50);
    addVersion("0.0.1+fac.zzzzzzz", 40);
    addVersion("0.0.1+fac.bbbbbbb", 30);
    addVersion("0.0.1+fac.yyyyyyy", 20);
    addVersion(installedName(), 10);
    const first = installedName();
    const sha = commitToOrigin("second");
    const short = git(clone, "rev-parse", "--short", sha);

    const result = await runAutodeploy();

    expect(result.status).toBe(0);
    expect(versions()).toEqual(
      [`0.0.1+fac.${short}`, first, "0.0.1+fac.yyyyyyy", "0.0.1+fac.bbbbbbb"].toSorted(),
    );
    expect(pruned(result.output)).toEqual([
      "pruned versions/0.0.1+fac.zzzzzzz",
      "pruned versions/0.0.1+fac.aaaaaaa",
    ]);
    expect(lines(result.output)[0]).toContain(`deployed ${short}`);
  });

  it("keeps only current with keep_versions: 0, even when current is the oldest", async () => {
    writeMachineConfig("gh_config_dir: /gh\nmax_concurrent_runs: 1\nkeep_versions: 0 # tight\n");
    const sha = commitToOrigin("second");
    const short = git(clone, "rev-parse", "--short", sha);
    // Older than every other, which install.sh never leaves, so only the name keeps it.
    addVersion(`0.0.1+fac.${short}`, 60);
    addVersion(installedName(), 30);
    addVersion("0.0.1+fac.ccccccc", 20);

    const result = await runAutodeploy();

    expect(result.status).toBe(0);
    expect(current()).toBe(`versions/0.0.1+fac.${short}`);
    expect(versions()).toEqual([`0.0.1+fac.${short}`]);
    expect(pruned(result.output)).toHaveLength(2);
  });

  it("deletes nothing when the build or the install fails", async () => {
    for (const [i, name] of ["a", "b", "c", "d", "e"].entries()) {
      addVersion(`0.0.1+fac.${name.repeat(7)}`, 60 - i);
    }
    addVersion(installedName(), 10);
    const before = versions();

    commitToOrigin("bad build");
    const build = await runAutodeploy({ DEPLOY_FAIL: "1" });
    expect(build.status).toBe(1);
    expect(versions()).toEqual(before);

    commitToOrigin("bad install");
    const install = await runAutodeploy({ INSTALL_FAIL: "1" });
    expect(install.status).toBe(1);
    expect(versions()).toEqual(before);
    expect(pruned(build.output + install.output)).toEqual([]);
  });

  // The server's YAML parser reads every one of these; the script reads none, so it must not guess.
  it.each([
    "keep_versions: lots",
    "keep_versions: 10000000000000000000",
    "keep_versions : 10",
    '"keep_versions": 10',
    "keep_versions: 1\nkeep_versions: 2",
  ])("does not prune when it cannot read %j, and says so", async (line) => {
    writeMachineConfig(`gh_config_dir: /gh\nmax_concurrent_runs: 1\n${line}\n`);
    for (const [i, name] of ["a", "b", "c", "d", "e"].entries()) {
      addVersion(`0.0.1+fac.${name.repeat(7)}`, 60 - i);
    }
    addVersion(installedName(), 10);
    const sha = commitToOrigin("second");

    const result = await runAutodeploy();

    expect(result.status).toBe(0);
    expect(versions()).toHaveLength(7);
    expect(pruned(result.output)).toEqual([]);
    expect(result.output).toContain("not pruning versions: cannot read keep_versions");
    expect(lines(result.output)[0]).toContain(
      `deployed ${git(clone, "rev-parse", "--short", sha)}`,
    );
  });

  it("takes the default past a commented-out keep_versions", async () => {
    writeMachineConfig("gh_config_dir: /gh\nmax_concurrent_runs: 1\n# keep_versions: 0\n");
    for (const [i, name] of ["a", "b", "c", "d", "e"].entries()) {
      addVersion(`0.0.1+fac.${name.repeat(7)}`, 60 - i);
    }
    addVersion(installedName(), 10);
    commitToOrigin("second");

    const result = await runAutodeploy();

    expect(result.status).toBe(0);
    expect(versions()).toHaveLength(4);
    expect(pruned(result.output)).toHaveLength(3);
  });

  // install.sh copies an absolute `current` into `previous` as it is on the next deploy.
  it("knows current and previous by their directories when their links are absolute", async () => {
    writeMachineConfig("gh_config_dir: /gh\nmax_concurrent_runs: 1\nkeep_versions: 1\n");
    const first = installedName();
    addVersion("0.0.1+fac.aaaaaaa", 60);
    addVersion(first, 40);
    const second = git(clone, "rev-parse", "--short", commitToOrigin("second"));

    const absolute = await runAutodeploy({ CURRENT_AT: versionsDir() });

    expect(absolute.status).toBe(0);
    expect(current()).toBe(NodePath.join(versionsDir(), `0.0.1+fac.${second}`));
    expect(versions()).toEqual([`0.0.1+fac.${second}`, first].toSorted());

    // Installed after `second`, so only being `previous` keeps `second` ahead of it.
    addVersion("0.0.1+fac.newerzz", -1);
    const third = git(clone, "rev-parse", "--short", commitToOrigin("third"));

    const relative = await runAutodeploy();

    expect(relative.status).toBe(0);
    expect(current()).toBe(`versions/0.0.1+fac.${third}`);
    expect(versions()).toEqual([`0.0.1+fac.${third}`, `0.0.1+fac.${second}`].toSorted());
    expect(pruned(relative.output).toSorted()).toEqual(
      [`pruned versions/${first}`, "pruned versions/0.0.1+fac.newerzz"].toSorted(),
    );
  });

  it("deletes nothing when current is not one of the version directories", async () => {
    writeMachineConfig("gh_config_dir: /gh\nmax_concurrent_runs: 1\nkeep_versions: 0\n");
    for (const [i, name] of ["a", "b", "c"].entries()) {
      addVersion(`0.0.1+fac.${name.repeat(7)}`, 60 - i);
    }
    addVersion(installedName(), 10);
    commitToOrigin("second");

    const result = await runAutodeploy({ CURRENT_AT: NodePath.join(tmp, "elsewhere") });

    expect(result.status).toBe(0);
    expect(versions()).toHaveLength(4);
    expect(pruned(result.output)).toEqual([]);
  });

  // `previous` is kept first, so a version installed after it (then rolled back from) goes first.
  it("keeps the version rollback.sh returns to, and rollback.sh still works after pruning", async () => {
    writeMachineConfig("gh_config_dir: /gh\nmax_concurrent_runs: 1\nkeep_versions: 1\n");
    const first = installedName();
    addVersion(first, 30);
    addVersion("0.0.1+fac.rolledb", 20);
    const sha = commitToOrigin("second");
    const short = git(clone, "rev-parse", "--short", sha);

    const result = await runAutodeploy();

    expect(result.status).toBe(0);
    expect(versions()).toEqual([`0.0.1+fac.${short}`, first].toSorted());
    expect(pruned(result.output)).toEqual(["pruned versions/0.0.1+fac.rolledb"]);

    // A launchctl whose jobs are never loaded, and whose server comes up at once.
    const bin = NodePath.join(tmp, "bin");
    NodeFS.mkdirSync(bin);
    NodeFS.writeFileSync(
      NodePath.join(bin, "launchctl"),
      [
        "#!/bin/sh",
        'case "$1" in',
        "  print) exit 113 ;;",
        '  bootstrap) if [ "$(basename "$3")" = io.github.rawphp.t3fac.plist ]; then',
        '    mkdir -p "$HOME/Library/Logs/t3fac"; echo "factory started" >> "$HOME/Library/Logs/t3fac/t3fac.log"; fi ;;',
        "esac",
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const rollback = await new Promise<{ status: number | null; output: string }>((resolve) => {
      const child = NodeChildProcess.spawn(
        "bash",
        [NodePath.join(NodePath.dirname(script), "rollback.sh")],
        {
          env: {
            T3FAC_PLATFORM: "Darwin",
            HOME: home,
            PATH: `${bin}:/usr/bin:/bin`,
            T3FAC_PORT: String(port),
          },
        },
      );
      let output = "";
      child.stdout.on("data", (chunk) => (output += chunk));
      child.stderr.on("data", (chunk) => (output += chunk));
      child.on("close", (code) => resolve({ status: code, output }));
    });
    expect(rollback.status, rollback.output).toBe(0);
    expect(current()).toBe(`versions/${first}`);
  });
});
