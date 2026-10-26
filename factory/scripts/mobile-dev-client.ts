#!/usr/bin/env node
// Starts Metro for the fork's dev client. Upstream's dev:client scripts pass --scheme t3code-dev,
// which the fork's dev build does not register (apps/mobile/src/factory/mobileIdentity.ts). Expo
// reads the scheme from --scheme or the prebuilt native folders, not app.config.ts.
//
//   node factory/scripts/mobile-dev-client.ts [expo start args]
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

import { FORK_MOBILE_VARIANTS } from "../../packages/shared/src/forkIdentity.ts";

const mobile = NodePath.resolve(import.meta.dirname, "../../apps/mobile");

const result = NodeChildProcess.spawnSync(
  NodePath.join(mobile, "node_modules/.bin/expo"),
  [
    "start",
    "--dev-client",
    "--scheme",
    FORK_MOBILE_VARIANTS.development.scheme,
    "--lan",
    ...process.argv.slice(2),
  ],
  { cwd: mobile, env: { ...process.env, APP_VARIANT: "development" }, stdio: "inherit" },
);

if (result.error) {
  console.error(`mobile-dev-client: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
