# Add a repo

The factory watches a repo when two things are true:

1. A clone of the repo is a T3 [project](https://github.com/pingdotgg/t3code/tree/main/docs/user/project-settings.md) on the factory's server.
2. That checkout has a `.dw/config.yml` with a `factory` block, in its working tree or, when the working tree has none, in the copy on origin's default branch.

There is no list of repos to edit. Adding the project is the switch, and deleting the project is how the repo leaves.

## 1. Commit the factory block

Add `.dw/config.yml` to the repo and commit it on its default branch:

```yaml
factory:
  instructors: [alice, bob]
  base: main
  provision: [npm ci]
  gate: [npm test, npm run lint]
  limits: { gate_retries: 2 }
  autonomy: pr
```

The factory reads this file from the tip of the default branch on GitHub, not from your checkout, so a change takes effect once it is pushed there. A pull request can't change the gate it is checked with.

| Key                           | Required | Default | What it does                                                                                                                                      |
| ----------------------------- | -------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `instructors`                 | yes      |         | GitHub logins whose `factory:ready` label, comments and edits the factory acts on. At least one. See [File work](/guide/filing-work#instructors). |
| `base`                        | yes      |         | The branch pull requests target. It must be the repo's default branch, or the repo is skipped.                                                    |
| `provision`                   | yes      |         | Commands that prepare a fresh checkout before the gate, such as installing dependencies. May be empty (`[]`).                                     |
| `gate`                        | yes      |         | The checks. Every command must exit 0 for a pull request to pass. At least one.                                                                   |
| `required_checks`             | no       | `[]`    | Names of GitHub checks that must also pass on the gated commit before the pull request is marked ready.                                           |
| `limits.gate_retries`         | yes      |         | How many failed gates go back to the session to fix. `0` means the first failure stops the run.                                                   |
| `limits.minutes`              | no       | `180`   | How long a run may spend building before the factory stops it.                                                                                    |
| `limits.regates`              | no       | `5`     | How many times the gate may run again because the base branch moved while it ran.                                                                 |
| `limits.checks_minutes`       | no       | `30`    | How long to wait for `required_checks` to report.                                                                                                 |
| `limits.interruption_resumes` | no       | `2`     | How many times to resume a session that ended because T3 itself had trouble.                                                                      |
| `autonomy`                    | yes      |         | Must be `pr`: the factory stops at a pull request a person merges.                                                                                |

The gate runs each `provision` command, then each `gate` command, through the shell at the root of a fresh checkout of the pull request merged with the base branch. Each command has 30 minutes. The commands get only a few variables from the server's environment: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `TMPDIR`, `TERM` and `LC_*`. The tools they need must be on that `PATH` ([Install and run](/guide/install#tools-the-server-can-see)); any other variable has to be set by the command itself.

[For agents → Repo config](/agents/repo-config) has the exact types and limits.

## 2. Add the clone as a T3 project

Clone the repo somewhere the factory can use as its own, and add that folder as a project on the factory's server, from the sidebar or with:

```sh
~/.local/share/t3fac/current/t3 project add <path> --base-dir ~/.config/t3fac
```

Then set the project's default model in its T3 settings, or rely on the default model in T3's own Settings. Every session the factory starts for this repo uses it. With neither set, nothing launches and the issue goes to `factory:stuck`.

The factory names the repo by the clone's `origin` remote. Watch out for these:

- A clone with an `upstream` remote is named after that remote by T3, so the factory doesn't watch it. Use a clone without one.
- Two projects whose `origin` is the same repo leave it unwatched: the factory can't tell which checkout is its own. Settings → Factory names them.
- One factory per repo. Two factories on different machines, or a second factory of another kind, watching the same repo would claim each other's issues.

## 3. Check it is watched

Open Settings → Factory. Each watched repo is listed with its workspace root and the factory block as the last pass read it, along with any config errors. A repo the factory couldn't settle (an unreadable or half-merged `.dw/config.yml`, a checkout T3 can't name) appears under "Not settled on the last read". [Watch runs](/guide/watching-runs) has more on the page.

## 4. Create the labels

The factory's GitHub login needs write access to the repo: it assigns issues, sets labels and comments, and its sessions push branches and open pull requests.

The factory moves issues through seven `factory:*` labels and expects them to exist on the repo. Create any that are missing, as the factory's login or as a repo admin:

```sh
repo=owner/name
gh label create factory:proposed  --repo $repo --color c5def5
gh label create factory:ready     --repo $repo --color 0e8a16
gh label create factory:triage    --repo $repo --color fbca04
gh label create factory:needs-info --repo $repo --color d93f0b
gh label create factory:building  --repo $repo --color 1d76db
gh label create factory:pr-open   --repo $repo --color 5319e7
gh label create factory:stuck     --repo $repo --color b60205
```

[File work](/guide/filing-work#labels) says what each one means.
