// @effect-diagnostics nodeBuiltinImport:off - the server provision check reads source text, as boundary.test.ts does.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import {
  type VcsError,
  VcsProcessExitError,
  VcsProcessSpawnError,
  VcsProcessTimeoutError,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import { driver as gitHubDriver } from "@t3tools/source-control-github/server/driver";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSettings from "../../serverSettings.ts";
import * as ServerSourceControlHost from "../../sourceControl/ServerSourceControlHost.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import { VcsProcess, type VcsProcessInput, type VcsProcessOutput } from "../../vcs/VcsProcess.ts";
import { decorate, layer } from "./ghCredentialProcess.ts";

const TOKEN = "gho_fakeTokenThatMustNeverBeLogged";

const credentialInput: VcsProcessInput = {
  operation: "GitHubCredentials.get",
  command: "gh",
  args: ["auth", "token", "--hostname", "github.com"],
  cwd: "/work",
  timeoutMs: 10_000,
};

const base = { operation: "GitHubCredentials.get", command: "gh", cwd: "/work" };
const timeout = (timeoutMs = 10_000) => new VcsProcessTimeoutError({ ...base, timeoutMs });
const exitError = new VcsProcessExitError({
  ...base,
  exitCode: 1,
  detail: "no oauth token",
  failureKind: "authentication",
});
const spawnError = new VcsProcessSpawnError({ ...base, cause: new Error("ENOENT") });

const success: VcsProcessOutput = {
  exitCode: 0 as VcsProcessOutput["exitCode"],
  stdout: `${TOKEN}\n`,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
};

type Reply =
  | { readonly _tag: "ok"; readonly stdout?: string }
  | { readonly _tag: "fail"; readonly error: VcsError };
const ok: Reply = { _tag: "ok" };
const okWith = (stdout: string): Reply => ({ _tag: "ok", stdout });
const fail = (error: VcsError): Reply => ({ _tag: "fail", error });

/** An inner VcsProcess that answers each call with the next scripted reply and records its input. */
const fakeInner = (replies: Array<Reply>) => {
  const calls: Array<VcsProcessInput> = [];
  const run = (input: VcsProcessInput) =>
    Effect.suspend(() => {
      calls.push(input);
      const reply = replies.shift();
      if (reply === undefined) return Effect.die(new Error("unexpected inner run"));
      if (reply._tag === "fail") return Effect.fail(reply.error);
      return Effect.succeed(
        reply.stdout === undefined ? success : { ...success, stdout: reply.stdout },
      );
    });
  return { calls, service: { run } };
};

/** Every log line the effect writes, with its message, annotations and spans, as JSON. */
const captureLogs = () => {
  const lines: Array<string> = [];
  const logger = Logger.map(Logger.formatJson, (line) => {
    lines.push(line);
  });
  return { lines, layer: Logger.layer([logger]) };
};

describe("ghCredentialProcess.decorate", () => {
  it.effect(
    "(a) retries a timed-out credential lookup once with a 30 s timeout, and remembers that success",
    () =>
      Effect.gen(function* () {
        const inner = fakeInner([fail(timeout()), ok, fail(timeout()), fail(timeout(30_000))]);
        const decorated = decorate(inner.service);
        const output = yield* decorated.run(credentialInput);
        assert.strictEqual(output.stdout, success.stdout);
        assert.strictEqual(inner.calls.length, 2);
        assert.strictEqual(inner.calls[1]!.timeoutMs, 30_000);
        assert.deepStrictEqual({ ...inner.calls[1]!, timeoutMs: 10_000 }, credentialInput);
        const fallback = yield* decorated.run(credentialInput);
        assert.strictEqual(fallback.stdout, success.stdout);
      }),
  );

  it.effect(
    "(b) reuses the output read 10 min earlier after two timeouts, and warns once with the host and age",
    () =>
      Effect.gen(function* () {
        const logs = captureLogs();
        const inner = fakeInner([ok, fail(timeout()), fail(timeout(30_000))]);
        const decorated = decorate(inner.service);
        yield* Effect.gen(function* () {
          yield* decorated.run(credentialInput);
          yield* TestClock.adjust("10 minutes");
          const output = yield* decorated.run(credentialInput);
          assert.strictEqual(output.stdout, success.stdout);
        }).pipe(Effect.provide(logs.layer));
        assert.strictEqual(inner.calls.length, 3);
        const warnings = logs.lines.filter((line) => line.includes('"WARN"'));
        assert.strictEqual(warnings.length, 1);
        assert.include(
          warnings[0]!,
          "gh credential lookup timed out twice; reusing the credential read 600 s ago",
        );
        assert.include(warnings[0]!, '"host":"github.com"');
      }),
  );

  it.effect("(f) writes the token into no log line on the success, retry or fallback path", () =>
    Effect.gen(function* () {
      const logs = captureLogs();
      const inner = fakeInner([ok, fail(timeout()), ok, fail(timeout()), fail(timeout(30_000))]);
      const decorated = decorate(inner.service);
      yield* Effect.gen(function* () {
        yield* decorated.run(credentialInput);
        yield* decorated.run(credentialInput);
        yield* TestClock.adjust("1 minute");
        yield* decorated.run(credentialInput);
      }).pipe(Effect.withSpan("credential lookups"), Effect.provide(logs.layer));
      assert.strictEqual(inner.calls.length, 5);
      assert.isNotEmpty(logs.lines);
      assert.isFalse(logs.lines.some((line) => line.includes(TOKEN)));
    }),
  );

  it.effect("falls back at exactly 30 minutes and fails 1 ms later", () =>
    Effect.gen(function* () {
      const inner = fakeInner([
        ok,
        fail(timeout()),
        fail(timeout(30_000)),
        fail(timeout()),
        fail(timeout(30_000)),
      ]);
      const decorated = decorate(inner.service);
      yield* decorated.run(credentialInput);
      yield* TestClock.adjust("30 minutes");
      assert.strictEqual((yield* decorated.run(credentialInput)).stdout, success.stdout);
      yield* TestClock.adjust("1 millis");
      const error = yield* Effect.flip(decorated.run(credentialInput));
      assert.deepStrictEqual(error, timeout(30_000));
    }),
  );

  it.effect("replaces the remembered output and its time with each newer success", () =>
    Effect.gen(function* () {
      const logs = captureLogs();
      const inner = fakeInner([
        okWith("token-a\n"),
        okWith("token-b\n"),
        fail(timeout()),
        fail(timeout(30_000)),
        fail(timeout()),
        fail(timeout(30_000)),
      ]);
      const decorated = decorate(inner.service);
      yield* Effect.gen(function* () {
        yield* decorated.run(credentialInput);
        yield* TestClock.adjust("20 minutes");
        yield* decorated.run(credentialInput);
        yield* TestClock.adjust("15 minutes");
        assert.strictEqual((yield* decorated.run(credentialInput)).stdout, "token-b\n");
        yield* TestClock.adjust("15 minutes");
        assert.strictEqual((yield* decorated.run(credentialInput)).stdout, "token-b\n");
      }).pipe(Effect.provide(logs.layer));
      const warnings = logs.lines.filter((line) => line.includes('"WARN"'));
      assert.include(warnings[0]!, "reusing the credential read 900 s ago");
      assert.include(warnings[1]!, "reusing the credential read 1800 s ago");
    }),
  );

  it.effect("(c) fails with the timeout when the last success is 31 min old", () =>
    Effect.gen(function* () {
      const inner = fakeInner([ok, fail(timeout()), fail(timeout(30_000))]);
      const decorated = decorate(inner.service);
      yield* decorated.run(credentialInput);
      yield* TestClock.adjust("31 minutes");
      const error = yield* Effect.flip(decorated.run(credentialInput));
      assert.deepStrictEqual(error, timeout(30_000));
    }),
  );

  it.effect("(c) fails with the timeout when there was never a success", () =>
    Effect.gen(function* () {
      const inner = fakeInner([fail(timeout()), fail(timeout(30_000))]);
      const error = yield* Effect.flip(decorate(inner.service).run(credentialInput));
      assert.deepStrictEqual(error, timeout(30_000));
      assert.strictEqual(inner.calls.length, 2);
    }),
  );

  it.effect("keeps the last-good output per command and args, not per host", () =>
    Effect.gen(function* () {
      const inner = fakeInner([ok, fail(timeout()), fail(timeout(30_000))]);
      const decorated = decorate(inner.service);
      yield* decorated.run(credentialInput);
      const other = { ...credentialInput, args: ["auth", "token", "--hostname", "acme.ghe.com"] };
      const error = yield* Effect.flip(decorated.run(other));
      assert.deepStrictEqual(error, timeout(30_000));
    }),
  );

  it.effect(
    "(d) propagates an exit error with no retry and forgets the output, so a later double timeout fails",
    () =>
      Effect.gen(function* () {
        const inner = fakeInner([ok, fail(exitError), fail(timeout()), fail(timeout(30_000))]);
        const decorated = decorate(inner.service);
        yield* decorated.run(credentialInput);
        const exited = yield* Effect.flip(decorated.run(credentialInput));
        assert.deepStrictEqual(exited, exitError);
        assert.strictEqual(inner.calls.length, 2);
        const timedOut = yield* Effect.flip(decorated.run(credentialInput));
        assert.deepStrictEqual(timedOut, timeout(30_000));
      }),
  );

  it.effect("(d) propagates a spawn error with no retry and forgets the output", () =>
    Effect.gen(function* () {
      const inner = fakeInner([ok, fail(spawnError), fail(timeout()), fail(timeout(30_000))]);
      const decorated = decorate(inner.service);
      yield* decorated.run(credentialInput);
      const spawned = yield* Effect.flip(decorated.run(credentialInput));
      assert.deepStrictEqual(spawned, spawnError);
      assert.strictEqual(inner.calls.length, 2);
      const timedOut = yield* Effect.flip(decorated.run(credentialInput));
      assert.deepStrictEqual(timedOut, timeout(30_000));
    }),
  );

  it.effect("(d) forgets the output when the retry after a timeout exits non-zero", () =>
    Effect.gen(function* () {
      const inner = fakeInner([
        ok,
        fail(timeout()),
        fail(exitError),
        fail(timeout()),
        fail(timeout(30_000)),
      ]);
      const decorated = decorate(inner.service);
      yield* decorated.run(credentialInput);
      assert.deepStrictEqual(yield* Effect.flip(decorated.run(credentialInput)), exitError);
      assert.deepStrictEqual(yield* Effect.flip(decorated.run(credentialInput)), timeout(30_000));
    }),
  );

  it.effect("(e) passes another operation's timeout through with one inner call", () =>
    Effect.gen(function* () {
      const gitTimeout = new VcsProcessTimeoutError({
        operation: "GitVcsDriver.execute",
        command: "git",
        cwd: "/work",
        timeoutMs: 30_000,
      });
      const inner = fakeInner([fail(gitTimeout)]);
      const input: VcsProcessInput = {
        operation: "GitVcsDriver.execute",
        command: "git",
        args: ["status"],
        cwd: "/work",
      };
      const error = yield* Effect.flip(decorate(inner.service).run(input));
      assert.deepStrictEqual(error, gitTimeout);
      assert.strictEqual(inner.calls.length, 1);
      assert.strictEqual(inner.calls[0], input);
    }),
  );
});

describe("ghCredentialProcess.layer", () => {
  // Live: the process timeout runs on the clock, which it.effect would freeze.
  it.live("provides a VcsProcess whose credential lookup retries a real timed-out process", () =>
    Effect.gen(function* () {
      const vcs = yield* VcsProcess;
      // Answers after 300 ms: the 100 ms first attempt times out, the 30 s retry reads it.
      const output = yield* vcs.run({
        ...credentialInput,
        command: process.execPath,
        args: ["-e", "setTimeout(() => process.stdout.write('ok'), 300)"],
        cwd: process.cwd(),
        timeoutMs: 100,
      });
      assert.strictEqual(output.stdout, "ok");
    }).pipe(Effect.provide(layer.pipe(Layer.provide(NodeServices.layer)))),
  );
});

describe("ghCredentialProcess in the server graph", () => {
  // Fails when upstream renames the operation or reshapes the lookup, since nothing else would.
  it.effect(
    "retries upstream's own gh credential lookup through the server's source-control host",
    () => {
      const inner = fakeInner([fail(timeout()), ok]);
      const authorizations: Array<string | undefined> = [];
      return Effect.gen(function* () {
        const instance = yield* gitHubDriver.make;
        const response = yield* instance.fetchMedia!({
          url: "https://raw.githubusercontent.com/owner/repo/main/shot.png",
          headers: {},
        });
        assert.strictEqual(response?.status, 200);
        assert.strictEqual(inner.calls.length, 2);
        assert.strictEqual(inner.calls[0]!.operation, credentialInput.operation);
        assert.strictEqual(inner.calls[1]!.timeoutMs, 30_000);
        assert.deepStrictEqual(authorizations, [`Bearer ${TOKEN}`]);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            ServerSourceControlHost.layer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeed(VcsProcess, decorate(inner.service)),
                  ServerSettings.layerTest(),
                  Layer.mock(GitVcsDriver.GitVcsDriver)({}),
                  Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({}),
                ),
              ),
            ),
            SourceControlRateLimit.layer,
          ).pipe(Layer.provideMerge(Layer.mergeAll(NodeCrypto.layer, NodeServices.layer))),
        ),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            authorizations.push(request.headers.authorization);
            return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null)));
          }),
        ),
        Effect.provideService(HostProcess.Environment, {}),
        Effect.scoped,
      );
    },
  );

  // server.ts cannot be built in a test, so its provision is pinned by source. Its position is
  // pinned by the typecheck: with no other provider, a consumer the line does not reach leaves
  // VcsProcess unsatisfied and binCli.ts fails to compile.
  it("is the only VcsProcess the server provides, apart from workspace entries' own", () => {
    const srcRoot = NodePath.resolve(import.meta.dirname, "../..");
    const server = NodeFS.readFileSync(NodePath.join(srcRoot, "server.ts"), "utf8");
    assert.include(server, "Layer.provide(FactoryGhCredentialProcess.layer)");
    const providers = NodeFS.readdirSync(srcRoot, { recursive: true, encoding: "utf8" })
      .filter((file) => /\.tsx?$/.test(file) && !/\.test(kit)?\.tsx?$/.test(file))
      .filter(
        (file) => !file.split(NodePath.sep).some((dir) => dir === "factory" || dir === "testkit"),
      )
      .filter((file) =>
        /\bVcsProcess\.layer\b/.test(NodeFS.readFileSync(NodePath.join(srcRoot, file), "utf8")),
      )
      .map((file) => file.split(NodePath.sep).join("/"));
    assert.deepStrictEqual(providers, ["workspace/WorkspaceEntries.ts"]);
  });
});
