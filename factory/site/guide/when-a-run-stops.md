# When a run stops

Most runs end at `factory:pr-open`. The rest end in one of two labels, each with a comment on the issue that says what happened. Either way the factory archives the session's T3 thread and removes its worktree, and keeps the branch.

## needs-info

<img class="screenshot light-only" src="/screenshots/run-needs-info-light.png" alt="A needs-info run's page: no gate has run, and the ledger's questions_posted line holds the questions the session posted on the issue" />
<img class="screenshot dark-only" src="/screenshots/run-needs-info-dark.png" alt="A needs-info run's page: no gate has run, and the ledger's questions_posted line holds the questions the session posted on the issue" />

The session decided the issue can't be built as written: the outcome is unclear, two readings would give different code, or the issue holds two separate pieces of work. It ends with its questions, and the factory posts them as a comment, sets `factory:needs-info` and unassigns the issue.

Answer in a comment or edit the issue so it settles every question, then an instructor sets `factory:ready`. The factory doesn't read the answer by itself: the label starts a new run, which reads the issue from the top.

## stuck

The factory gave up. The comment gives the reason and, when the session had made commits, the branch they are on. Common reasons:

| Reason                                                        | What to do                                                                                                                         |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| The gate failed after the allowed attempts                    | Read the gate output on the [run's page](/guide/watching-runs#a-run-s-page), fix the cause or the issue, then set `factory:ready`. |
| The run passed its time limit                                 | Split the issue, or raise `limits.minutes` in `.dw/config.yml`.                                                                    |
| The session gave up, or ended without a result line           | Read the session in its T3 thread.                                                                                                 |
| The base branch kept moving and the gate could not settle     | Set `factory:ready` to try again; raise `limits.regates` if it keeps happening.                                                    |
| The session's T3 thread no longer exists                      | Set `factory:ready` for a new run.                                                                                                 |
| The issue text was changed by someone who isn't an instructor | Review the text, then set `factory:ready`.                                                                                         |
| The session ran as the wrong GitHub account                   | Restart the server so it has the right `GH_CONFIG_DIR` (see [the machine config](/guide/machine-config#changing-it)).              |
| The required checks failed, or didn't report in time          | Check the repo's CI and `required_checks`.                                                                                         |
| No model to launch with                                       | Set a default model on the T3 project or in T3's Settings.                                                                         |
| Stopped by hand                                               | Nothing: someone stopped it.                                                                                                       |

Fix the cause, then an instructor sets `factory:ready` to start a new run. A new run starts from the base branch, not from the old branch.

## The time limit

Each run may spend `limits.minutes` (180 by default) claimed and building. Time waiting at `factory:pr-open` doesn't count. Past the limit, the factory stops the session and sets `factory:stuck` with the reason "the run passed its time limit".

Other limits in the repo's [factory block](/guide/add-a-repo#_1-commit-the-factory-block) cap the gate retries, the gate reruns when the base branch moves, and the wait for required checks. Each ends the run with `factory:stuck` when it runs out.

If T3 itself had trouble (the server restarted, or several sessions failed at once), the factory resumes the session instead of giving up, up to `limits.interruption_resumes` times. A session someone stopped in T3 waits rather than counting as a failure.

## Stopping a run by hand

A run in `factory:building` can be stopped from its [run page](/guide/watching-runs#a-run-s-page), or on the server's Mac with:

```sh
factory/scripts/stop-run.sh <run id>
```

The run id is on the Factory page, for example `original-solutions__t3code-factory__20__1`. On its next pass the factory archives the session, removes the worktree and sets `factory:stuck` with the reason "stopped by hand". If a gate is running for the run, the stop waits for it.

A run in any other state can't be stopped this way. The script and the page say why and what to do instead.

## Abandoning a run

Close the issue. A run that hasn't reached `factory:pr-open` is abandoned on the next pass: the factory archives the session, removes the worktree and writes nothing on GitHub. The server's Mac gets a notification that the run was abandoned.

A run at `factory:pr-open` ends when its pull request is merged or closed. Close the pull request to end it early.
