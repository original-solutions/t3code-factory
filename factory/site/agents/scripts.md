# Scripts

All under `factory/scripts/`, run from a clone of the repo. Each uses `set -euo pipefail`: an unlisted failure exits with the failing command's code.

## check.sh

The fork's one check: the factory gate and the `Check` job of `factory-ci`.

|        |                                                                                                                                                                                                        |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Usage  | `factory/scripts/check.sh`                                                                                                                                                                             |
| Steps  | `check-seams.sh`; `vp test run apps/server/src/factory apps/mobile/src/factory`; `vp run --filter t3 typecheck`; `vp run --filter @t3tools/web typecheck`; `vp run --filter @t3tools/mobile typecheck` |
| Prints | `check: <command>` before each step                                                                                                                                                                    |
| 0      | Every step passed.                                                                                                                                                                                     |
| other  | The first failing step's exit code.                                                                                                                                                                    |

## check-seams.sh

Fails when a committed file differs from the upstream commit in `factory/UPSTREAM` and is neither factory-owned nor listed in `factory/SEAMS`.

|               |                                                                                                                                                                                                                                                |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Usage         | `factory/scripts/check-seams.sh`                                                                                                                                                                                                               |
| Factory-owned | `apps/server/src/factory/`, `apps/web/src/factory/`, `apps/desktop/src/factory/`, `apps/mobile/src/factory/`, `factory/`, `.dw/`, `apps/web/src/routes/factory*`, `apps/web/src/routes/_chat.settings.factory*`, `.github/workflows/factory-*` |
| Prints        | `check-seams: not a listed seam: <path>` per offender                                                                                                                                                                                          |
| 0             | No offender.                                                                                                                                                                                                                                   |
| 1             | At least one offender.                                                                                                                                                                                                                         |

## deploy.sh

`build.sh`, then `install.sh` on the archive.

|                |                                                                                       |
| -------------- | ------------------------------------------------------------------------------------- |
| Usage          | `factory/scripts/deploy.sh [--rebuild] [--build-only]`                                |
| `--rebuild`    | Build even when `release/t3fac-<version>-darwin-arm64.tar.gz` exists for this commit. |
| `--build-only` | Stop after the build.                                                                 |
| 0              | Installed, or built with `--build-only`.                                              |
| 1              | Uncommitted changes; or the build left no archive.                                    |
| 2              | Unknown argument.                                                                     |
| other          | `build.sh` or `install.sh` failed with that code.                                     |

## build.sh

Builds the server archive and smoke-tests it.

|         |                                                                                                                                          |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Usage   | `factory/scripts/build.sh [--print-version \| --print-node-version]`                                                                     |
| Output  | `release/t3fac-<version>-darwin-arm64.tar.gz`; its absolute path is the last line printed                                                |
| Version | `<upstream nightly version>+fac.<short sha>`; the `apps/server/package.json` version when `factory/UPSTREAM` names no nightly tag        |
| Env     | `T3FAC_REPO_ROOT` (default: git top level), `T3FAC_SMOKE_TIMEOUT` (default 60 seconds)                                                   |
| Needs   | `node`, `vp`, stable Rust (`cargo`)                                                                                                      |
| Node    | `engines.node` from the root `package.json`, else `SEA_NODE_VERSION` from `apps/server/vite.config.ts`; `--print-node-version` prints it |
| 0       | Built and smoke-tested, or `--print-version` / `--print-node-version`.                                                                   |
| 1       | Dirty tree; no Node version in either source (`could not read the SEA Node version: ...`); smoke test failed (`smoke: FAILED: ...`).     |

## install.sh

|         |                                                                                                                                                                                                                                                                                                                                       |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Usage   | `factory/scripts/install.sh <t3fac-<version>-darwin-arm64.tar.gz>`                                                                                                                                                                                                                                                                    |
| Does    | Unpacks to `~/.local/share/t3fac/versions/<version>`, sets `previous` to the old `current`, points `current` at the new version, reloads `io.github.rawphp.t3fac.logrotate` and `io.github.rawphp.t3fac.autodeploy`, restarts `io.github.rawphp.t3fac`, waits for health.                                                             |
| Healthy | Port accepts connections and the log gains `factory started` or `no factory config` after the restart.                                                                                                                                                                                                                                |
| Env     | `T3FAC_HEALTH_WAIT` (default 90 seconds), `T3FAC_UNLOAD_WAIT` (default 10 seconds)                                                                                                                                                                                                                                                    |
| Prints  | `installed <version>`, `current -> versions/<version>`, `job io.github.rawphp.t3fac restarted`                                                                                                                                                                                                                                        |
| 0       | Installed and healthy.                                                                                                                                                                                                                                                                                                                |
| 1       | Missing or misnamed archive; another deploy holds `~/.local/share/t3fac/deploy.lock` (`another deploy is running (pid <n>)`); no `t3` in it; health check failed (then rolls back: `install of <v> failed its health check; rolled back to <p>`, or `...; rollback to <p> failed too`, or `...; no earlier version to roll back to`). |

## autodeploy.sh

Run every 10 minutes by the `io.github.rawphp.t3fac.autodeploy` LaunchAgent, from the copy `install.sh` puts in `~/.local/share/t3fac`. Deploys `origin/main` from a dedicated clone.

|        |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Usage  | `~/.local/share/t3fac/autodeploy.sh`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Env    | From `~/.config/t3fac/env`: `T3FAC_AUTODEPLOY_CLONE` (unset: only removes `deploy-pending`), `T3FAC_AUTODEPLOY_TOKEN` (scope `orchestration:read`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Skips  | Silently when `origin/main` is the `+fac.<sha>` of `current` or the last commit that failed. With a line, recording `origin/main` as failed, after `install.sh` or `rollback.sh` was run by hand (they leave `~/.local/share/t3fac/autodeploy.hold`). With a line when a run is in progress or an agent is at work in a thread (`GET /api/factory/status`), the status cannot be read, or another autodeploy holds `~/.local/share/t3fac/autodeploy.lock`. Before the install, with a line when another deploy holds `~/.local/share/t3fac/deploy.lock` or one ran by hand during the build; the next tick reuses the build. |
| Does   | Checks the commit out in the clone, `deploy.sh --build-only`, checks the status again, then `deploy.sh`. Build output goes to `~/Library/Logs/t3fac/autodeploy-build.log`. After a deploy that passed its health check, deletes the directories in `~/.local/share/t3fac/versions` beyond `current`, `previous` and the most recently installed others, `keep_versions` from the machine config in all (default 3; 0 keeps only `current`).                                                                                                                                                                                  |
| Prints | `deployed <sha>`, `pruned versions/<version>`, `could not prune versions/<version>`, `not pruning versions: cannot read keep_versions ...`, or `deploy of <sha> failed; ...`, one line each                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 0      | Deployed, nothing to do, or waiting.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 1      | Fetch failed; the build failed or ran past an hour (retried on the next two ticks, counted in `~/.local/share/t3fac/autodeploy.attempts`); or the install failed or the third build did, which records the commit in `~/.local/share/t3fac/autodeploy.failed`.                                                                                                                                                                                                                                                                                                                                                               |

## rollback.sh

|        |                                                                                                                                     |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Usage  | `factory/scripts/rollback.sh`                                                                                                       |
| Does   | Points `current` at `previous`, reloads the timer jobs, restarts the server, removes `previous`, runs the health check.             |
| Prints | `rolled back to <version>`                                                                                                          |
| 0      | Rolled back and healthy.                                                                                                            |
| 1      | `no earlier version to roll back to`; `another deploy is running (pid <n>)`; or `rollback to <v> from <c> failed its health check`. |

## stop-run.sh

|        |                                                                                                                                                    |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Usage  | `factory/scripts/stop-run.sh <run id>`                                                                                                             |
| Env    | `T3FAC_DATA` (default `~/.config/t3fac/factory`)                                                                                                   |
| Does   | Writes `<data dir>/stop-requests/<run id>`. The next pass archives the session, removes the worktree and sets `factory:stuck` ("stopped by hand"). |
| Prints | `stop requested: <id>; the issue goes to factory:stuck on the next pass`                                                                           |
| 0      | Request written.                                                                                                                                   |
| 1      | Wrong argument count; no ledger; run finished; run not `building` (the message says what to do instead).                                           |

## rotate-log.sh

Run every 10 minutes by `io.github.rawphp.t3fac.logrotate`; installed to `~/.local/share/t3fac/rotate-log.sh`.

|        |                                                                                                                                           |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Usage  | `rotate-log.sh <file> [max_mb] [keep]`, defaults 20 and 5                                                                                 |
| Does   | When `<file>` is over `max_mb`, copies it to `<file>.1`, shifts older copies (`.2.gz` and up), keeps `keep`, truncates `<file>` in place. |
| Prints | `rotated <file> (<size> bytes)`                                                                                                           |
| 0      | Rotated, or nothing to do.                                                                                                                |
| 1      | Bad arguments; copy failed (nothing changed).                                                                                             |

## regenerate-routes.sh

Rewrites `apps/web/src/routeTree.gen.ts` with the TanStack generator, for a sync conflict in that file. Needs `vp i` first.

|        |                                                                               |
| ------ | ----------------------------------------------------------------------------- |
| Usage  | `factory/scripts/regenerate-routes.sh`                                        |
| Prints | `regenerated <path>`                                                          |
| 0      | Regenerated.                                                                  |
| 1      | `apps/web/vite.config.ts` calls `tanstackRouter` differently from the script. |

## sync.sh

Merges upstream's newest `v*-nightly.*` tag into `main` through a pull request. Run daily by `.github/workflows/factory-sync.yml`.

|           |                                                                                                                                                                                                                                               |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Usage     | `factory/scripts/sync.sh [prepare <dir> \| publish <dir>]`; no argument runs both                                                                                                                                                             |
| Env       | `SYNC_UPSTREAM` (default `https://github.com/pingdotgg/t3code`); a non-empty `GITHUB_ACTIONS` makes `publish` dispatch after landing; `publish` pushes with `SYNC_APP_TOKEN` when `SYNC_APP_CONFIGURED` is `true`, else `SYNC_TOKEN` when set |
| `prepare` | Merges the tag on `sync/<tag>`, runs `vp i` and `check.sh`, writes the outcome and a bundle to `<dir>`. No write token.                                                                                                                       |
| `publish` | Verifies the bundle, then pushes, lands, or files an issue. Inside the workflow, a landing then dispatches Factory CI and desktop, unless a sync secret pushed it, and, when the merge touched `apps/mobile` or `packages`, mobile.           |
| 0         | Up to date; waiting on an open sync PR; merged into `main`; or `prepare` recorded an outcome.                                                                                                                                                 |
| 1         | Anything that files an issue (conflicts, failing checks, cannot push, cannot land, route-tree review, stuck), a failed dispatch, or a bad tag or remote.                                                                                      |
| 2         | Wrong arguments.                                                                                                                                                                                                                              |

## Desktop release scripts

Run by `.github/workflows/factory-desktop.yml` on every push to `main`. `desktop-preflight.sh` and `desktop-notarize-dmg.sh` read the signing secrets of the `desktop-release` environment from the environment and print none of them. Those two and `desktop-verify.sh` need macOS.

| Script                                     | Does                                                                                                                                                  | Non-zero when                                                                          |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `desktop-preflight.sh`                     | Checks the Developer ID certificate, the provisioning profile and the notarization API key. Also run by hand through `factory-desktop-preflight.yml`. | A secret is empty or fails its check; a `::error::` line names it.                     |
| `desktop-version.sh <run> [YYYYMMDD]`      | Prints `<apps/desktop version>-nightly.<date>.<run>`; the date defaults to today in UTC.                                                              | The run or date is not a plain number; the package version is not `MAJOR.MINOR.PATCH`. |
| `desktop-notarize-dmg.sh <dmg> <manifest>` | Signs, notarizes and staples the dmg, then runs `desktop-restamp-dmg.ts`.                                                                             | Any step fails.                                                                        |
| `desktop-restamp-dmg.ts <dmg> <manifest>`  | Rebuilds `<dmg>.blockmap` and rewrites the dmg's `sha512` and `size` in the update manifest, after stapling changed the dmg. Run with `node`.         | The manifest does not list the dmg (nothing written).                                  |
| `desktop-verify.sh <dmg> <zip>`            | `xcrun stapler validate` on the dmg; `codesign --verify --deep --strict` and `spctl -a -vv` on the `.app` in the zip and in the dmg.                  | Any check fails.                                                                       |

## Mobile release scripts

Run by `.github/workflows/factory-mobile.yml` after pushes to `main` that change mobile code. `mobile-preflight.sh` reads the signing secrets of the `mobile-release` environment from the environment and prints none of them; past the check that each one is set, it needs macOS.

| Script                                                                  | Does                                                                                                                                                                                     | Non-zero when                                                                          |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `mobile-preflight.sh`                                                   | Checks the Apple Distribution certificate and the App Store profiles of the app, widgets and share extension (team, bundle id, type, expiry, entitlements), and that the API key is set. | A secret is empty or fails its check; a `::error::` line names it.                     |
| `mobile-sign-project.ts <app dir> <team> <bundle id>=<profile name>...` | Sets manual signing with Apple Distribution and the named profile on every build configuration of the prebuilt iOS project that has a bundle id. Run with `node`.                        | A target's bundle id has no profile, or a profile matches no target (nothing written). |

## mobile-dev-client.ts

Starts Metro for the fork's development dev client, in place of upstream's `vp run dev:client`, whose `--scheme t3code-dev` the fork's dev build does not register.

|       |                                                                                                         |
| ----- | ------------------------------------------------------------------------------------------------------- |
| Usage | `node factory/scripts/mobile-dev-client.ts [expo start args]`, e.g. `--clear`                           |
| Runs  | `expo start --dev-client --scheme t3code-factory-dev --lan` in `apps/mobile`, `APP_VARIANT=development` |
| Exit  | Expo's exit code.                                                                                       |
