import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

/**
 * The restart behind `POST /api/factory/restart` (`http.ts`): `request` begins it once and
 * answers `pending` to every later call, because this process is on its way out. `make` takes
 * the exit that ends the process, so the route's tests count calls instead of exiting vitest.
 */
export class ServerExit extends Context.Service<
  ServerExit,
  { readonly request: Effect.Effect<"started" | "pending"> }
>()("t3/factory/t3/exit/ServerExit") {}

/**
 * How long the 202 gets to leave the socket before the shutdown starts. Written before the
 * process begins to close, so the caller always receives the response; the restart itself takes
 * launchd about 10 seconds either way.
 */
export const RESTART_GRACE = "500 millis";

/** How long the normal shutdown gets before `process.exit(0)` ends the process regardless. */
export const EXIT_FALLBACK_MS = 10_000;

/**
 * The first `request` forks a detached fiber that waits out the grace, logs the line that tells a
 * requested restart from a crash in the launchd log, and runs `exit`; it answers `started` at
 * once, so the handler's response leaves before the process begins to close.
 */
export const make = (
  exit: Effect.Effect<void>,
  grace: Duration.Input = RESTART_GRACE,
): ServerExit["Service"] => {
  const pending = Ref.makeUnsafe(false);
  return {
    request: Effect.gen(function* () {
      if (yield* Ref.getAndSet(pending, true)) return "pending";
      yield* Effect.forkDetach(
        Effect.sleep(grace).pipe(
          Effect.andThen(Effect.logInfo("factory restart requested")),
          Effect.andThen(exit),
        ),
      );
      return "started";
    }),
  };
};

/**
 * Ends the process the way `t3 serve` handles a stop: SIGTERM to itself, which `runMain` turns
 * into an interrupt, so the scope closes as for `launchctl stop`. The `exit` listener turns
 * runMain's 130 into 0 (a requested restart is clean to launchd) and leaves other codes alone. A
 * hung shutdown is cut short by `process.exit(0)` after `fallbackMs`, with a line on stderr.
 */
export const exitProcess = (fallbackMs = EXIT_FALLBACK_MS): void => {
  process.once("exit", (code) => {
    if (code === 130) process.exitCode = 0;
  });
  // @effect-diagnostics-next-line globalTimers:off - must fire while the Effect runtime is shutting down or stuck.
  setTimeout(() => {
    process.stderr.write(`factory restart: shutdown did not finish in ${fallbackMs}ms, exiting\n`);
    process.exit(0);
  }, fallbackMs).unref();
  process.kill(process.pid, "SIGTERM");
};

export const layer = Layer.sync(ServerExit, () => make(Effect.sync(() => exitProcess())));
