# File work

Work for the factory is a GitHub issue on a [watched repo](/guide/add-a-repo). The session copies the issue body as its brief and builds exactly that, so the issue has to say what done looks like.

## Write the issue

Use four headings:

```md
## Outcome

What is true when this is done, in a few sentences.

## Acceptance criteria

1. Each one checkable: a command that exits 0, a page that shows something, a file that exists.

## Depends on

None.

## Notes

Constraints, pointers into the code, and anything out of scope.
```

Keep one change per issue. When an issue holds two independent pieces of work, or leaves a real product choice open, the session stops and asks instead of guessing (see [needs-info](/guide/when-a-run-stops#needs-info)). [For agents → Issue contract](/agents/issue-contract) has the rules in table form.

## Base

To land the work on a feature branch instead of the repo's base, add a heading that names it:

```md
## Base

feature/billing
```

The run starts from that branch, opens its pull request against it, and is gated on it. The branch must already exist on `origin`; the factory doesn't create it, and an issue naming a missing branch goes to `factory:stuck`. Leave the heading out, or write `None.`, to use the repo's base. A pull request merged into a feature branch doesn't close the issue, so close it yourself once it's merged.

## Instructors

An instructor is a GitHub login listed under `instructors` in the repo's `.dw/config.yml`. Logins match without regard to case, and a bot or GitHub App never counts, even when listed. Instructors decide what the factory does:

- Only an instructor's `factory:ready` label starts a run.
- An instructor's comments on the issue are sent to the running session as instructions. Anyone else's comments are ignored.
- An instructor may edit the issue at any time. An edit by anyone else after the label stops the work (see [Editing after ready](#editing-after-ready)).
- On an open pull request, reviews and comments from instructors, on the pull request or the issue, are feedback the factory acts on.

## Labels

An issue carries one `factory:*` label at a time. People set two of them; the factory sets the rest.

| Label                | Set by                          | Meaning                                                                                                                                             |
| -------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `factory:proposed`   | a person, a bot, or the factory | Parked. The factory ignores it. It moves an issue here when it refuses to start one, with a comment saying why.                                     |
| `factory:ready`      | an instructor                   | Build this. The factory claims it on its next pass, unless someone is assigned, a dependency is open, claims are paused or every run slot is taken. |
| `factory:triage`     | the factory                     | Claimed. The issue is assigned to the factory's login and a session is being launched.                                                              |
| `factory:building`   | the factory                     | A session is building it.                                                                                                                           |
| `factory:needs-info` | the factory                     | The session asked questions, posted as a comment. The issue is unassigned.                                                                          |
| `factory:pr-open`    | the factory                     | A pull request passed the gate and is ready for review.                                                                                             |
| `factory:stuck`      | the factory                     | The factory gave up and said why in a comment. The issue is unassigned.                                                                             |

To start again after `needs-info` or `stuck`, an instructor sets `factory:ready` again. Each time is a new run.

Don't assign the issue to anyone if you want the factory to take it. An assigned `factory:ready` issue is skipped. A `factory:ready` issue labelled `postponed` is skipped too, until the label is removed; a claim or run already in progress is not stopped.

## Dependency links

When an issue can't start until another one is done, say so in one of two ways:

- **A GitHub "blocked by" link** on the issue. This is the one to prefer.
- **The `## Depends on` section**, with references written `#12` for this repo or `owner/repo#12` for another. Full URLs aren't read. `None.` or an empty section means no dependencies.

The factory checks both when it is about to claim. While any dependency is open, the issue waits as `factory:ready` and takes no slot. A dependency counts as done when its issue is closed, for any reason. The check happens only before the claim: closing or reopening a dependency later doesn't affect a run already under way.

## Editing after ready

| When                                   | An instructor edits or comments                                                                                                                                                                                                                                                                                                                   | Someone else edits the body or title                                                                                                             |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `factory:ready`, not yet claimed       | Fine.                                                                                                                                                                                                                                                                                                                                             | The factory refuses to start, moves the issue to `factory:proposed` and comments. An instructor reviews the text and sets `factory:ready` again. |
| `factory:triage` or `factory:building` | A body edit is sent to the session, which goes back to its contract with the new text. A comment is sent as an instruction it applies at its next step.                                                                                                                                                                                           | The run stops with `factory:stuck`.                                                                                                              |
| `factory:pr-open`                      | A comment on the issue or the pull request, or a review, starts a new session on the pull request's branch. The pull request goes back to draft and the issue to `factory:building`. The factory looks for feedback at most every `feedback_seconds` (10 minutes by default). An edit to the issue on its own isn't feedback, so comment as well. | The run stops with `factory:stuck` when the factory next acts on it.                                                                             |

Closing the issue ends a run that hasn't reached `factory:pr-open`: the factory archives the session and writes nothing on GitHub.
