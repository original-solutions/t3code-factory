# Scripts

All under `factory/scripts/`, run from a clone of the repo. Each uses `set -euo pipefail`: an unlisted failure exits with the failing command's code.

## check.sh

The fork's one check: the factory gate and the `Check` job of `factory-ci`.

|        |                                                                                                                                   |
| ------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Usage  | `factory/scripts/check.sh`                                                                                                        |
| Steps  | `check-seams.sh`; `vp test run apps/server/src/factory`; `vp run --filter t3 typecheck`; `vp run --filter @t3tools/web typecheck` |
| Prints | `check: <command>` before each step                                                                                               |
| 0      | Every step passed.                                                                                                                |
| other  | The first failing step's exit code.                                                                                               |

## check-seams.sh

Fails when a committed file differs from the upstream commit in `factory/UPSTREAM` and is neither factory-owned nor listed in `factory/SEAMS`.

|               |                                                                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Usage         | `factory/scripts/check-seams.sh`                                                                                                                                                |
| Factory-owned | `apps/server/src/factory/`, `apps/web/src/factory/`, `factory/`, `.dw/`, `apps/web/src/routes/factory*`, `apps/web/src/routes/settings.factory*`, `.github/workflows/factory-*` |
| Prints        | `check-seams: not a listed seam: <path>` per offender                                                                                                                           |
| 0             | No offender.                                                                                                                                                                    |
| 1             | At least one offender.                                                                                                                                                          |

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

|         |                                                                                                                                   |
| ------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Usage   | `factory/scripts/build.sh [--print-version]`                                                                                      |
| Output  | `release/t3fac-<version>-darwin-arm64.tar.gz`; its absolute path is the last line printed                                         |
| Version | `<upstream nightly version>+fac.<short sha>`; the `apps/server/package.json` version when `factory/UPSTREAM` names no nightly tag |
| Env     | `T3FAC_REPO_ROOT` (default: git top level), `T3FAC_SMOKE_TIMEOUT` (default 60 seconds)                                            |
| Needs   | `vp`, stable Rust (`cargo`)                                                                                                       |
| 0       | Built and smoke-tested, or `--print-version`.                                                                                     |
| 1       | Dirty tree; unreadable `SEA_NODE_VERSION`; smoke test failed (`smoke: FAILED: ...`).                                              |

## install.sh

|         |                                                                                                                                                                                                                                      |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Usage   | `factory/scripts/install.sh <t3fac-<version>-darwin-arm64.tar.gz>`                                                                                                                                                                   |
| Does    | Unpacks to `~/.local/share/t3fac/versions/<version>`, sets `previous` to the old `current`, points `current` at the new version, reloads `io.github.rawphp.t3fac.logrotate`, restarts `io.github.rawphp.t3fac`, waits for health.    |
| Healthy | Port accepts connections and the log gains `factory started` or `no factory config` after the restart.                                                                                                                               |
| Env     | `T3FAC_HEALTH_WAIT` (default 90 seconds), `T3FAC_UNLOAD_WAIT` (default 10 seconds)                                                                                                                                                   |
| Prints  | `installed <version>`, `current -> versions/<version>`, `job io.github.rawphp.t3fac restarted`                                                                                                                                       |
| 0       | Installed and healthy.                                                                                                                                                                                                               |
| 1       | Missing or misnamed archive; no `t3` in it; health check failed (then rolls back: `install of <v> failed its health check; rolled back to <p>`, or `...; rollback to <p> failed too`, or `...; no earlier version to roll back to`). |

## rollback.sh

|        |                                                                                                |
| ------ | ---------------------------------------------------------------------------------------------- |
| Usage  | `factory/scripts/rollback.sh`                                                                  |
| Does   | Points `current` at `previous`, restarts both jobs, removes `previous`, runs the health check. |
| Prints | `rolled back to <version>`                                                                     |
| 0      | Rolled back and healthy.                                                                       |
| 1      | `no earlier version to roll back to`; or `rollback to <v> from <c> failed its health check`.   |

## stop-run.sh

|        |                                                                                                                                                    |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Usage  | `factory/scripts/stop-run.sh <run id>`                                                                                                             |
| Env    | `T3FAC_DATA` (default `~/.config/t3fac/factory`)                                                                                                   |
| Does   | Writes `<data dir>/stop-requests/<run id>`. The next pass archives the session, removes the worktree and sets `factory:stuck` ("stopped by hand"). |
| Prints | `stop requested: <id>; the issue goes to factory:stuck on the next pass`                                                                           |
| 0      | Request written.                                                                                                                                   |
| 1      | Wrong argument count; a run id that names a path; no ledger; run finished; run not `building` (the message says what to do instead).               |

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

|           |                                                                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Usage     | `factory/scripts/sync.sh [prepare <dir> \| publish <dir>]`; no argument runs both                                                    |
| Env       | `SYNC_UPSTREAM` (default `https://github.com/pingdotgg/t3code`)                                                                      |
| `prepare` | Merges the tag on `sync/<tag>`, runs `vp i` and `check.sh`, writes the outcome and a bundle to `<dir>`. No write token.              |
| `publish` | Verifies the bundle, then pushes, lands, or files an issue.                                                                          |
| 0         | Up to date; waiting on an open sync PR; merged into `main`; or `prepare` recorded an outcome.                                        |
| 1         | Anything that files an issue (conflicts, failing checks, cannot push, cannot land, route-tree review, stuck) or a bad tag or remote. |
| 2         | Wrong arguments.                                                                                                                     |
