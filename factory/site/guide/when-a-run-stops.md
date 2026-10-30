# When a run stops

Most runs end at `factory:pr-open`. The rest end in one of two labels, each with a comment on the issue that says what happened. Either way the factory archives the session's T3 thread and removes its worktree, and keeps the branch.

## needs-info

<img class="screenshot light-only" src="/screenshots/run-needs-info-light.png" alt="A needs-info run's page: the questions the session posted on the issue, then the gate section, where no gate has run, and the ledger" />
<img class="screenshot dark-only" src="/screenshots/run-needs-info-dark.png" alt="A needs-info run's page: the questions the session posted on the issue, then the gate section, where no gate has run, and the ledger" />

The session decided the issue can't be built as written: the outcome is unclear, two readings would give different code, or the issue holds two separate pieces of work. It ends with its questions, and the factory posts them as a comment, sets `factory:needs-info` and unassigns the issue.

Answer in a comment or edit the issue so it settles every question, then an instructor sets `factory:ready`. The factory doesn't read the answer by itself: the label starts a new run, which reads the issue from the top.

## stuck

The factory gave up. The comment gives the reason and, when the session had made commits, the branch they are on. Common reasons:

| Reason                                                        | What to do                                                                                                                         |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| The gate failed after the allowed attempts                    | Read the gate output on the [run's page](/guide/watching-runs#a-run-s-page), fix the cause or the issue, then set `factory:ready`. |
| The run passed its time limit                                 | See [the time limit](#the-time-limit): split the issue or raise `limits.minutes`, unless the session looked idle.                  |
| The session gave up, or ended without a result line           | Read the session in its T3 thread.                                                                                                 |
| The issue text was changed by someone who isn't an instructor | Review the text, then set `factory:ready`.                                                                                         |
| The session ran as the wrong GitHub account                   | Restart the server so it has the right `GH_CONFIG_DIR` (see [the machine config](/guide/machine-config#changing-it)).              |
| The required checks failed, or didn't report in time          | Check the repo's CI and `required_checks`.                                                                                         |
| No model to launch with                                       | Set a default model on the T3 project or in T3's Settings.                                                                         |
| Stopped by hand                                               | Nothing: someone stopped it.                                                                                                       |

Fix the cause, then an instructor sets `factory:ready` to start a new run. If an earlier run left the factory's pull request for the issue open, the new run continues that pull request on its branch, even when the issue text changed. To start over instead, close that pull request first. Otherwise a run that passed its time limit or lost its T3 session is continued from its branch, unless the issue text changed since. Any other new run starts from the issue's base branch (its `## Base`, else the repo's).

## The time limit

Each run may spend `limits.minutes` (180 by default) claimed and building. Time waiting at `factory:pr-open` doesn't count, and neither does the factory's own gate: from the session reporting its pull request until the gate sends it back, queued or running. Past the limit, the factory stops the session and sets `factory:stuck` with the reason "the run passed its time limit", followed by the minutes the run worked and how long before the stop the session's agent last did anything, for example "(92 min worked; last session activity 3 min before the stop)". When that was more than 15 minutes before the stop, the reason ends with ": the session looked idle". A busy session needed more time: split the issue or raise the limit. An idle one had stalled: read its T3 thread before starting a new run. When T3 can't say, the reason is the plain sentence.

Other limits in the repo's [factory block](/guide/add-a-repo#_1-commit-the-factory-block) cap the gate retries and the wait for required checks. Each ends the run with `factory:stuck` when it runs out.

If T3 itself had trouble (the server restarted, or several sessions failed at once), the factory resumes the session instead of giving up, up to `limits.interruption_resumes` times. A session someone stopped in T3 waits rather than counting as a failure.

A provider rate limit doesn't stop a run either. The factory resumes the session once the limit has cooled down, or at once on the [`model_fallbacks`](/guide/machine-config#keys) model, and that doesn't use up `limits.interruption_resumes`. The time limit keeps counting while the run waits.

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
