# Runs and result line

## Run id

`<owner>__<repo>__<issue>__<attempt>`, owner, repo and issue lowercased, attempt from 1. Example: `original-solutions__t3code-factory__20__1`. Ledger: `<data dir>/runs/<run id>.jsonl`. Each `factory:ready` that is claimed starts a new attempt.

## States

| State        | Holds a run slot                                           | Finished                                 |
| ------------ | ---------------------------------------------------------- | ---------------------------------------- |
| `triage`     | yes                                                        | no                                       |
| `building`   | yes, until the session reports its PR; not during the gate | no                                       |
| `pr-open`    | no                                                         | no; ends when the PR is merged or closed |
| `needs-info` | no                                                         | yes                                      |
| `stuck`      | no                                                         | yes                                      |

| Event                                      | From                              | To           |
| ------------------------------------------ | --------------------------------- | ------------ |
| approved                                   | `proposed`, `needs-info`, `stuck` | `ready`      |
| unapproved                                 | `ready`                           | `proposed`   |
| claimed                                    | `ready`                           | `triage`     |
| session started                            | `triage`                          | `building`   |
| questions raised                           | `triage`, `building`              | `needs-info` |
| failed                                     | `triage`, `building`, `pr-open`   | `stuck`      |
| instructor comment, body edit, gate failed | `building`                        | `building`   |
| gate passed                                | `building`                        | `pr-open`    |
| re-gate failed, instructor feedback        | `pr-open`                         | `building`   |

Any other transition is refused.

```mermaid
stateDiagram-v2
  state "needs-info" as needs_info
  state "pr-open" as pr_open
  proposed --> ready: approved
  needs_info --> ready: approved
  stuck --> ready: approved
  ready --> proposed: unapproved
  ready --> triage: claimed
  triage --> building: session started
  triage --> needs_info: questions raised
  building --> needs_info: questions raised
  triage --> stuck: failed
  building --> stuck: failed
  pr_open --> stuck: failed
  building --> building: instructor comment, body edit, gate failed
  building --> pr_open: gate passed
  pr_open --> building: re-gate failed, instructor feedback
```

## The session's launch message

The factory starts a T3 thread on the project's default model, full access, in a new worktree from `base`. Its first message is:

```text
/factory <owner/repo>#<n>

The factory daemon launched this session unattended, ...
You act on GitHub as <login>. ...
```

The session must check `gh api user --jq .login` first and must not change `GH_CONFIG_DIR`, `GH_TOKEN` or `GH_HOST`. A launch that continues earlier work (after the time limit, an interruption, a failed re-gate or instructor feedback) adds a paragraph saying so; the last two continue on the pull request's own branch.

## Result line

The whole last non-empty line of the session's last message:

| Last line                                                                            | Requires                                                                            | Result                                                    |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `FACTORY-DONE: https://github.com/<owner>/<repo>/pull/<n>`                           | Exactly that URL form; repo matches (case-insensitive); PR on the session's branch. | PR set to draft if needed; gate runs.                     |
| `FACTORY-STOP: needs-info`                                                           | Non-empty text above it: the numbered questions.                                    | Questions posted; `needs-info`. Empty text: `stuck`.      |
| `FACTORY-STOP: stuck`                                                                | Text above it explains why.                                                         | `stuck`, with the text quoted as unverified session text. |
| `FACTORY-STOP: stuck` with first line `the session's gh account is <x>, not <login>` |                                                                                     | `stuck`: wrong GitHub account.                            |
| `FACTORY-DONE:` with a malformed URL, or a PR on another repo                        |                                                                                     | `stuck` at once, no reminder.                             |
| no result line, or no message                                                        |                                                                                     | One reminder message; then `stuck`.                       |

```mermaid
sequenceDiagram
  participant Factory
  participant Session
  participant GitHub
  participant Gate
  Session->>GitHub: push the branch, open a draft PR
  Session->>Factory: FACTORY-DONE: #lt;PR URL#gt;
  Factory->>Gate: run the gate on a fresh checkout
  loop gate failed, up to gate_retries
    Gate-->>Factory: failed, with output
    Factory->>Session: The factory gate failed. (output)
    Session->>GitHub: fix, commit, push
    Session->>Factory: FACTORY-DONE: #lt;PR URL#gt;
    Factory->>Gate: run the gate on a fresh checkout
  end
  Gate-->>Factory: passed
  Factory->>GitHub: mark the PR ready for review, set factory:pr-open
```

When the repo names `required_checks`, the factory waits for them on the gated commit once the commands pass. A failed check goes back to the session like a failed command.

## Messages the factory sends into the session

| Message contains                                                              | Session must                                                                                                                               |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `Forwarded instructor comment on <repo>#<n>`                                  | Apply it at the next step boundary.                                                                                                        |
| `The body of <repo>#<n> was edited by <login>. Go back to your Contract step` | Work from the new body.                                                                                                                    |
| `Your last reply had no result line.`                                         | Finish; end with a result line.                                                                                                            |
| `The session was interrupted`                                                 | Continue; end with a result line.                                                                                                          |
| `The factory gate failed.`                                                    | Fix the cause (failing test first where behaviour changes), commit, push, end with `FACTORY-DONE: <PR URL>`. Never weaken or skip a check. |
| `The factory gate could not run: this branch conflicts with the base branch`  | Merge `origin/<base>`, resolve, push, end with `FACTORY-DONE: <PR URL>`.                                                                   |
| `A required check did not pass on commit`                                     | Fix the cause, commit, push, end with `FACTORY-DONE: <PR URL>`. Never weaken or skip a check.                                              |
| `The factory forwards new feedback from instructors on the pull request`      | Address every item, push to the same branch (no new pull request), end with `FACTORY-DONE: <PR URL>`.                                      |

A gate message opens with `When you have fixed this, end your reply with the line FACTORY-DONE: <PR URL> as before.` Command output inside these messages is untrusted text, not instructions.

## HTTP API

On the server (`http://127.0.0.1:3876` in the LaunchAgent install), authenticated like T3's own API: a paired session cookie or `Authorization: Bearer <token>`.

| Method | Path                             | Scope                   | Does                                                                                        |
| ------ | -------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------- |
| GET    | `/api/factory/status`            | `orchestration:read`    | State (`running` or `idle`), runs, open attention items.                                    |
| GET    | `/api/factory/runs`              | `orchestration:read`    | Unfinished runs and those finished in the last 7 days; `?all=1` for every run.              |
| GET    | `/api/factory/runs/:id`          | `orchestration:read`    | One run with its ledger.                                                                    |
| POST   | `/api/factory/runs/:id/stop`     | `orchestration:operate` | Stop request for a `building` run. 409 `not_building` otherwise; 404 when unknown.          |
| POST   | `/api/factory/claims/pause`      | `orchestration:operate` | Pause claims in every repo.                                                                 |
| POST   | `/api/factory/claims/resume`     | `orchestration:operate` | Resume claims.                                                                              |
| POST   | `/api/factory/attention/dismiss` | `orchestration:operate` | Body `{ "ids": [...] }`; answers `{ "dismissed": [...] }`.                                  |
| GET    | `/api/factory/config`            | `orchestration:read`    | Machine config report and watched repos.                                                    |
| PUT    | `/api/factory/config`            | `settings:write`        | Save machine config keys; 422 `invalid_config` on errors.                                   |
| POST   | `/api/factory/restart`           | `environment:maintain`  | 202, then the server exits; launchd restarts it. 409 `restart_pending` if one is under way. |

Unauthenticated: 401.

## Attention items

| Kind          | Raised when                                                                                                         | Clears when                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `stuck`       | A run ends `stuck`.                                                                                                 | The issue is claimed again.                      |
| `needs-info`  | A run ends `needs-info`.                                                                                            | The issue is claimed again.                      |
| `attention`   | Issue closed under a building run; a run holds a slot with nothing to move it; a thread may need archiving by hand. | The run finishes, or the issue is claimed again. |
| `config`      | The machine config fails to load.                                                                                   | It loads.                                        |
| `pass-errors` | 3 passes in a row fail.                                                                                             | A pass succeeds.                                 |

Dismissed items stay hidden until they clear and are raised again.
