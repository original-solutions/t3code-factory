# Issue contract

## Body

| Heading                  | Required | Content                              |
| ------------------------ | -------- | ------------------------------------ |
| `## Outcome`             | yes      | What is true when done.              |
| `## Acceptance criteria` | yes      | Numbered, each checkable.            |
| `## Depends on`          | yes      | Issue references, or `None.`         |
| `## Notes`               | yes      | Constraints, pointers, out of scope. |
| `## Base`                | no       | A branch on `origin`, or `None.`     |

- The build session copies the body as its brief. It does not improve it.
- One change per issue.
- The server parses `## Depends on` and `## Base`. The other headings are for the session.
- `## Base` names the branch the run starts from, opens its pull request against and is gated on. No section, an empty one or `None.` means `factory.base`. The branch must already be on `origin`.

## Labels

One `factory:*` label at a time. Matched exactly, case-sensitive.

| Label                | Set by               | Colour   | Factory action                                                                |
| -------------------- | -------------------- | -------- | ----------------------------------------------------------------------------- |
| `factory:proposed`   | person, bot, factory | `c5def5` | None. Refused approvals land here.                                            |
| `factory:ready`      | instructor           | `0e8a16` | Claim on next pass if unassigned, approved, unblocked, not paused, slot free. |
| `factory:triage`     | factory              | `fbca04` | Assigned to the factory login; session launching.                             |
| `factory:building`   | factory              | `1d76db` | Session running; instructor comments and edits forwarded.                     |
| `factory:needs-info` | factory              | `d93f0b` | Questions posted; issue unassigned; run finished.                             |
| `factory:pr-open`    | factory              | `5319e7` | PR passed the gate and is ready; instructor feedback relaunches.              |
| `factory:stuck`      | factory              | `b60205` | Reason posted; issue unassigned; run finished.                                |

Restart from `needs-info` or `stuck`: an instructor sets `factory:ready`. That is a new run.

## Approval

A claim needs all of:

| Rule                                                                                                             | Failing it                                                                    |
| ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| The latest `factory:ready` label event was applied by a login in `instructors` (case-insensitive), of type User. | Moved to `factory:proposed` with a comment.                                   |
| No body edit or title change by a non-instructor at or after that label event.                                   | Moved to `factory:proposed` with a comment.                                   |
| The edit history is short enough to judge.                                                                       | Moved to `factory:proposed`; file a new issue.                                |
| No assignee.                                                                                                     | Skipped.                                                                      |
| No `postponed` label (any case).                                                                                 | Skipped; `claim_skipped` reason `postponed`; nothing is written to the issue. |
| Issue open.                                                                                                      | Skipped.                                                                      |

## Dependencies

| Source                   | Syntax                                                                 | Read                           |
| ------------------------ | ---------------------------------------------------------------------- | ------------------------------ |
| GitHub "blocked by" link | native issue relationship                                              | first                          |
| `## Depends on` section  | `#12`, `owner/repo#12`, anywhere in the section until the next heading | when no linked blocker is open |

- `None.`, empty, or no section: no dependencies.
- Not recognised: full URLs, `word#12`, `#` without digits.
- Resolved: the issue is closed, for any reason. Open: blocks.
- A reference that cannot be read blocks.
- At most 100 references.
- Checked only before the claim. A blocked issue stays `factory:ready`, takes no slot, and nothing is written to GitHub.

## Instructors after the claim

| State                | Instructor comment                                                                                                                                             | Instructor body edit                       | Non-instructor body or title edit   |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ----------------------------------- |
| `triage`, `building` | Forwarded to the session (max 20,000 characters).                                                                                                              | Sent whole; session restarts its contract. | `factory:stuck`                     |
| `pr-open`            | On issue or PR, or a PR review: new session on the PR branch, PR to draft, label to `building`. Read at most every `feedback_seconds` (10 minutes by default). | Not read as feedback; comment instead.     | `factory:stuck` when next acted on. |

An instructor comment whose edit history includes a non-instructor is not forwarded; the factory comments that it did not send it.

## What sends an issue to needs-info

The build session decides, and ends with `FACTORY-STOP: needs-info` when:

- the outcome or the acceptance criteria are missing,
- two readings would give different code,
- a real product choice is left open,
- the issue holds two independent units of work.

The session asks every question at once, each answerable in a sentence.
