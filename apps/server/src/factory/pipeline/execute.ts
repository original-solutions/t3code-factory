/**
 * The executor: walks a pipeline with `interpret.ts`, doing each node's work through ports, and
 * records every step as it happens. The ports are the only I/O, so the tests drive it with fakes
 * and `live.ts` binds them to T3 sessions, the process runner and GitHub.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  kindInfo,
  type Check,
  type Edge,
  type Instructions,
  type Node,
  type Pipeline,
} from "./model.ts";
import { advance, initialCursor, nodeOf, type Cursor } from "./interpret.ts";
import { readResult } from "./resultLine.ts";
import type { RunEvent } from "./runsService.ts";

export class PortError extends Schema.TaggedError<PortError>()("PipelinePortError", {
  message: Schema.String,
}) {}

/** A thread as the executor knows it; the worktree and branch are null until T3 prepared them. */
export interface ThreadRef {
  readonly threadId: string;
  readonly worktree: string | null;
  readonly branch: string | null;
}

export type PullRequestPort = "feedback" | "base-moved" | "merged" | "closed";

export interface Tracker {
  /** Posts the agent's questions on the issue and asks a person to answer. */
  readonly postQuestions: (text: string) => Effect.Effect<void, PortError>;
  /** Waits until a person set `factory:ready` again; answers the comments since the questions. */
  readonly awaitAnswer: () => Effect.Effect<{ readonly text: string }, PortError>;
  readonly markReady: (pr: number) => Effect.Effect<void, PortError>;
  /** Waits for the next event on the pull request. */
  readonly awaitPullRequest: (
    pr: number,
  ) => Effect.Effect<{ readonly port: PullRequestPort; readonly detail: string | null }, PortError>;
}

export interface Ports {
  /** Starts a thread in its own worktree from `fromBranch`, or from the project's base when null. */
  readonly launch: (input: {
    readonly title: string;
    readonly message: string;
    readonly fromBranch: string | null;
  }) => Effect.Effect<ThreadRef, PortError>;
  readonly send: (threadId: string, message: string) => Effect.Effect<void, PortError>;
  /** Waits until the thread's current run is settled; answers its last assistant message (null when none). */
  readonly settle: (threadId: string) => Effect.Effect<
    {
      readonly text: string | null;
      readonly worktree: string | null;
      readonly branch: string | null;
    },
    PortError
  >;
  readonly archive: (threadId: string) => Effect.Effect<void, PortError>;
  /** Runs each line as a /bin/sh command in `cwd`, stopping at the first failure. */
  readonly commands: (
    lines: ReadonlyArray<string>,
    cwd: string,
  ) => Effect.Effect<{ readonly ok: boolean; readonly output: string }, PortError>;
  /** Null when the run has no issue on a watched repo: `ask` and `pr` then end the run stuck. */
  readonly tracker: Tracker | null;
  readonly record: (event: RunEvent) => Effect.Effect<void, PortError>;
}

export interface RunContext {
  /** The watched repo, `owner/name`, when the project is one. */
  readonly repo: string | null;
  readonly issue: number | null;
}

export type RunEnd = {
  readonly result: "done" | "stuck" | "error";
  readonly reason: string | null;
};

export const RESULT_LINES =
  "End your reply with one result line: FACTORY-DONE: <summary or PR URL>, FACTORY-STOP: needs-info (after numbered questions), or FACTORY-STOP: stuck.";

export const RESULT_LINE_REMINDER = `Your last reply had no result line. If your work is still in progress, finish it. ${RESULT_LINES}`;

export const REVIEW_ENDING =
  "Review the work on this branch. End with FACTORY-DONE if it passes, FACTORY-STOP: stuck with your reasons if not.";

export const NO_RESULT_TWICE = "no result line twice";
export const NO_WORKTREE = "no worktree yet";
export const NO_PULL_REQUEST = "no pull request was reported";

/** How much of each outcome's detail a learner is shown. */
const DETAIL_IN_SUMMARY = 400;

const nameOf = (node: Node) => node.label ?? kindInfo(node.kind).label;

export const instructionsText = (instructions: Instructions | Check): string =>
  "skill" in instructions
    ? `/${instructions.skill}`
    : "brief" in instructions
      ? instructions.brief
      : instructions.commands.join("\n");

const preamble = (pipeline: Pipeline, node: Node, run: RunContext): string => {
  const issue =
    run.issue === null ? "" : ` The issue is ${run.repo === null ? "" : run.repo}#${run.issue}.`;
  return `The factory launched this session unattended as part of the pipeline ${pipeline.name}, step ${nameOf(node)}. Nobody is in the chat.${issue} ${RESULT_LINES}`;
};

/** What one node ended with, or the reason the run ends stuck at it. */
type Step = { readonly port: string; readonly detail: string | null } | { readonly stuck: string };

/** What a node ended with, and the node, so the next message can say what the detail is. */
interface Outcome {
  readonly node: Node;
  readonly port: string;
  readonly detail: string | null;
}

const contextTitle = (outcome: Outcome): string => {
  switch (outcome.node.kind) {
    case "verify":
      return "The gate's output:";
    case "ask":
      return "The answers:";
    case "pr":
      return outcome.port === "feedback" ? "The feedback:" : "The pull request:";
    default:
      return "The previous step's reply:";
  }
};

const contextBlock = (outcome: Outcome | null): string =>
  outcome === null || outcome.detail === null || outcome.detail.trim() === ""
    ? ""
    : `\n\n${contextTitle(outcome)}\n\n${outcome.detail}`;

/** The run so far, as a learner reads it: the nodes entered, their outcomes and the loops taken. */
export const recordSummary = (pipeline: Pipeline, events: ReadonlyArray<RunEvent>): string => {
  const taken = new Map<string, number>();
  const lines: Array<string> = [];
  for (const event of events) {
    switch (event.event) {
      case "entered": {
        const node = nodeOf(pipeline, event.node);
        const name = node === undefined ? event.node : nameOf(node);
        lines.push(`- ${name} (${event.node}), visit ${event.visit}`);
        break;
      }
      case "outcome": {
        const detail =
          event.detail === null || event.detail.trim() === ""
            ? ""
            : `: ${event.detail.trim().slice(0, DETAIL_IN_SUMMARY)}`;
        lines.push(`  ended with ${event.port}${detail}`);
        break;
      }
      case "moved": {
        const count = (taken.get(event.edge) ?? 0) + 1;
        taken.set(event.edge, count);
        const max = pipeline.edges.find((edge) => edge.id === event.edge)?.max;
        lines.push(`  took ${event.edge}${max === undefined ? "" : ` (${count} of ${max})`}`);
        break;
      }
      case "error":
        lines.push(`  error: ${event.message}`);
        break;
      default:
        break;
    }
  }
  return lines.join("\n");
};

/**
 * Walks `pipeline` from its start node to an end, recording each step through `ports.record`.
 * Answers how the run ended. A port's failure is recorded as an `error` and ends the run with
 * it; the effect fails only when the record itself cannot be written.
 */
export const execute = Effect.fn("PipelineExecute.execute")(function* (
  pipeline: Pipeline,
  ports: Ports,
  run: RunContext,
) {
  const log: Array<RunEvent> = [];
  const record = (event: RunEvent) =>
    Effect.suspend(() => {
      log.push(event);
      return ports.record(event);
    });

  /** The run's session: the thread non-fresh agent nodes continue, whose branch is the run's. */
  let main: ThreadRef | null = null;
  let pr: number | null = null;
  const markedReady = new Set<number>();
  const visits = new Map<string, number>();

  // One step that a stop cannot cut in two: a stopped run archives the threads its record
  // names, so a thread that was launched must be in the record.
  const launch = Effect.fn("PipelineExecute.launch")(function* (
    node: Node,
    message: string,
    fromBranch: string | null,
  ) {
    const thread = yield* ports.launch({
      title: `${pipeline.name}: ${nameOf(node)}`,
      message,
      fromBranch,
    });
    yield* record({ event: "thread", node: node.id, ...thread });
    return thread;
  }, Effect.uninterruptible);

  /** Settles `thread` and keeps the main thread's worktree and branch once T3 has them. */
  const settle = Effect.fn("PipelineExecute.settle")(function* (node: Node, thread: ThreadRef) {
    const settled = yield* ports.settle(thread.threadId);
    if (
      main !== null &&
      main.threadId === thread.threadId &&
      (settled.worktree !== main.worktree || settled.branch !== main.branch)
    ) {
      main = { threadId: main.threadId, worktree: settled.worktree, branch: settled.branch };
      yield* record({ event: "thread", node: node.id, ...main });
    }
    return settled.text;
  });

  const agent = Effect.fn("PipelineExecute.agent")(function* (
    node: Extract<Node, { kind: "agent" }>,
    edge: Edge | null,
    incoming: Outcome | null,
  ) {
    const context = contextBlock(incoming);
    let thread: ThreadRef;
    if (main === null || node.fresh) {
      const message = `${instructionsText(node.instructions)}${context}\n\n${preamble(pipeline, node, run)}`;
      thread = yield* launch(node, message, main?.branch ?? null);
      if (!node.fresh) main = thread;
    } else {
      thread = main;
      yield* ports.send(
        thread.threadId,
        `${instructionsText(edge?.instructions ?? node.instructions)}${context}`,
      );
      yield* record({ event: "thread", node: node.id, ...thread });
    }
    let result = readResult(yield* settle(node, thread));
    if (result.kind === "none") {
      yield* ports.send(thread.threadId, RESULT_LINE_REMINDER);
      result = readResult(yield* settle(node, thread));
    }
    if (node.fresh) yield* ports.archive(thread.threadId);
    switch (result.kind) {
      case "done":
        if (result.pr !== null) pr = result.pr;
        return { port: "done", detail: result.text } as const;
      case "questions":
        return { port: "questions", detail: result.questions } as const;
      case "stop":
        return { port: "stop", detail: result.text } as const;
      case "none":
        return { port: "stop", detail: NO_RESULT_TWICE } as const;
    }
  });

  const verify = Effect.fn("PipelineExecute.verify")(function* (
    node: Extract<Node, { kind: "verify" }>,
    incoming: Outcome | null,
  ) {
    const check = node.check;
    if ("commands" in check) {
      if (main === null || main.worktree === null) {
        return { port: "fail", detail: NO_WORKTREE } as const;
      }
      const ran = yield* ports.commands(check.commands, main.worktree);
      return { port: ran.ok ? "pass" : "fail", detail: ran.output } as const;
    }
    const message = `${instructionsText(check)}${contextBlock(incoming)}\n\n${REVIEW_ENDING}`;
    const reviewer = yield* launch(node, message, main?.branch ?? null);
    const text = yield* settle(node, reviewer);
    yield* ports.archive(reviewer.threadId);
    const result = readResult(text);
    return result.kind === "done"
      ? ({ port: "pass", detail: result.text } as const)
      : ({ port: "fail", detail: text } as const);
  });

  const learn = Effect.fn("PipelineExecute.learn")(function* (
    node: Extract<Node, { kind: "learn" }>,
  ) {
    const message = `${instructionsText(node.instructions)}\n\nThe run's record:\n\n${recordSummary(pipeline, log)}\n\n${preamble(pipeline, node, run)}`;
    const learner = yield* launch(node, message, main?.branch ?? null);
    const text = yield* settle(node, learner);
    yield* ports.archive(learner.threadId);
    return { port: "done", detail: text } as const;
  });

  const step = Effect.fn("PipelineExecute.step")(function* (
    node: Node,
    edge: Edge | null,
    incoming: Outcome | null,
  ): Effect.fn.Return<Step, PortError> {
    switch (node.kind) {
      case "start":
        return { port: "next", detail: null };
      case "agent":
        return yield* agent(node, edge, incoming);
      case "verify":
        return yield* verify(node, incoming);
      case "learn":
        return yield* learn(node);
      case "ask": {
        if (ports.tracker === null)
          return { stuck: `${nameOf(node)} needs an issue on a watched repo` };
        yield* ports.tracker.postQuestions(incoming?.detail ?? "");
        yield* record({ event: "waiting", node: node.id, on: "an answer on the issue" });
        const answer = yield* ports.tracker.awaitAnswer();
        return { port: "answered", detail: answer.text };
      }
      case "pr": {
        if (pr === null) return { stuck: NO_PULL_REQUEST };
        if (ports.tracker === null)
          return { stuck: `${nameOf(node)} needs an issue on a watched repo` };
        if (!markedReady.has(pr)) {
          yield* ports.tracker.markReady(pr);
          markedReady.add(pr);
        }
        yield* record({ event: "waiting", node: node.id, on: `pull request #${pr}` });
        return yield* ports.tracker.awaitPullRequest(pr);
      }
      case "end":
        return { stuck: "an end node has no outcome" };
    }
  });

  const finish = Effect.fn("PipelineExecute.finish")(function* (
    result: RunEnd["result"],
    reason: string | null,
  ) {
    if (main !== null) yield* Effect.ignore(ports.archive(main.threadId));
    yield* record({ event: "ended", result, reason });
    return { result, reason } satisfies RunEnd;
  });

  const enter = Effect.fn("PipelineExecute.enter")(function* (id: string) {
    const visit = (visits.get(id) ?? 0) + 1;
    visits.set(id, visit);
    yield* record({ event: "entered", node: id, visit });
  });

  const walk = Effect.gen(function* () {
    let cursor: Cursor | undefined = initialCursor(pipeline);
    if (cursor === undefined) return yield* finish("stuck", "the pipeline has no start node");
    yield* enter(cursor.node);
    let edge: Edge | null = null;
    let incoming: Outcome | null = null;
    while (true) {
      const node = nodeOf(pipeline, cursor.node);
      if (node === undefined) return yield* finish("stuck", `node ${cursor.node} does not exist`);
      if (node.kind === "end") return yield* finish(node.result, null);
      const outcome: Step = yield* step(node, edge, incoming);
      if ("stuck" in outcome) return yield* finish("stuck", outcome.stuck);
      yield* record({ event: "outcome", node: node.id, ...outcome });
      const move = advance(pipeline, cursor, outcome.port);
      if (move.kind === "stuck") return yield* finish("stuck", move.reason);
      yield* record({ event: "moved", edge: move.edge.id });
      cursor = move.cursor;
      edge = move.edge;
      incoming = { node, ...outcome };
      yield* enter(cursor.node);
    }
  });

  return yield* walk.pipe(
    Effect.catchTags({
      PipelinePortError: (error) =>
        Effect.gen(function* () {
          yield* record({ event: "error", message: error.message });
          return yield* finish("error", error.message);
        }),
    }),
  );
});
