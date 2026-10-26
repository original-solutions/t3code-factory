# Factory inside a T3 Code fork: experiment design

Status: draft for Tom's review. Date: 2026-10-15.

## Why

softfac and T3 Code are two apps today. softfac is a Rust daemon that drives a separate `t3 serve` over an undocumented wire format. That means two installs, two LaunchAgents, two update paths, two logs, and an orchestration layer that copies thread state into its own ledger so it can survive crashes between "send" and "record".

The experiment puts the factory inside a fork of T3 Code as one product. The factory code knows T3's internals. T3's code never imports the factory. The fork keeps taking upstream changes.

This is an experiment. The Rust softfac keeps running and keeps building its repos. The fork replaces it only if the numbers below say it should.

## What we know about T3 Code (main at 339179f, 2026-10-15)

- pnpm monorepo on Node 24, Effect v4, vitest, oxlint, all wrapped by the `vp` (Vite+) toolchain. MIT licence.
- `apps/server` is the `t3` CLI. `apps/web` is React 19 with TanStack Router and file-based routes. `apps/desktop` is Electron.
- The server is one Effect `Layer` graph in `apps/server/src/server.ts`. Background workers sit in `layerRuntimeCoreDependenciesBase` as `Layer.effectDiscard(...)` entries. `PullRequestSyncReactor` is a worker that reads projections and dispatches commands, which is the same shape the factory needs.
- Orchestration v2 is event-sourced on SQLite (`<base>/userdata/statev2.sqlite`). In-process entry points:
  - `OrchestratorV2.dispatch(command)` for every thread command, with command receipts, so a command id is idempotent.
  - `EventSinkV2.stream({ threadId?, afterSequence?, eventType? })` replays from a sequence and then goes live.
  - `ProjectionStoreV2` is the read model.
  - `ThreadLaunchService` starts a thread in its own worktree.
  - `ProcessRunner.run({ command, args, cwd, env, timeout, maxOutputBytes })` returns stdout, stderr, exit code and a timed-out flag.
- There is no plugin mechanism. Upstream's `AGENTS.md` says many users run forks.
- Upstream moves fast: about 350 commits a week across the repo, about 24 a week in `orchestration-v2/`, about 10 in `server.ts` and about 14 in `ws.ts`.
- Release: `vp pack` builds the server bundle, and `T3CODE_PACK_EXE=1` wraps it as a Node single-executable app (`t3`). `scripts/build-cli-archive.ts` puts `t3`, `client/` (the web build), `resource-monitor/` (a small Rust binary) and the native `node_modules/` into one archive. Nightly versions are `<next patch>-nightly.<YYYYMMDD>.<run number>`, released every 30 minutes when main has changed.

## Shape

```
┌──────────────────────── t3 serve (the fork, one process) ────────────────────────┐
│                                                                                  │
│  upstream T3 (untouched)                     factory (new directories only)      │
│  ─────────────────────────                   ──────────────────────────────      │
│  OrchestratorV2 ◄──── dispatch ───────────── factory/t3/sessions.ts              │
│  EventSinkV2 ─────── stream(run.updated) ──► factory/t3/events.ts ─┐             │
│  ProjectionStoreV2 ◄─ read thread/run ─────── factory/t3/sessions.ts│            │
│  ThreadLaunchService ◄ launch ─────────────── factory/t3/sessions.ts│            │
│  node:child_process ◄ gh, git, gate cmds ──── factory/process.ts    │            │
│  ServerConfig ─────── base dir, worktrees ──► factory/t3/paths.ts   │            │
│                                                                     ▼            │
│  server.ts  +1 line: FactoryLayer ──────────► factory/index.ts ─► pass loop      │
│  server.ts  +1 line: FactoryRoutes ─────────► factory/http.ts      (60s + wakes) │
│                                                                                  │
│  web: routes/factory.tsx,                                                        │
│       routes/factory_.$environmentId.$runId.tsx  ◄── /api/factory/*              │
└──────────────────────────────────────────────────────────────────────────────────┘
         │ gh CLI (GH_CONFIG_DIR)                     │ JSONL ledger
         ▼                                            ▼
      GitHub issues, labels, PRs              <base>/factory/runs/*.jsonl
```

One process, one binary, one log. One LaunchAgent runs the server; a second, `io.github.rawphp.t3fac.logrotate`, only rotates the log on a timer (see "Decisions since the draft"). Agent sessions are ordinary T3 threads, so the T3 UI shows them next to a Factory page.

## Code layout in the fork

```
apps/server/src/factory/
  index.ts          FactoryLayer: the factory's layer, wired from server.ts
  process.ts        node:child_process with env allowlist, process group kill and a bounded output tail
  t3/               the adapter: the only factory code that imports T3 internals
    sessions.ts     launch, send, archive, status over ThreadLaunchService, OrchestratorV2, ProjectionStoreV2
    events.ts       EventSinkV2.stream → wake the run that owns the thread
    paths.ts        ServerConfig → base dir, worktrees dir, factory dir
  domain/           pure: lifecycle states, result-line parsing, approval, limits, fairness
  ledger/           JSONL ledger, same format as softfac docs/reference/ledger.md
  tracker/github.ts gh CLI calls (the same argv softfac uses today)
  runner/           start, building, gating, feedback, interruptions
  gate.ts           checkout + provision + gate commands
  pass.ts           one pass: claims, ordering, slots, then advance each run
  config.ts         <base>/factory/config.yml and the repo's .dw/config.yml factory block
  http.ts           /api/factory/status, /runs, /runs/:id, /runs/:id/stop, /claims/pause
apps/web/src/routes/factory.tsx, factory_.$environmentId.$runId.tsx   the underscore keeps the run route out of the runs list's tree
apps/web/src/factory/               page components
apps/desktop/src/factory/           packaged desktop app: opens onto the LaunchAgent server
apps/mobile/src/factory/            mobile app identity hook for app.config.ts
factory/                            repo root: SEAMS, sync/build/install scripts, docs
.github/workflows/factory-*.yml     the fork's own CI, sync and release
```

### Seams: the only upstream files we edit

A seam is acceptable when it is a hook, not a feature: the smallest edit that calls fork-owned code. [`factory/AGENTS.md`](../AGENTS.md) has the rule. `apps/server/src/ws.ts`, `apps/server/src/rpc.ts`, `packages/contracts/` and `apps/server/src/persistence/Migrations.ts` are never seams. Those are the files upstream churns most, and adding an RPC would touch five of them, so the factory API is a separate HTTP route layer instead. [`factory/SEAMS`](../SEAMS) is the list, and CI fails any change to an upstream file not on it.

### Boundary rules, checked by a test

- Only `apps/server/src/factory/t3/**` may import T3 code: files outside `apps/server/src/factory/`, or the workspace packages (`@t3tools/*` and the rest) the server depends on.
- No file outside `factory/` may import from it, except `server.ts` (its factory hooks) and the routed projection store import in `orchestration-v2/runtimeLayer.ts`.
- The checks run as a vitest test in `apps/server/src/factory/boundary.test.ts`, so they run with the factory suite.

When upstream changes an internal API, the break lands as a type error in `factory/t3/`. Everything above the adapter uses softfac-shaped types (`Launched`, `ThreadStatus`, `Thread`) that we own.

## How the factory runs inside T3

The behaviour is softfac's, as written down in `docs/lifecycle.md` and pinned by `src/runner/tests.rs`. What changes is what sits underneath it.

| softfac today                                                                                | In the fork                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Sessions` trait over HTTP and WebSocket, protocol header, bearer token, websocket ticket    | `factory/t3/sessions.ts` calls services in-process. No token, no ticket, no protocol version.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Poll every 60s for thread status                                                             | Still a 60s pass for GitHub, plus `EventSinkV2.stream` wakes a run as soon as its thread's run settles                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Ledger copies thread id, branch, worktree path and run ordinals                              | The ledger records factory events. Thread facts are read from `ProjectionStoreV2` when needed.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `forward-wait`, `gate-sending` and similar steps survive a crash between "send" and "record" | Kept, but simpler: T3's command receipts dedupe a retried `softfac:<run>:…` command id in the same process                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Gate runs as a detached `softfac gate` child that outlives the daemon                        | Gate runs through `process.ts` inside the server. A server restart kills it, and the next pass re-runs the gate from a fresh checkout.                                                                                                                                                                                                                                                                                                                                                                                                              |
| T3 trouble is a failed T3 call or preflight in the machine log, seen from outside            | The same, plus a run a server restart cut off: the machine log records each start (`server_started`) and each shutdown (`server_stopping`), and the pass reads the last day of starts and, for each, the stop it follows, whatever its age; a run that began before a start and ended at or after that stop, with ten minutes of grace before the stop (a run that ended just before the stop line was written) or before the start when no stop was written, was cut by it, as a restart ends every running turn as `cancelled` and no call fails. |
| `t3 install`, `rollback`, pairing, Open T3 deadline, two LaunchAgents                        | One binary, versioned as a whole, installed by `install.sh` and rolled back by `rollback.sh`. Two LaunchAgents: the server and the log rotator (below).                                                                                                                                                                                                                                                                                                                                                                                             |
| `status`, `runs list/show/stop`, menubar                                                     | The Factory page and `/api/factory/*`. A small CLI can come later if needed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

Kept exactly:

- The `/factory` skill and its last-line protocol (`FACTORY-DONE`, `FACTORY-STOP`). The skill does not know which factory launched it.
- The `factory:*` labels, instructors, `.dw/config.yml` factory block, claims by assignee and label, and comment wording.
- The ledger format. `softfac retro --data-dir <fork base>/factory` then reads the fork's runs with the same code that reads the Rust factory's runs, so the comparison is like for like.

Persistence: JSONL files under `<base>/factory/`, the same layout as `~/.local/share/softfac`. No changes to T3's SQLite and no migrations. If a later version wants factory events in T3's store, that is a separate decision.

### Decisions since the draft

- **Factory HTTP routes use T3's auth, with no RPC (#57).** `apps/server/src/factory/t3/http.ts` is a plain route layer merged into `layerMakeRoutes`, and `t3/auth.ts` authenticates each request through `EnvironmentAuth.authenticateHttpRequest` and checks scopes with `AuthHttp.requireEnvironmentScope`, so paired, relay and tunnel sessions sign in exactly as they do for T3's own HTTP API. Nothing is added to `ws.ts`, `rpc.ts` or `packages/contracts`; Decided 1 has the detail.
- **Attention items and the macOS notification (#58).** An `Attention` service keeps the open items that need a person (ledger `attention` events, runs in `stuck` or `needs-info`, a config that fails to load, free disk space below `min_free_gib`, a build autodeploy has had waiting longer than `deploy_wait_minutes`, threads the pass archived on a broken session worktree, three pass errors in a row) in `<base>/factory/attention.json`, clears each when its condition clears (a repo's items when the T3 project it was watched from is deleted, never because its checkout stops opting in: the reader remembers those projects in `<base>/factory/watched-projects.json`), and posts one macOS notification per new item through `process.ts` running `osascript` with the text as argv. `notify: false` in the machine config keeps the list and turns the notification off.
- **Autodeploy drains the factory instead of waiting forever (#227).** `autodeploy.sh` writes `<base>/factory/deploy-pending` (epoch seconds and the sha) while origin/main has a commit it has not installed, and removes it when nothing is pending. The pass claims no new issue while the file is there (`claim_skipped` reason `deploy-pending`) and raises `deploy-waiting` once the wait passes `deploy_wait_minutes` (default 120); past that the script installs with factory runs in progress, and the server restart turns their sessions into interruptions the pass resumes. Every "waiting to deploy" line carries the wait so far. The script rewrites the marker on every tick that reads the status and the pass ignores one older than 30 minutes (`PENDING_STALE_MS`), so an autodeploy that stopped ticking holds nothing back. Past the limit the script installs whatever is in the way, since the status cannot tell a person's thread from a factory run's: factory runs resume through the pass, and a person's thread shows as interrupted in T3 for the person to continue. The script touches the marker while a build runs (a build can outlast the 30 minutes), and restarts the wait when it finds a marker older than 30 minutes, since the server was not draining in that time.
- **A flaky link to GitHub is waited out, not skipped (#218).** A `gh` call GitHub never received (a TLS handshake or dial that failed, so a write is safe to repeat too) is tried up to 5 times, waiting 2, 5, 15 and 30 s plus up to a second of jitter. When a repo's config or login read still fails that way and an earlier pass loaded one, the pass runs on that last good copy, kept in memory per repo, and records `repo_config_stale`. A failure that is not transient drops the copy, so a config removed or broken on purpose does not come back on a later blip. A stale config replaces `repo_skipped`; a stale login replaces the tracker `error` event. Each stale pass, and each pass that falls back on the config but cannot read the login, counts toward the 3-pass attention item. A login failure with no fallback is still that `error` event; a 404, a parse error or a config with no earlier copy skips the repo as before. The gate's fetch uses HTTP/1.1 and is tried up to 3 times (5 s, then 15 s, plus jitter) when git's stderr names a network error. Because the waits lengthen a pass, a pass 20 minutes in starts no more claims (`claim_skipped` reason `late`): the 30-minute pass timeout would leave a claim it cuts short `stuck`.
- **Install health check, auto-rollback and the hand-back runbook (#59).** After restarting the job, `install.sh` waits up to `T3FAC_HEALTH_WAIT` seconds (default 90) for the port to accept connections and for a `factory started` or `no factory config` log line written after the restart, and otherwise runs `rollback.sh` and exits 1. `factory/README.md` "Recovery" is the runbook for rolling back by hand, and `factory/docs/handover.md` is the one for handing this repo back to the Rust factory and moving it back.
- **A separate log-rotation LaunchAgent (#60).** `io.github.rawphp.t3fac.logrotate` runs `rotate-log.sh` every 600 seconds and copytruncates `~/Library/Logs/t3fac/t3fac.log`, because a crash-looping server writes the most log and is the one that cannot rotate it. `install.sh` and `rollback.sh` copy the script from `factory/scripts/` to `~/.local/share/t3fac/` and reload the job before restarting the server.
- **Factory CI's `Lint` job, with the gate unchanged (#56).** `factory-ci.yml` has a `Lint` job beside `Check` that runs `vp check`, the command upstream's own Lint job runs. `check.sh`, and so the gate, do not run it.
- **Remote and phone use through the fork's own served web, with no native mobile screen (#61).** The Factory pages are reached over the tailnet from the fork server's web, paired like any T3 browser. Below 640 px the runs, the gate commands and the ledger are stacked cards and lists, the status rows come first and the attention items follow, and every control is a 44 px tap target: inputs through a `touch` size on `Input` (a seam), buttons through the coarse-pointer hit area upstream's `Button` already has, inline links through the factory's own `TouchLink`. Every factory call goes through `factory/http.ts` on an environment's prepared connection: its HTTP base, the session cookie or the bearer token, never the page's own origin. The Factory pages read every connected environment, the primary first, and leave out one whose status answers 404; each control (Stop, Pause/Resume, Dismiss) goes to the environment that owns the run or item, and a run page reads the environment in its URL (#162); the settings page follows the settings scope's environment. A relay (DPoP) connection is reported as unavailable because the factory routes are not in the typed API groups that T3 signs proofs for. `factory/README.md` "Remote" has the pairing steps. The T3 mobile app on phones is upstream's App Store build and never contains fork code, so there is no native factory screen.
- **Factory HTTP API (#27, #28, #86, #108).** Eight routes in `t3/http.ts`: `GET /api/factory/status`, `GET /api/factory/runs` and `GET /api/factory/runs/:id` need `orchestration:read`; `POST /api/factory/runs/:id/stop`, `POST /api/factory/claims/pause`, `resume` and `POST /api/factory/attention/dismiss` need `orchestration:operate`; `POST /api/factory/restart` needs `environment:maintain`, the scope T3 gives its own process control (`server.signalProcess`, `server.updateServer`), so an MCP client, whose tokens carry only read and operate, cannot end the server. The status is softfac's `status --json` report with the fork's open attention items added, and without the keys the fork has nothing for (`commit`, `self_update_repo`, `disk`, `claims_paused`, `t3_env_holds`, `t3_logs`). `runs` and `runs/:id` are `runs list` and `runs show`. `runs` lists every unfinished run and the finished runs of the last seven days, or every run with `?all=1` (#28), and reads a finished one only at the ends of its file: the first line, and back from the end to its last state change and pull request. A finished file older than the window is not read at all. Only unfinished runs are read whole. The fork accepts softfac's `is_file` filter, so a directory or symlink named like a run file is not a run and holds no slot. A stop leaves a stop request for the next pass, as `stop-run.sh` does, and wakes the loop. The route never writes the ledger: the pass takes the request when the gate does not have the run, then archives the thread and removes the worktree (#20). Pause and resume write and remove `claims-paused`. Dismiss takes `{ ids }`, marks those open attention items dismissed, and answers `{ dismissed }`, the ids it dismissed; a body without an `ids` array of strings is 400 `invalid_body`. A restart answers 202 first, then logs `factory restart requested` and ends the process through an injected `ServerExit` (`t3/exit.ts`): SIGTERM to itself, which `runMain` turns into the normal shutdown, with the interrupt's exit code 130 made 0 (a failed teardown keeps its code) and `process.exit(0)` after 10 seconds if the shutdown hangs; the LaunchAgent starts the server again, and a dev server simply exits. A second request while one is pending answers 409 `restart_pending`. Open question 1 (do `layerMakeRoutes` routes get T3's auth) is answered by Decided 1 (#57): these routes use the same `withScope`, so an unauthenticated call gets 401.

## Scope of the experiment (v1)

In:

- One machine (this Mac), one factory identity (the `rawphp` gh login), GitHub issues only.
- Claim, start, building, result line, gate, gate retries, `pr-open` re-gating, feedback relaunch, interruptions, time limits, `needs-info` and `stuck`.
- Factory page: runs, state, current step, last gate output, stop, pause claims.
- Settings page: the machine config at Settings → Factory, with each watched repo's factory block read-only.
- Attention list: what needs a person, on the Factory page and as a macOS notification.

Out, until the experiment earns them: Linear, multiple identities, fleet API, self-update, menubar, retro step, `repo add` and `user add` wizards, `doctor`, a native mobile screen. Rust softfac keeps the rest; neither factory has a mobile screen.

## Running both factories side by side

The rule is the one softfac already has: one factory per repo.

- The fork watches only repos that are removed from the Rust factory's `repos` list. Start with one low-stakes repo. Both factories use the same labels, assignee and comment markers, so sharing a repo would make them claim each other's issues.
- Separate everything else:

|              | Rust softfac                                        | Fork                                                         |
| ------------ | --------------------------------------------------- | ------------------------------------------------------------ |
| T3 base dir  | `~/.config/softfac/t3`                              | `~/.config/t3fac`                                            |
| Port         | 3874                                                | 3876                                                         |
| LaunchAgent  | `io.github.rawphp.softfac`, `com.rawphp.softfac.t3` | `io.github.rawphp.t3fac`, `io.github.rawphp.t3fac.logrotate` |
| Factory data | `~/.local/share/softfac`                            | `~/.config/t3fac/factory`                                    |
| Repo clones  | `repos[].path`                                      | the T3 project's workspace root                              |
| Logs         | `~/Library/Logs/softfac`                            | `~/Library/Logs/t3fac`                                       |

`t3fac` is a working name.

## Building the fork ourselves

### Repo and branches

- `original-solutions/t3code-factory`, a public GitHub fork of `pingdotgg/t3code`. `main` is upstream plus our commits. On 2026-10-15 it was identical to upstream `main`, and the factory's `rawphp` login has admin on it.
- Issues are on (set 2026-10-15). Forks start with issues off, and the factory works from issues. Auto-merge is not used: `sync.sh` lands a green sync by pushing the checked merge commit to `main`.
- Actions are on. Each of upstream's workflows is disabled in the repo's settings, without editing their files, so they stay off the seam list, and the fork's `factory-*.yml` workflows run.

### Syncing with upstream

We sync to upstream's newest nightly tag, not to the tip of main. A nightly has passed upstream's own quality, test and build jobs.

`factory-sync.yml` runs daily:

1. Find the newest `v*-nightly.*` tag upstream.
2. Merge it into a `sync/<tag>` branch. Use merge, not rebase: our history stays intact and conflicts only show up in the seam files.
3. Run `factory/scripts/check.sh` on the branch ([README](../README.md#checks) "Checks" has the steps).
4. Green: open the PR and fast-forward `main` to the checked merge commit, which marks the PR merged.
5. Red: open the PR as a draft and file a `factory:proposed` issue on the fork naming the failing step.

The fork never runs a build that failed its own gates. The installed version only moves when a sync merges and a release builds.

### Contract tests

`apps/server/src/factory/t3/*.contract.test.ts` boot the real orchestration layers with `packages/provider-testing` as the provider. They launch a thread, send a message, wait for `run.updated` to settle, read the last assistant message, archive, and check the worktree is gone. These tests cover only what the adapter uses. They answer one question on every sync: does the adapter still work against this upstream?

### Release build

The server archive is built locally on this Mac by `factory/scripts/build.sh`:

1. `vp i`
2. `vp run --filter @t3tools/web build`
3. `cargo build --locked --release` in `native/resource-monitor`
4. `node apps/server/scripts/cli.ts build-exe` with the SEA Node version upstream pins
5. `node scripts/build-cli-archive.ts --platform mac --arch arm64 --version <v> …`
6. Smoke test: `t3 serve` on a throwaway home and base dir, wait for `/.well-known/t3/environment` to answer 200, then check the server log holds `factory started`. It does not call `/api/factory/status`, which needs a paired session (see Decided below).

Version: `<upstream nightly version>+fac.<fork short sha>`, for example `0.0.46-nightly.20261014.2950+fac.1a2b3c4`.

`factory/scripts/install.sh` unpacks the archive into `~/.local/share/t3fac/versions/<version>`, points a `current` symlink at it, and restarts the LaunchAgent. `rollback.sh` points `current` at the previous version. That is the same idea as `softfac t3 install` and `rollback`, as two short scripts.

The desktop app is built, signed, notarised and published as a prerelease by `.github/workflows/factory-desktop.yml` on a `macos-15` runner, and the iOS app is built and uploaded to TestFlight by `.github/workflows/factory-mobile.yml`. [README](../README.md) "Desktop app" and "Mobile app" have the detail.

Not built: npm packages, Linux and Windows desktop builds, Android. A second machine can install from a GitHub Release asset later.

### Fork CI on pull requests

`factory-ci.yml` on an Ubuntu runner runs `factory/scripts/check.sh` (the `Check` job) and `vp check` (the `Lint` job).

## Who builds the fork

The Rust factory builds the fork until the fork's own factory can build its own repo. After that the fork builds itself. Issues `original-solutions/t3code-factory#1` to `#21` take it up to the handover (#21). The handover is a config switch a person makes: the repo leaves the Rust factory's `repos` list and becomes a T3 project on the fork's server, with a `.dw/config.yml` factory block. Issues #22 to #28 (forwarding, re-gating, feedback, interruptions, required checks, the API and the page), #55 (the settings page) and #61 (phone and tailnet use) stay `factory:proposed` until that switch, and then the fork's factory builds them.

To begin with, `original-solutions/t3code-factory` becomes one of the Rust factory's repos, with a `.dw/config.yml` factory block whose gate is the fork CI commands above. `.dw/` is a new path, so it is not a seam. The work goes in as issues in this order, each one testable on its own:

1. Fork, seams, boundary test, sync job, build and install scripts, an empty `FactoryLayer` that logs "factory started". This proves we can sync and ship before porting anything.
2. Adapter and contract tests.
3. Ledger (format tests ported from `ledger.rs`) and the pure domain (lifecycle, result line, approval, limits).
4. GitHub tracker over `gh`, with argv-matching tests ported from `github.rs`.
5. Pass and claim, then start and building up to the result line.
6. Gate and gate retries, then `pr-open` re-gating and feedback.
7. Interruptions and time limits.
8. Factory page.

Port behaviour, not code. `docs/lifecycle.md` and `src/runner/tests.rs` (836 tests) are the spec. Port the test cases first in each step, then make them pass.

## How we decide

Run the two factories side by side for at least 4 weeks or 30 fork runs, whichever comes later.

Factory output, from `softfac retro` on both data dirs:

- share of runs that reach `pr-open` without a human
- stuck rate, by reason
- time from claim to `pr-open`
- PRs merged without change requests

Cost of the fork:

- sync PRs that went red, and hours spent fixing them
- commits to `factory/t3/` caused by upstream changes
- seam conflicts per month

The fork replaces Rust softfac if its output is at least as good and the sync cost stays under an agreed bound, for example one red sync a week fixed by the factory without Tom. If the sync cost is the problem, the fallback is the cheaper design from the brainstorm: Rust softfac bundled with T3 as one install, still talking over the wire.

## Decided

1. Routes added through `layerMakeRoutes` do not get T3's auth by themselves. `AuthHttp.layerAuthenticatedAuth` is an `HttpApiMiddleware` wired to `EnvironmentHttpApi` endpoints, and its middleware function is typed against HttpApi endpoint metadata, so it cannot wrap a plain `HttpRouter` route. What it does inside is one call, `EnvironmentAuth.authenticateHttpRequest`, and upstream's own plain OTLP trace proxy route (`authenticateRawRouteWithScope` in `apps/server/src/http.ts`) calls that same function and maps its failures with the helpers `auth/http.ts` exports. The factory does the same in `apps/server/src/factory/t3/auth.ts`: `withScope(scope, handler)` authenticates the request through `EnvironmentAuth.authenticateHttpRequest`, provides `EnvironmentAuthenticatedPrincipal`, and checks the scope with `AuthHttp.requireEnvironmentScope`. Paired, relay and tunnel sessions pass through the same code as for `EnvironmentHttpApi`; there is no factory token, no contract change and no RPC. The route layer is `apps/server/src/factory/t3/http.ts` (not `factory/http.ts` as the layout above sketches) because it reads T3's auth, and `server.ts` merges `FactoryRoutes` into `layerMakeRoutes` in one line. Not carried over: the DPoP `WWW-Authenticate` challenge header on a 401, which is private to `auth/http.ts`; upstream's plain routes omit it too. The Factory page will call `/api/factory/*` with the browser session cookie, as it calls T3's HTTP API.
2. `yaml` is already a server dependency: `apps/server/package.json` lists it and `apps/server/src/factory/config.ts` imports it. It needs no seam, and `package.json` and the lockfile stay off the seam list.

## Open questions to settle in step 1 or 2

2. Answered (#8): `ProcessRunner` spawns through Effect's Node spawner, which does put the child in its own process group (`detached: true` on POSIX) and sends the group `SIGTERM` when the effect is interrupted. It cannot do the rest: it always extends the parent environment (`extendEnv` is true whenever `env` is set), it reads stdout and stderr on separate pipes, and on timeout it drops the partial output and never escalates to `SIGKILL`. `apps/server/src/factory/process.ts` therefore uses `node:child_process` directly, outside `factory/t3/`, and needs no seam.
3. How does T3 handle a thread's worktree on archive? It leaves it on disk. `thread.archive` cancels the thread's queued runs, detaches its provider sessions, revokes its MCP credential, and closes its terminals and deletes their history (`terminal.cleanup`); the worktree stays. Storage cleanup (Settings → Storage, off by default) only considers active threads, so an archived thread's worktree is never a candidate; only "Delete worktrees with deleted threads" removes one, when the thread is deleted. So the factory removes the worktree itself with git after archiving, as softfac does: `FactorySessions.removeWorktree`, which keeps the branch. Archiving one thread does not archive the others on its worktree, such as a subagent created in the session's shared checkout, so `removeWorktree` archives every live thread on the worktree before git runs. A live thread left on a worktree that is gone or has no `.git` makes T3's pull request lookup and settlement fail every minute; each pass archives such threads once the session that was on that worktree is stopped, and raises one attention item per worktree (#187). A thread the factory archived on any path (the stop, the removal, the pass) is not found again until the server restarts, so one a person unarchives stays theirs until then; T3 records no unarchive the factory could read after a restart. Archiving replaces the issue's ask that settlement resolve such a thread: upstream falls back to the project checkout only when the folder is gone, and changing that is not a hook. The launch records the worktree as null (T3 makes it after the launch returns), so the run is found through the thread ids on the path: an archived thread keeps its path.
4. Is the installed 0.0.46 nightly already on orchestration v2? The Rust factory works against it with protocol 2, so probably yes. It only affects which upstream tag the first sync starts from.
