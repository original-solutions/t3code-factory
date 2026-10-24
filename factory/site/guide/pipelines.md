# Design a pipeline

A pipeline is the path a run follows, drawn as a graph: which agent steps run, with what brief or skill, what verifies the work, where the run waits for a person, and where it loops back. The factory's fixed lifecycle (build, gate, pull request, feedback) is one such graph. A pipeline lets you draw a different one: a second reviewer, a stricter gate, or a learning step that writes what the run taught it into a skill the next run reads.

Pipelines belong to the machine that runs the factory. Open them from the Factory page's Pipelines link, or at `/factory/pipelines`. Reading needs a normal paired session; saving needs `settings:write`, starting a run `orchestration:operate`.

## Start from a template

New pipeline offers a blank canvas and three templates: Brief and gate (one agent with a brief, one gate, two tries), Build, review, ship (the factory's lifecycle with an agent review before the pull request), and Learning loop (the same, plus a learn step after the work is merged or given up). Pick the nearest one and change it.

## Nodes

Add a node from the Add menu, drag it where you want it, and fill it in on the right.

| Node             | What it does                                                                              | Ways out                             |
| ---------------- | ----------------------------------------------------------------------------------------- | ------------------------------------ |
| **Start**        | Where a run begins. One per pipeline.                                                     | next                                 |
| **Agent**        | An agent turn in the run's session. Give it a skill on this machine or a brief.           | done, questions, stop                |
| **Verify**       | Commands in the worktree, or a reviewer agent (skill or brief) that answers pass or fail. | pass, fail                           |
| **Ask**          | Posts the agent's questions on the issue and waits for a person to answer and re-approve. | answered                             |
| **Pull request** | Marks the pull request the session reported ready, and waits for a person.                | feedback, base-moved, merged, closed |
| **Learn**        | A fresh agent reads the run's record and writes what it learned into a skill or brief.    | done                                 |
| **End**          | The run ends, done or stuck.                                                              |                                      |

Every Agent, Verify and Learn node needs a brief or a skill. Skills are the ones installed on the factory machine, listed when you pick one. A brief is text the agent receives as written.

## Transitions and loops

Drag from a node's outcome to another node to make a transition. A transition back to an earlier node is a loop. Give it a limit: the number of times a run may take it before the run ends stuck. Every loop needs a limit on at least one of its transitions, and the editor says so until it has one.

A transition can carry instructions of its own. A node's instructions start a session; a transition's instructions continue one. When the gate fails and the run goes back to Build, the agent is told the transition's brief and the gate's output, not the Build skill again.

An outcome with no transition ends the run stuck, and the editor warns about it. Give the stuck end its own node so you can see where runs go.

## Check it before you run it

The editor validates as you edit. Errors (a missing brief, a loop without a limit, a skill this machine does not have) stop a run from starting; warnings do not.

Simulate walks the graph with outcomes you pick. Turn it on, and the current node's outcomes become buttons. Click them to follow the run, watch the loop counts on the transitions, and see where it ends. Happy path picks the first outcome every time. What the simulation shows is what a run does, because they share the same interpreter.

## Run it

Run starts the pipeline on a project of this environment, on an issue if you give one. Ask and Pull request nodes need an issue on a watched repo; without one, a run that reaches them ends stuck. The run's steps appear as they happen, and its threads are ordinary T3 threads. Stop ends a run and archives its threads.

Pipeline runs are started by hand for now. The claim loop still builds `factory:ready` issues with the fixed lifecycle. A run cut off by a server restart is marked interrupted, not resumed.
