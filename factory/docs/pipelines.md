# Pipelines: a factory run as a graph

Status: prototype, 2026-10-25.

## Why

The factory runs one fixed lifecycle: claim, build, gate, pull request, feedback, done. It is written as code, so changing how an issue is built (a second reviewer, a retro that improves the skill the next run uses, a different gate per repo) is a code change. A pipeline makes that lifecycle data: a graph a person draws in the web UI, where every node that runs an agent names a brief or a skill on the factory machine, and every transition can say what to tell the agent when it is taken. Loops are edges that go back, with a limit. Verifications are nodes with two ways out. A learning loop is a node that runs after the work is accepted and writes what it learned into a skill, so the next run reads it.

## Where it lives

Pipelines are per factory machine, under `<factory dir>/pipelines/<id>.yml`, and are edited over `/api/factory/pipelines/*`. Skills and briefs resolve on that same machine, which is where the pipeline runs. A run's record is `<factory dir>/pipelines/runs/<run id>.jsonl`.

The code is fork-owned: `apps/server/src/factory/pipeline/` (model, validation, interpreter, store, skills catalog, executor, runs service), `apps/server/src/factory/t3/pipelineHttp.ts` (routes), `apps/web/src/factory/pipelines/` (the pages and the canvas) and `apps/web/src/routes/factory_.pipelines*`. The canvas is hand-rolled SVG and DOM: `pnpm-lock.yaml` is upstream's, so no graph library.

## The model

```yaml
id: build-and-learn # [a-z0-9-]{1,64}
name: Build and learn
nodes:
  - { id: start, kind: start, x: 40, y: 200 }
  - { id: build, kind: agent, label: Build, x: 280, y: 200, instructions: { skill: factory } }
  - {
      id: gate,
      kind: verify,
      label: Gate,
      x: 520,
      y: 200,
      check: { commands: [factory/scripts/check.sh] },
    }
  - { id: review, kind: pr, label: Review, x: 760, y: 200 }
  - {
      id: learn,
      kind: learn,
      label: Learn,
      x: 1000,
      y: 200,
      instructions: { skill: session-capture },
    }
  - { id: done, kind: end, result: done, x: 1240, y: 200 }
  - { id: stuck, kind: end, result: stuck, x: 520, y: 420 }
edges:
  - { id: e1, from: start, port: next, to: build }
  - { id: e2, from: build, port: done, to: gate }
  - {
      id: e3,
      from: gate,
      port: fail,
      to: build,
      max: 2,
      instructions: { brief: "The gate failed. Fix it and end with a result line." },
    }
  - { id: e4, from: gate, port: pass, to: review }
  - {
      id: e5,
      from: review,
      port: feedback,
      to: build,
      max: 5,
      instructions: { brief: "Address the feedback below." },
    }
  - { id: e6, from: review, port: base-moved, to: gate, max: 10 }
  - { id: e7, from: review, port: merged, to: learn }
  - { id: e8, from: learn, port: done, to: done }
  - { id: e9, from: review, port: closed, to: stuck }
```

### Nodes

Every node has `id`, `kind`, an optional `label`, and `x`, `y` for the canvas. A kind decides what runs and which outcomes (ports) it has. Every outcome is a port; an edge leaves a port.

| kind     | what runs                                                                                          | ports                                        | fields                                             |
| -------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------- | -------------------------------------------------- |
| `start`  | nothing; where a run begins                                                                        | `next`                                       |                                                    |
| `agent`  | an agent turn in the run's session (or a fresh thread with `fresh: true`)                          | `done`, `questions`, `stop`                  | `instructions` (required), `fresh` (default false) |
| `verify` | commands in the run's worktree, or a reviewer agent in a fresh thread that answers pass or fail    | `pass`, `fail`                               | `check` (required): `commands`, `skill` or `brief` |
| `ask`    | the questions go to the issue as a comment; the run waits for a person to answer and re-approve    | `answered`                                   |                                                    |
| `pr`     | the pull request the session reported is marked ready; the run waits for a person                  | `feedback`, `base-moved`, `merged`, `closed` |                                                    |
| `learn`  | an agent in a fresh thread, given the run's record, to write what it learned into a skill or brief | `done`                                       | `instructions` (required)                          |
| `end`    | nothing; the run ends                                                                              | none                                         | `result`: `done` or `stuck`                        |

`instructions` is `{ skill: <name> }`, a skill installed on the factory machine, or `{ brief: <text> }`, free text. A `verify` node's `check` is the same, plus `{ commands: [<shell line>, ...] }` for a deterministic gate. The rule the user asked for, every node that runs an agent carries a brief or a skill, is a validation error when missing. `start`, `ask`, `pr` and `end` run no agent, so they carry none.

### Edges

An edge has `id`, `from` (a node), `port` (one of the source's ports), `to` (a node), and optionally `max` and `instructions`.

- One edge per port. An outcome with no edge ends the run `stuck`, with the outcome named as the reason. The editor warns on it.
- `max` is a loop limit: the number of times a run may take this edge. Past it, the run ends `stuck`. Every cycle must contain at least one edge with `max`; the check is that the graph with the limited edges removed is acyclic.
- `instructions` is what the agent is told when the edge is taken into an `agent` node that continues an existing thread. A node's instructions start a session; a transition's instructions continue one. With no transition instructions, the node's own are sent again.

### What the agent is told

The message that enters an `agent` node is the instructions (a skill as `/<name>`, a brief verbatim), then a context block the executor adds: the outcome that led here (the gate's output tail, the feedback items, the answers), and on a thread's first message the preamble (nobody is in the chat; end with a result line). The result-line protocol is the factory's: `FACTORY-DONE: <text>` is `done` (a pull request URL in the text is remembered for the `pr` node), `FACTORY-STOP: needs-info` after numbered questions is `questions`, `FACTORY-STOP: stuck` is `stop`. A message with no result line gets one reminder; a second gets `stop`. A `verify` reviewer answers the same way: `FACTORY-DONE` is `pass`, anything else is `fail` with the message as the output. A `learn` node is `done` whatever it answers; it never blocks the run.

## Validation

Validation runs on the server (`POST /api/factory/pipelines/validate`), so the editor and the executor agree. Problems carry a level (`error` or `warning`), a message and the node or edge they belong to. Errors stop a run from starting; a pipeline with errors still saves, as a draft.

Errors: exactly one `start`; at least one `end`; unknown node or port on an edge; an edge into `start` or out of an `end`; two edges on one port; missing `instructions` or `check`; a skill the machine does not have; a cycle with no limited edge; `max` below 1.

Warnings: a port with no edge (that outcome ends the run stuck); a node unreachable from `start`; `max` on an edge that is in no cycle.

## Simulation

A simulation walks the graph with outcomes the person picks. `POST /api/factory/pipelines/simulate` takes the pipeline and a script, a list of ports, and answers the trace: the node entered at each step, the edge taken, the loop counts, and where it stopped (an end, a stuck reason, or waiting at a node for the next outcome). The editor shows the trace on the canvas and offers the current node's ports as buttons. It is the interpreter the executor uses (`interpret.ts`), fed outcomes from a list instead of from agents, so what the simulation shows is what the run does.

## Execution

`PipelineRuns` starts a run from the UI: a pipeline, a T3 project (its workspace root), and optionally the issue to work on. The run is a fiber inside the factory layer. It walks the graph with `interpret.ts`, doing each node's work through the T3 sessions adapter (launch, send, status, archive), the factory process runner (commands) and the GitHub tracker (comments, labels, pull requests). Every step is appended to the run's record as it happens, so the page shows the run live and the record survives the process.

The prototype's limits, by choice:

- A run is not resumed across a server stop. When the server stops, each running run is interrupted, its threads archived and its record ended `interrupted`; a record a crash left open is marked so at the next start. The factory's issue runs have resumable steps; pipeline runs do not yet.
- A run may work for 180 minutes in all (`RUN_LIMIT_MINUTES`), counted like the factory's own limit: time spent waiting at `ask` and `pr` nodes does not count. Past it the run ends `stuck`.
- Reads in the wait loops (a thread's status, the issue's approval, the pull request) are retried on failure and give up only after ten failures in a row, so a day-long wait survives a network blip. Writes fail at once.
- Who counts as a person is the repo's `instructors`, read from the checkout's `.dw/config.yml`, else from the default branch's. With neither, the run has no tracker, and its `ask` and `pr` nodes end it stuck.
- Commands run in the session's worktree, not in a fresh checkout merged with the base, as the factory's gate does.
- `ask` and `pr` need an issue on a watched repo. A run started without one ends `stuck` when it reaches them.
- A thread's settlement is polled, every 10 seconds; the factory's own runs are woken by the event stream.
- An `ask` node waits for the issue to be `factory:ready` again, which is also what the claim loop claims. On a watched repo the fixed lifecycle can claim the issue before the pipeline reads the answer. Until the claim loop hands issues to pipelines, run pipelines with `ask` nodes on issues the claim loop will not take: a repo the factory does not watch, or with claims paused.

The claim loop does not start pipeline runs for `factory:ready` issues yet. Wiring that is the follow-up once the design has been used: a repo's factory block would name its pipeline, and the pass would hand a claimed issue to `PipelineRuns` instead of the fixed lifecycle.

## HTTP

Under `/api/factory/pipelines`, with the factory's auth (`t3/auth.ts`):

| method | path             | scope                 | does                                                              |
| ------ | ---------------- | --------------------- | ----------------------------------------------------------------- |
| GET    | `/catalog`       | orchestration:read    | the node kinds, their ports, and the skills                       |
| GET    | `/`              | orchestration:read    | lists pipelines: id, name, counts, problems                       |
| GET    | `/:id`           | orchestration:read    | one pipeline with its problems                                    |
| POST   | `/:id`           | settings:write        | saves the body as the pipeline; answers it back with its problems |
| POST   | `/:id/delete`    | settings:write        | removes it                                                        |
| POST   | `/validate`      | orchestration:read    | problems for the body, without saving                             |
| POST   | `/simulate`      | orchestration:read    | the trace for `{ pipeline, script }`                              |
| POST   | `/:id/run`       | orchestration:operate | starts a run: `{ projectRoot, issue? }`                           |
| GET    | `/runs`          | orchestration:read    | lists runs                                                        |
| GET    | `/runs/:id`      | orchestration:read    | one run's record                                                  |
| POST   | `/runs/:id/stop` | orchestration:operate | stops it                                                          |

POST, not PUT or DELETE: the browser CORS layer allows GET and POST.

## Templates

`pipeline/templates.ts` holds three pipelines the catalog serves and the New pipeline dialog offers: the three prototypes the design was exercised on, simplest first. A template is a pipeline body; the dialog gives it the new name and id. They are the examples in this document, kept valid by their test.

## Skills on the machine

The catalog lists `<dir>/<name>/SKILL.md` under `~/.claude/skills`, `~/.codex/skills` and `~/.agents/skills`, with the `name` and `description` from the front matter. The same skill reached through two of those (the hub symlinks) is listed once.
