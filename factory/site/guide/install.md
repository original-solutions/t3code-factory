# Install and run

The factory runs in a T3 server started by a macOS LaunchAgent, or by a systemd user unit [on Linux](#on-linux). The desktop app is optional: it is a window onto that server. The server is built from a clone of this repo on the machine that runs it; the app comes signed from the repo's releases.

## Before you start

- Clone [original-solutions/t3code-factory](https://github.com/original-solutions/t3code-factory) and run `vp i` in it.
- Install current stable Rust (`rustup update stable`). The build compiles a small native helper.
- Log in a GitHub CLI config directory as the login the factory will act as:

  ```sh
  GH_CONFIG_DIR=~/.config/t3fac/gh gh auth login
  GH_CONFIG_DIR=~/.config/t3fac/gh gh api user --jq .login
  ```

  The LaunchAgent sets `GH_CONFIG_DIR` to this directory, so the server's own GitHub calls and its agent sessions act as this login. Gate commands don't inherit `GH_CONFIG_DIR` ([Add a repo](/guide/add-a-repo)); a gate that calls `gh` must set it itself.

## Install the server

From a clean checkout, build and install in one step:

```sh
factory/scripts/deploy.sh
```

It builds `release/t3fac-<version>-darwin-arm64.tar.gz`, smoke-tests it, then installs it: the archive is unpacked under `~/.local/share/t3fac/versions/`, `~/.local/share/t3fac/current` points at it, and the LaunchAgent `io.github.rawphp.t3fac` restarts the server on port 3876 with its data in `~/.config/t3fac`. A second LaunchAgent, `io.github.rawphp.t3fac.logrotate`, rotates the log, and a third, `io.github.rawphp.t3fac.autodeploy`, [follows `main`](#follow-main) once you turn it on.

`deploy.sh` reuses an archive already built for the same commit. Pass `--rebuild` to build again, or `--build-only` to stop before installing. [Scripts](/agents/scripts) lists every script and its exit codes.

The install waits up to 90 seconds for the server to answer on port 3876 and to log `factory started` or `no factory config`. If it doesn't, the install rolls back to the previous version and exits 1. With no [machine config](/guide/machine-config) yet, the server logs `no factory config` and the factory stays idle.

### Tools the server can see

launchd starts the server with the `PATH` its plist sets, which covers Homebrew, `/usr/bin` and `vp`. At startup the server also reads your login shell's `PATH` and adds it, so agent sessions see the tools your shell does. Every command the factory runs itself, provision and gate included, gets the plist's `PATH`, with `~/.config/t3fac/env` applied, first, and the login shell's entries after it, so a tool in the env file's `PATH` wins over the login shell's. The plist's own directories, `/usr/bin` included, also come before the login shell's, so a version manager's shims (pyenv, mise, asdf) reach those commands only when the env file prepends them. Put tools gates need there, such as `claude`, `cargo`, `php` or `composer`; the job sources the file before it starts the server. Append a directory to add a tool. Prepend it to shadow one the plist's `PATH` already has, such as the `python3` in `/usr/bin`:

```sh
PATH="/opt/homebrew/opt/python@3.13/libexec/bin:$PATH:$HOME/.cargo/bin"
export PATH
```

Check what the running job has with `launchctl print gui/$(id -u)/io.github.rawphp.t3fac`.

## Follow main

Once it is on, the server follows `main` on its own. Every 10 minutes the autodeploy job fetches a clone kept for it, and when `origin/main` is not the installed commit it builds and installs that commit with `deploy.sh`, health check and rollback included. Each deploy restarts the server, so it waits while an agent is at work in any thread, yours or the factory's, while a factory run has a gate at work, or while a pass is running, and tries again on the next tick. A thread waiting on your answer doesn't hold it up.

While a build waits, the factory claims no new issue, so the runs in progress can finish, and each `waiting to deploy` line in `autodeploy.log` says how long the build has waited. After `deploy_wait_minutes` in the [machine config](/guide/machine-config) (default 120) the job installs anyway: factory runs in progress resume on the new version, and a thread of yours with an agent at work is interrupted, which you continue in T3. If autodeploy stops running, the server ignores its marker after 30 minutes and claims again.

The [Factory page](/guide/watching-runs) shows a waiting build in a banner on the belt, with when it installs at the latest. **Snooze 1 hour** lets the factory claim as normal and holds the install for the hour; when the snooze ends, the wait starts again. A build can be snoozed 3 times. **Update now** installs the build at once, over the runs in progress. When the restart would interrupt something, it first lists the runs in progress, says whether a factory pass is running and how many threads have an agent at work, and asks you to confirm.

A build that fails, or is still going after an hour, is tried again on the next two ticks; after the third failure that commit is left until `main` moves. A commit that fails its health check is left at once.

After a deploy that passes its health check, the job deletes old versions from `~/.local/share/t3fac/versions` and logs each one in `autodeploy.log`. It keeps the current version and 3 others: the one `rollback.sh` returns to, then the most recently installed. Set `keep_versions` in the [machine config](/guide/machine-config) to keep a different number; `0` keeps only the current version, which leaves nothing to roll back to. A failed deploy deletes nothing, and neither does an install or rollback you run by hand. A `keep_versions` the job cannot read as one plain number, such as a quoted key, deletes nothing either, and the log says so.

The job builds with its plist's `PATH`, which covers Homebrew, `vp` and `~/.cargo/bin` from rustup, plus anything `~/.config/t3fac/env` adds to it.

To turn it on, make a clone used for nothing else, and mint a token that can read the factory's status:

```sh
git clone https://github.com/original-solutions/t3code-factory ~/.local/share/t3fac/clone
~/.local/share/t3fac/current/t3 auth session issue --base-dir ~/.config/t3fac \
  --scope orchestration:read --ttl 365d --label autodeploy --token-only
```

Then add both to `~/.config/t3fac/env`. Leave out `export`, so the server and its sessions don't get the token:

```sh
T3FAC_AUTODEPLOY_CLONE="$HOME/.local/share/t3fac/clone"
T3FAC_AUTODEPLOY_TOKEN=<token>
```

When the token expires, the log says it cannot read the status and nothing deploys until you mint a new one.

A deploy or rollback you run by hand stays until `main` moves: the next tick leaves it in place and logs that it is doing so.

To turn it off, remove `T3FAC_AUTODEPLOY_CLONE` from `~/.config/t3fac/env`. To stop the job until the next install or rollback, run `launchctl bootout gui/$(id -u)/io.github.rawphp.t3fac.autodeploy`. To remove it, run that, then delete `~/Library/LaunchAgents/io.github.rawphp.t3fac.autodeploy.plist` and `~/.local/share/t3fac/autodeploy.sh`; a later install puts them back. If a build was waiting when you stopped the job, also delete `~/.config/t3fac/factory/deploy-pending`, or every pass logs it as stale.

## On Linux

The same scripts install and update the server on an x64 or arm64 Linux machine. Each name below stands in for the macOS one above:

| macOS                                                              | Linux                                                                       |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `t3fac-<version>-darwin-arm64.tar.gz`                              | `t3fac-<version>-linux-x64.tar.gz` (or `linux-arm64`)                       |
| LaunchAgent `io.github.rawphp.t3fac`                               | `~/.config/systemd/user/t3fac.service`                                      |
| `io.github.rawphp.t3fac.logrotate`, `.autodeploy`                  | `t3fac-logrotate.timer`, `t3fac-autodeploy.timer`, each with its `.service` |
| `~/Library/Logs/t3fac/`                                            | `~/.local/state/t3fac/`                                                     |
| `launchctl print gui/$(id -u)/io.github.rawphp.t3fac`              | `systemctl --user status t3fac`                                             |
| `launchctl bootout gui/$(id -u)/io.github.rawphp.t3fac.autodeploy` | `systemctl --user disable --now t3fac-autodeploy.timer`                     |

For the server to run while you are logged out, and to start at boot, turn on lingering once: `loginctl enable-linger $USER`. The install overwrites `t3fac.service` from its template, so put machine settings in `~/.config/t3fac/env`, not in the unit. **Update now** on the Factory page starts `t3fac-autodeploy.service` at once.

## Install the desktop app

Every merge to `main` publishes a signed, notarized build for Apple silicon as a prerelease.

1. Open the newest prerelease on the [releases page](https://github.com/original-solutions/t3code-factory/releases) and download its `.dmg`.
2. Open the dmg and drag `T3 Code Factory (Nightly)` to Applications.
3. Open the app from Applications.

You install it once. When a newer build is published, the app shows "Update available"; choose "Restart to update" to install it. The app installs beside upstream T3 Code and shares no data with it.

To build it yourself instead, run `vp run dist:desktop:dmg:arm64`. That dmg lands under `release/` and is unsigned, so the first time you open the app, right-click it and choose Open. It has no update feed.

The app runs no server of its own. It opens onto the LaunchAgent server on port 3876, so install the server first and keep it running. The first time you open the app it asks for a pairing link. Make one with:

```sh
~/.local/share/t3fac/current/t3 pair --base-dir ~/.config/t3fac
```

Paste the link into the app. It remembers the pairing, so later launches open straight onto the server. If the server is down, the app can't load until it's back; use Try again, or wait for it to reconnect. The Factory pages in the app show that server directly.

Add `--tailscale` for a link that works over your tailnet, for example from a phone's browser. The Factory pages are part of the fork's web app, so any browser paired with the server can open them. A connection through T3 Connect (the relay) doesn't reach them yet. [Remote access](https://github.com/pingdotgg/t3code/tree/main/docs/user/remote-access.md) covers pairing in general.

## Logs

| File                                          | What it holds                                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `~/Library/Logs/t3fac/t3fac.log`              | The server's output, including each factory pass. Rotated at 20 MB, five copies kept.             |
| `~/Library/Logs/t3fac/logrotate.log`          | One line per rotation.                                                                            |
| `~/Library/Logs/t3fac/autodeploy.log`         | One line per deploy, failed deploy, deleted version or wait while [following main](#follow-main). |
| `~/Library/Logs/t3fac/autodeploy-build.log`   | The build and install output of the latest autodeploy attempt.                                    |
| `~/.config/t3fac/factory/events.jsonl`        | The factory's machine log: passes, skipped repos, errors, server starts and stops.                |
| `~/.config/t3fac/factory/runs/<run id>.jsonl` | One ledger per run. The run's page shows it.                                                      |

To tell whether the server is up:

```sh
launchctl print gui/$(id -u)/io.github.rawphp.t3fac
tail -n 50 ~/Library/Logs/t3fac/t3fac.log
```

No `pid` line means the job isn't running. A non-zero `last exit code` with a growing `runs` count is a crash loop. A config error is logged as `<file>: <field>: <message>`, and the factory stays idle until it is fixed.

## Roll back

```sh
factory/scripts/rollback.sh
```

It points `current` back at the previous version, restarts the server and runs the same health check. With no previous version it exits 1; install an older archive from `release/` with `factory/scripts/install.sh <archive>` instead.

While [autodeploy](#follow-main) is on, the rollback lasts until `main` moves; then the new `main` is deployed. To stay on the older version past that, turn autodeploy off first.

## Restart without installing

A paired session with the `environment:maintain` scope can restart the server:

```sh
curl -X POST -H "Authorization: Bearer <token>" http://127.0.0.1:3876/api/factory/restart
```

launchd starts it again about 10 seconds later, on the version `current` points at. A gate that was running is killed, and the next pass runs it again from a fresh checkout.
