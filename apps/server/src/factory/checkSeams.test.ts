// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

const script = NodePath.resolve(import.meta.dirname, "../../../../factory/scripts/check-seams.sh");

let repo: string;

const git = (...args: Array<string>) => {
  const result = NodeChildProcess.spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

const write = (file: string, content: string) => {
  const full = NodePath.join(repo, file);
  NodeFS.mkdirSync(NodePath.dirname(full), { recursive: true });
  NodeFS.writeFileSync(full, content);
};

const commit = (message: string) => {
  git("add", "-A");
  git("commit", "-q", "-m", message);
};

const runScript = () => {
  const result = NodeChildProcess.spawnSync("bash", [script], { cwd: repo, encoding: "utf8" });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
};

describe("check-seams.sh", () => {
  beforeAll(() => {
    repo = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "check-seams-"));
    git("init", "-q");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.com");
    git("config", "commit.gpgsign", "false");
    write("apps/server/src/server.ts", "base\n");
    write("apps/server/src/ws.ts", "base\n");
    write("apps/server/src/rpc.ts", "rpc base\n");
    commit("base");
    const base = git("rev-parse", "HEAD");
    write("factory/UPSTREAM", `v0.0.0-test ${base}\n`);
    write("factory/SEAMS", "apps/server/src/server.ts\n");
    commit("factory metadata");
  });

  afterAll(() => {
    NodeFS.rmSync(repo, { recursive: true, force: true });
  });

  it("passes when every change is allowed or a listed seam", () => {
    write("apps/server/src/server.ts", "changed\n");
    write("apps/server/src/factory/index.ts", "x\n");
    write("apps/web/src/factory/page.tsx", "x\n");
    write("apps/desktop/src/factory/factoryServer.ts", "x\n");
    write("apps/mobile/src/factory/mobileIdentity.ts", "x\n");
    write(".dw/config.yml", "x: 1\n");
    write("apps/web/src/routes/factory.tsx", "x\n");
    write("apps/web/src/routes/_chat.settings.factory.tsx", "x\n");
    write(".github/workflows/factory-ci.yml", "x: 1\n");
    commit("allowed changes");

    const { status, output } = runScript();
    expect(output).not.toContain("not a listed seam");
    expect(status).toBe(0);
  });

  it("fails and names an unlisted upstream change", () => {
    write("apps/server/src/server.ts", "changed again\n");
    write("apps/server/src/ws.ts", "changed\n");
    write("apps/web/src/routes/settings.other.tsx", "x\n");
    write("apps/web/src/routes/settings.factory.tsx", "x\n");
    commit("unlisted change");

    const { status, output } = runScript();
    expect(status).toBe(1);
    expect(output).toContain("apps/server/src/ws.ts");
    expect(output).toContain("apps/web/src/routes/settings.other.tsx");
    expect(output).toContain("apps/web/src/routes/settings.factory.tsx");
    expect(output).not.toContain("apps/server/src/server.ts");
    expect(output).not.toContain("_chat.settings.factory.tsx");
  });

  it("names an upstream file renamed into an allowed path", () => {
    git("mv", "apps/server/src/rpc.ts", "factory/rpc.ts");
    commit("rename upstream file");

    const { status, output } = runScript();
    expect(status).toBe(1);
    expect(output).toContain("apps/server/src/rpc.ts");
    expect(output).not.toContain("factory/rpc.ts");
  });

  // Runs last: it deletes the upstream commit's root tree, which every diff needs.
  it("fails when git diff fails", () => {
    const upstream = NodeFS.readFileSync(NodePath.join(repo, "factory/UPSTREAM"), "utf8").split(
      " ",
    )[1]!;
    const tree = git("rev-parse", `${upstream.trim()}^{tree}`);
    NodeFS.rmSync(NodePath.join(repo, ".git/objects", tree.slice(0, 2), tree.slice(2)));

    const { status, output } = runScript();
    expect(status).not.toBe(0);
    expect(output).toContain("fatal");
  });
});
