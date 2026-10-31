// @effect-diagnostics nodeBuiltinImport:off - one launchctl or systemctl call with a timeout, which execFile gives directly.
import * as NodeChildProcess from "node:child_process";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * Starts an autodeploy tick now, for `POST /api/factory/deploy/now` (`http.ts`). `kick` answers
 * whether launchd or systemd took the request; false on a dev server or a machine without the
 * autodeploy job, where the next scheduled tick picks the request up. The route's tests inject one
 * that never runs a command.
 */
export class DeployKick extends Context.Service<
  DeployKick,
  { readonly kick: Effect.Effect<boolean> }
>()("t3/factory/t3/deployKick") {}

/**
 * The command that starts the autodeploy job, named in factory/scripts/lib/platform.sh, without
 * stopping a tick that is already running: `launchctl kickstart` without `-k`, or `systemctl start`
 * of the oneshot unit, which leaves an active run alone. `--no-block` answers once systemd queued
 * the start rather than after the whole tick. Null where no such job exists.
 */
const autodeployKickCommand = (
  platform: NodeJS.Platform,
  uid: number | undefined,
): readonly [string, ReadonlyArray<string>] | null => {
  if (platform === "darwin" && uid !== undefined) {
    return ["launchctl", ["kickstart", `gui/${uid}/io.github.rawphp.t3fac.autodeploy`]];
  }
  if (platform === "linux") {
    return ["systemctl", ["--user", "start", "--no-block", "t3fac-autodeploy.service"]];
  }
  return null;
};

const kickstart = Effect.gen(function* () {
  const command = autodeployKickCommand(yield* HostProcess.Platform, yield* HostProcess.UserId);
  if (command === null) return false;
  return yield* Effect.callback<boolean>((resume) => {
    NodeChildProcess.execFile(command[0], command[1], { timeout: 10_000 }, (error) =>
      resume(Effect.succeed(error === null)),
    );
  });
});

export const layer = Layer.succeed(DeployKick, { kick: kickstart });
