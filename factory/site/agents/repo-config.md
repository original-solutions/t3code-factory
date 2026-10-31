# Repo config

File: `.dw/config.yml` in the repo. Parsed by [`apps/server/src/factory/config.ts`](https://github.com/original-solutions/t3code-factory/blob/main/apps/server/src/factory/config.ts) (`parseProjectConfig`).

## Where it is read

| Purpose                     | Source                                                                                                                                                                                                                                                   |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Whether the repo is watched | The T3 project's checkout on disk; falls back to `git show origin/HEAD:.dw/config.yml`. Opted in when the root and `factory` are both mappings. Not validated here. Without them, watched only on the machine's [`default_project`](#the-default-block). |
| The config runs use         | The tip of the repo's default branch on GitHub, read on every pass. Only when GitHub says the file is not there, the checkout's working tree, so a checkout-only config takes effect on the next pass without a push.                                    |

## Schema

```yaml
factory:
  instructors: [login, ...] # required
  base: main # required
  provision: [cmd, ...] # required, may be []
  gate: [cmd, ...] # required
  required_checks: [name] # optional
  limits: # required mapping
    gate_retries: 2 # required
    minutes: 180 # optional
    regates: 5 # optional, accepted and ignored
    checks_minutes: 30 # optional
    interruption_resumes: 2 # optional
  autonomy: pr # required
  owner: t3fac # optional
```

| Key                                   | Type            | Required | Default | Rule                                                                         |
| ------------------------------------- | --------------- | -------- | ------- | ---------------------------------------------------------------------------- |
| `factory`                             | mapping         | yes      |         |                                                                              |
| `factory.instructors`                 | list of strings | yes      |         | Non-empty list; no empty strings. GitHub logins, matched case-insensitively. |
| `factory.base`                        | string          | yes      |         | Non-empty. Must equal the repo's default branch, or the repo is skipped.     |
| `factory.provision`                   | list of strings | yes      |         | May be empty. Shell commands.                                                |
| `factory.gate`                        | list of strings | yes      |         | Non-empty. Shell commands.                                                   |
| `factory.required_checks`             | list of strings | no       | `[]`    | GitHub check names.                                                          |
| `factory.limits`                      | mapping         | yes      |         |                                                                              |
| `factory.limits.gate_retries`         | integer ≥ 0     | yes      |         |                                                                              |
| `factory.limits.minutes`              | integer ≥ 1     | no       | `180`   |                                                                              |
| `factory.limits.regates`              | any             | no       |         | Accepted and ignored.                                                        |
| `factory.limits.checks_minutes`       | integer ≥ 1     | no       | `30`    |                                                                              |
| `factory.limits.interruption_resumes` | integer ≥ 0     | no       | `2`     |                                                                              |
| `factory.autonomy`                    | string          | yes      |         | Only `pr`.                                                                   |
| `factory.owner`                       | string          | no       |         | Non-empty. The one machine that may claim the repo's issues: see below.      |

Keys the server does not read are ignored.

`factory.owner` is the machine name from the `Machine:` line of a factory status comment, matched ignoring ASCII case. Absent, any machine that watches the repo claims its issues. Set, every other machine lists, claims, resumes and releases nothing there, and writes nothing to its issues. Each pass it prints `not owner: <repo>: factory.owner is <owner>, this machine is <name>; no issue is claimed` and writes `claim_skipped` with reason `not-owner`. Runs a machine already holds go on. A misspelt owner means no machine claims; moving the repo to another machine is a one-line commit on the default branch.

## Limits

| Key                    | Counts                                                                                                                                                                                           | On running out                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `minutes`              | Minutes the run spent in `triage` and `building`. `pr-open` is not counted, nor the factory's gate from the session reporting its pull request until the gate sends it back (queued or running). | `stuck`: "the run passed its time limit", with the minutes worked and the session's last activity |
| `gate_retries`         | Gate or required-check failures sent back to the session. `0`: the first failure is final. Reset after a pass.                                                                                   | `stuck`: "the gate failed after N attempts"                                                       |
| `regates`              | Nothing. The key is accepted and ignored.                                                                                                                                                        | None                                                                                              |
| `checks_minutes`       | Wait for `required_checks` after the gate commands pass.                                                                                                                                         | `stuck`                                                                                           |
| `interruption_resumes` | Resumes or relaunches after a session ended `failed` or `cancelled`, or its thread vanished, when T3 trouble is in evidence.                                                                     | `stuck`                                                                                           |

## The default block

With the machine config's `default_project` set, a T3 project whose GitHub-origin checkout has no `factory` block (no `.dw/config.yml`, or one without the key) is watched on the default. A repo with its own `factory` block uses that block alone: nothing from the default and no inferred command is merged in. Code: [`apps/server/src/factory/defaultProject.ts`](https://github.com/original-solutions/t3code-factory/blob/main/apps/server/src/factory/defaultProject.ts).

| Field               | Value                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------- |
| `instructors`       | `default_project.instructors`                                                                                 |
| `limits`            | `default_project.limits`, with its defaults                                                                   |
| `base`              | The repo's default branch on GitHub                                                                           |
| `required_checks`   | `[]`                                                                                                          |
| `autonomy`          | `pr`                                                                                                          |
| `owner`             | None: any machine that watches the repo claims                                                                |
| `provision`, `gate` | Inferred from the files committed at the root of `origin/HEAD`, read with `git` in the checkout on every pass |

| Found on the default branch                   | provision                                         | gate                                                                                                                      |
| --------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `package.json` with `package-lock.json`       | `npm ci`                                          | `npm run <script>` for each of `typecheck`, `lint`, `build`, `test`, `format:check` that `scripts` defines, in that order |
| `package.json` with `pnpm-lock.yaml`          | `pnpm install --frozen-lockfile`                  | the same scripts, with `pnpm run`                                                                                         |
| `package.json` with `bun.lock` or `bun.lockb` | `bun install --frozen-lockfile`                   | the same scripts, with `bun run`                                                                                          |
| `package.json` with `yarn.lock`               | `yarn install --frozen-lockfile`                  | the same scripts, with `yarn run`                                                                                         |
| `composer.json`                               | `composer install --no-interaction --no-progress` | `composer check` if `scripts.check` exists, else `composer test` if `scripts.test` exists                                 |

A repo with both manifests gets both: composer first in `provision` and in `gate`. With more than one lockfile, the first row that matches wins. A `package.json` with no lockfile infers nothing.

Each pass reads `.dw/config.yml` on the default branch on GitHub first, as for any watched repo (three API calls per repo per pass): if it has a `factory` block, that block is used, even though the checkout showed none, and Settings does not mark the repo "default config". The files are read from the checkout's `origin/HEAD`, so they are as fresh as its last fetch.

No gate inferred (no manifest, or no matching script): the repo is watched, its reading is one error saying no gate could be inferred and a `factory` block in `.dw/config.yml` is needed, and its issues are not claimed. A clone with no `origin/HEAD`, or one whose `origin/HEAD` names another branch than the default branch on GitHub, is watched with one error saying to run `git remote set-head origin --auto`. A `git` that times out reading the files leaves the checkout unresolved for that pass. A checkout T3 cannot name (no remote, or a timeout) is not watched that pass. When another project of the same repo has its own `factory` block, the defaulted checkout is dropped, so the repo is not ambiguous.

## Gate

| Step        | Detail                                                                                                                                                                                                                                                                                                                        |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Checkout    | Fresh clone of the PR head merged with the base branch tip. A merge conflict fails the attempt.                                                                                                                                                                                                                               |
| Commands    | Each `provision` command, then each `gate` command, through the shell, at the checkout root.                                                                                                                                                                                                                                  |
| Timeout     | 30 minutes per command.                                                                                                                                                                                                                                                                                                       |
| Pass        | Every command exits 0. Then `required_checks`, if any, must pass on the gated commit.                                                                                                                                                                                                                                         |
| Source      | The commands come from the default branch on GitHub or, when the file is not there, from the checkout's working tree. Never from the PR.                                                                                                                                                                                      |
| Environment | Only `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `TMPDIR`, `TERM` and `LC_*` from the server. `PATH` starts with the LaunchAgent's entries, `~/.config/t3fac/env` applied, then adds the login shell's entries the server read at startup, duplicates removed. A tool the env file names wins over the login shell's. |
