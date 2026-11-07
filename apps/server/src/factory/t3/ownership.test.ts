// @effect-diagnostics nodeBuiltinImport:off - the owner is a real child process, killed with SIGKILL.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ProcessRunner from "../../processRunner.ts";
import { acquireServerOwnership } from "../../serverOwnership.ts";

const srcDir = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../..");
const moduleUrl = (file: string) =>
  JSON.stringify(NodeURL.pathToFileURL(NodePath.join(srcDir, file)).href);

/** An empty home, so no boot service unit installed on this machine is read. */
const ownershipLayer = Layer.mergeAll(
  ProcessRunner.layer,
  Layer.effect(
    HostProcess.HomeDirectory,
    Effect.gen(function* () {
      return yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
    }),
  ),
  Layer.succeed(HostProcess.Environment, {}),
).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layerSecureRandom)));

/**
 * A child process that takes server ownership of `statePath` the way a server does, publishes its
 * runtime record, prints `owned` and then waits to be killed.
 */
const ownerScript = (statePath: string, home: string) =>
  [
    `import * as NodeCrypto from "@effect/platform-node/NodeCrypto";`,
    `import * as NodeServices from "@effect/platform-node/NodeServices";`,
    `import * as HostProcess from "@t3tools/shared/HostProcess";`,
    `import * as Effect from "effect/Effect";`,
    `import * as Layer from "effect/Layer";`,
    `import * as ProcessRunner from ${moduleUrl("processRunner.ts")};`,
    `import { acquireServerOwnership } from ${moduleUrl("serverOwnership.ts")};`,
    `import { makePersistedServerRuntimeState } from ${moduleUrl("serverRuntimeState.ts")};`,
    `const layer = Layer.mergeAll(`,
    `  ProcessRunner.layer,`,
    `  Layer.succeed(HostProcess.HomeDirectory, ${JSON.stringify(home)}),`,
    `  Layer.succeed(HostProcess.Environment, {}),`,
    `).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layerSecureRandom)));`,
    // A fiber waiting on Effect.never holds no handle, so the open stdin keeps the child, and its
    // lock, alive until it is killed; it ends with the test runner if the runner dies first.
    `process.stdin.on("end", () => process.exit()).resume();`,
    `Effect.runFork(Effect.scoped(Effect.gen(function* () {`,
    `  const owner = yield* acquireServerOwnership(${JSON.stringify(statePath)});`,
    `  yield* owner.publish(yield* makePersistedServerRuntimeState({`,
    `    config: { host: undefined, devUrl: undefined },`,
    `    port: 3773,`,
    `  }));`,
    `  process.stdout.write("owned\\n");`,
    `  yield* Effect.never;`,
    `})).pipe(Effect.provide(layer)));`,
  ].join("\n");

/** Starts the owner and waits for it to own the directory; the scope kills it if it is still up. */
const startOwner = (statePath: string, home: string) =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<NodeChildProcess.ChildProcess>((resolve, reject) => {
          const child = NodeChildProcess.spawn(
            process.execPath,
            ["--input-type=module", "--no-warnings", "-e", ownerScript(statePath, home)],
            { cwd: NodePath.resolve(srcDir, ".."), stdio: ["pipe", "pipe", "pipe"] },
          );
          let stderr = "";
          child.stderr.setEncoding("utf8").on("data", (text: string) => (stderr += text));
          child.stdout.setEncoding("utf8").on("data", (text: string) => {
            if (text.includes("owned")) resolve(child);
          });
          child.on("exit", (code) => reject(new Error(`owner exited ${code}: ${stderr}`)));
        }),
    ),
    (child) => Effect.sync(() => child.kill("SIGKILL")),
  );

const killed = (child: NodeChildProcess.ChildProcess) =>
  Effect.promise(
    () =>
      new Promise<NodeJS.Signals | null>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve(child.signalCode);
        child.on("exit", (_code, signal) => resolve(signal));
        child.kill("SIGKILL");
      }),
  );

it.live("a server killed with SIGKILL leaves no ownership behind to clear by hand", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "factory-owner-" });
    const home = yield* HostProcess.HomeDirectory;
    const statePath = NodePath.join(root, "userdata", "server-runtime.json");

    yield* Effect.scoped(
      Effect.gen(function* () {
        const owner = yield* startOwner(statePath, home);
        const refused = yield* Effect.scoped(acquireServerOwnership(statePath)).pipe(Effect.flip);
        assert.equal(refused._tag, "ServerAlreadyRunningError");
        assert.equal(yield* killed(owner), "SIGKILL");
      }),
    );

    // The killed owner's record is still on disk; the lock is not.
    assert.isTrue(yield* fs.exists(statePath));
    yield* Effect.scoped(acquireServerOwnership(statePath));
  }).pipe(Effect.provide(ownershipLayer)),
);
