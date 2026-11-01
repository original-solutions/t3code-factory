// The fictional factory the docs screenshots are taken of: one owner, `acme`, two repos, and a
// run in each state and at each post of the belt. Everything is written in the factory's own
// formats, through its ledger writer, so the server reads it as it reads a real machine's data.
// Nothing here names a real repo, login or path.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { Ledger } from "../../../apps/server/src/factory/ledger/ledger.ts";
import type {
  Cause,
  CauseExtras,
  CauseStep,
  RunEvent,
  StateName,
} from "../../../apps/server/src/factory/ledger/events.ts";
import { formatTs } from "../../../apps/server/src/factory/ledger/time.ts";

export const OWNER = "acme";
export const INSTRUCTORS = ["jo-park", "sam-lee"] as const;
const MACHINE = "build-mac";
const FACTORY_LOGIN = "acme-factory";
const GATE = ["npm run lint", "npm test"] as const;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export type DemoRunKind =
  | "claimed"
  | "building"
  | "gate"
  | "pr-open"
  | "needs-info"
  | "stuck"
  | "merged";

export interface DemoRun {
  readonly repo: string;
  readonly issue: number;
  readonly title: string;
  readonly kind: DemoRunKind;
  readonly instructor: (typeof INSTRUCTORS)[number];
  /** How long before now the instructor approved it. */
  readonly startedAgoMs: number;
  /** The pull request the session opened, for a run that got that far. */
  readonly pr?: number;
  /** For `needs-info`: what the session asked, as it was posted on the issue. */
  readonly questions?: string;
}

export const DEMO_RUNS: ReadonlyArray<DemoRun> = [
  {
    repo: "acme/storefront",
    issue: 60,
    title: "Show stock levels on product cards",
    kind: "claimed",
    instructor: "jo-park",
    startedAgoMs: 4 * MINUTE,
  },
  {
    repo: "acme/billing",
    issue: 24,
    title: "Retry failed webhook deliveries",
    kind: "building",
    instructor: "sam-lee",
    startedAgoMs: 38 * MINUTE,
  },
  {
    repo: "acme/billing",
    issue: 27,
    title: "Export invoices as CSV",
    kind: "gate",
    instructor: "jo-park",
    startedAgoMs: 70 * MINUTE,
    pr: 29,
  },
  {
    repo: "acme/billing",
    issue: 19,
    title: "Send invoices in the customer's currency",
    kind: "needs-info",
    instructor: "jo-park",
    startedAgoMs: 95 * MINUTE,
    // Short enough to read whole in the run page's one-line ledger row.
    questions: ["1. Card or billing-country currency?", "2. Reissue open invoices?"].join("\n"),
  },
  {
    repo: "acme/storefront",
    issue: 57,
    title: "Refund button on the order page",
    kind: "pr-open",
    instructor: "jo-park",
    startedAgoMs: 3 * HOUR,
    pr: 63,
  },
  {
    repo: "acme/storefront",
    issue: 52,
    title: "Saved addresses at checkout",
    kind: "stuck",
    instructor: "sam-lee",
    startedAgoMs: 6 * HOUR,
    pr: 61,
  },
  {
    repo: "acme/storefront",
    issue: 48,
    title: "Fix the coupon field on mobile",
    kind: "merged",
    instructor: "jo-park",
    startedAgoMs: 2 * DAY,
    pr: 58,
  },
];

/** The machine config the server loads from `<home>/factory/config.yml`. */
const MACHINE_CONFIG = `# Demo machine config for the docs screenshots.
gh_config_dir: /Users/jo-park/.config/t3fac/gh
poll_seconds: 60
max_concurrent_runs: 2
max_concurrent_gates: 1
notify: false
# The throwaway home sits on whatever disk runs the script; no low-disk item in the shots.
min_free_gib: 0
`;

/** A stable fake id from a run, so every rerun of the script draws the same images. */
const hex = (seed: string, length: number): string => {
  let out = "";
  let h = 2166136261;
  while (out.length < length) {
    for (const c of `${seed}:${out.length}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
    out += (h >>> 0).toString(16).padStart(8, "0");
  }
  return out.slice(0, length);
};

const uuid = (seed: string): string => {
  const h = hex(seed, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20)}`;
};

const runName = (run: DemoRun): string => `${run.repo.replace("/", "__")}__${run.issue}__1`;

/**
 * Writes one run's ledger as the factory would have written it, each line stamped at its own
 * moment from the approval on. Answers the moment of its last line.
 */
const writeRun = (factoryDir: string, run: DemoRun, nowMs: number): number => {
  let at = nowMs - run.startedAgoMs;
  const ledger = Ledger.create(
    factoryDir,
    { repo: run.repo, issue: String(run.issue), attempt: 1 },
    { clock: () => at },
  );
  const name = run.repo.split("/")[1]!;
  const branch = `t3/${name}-issue-${run.issue}`;
  const worktree = `/Users/jo-park/.config/t3fac/worktrees/${name}/t3-${hex(runName(run), 8)}`;
  const prUrl = run.pr === undefined ? null : `https://github.com/${run.repo}/pull/${run.pr}`;
  const head = hex(`${runName(run)}:head`, 40);
  const base = hex(`${run.repo}:base`, 40);

  const write = (
    afterMs: number,
    event: RunEvent,
    step: CauseStep,
    reason: string,
    extras: CauseExtras = {},
  ) => {
    at += afterMs;
    const cause: Cause = { step, reason, ...extras };
    ledger.append(event, cause);
  };
  const step = (
    afterMs: number,
    value: string,
    cause: CauseStep,
    reason: string,
    extras: CauseExtras = {},
  ) => write(afterMs, { event: "step_changed", data: { step: value } }, cause, reason, extras);
  const state = (
    afterMs: number,
    change: { from: StateName; to: StateName },
    cause: CauseStep,
    reason: string,
  ) => write(afterMs, { event: "state_changed", data: change }, cause, reason);
  const gateAttempt = (attempt: number, exits: ReadonlyArray<number>, ran = GATE.length) => {
    write(
      2 * MINUTE,
      {
        event: "gate_checkout",
        data: {
          attempt,
          dir: `/Users/jo-park/.config/t3fac/factory/gate/${runName(run)}/${attempt}`,
          sha: head,
          base_sha: base,
        },
      },
      "gate",
      "gate-checkout-made",
      { attempt },
    );
    GATE.slice(0, ran).forEach((command, index) => {
      const exit = exits[index] ?? 0;
      write(
        index === 0 ? 40_000 : 95_000,
        {
          event: "gate_command",
          data: {
            attempt,
            command,
            exit_code: exit,
            duration_ms: index === 0 ? 38_412 + attempt * 517 : 93_208 + attempt * 1_309,
          },
        },
        "gate",
        "gate-command-ran",
        { command, attempt },
      );
    });
  };
  const sendBack = (attempt: number) => {
    step(4_000, `gate-sending ${attempt} ${attempt}`, "gate", "gate-sending", { attempt });
    write(
      3_000,
      { event: "gate_sent_back", data: { attempt, run_ordinal: attempt } },
      "gate",
      "gate-sent-back",
      { attempt },
    );
  };
  const removeWorktree = (cause: CauseStep) =>
    write(
      20_000,
      { event: "worktree_removed", data: { path: worktree } },
      cause,
      "worktree-removed",
    );
  const passGate = (attempt: number) => {
    step(15_000, `gate-passed ${head} ${GATE.length}`, "gate", "gate-passed", { attempt });
    removeWorktree("gate");
    step(3_000, "gate-results-posted", "gate", "gate-results-posted");
    state(4_000, { from: "building", to: "pr-open" }, "gate", "gate-passed");
  };

  // Claim, launch, and the move to building, as every run starts.
  step(2 * MINUTE, `approved ${formatTs(at).replace(/\.\d+Z$/, "Z")}`, "start", "approved", {
    actor: run.instructor,
  });
  write(
    7,
    { event: "claimed", data: { machine: MACHINE, github_user: FACTORY_LOGIN } },
    "start",
    "claimed",
  );
  state(5, { from: "ready", to: "triage" }, "start", "claimed");
  step(8, "launch-sending", "start", "launch-sending");
  // A claimed run is still waiting for its session to start.
  if (run.kind === "claimed") {
    ledger.close();
    return at;
  }
  write(
    40,
    {
      event: "session_launched",
      data: {
        thread_id: `thread:project:${uuid(run.repo)}:${uuid(runName(run))}`,
        worktree: null,
        branch: null,
        model_instance: "claudeAgent",
        model: "claude-opus-5-5",
        model_options: null,
        resumed_from: null,
        title: run.title,
      },
    },
    "start",
    "session-launched",
  );
  step(600, "approval-rechecked", "start", "approval-rechecked");
  state(4_500, { from: "triage", to: "building" }, "start", "session-started");

  switch (run.kind) {
    case "building":
      break;
    case "gate":
      write(
        47 * MINUTE,
        { event: "pr_opened", data: { pr: run.pr!, url: prUrl! } },
        "advance",
        "pr-opened",
      );
      // Partway through its first gate: the lint has passed and the tests are running.
      gateAttempt(1, [0], 1);
      break;
    case "needs-info":
      write(
        14 * MINUTE,
        { event: "questions_posted", data: { questions: run.questions ?? "" } },
        "advance",
        "questions-asked",
      );
      state(7_000, { from: "building", to: "needs-info" }, "advance", "questions-asked");
      removeWorktree("advance");
      ledger.finish("needs-info", null, null, { step: "advance", reason: "questions-asked" });
      break;
    case "pr-open":
      write(
        52 * MINUTE,
        { event: "pr_opened", data: { pr: run.pr!, url: prUrl! } },
        "advance",
        "pr-opened",
      );
      gateAttempt(1, [0, 1]);
      sendBack(1);
      gateAttempt(2, [0, 0]);
      passGate(2);
      break;
    case "stuck":
      write(
        71 * MINUTE,
        { event: "pr_opened", data: { pr: run.pr!, url: prUrl! } },
        "advance",
        "pr-opened",
      );
      for (const attempt of [1, 2, 3]) {
        gateAttempt(attempt, [0, 1]);
        if (attempt < 3) {
          sendBack(attempt);
          at += 18 * MINUTE;
        }
      }
      // As the factory ends a stuck run: the session's worktree goes first.
      removeWorktree("gate");
      write(
        5_000,
        {
          event: "stuck",
          data: { reason: "the gate failed after 3 attempts", branch, commits_ahead: 9 },
        },
        "gate",
        "gate-failed",
      );
      state(4_000, { from: "building", to: "stuck" }, "gate", "gate-failed");
      ledger.finish("stuck", null, null, { step: "gate", reason: "gate-failed" });
      break;
    case "merged":
      write(
        44 * MINUTE,
        { event: "pr_opened", data: { pr: run.pr!, url: prUrl! } },
        "advance",
        "pr-opened",
      );
      gateAttempt(1, [0, 0]);
      passGate(1);
      at += 5 * HOUR;
      ledger.finish(
        "pr-open",
        null,
        prUrl,
        { step: "gate", reason: "pull-request-ended" },
        "merged",
      );
      break;
  }
  ledger.close();
  return at;
};

/** The Needs attention items the pass raised when the stuck and needs-info runs ended. */
const attentionItems = (endedAt: ReadonlyMap<DemoRun, number>) =>
  DEMO_RUNS.flatMap((run) => {
    if (run.kind !== "stuck" && run.kind !== "needs-info") return [];
    const name = runName(run);
    const label = `${run.repo}#${run.issue}`;
    return [
      {
        id: `run:${name}:${run.kind}`,
        kind: run.kind,
        repo: run.repo,
        issue: run.issue,
        run: name,
        message:
          run.kind === "stuck"
            ? `${label} stuck, the reason is in the ledger of run ${name}`
            : `${label} needs-info, the session asked questions on the issue`,
        first_seen: formatTs(endedAt.get(run)!),
      },
    ];
  });

/**
 * Seeds `<home>/factory`, the factory's data dir under a T3 home: the machine config, a ledger
 * per run in `DEMO_RUNS`, and the open attention items. No T3 project is seeded, so no repo is
 * watched and the factory's passes have nothing to ask GitHub.
 */
export const seedDemoHome = (home: string, nowMs: number): void => {
  const factoryDir = NodePath.join(home, "factory");
  NodeFS.mkdirSync(factoryDir, { recursive: true, mode: 0o700 });
  NodeFS.writeFileSync(NodePath.join(factoryDir, "config.yml"), MACHINE_CONFIG, { mode: 0o600 });
  const endedAt = new Map(DEMO_RUNS.map((run) => [run, writeRun(factoryDir, run, nowMs)]));
  NodeFS.writeFileSync(
    NodePath.join(factoryDir, "attention.json"),
    `${JSON.stringify({ items: attentionItems(endedAt) })}\n`,
    { mode: 0o600 },
  );
};

/** The run id of the first run of `kind`, as the Factory page links it. */
export const demoRunId = (kind: DemoRunKind): string => {
  const run = DEMO_RUNS.find((candidate) => candidate.kind === kind);
  if (run === undefined) throw new Error(`no demo run is ${kind}`);
  return runName(run);
};
