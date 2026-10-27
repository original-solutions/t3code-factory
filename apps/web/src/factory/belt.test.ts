import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { FactoryRunRow, FactoryStatus } from "./api";
import {
  deriveBelt,
  fitLane,
  formatClock,
  newestAttempts,
  nextPassText,
  stationOf,
  type BeltEnvironment,
} from "./belt";

const ENV_A = "env-a" as EnvironmentId;
const ENV_B = "env-b" as EnvironmentId;

/** A local time, so the day boundaries the tests cross are the viewer's, whatever zone this runs in. */
const at = (hour: number, minute = 0, dayOffset = 0) =>
  new Date(2026, 9, 27 + dayOffset, hour, minute).getTime();
const iso = (ms: number) => new Date(ms).toISOString();
const NOW = at(15);

const id = (issue: number, attempt = 1, repo = "acme/widgets") =>
  `${repo.replace("/", "__")}__${issue}__${attempt}`;

const row = (overrides: Partial<FactoryRunRow> & { id: string }): FactoryRunRow => ({
  started_ts: iso(at(9)),
  state: "building",
  last_event: "step_changed",
  step: null,
  status: "running",
  pr_url: null,
  finished: false,
  total_ms: null,
  unreadable: false,
  ...overrides,
});

type ActiveRun = FactoryStatus["runs"][number];
const active = (overrides: Partial<ActiveRun> & { id: string }): ActiveRun => ({
  state: "building",
  last_event: "step_changed",
  title: null,
  user: null,
  for_ms: 60_000,
  pr_url: null,
  thread_id: null,
  unreadable: false,
  ...overrides,
});

const environment = (
  environmentId: EnvironmentId,
  parts: { active?: ActiveRun[]; recent?: FactoryRunRow[] } = {},
): BeltEnvironment => ({
  environmentId,
  label: environmentId === ENV_A ? "Desktop" : "Studio",
  active: parts.active ?? [],
  recent: parts.recent ?? [],
});

const finished = (
  issue: number,
  end: "merged" | "closed" | null,
  startedMs: number,
  totalMs: number,
  attempt = 1,
) =>
  row({
    id: id(issue, attempt),
    state: "pr-open",
    finished: true,
    status: "finished",
    pr_end: end,
    started_ts: iso(startedMs),
    total_ms: totalMs,
  });

describe("stationOf", () => {
  it.each([
    [{ state: "triage", last_event: "claimed" }, "claimed"],
    [{ state: null, last_event: null }, "claimed"],
    [{ state: "building", last_event: "session_launched" }, "building"],
    [{ state: "building", last_event: null }, "building"],
    [{ state: "building", last_event: "gate_checkout" }, "gate"],
    [{ state: "building", last_event: "gate_command" }, "gate"],
    [{ state: "pr-open", last_event: "gate_checkout" }, "pr"],
    [{ state: "pr-open", last_event: "gate_regate" }, "pr"],
    [{ state: "stuck", last_event: "stuck" }, null],
    [{ state: "needs-info", last_event: "questions_posted" }, null],
    [{ state: "something-new", last_event: null }, null],
  ] as const)("puts %j on %s", (run, station) => {
    expect(stationOf(run)).toBe(station);
  });
});

describe("newestAttempts", () => {
  it("keeps the highest attempt of each issue, comparing the attempt as a number", () => {
    const kept = newestAttempts([
      { id: id(5, 9) },
      { id: id(5, 10) },
      { id: id(5, 2) },
      { id: id(6, 1) },
    ]);
    expect(kept.map((run) => run.id).toSorted()).toEqual([id(5, 10), id(6, 1)].toSorted());
  });

  it("compares the repo without regard to case", () => {
    const kept = newestAttempts([
      { id: id(5, 1, "Acme/Widgets") },
      { id: id(5, 2, "acme/widgets") },
    ]);
    expect(kept.map((run) => run.id)).toEqual([id(5, 2, "acme/widgets")]);
  });

  it("keeps issues of different repos apart, and an id that does not parse as its own", () => {
    const kept = newestAttempts([
      { id: id(5, 1, "acme/widgets") },
      { id: id(5, 1, "acme/gadgets") },
      { id: "unparsed" },
    ]);
    expect(kept).toHaveLength(3);
  });
});

describe("fitLane", () => {
  it("hides nothing when every run has a slot", () => {
    expect(fitLane(0, 5)).toEqual({ shown: 0, hidden: 0 });
    expect(fitLane(5, 5)).toEqual({ shown: 5, hidden: 0 });
  });

  it("shows one tile fewer than the slots and a +N tile for the rest", () => {
    expect(fitLane(12, 6)).toEqual({ shown: 5, hidden: 7 });
    expect(fitLane(6, 5)).toEqual({ shown: 4, hidden: 2 });
  });

  it("leaves only the +N tile when a single slot fits", () => {
    expect(fitLane(3, 1)).toEqual({ shown: 0, hidden: 3 });
    expect(fitLane(3, 0)).toEqual({ shown: 0, hidden: 3 });
  });
});

describe("nextPassText", () => {
  const passes = (overrides: Partial<FactoryStatus["passes"]> = {}): FactoryStatus["passes"] => ({
    at: iso(NOW - 12_000),
    poll_seconds: 60,
    running: false,
    ...overrides,
  });

  it("counts down to the end of the last pass plus the poll", () => {
    expect(nextPassText(passes(), NOW)).toBe("next pass in 48s");
    expect(nextPassText(passes(), NOW + 30_000)).toBe("next pass in 18s");
  });

  it("stops at 0 once the pass is due", () => {
    expect(nextPassText(passes(), NOW + 48_000)).toBe("next pass in 0s");
    expect(nextPassText(passes(), NOW + 600_000)).toBe("next pass in 0s");
  });

  it("says a pass is running while one is, whatever the clock says", () => {
    expect(nextPassText(passes({ running: true }), NOW)).toBe("pass running");
    expect(nextPassText(passes({ running: true, at: null }), NOW)).toBe("pass running");
  });

  it("says the pass is overdue when the server calls the last pass stale", () => {
    expect(nextPassText(passes({ stale: true }), NOW + 600_000)).toBe("pass overdue");
    expect(nextPassText(passes({ stale: false }), NOW)).toBe("next pass in 48s");
  });

  it("says a running pass is running even when the last one is stale", () => {
    expect(nextPassText(passes({ stale: true, running: true }), NOW)).toBe("pass running");
  });

  it("says nothing without a last pass or a poll", () => {
    expect(nextPassText(passes({ at: null }), NOW)).toBeNull();
    expect(nextPassText(passes({ poll_seconds: null }), NOW)).toBeNull();
    expect(nextPassText(passes({ at: "not a time" }), NOW)).toBeNull();
    expect(nextPassText(undefined, NOW)).toBeNull();
  });
});

describe("formatClock", () => {
  it("is HH:MM in the viewer's time with both parts padded", () => {
    expect(formatClock(at(9, 5))).toBe("09:05");
    expect(formatClock(at(23, 40))).toBe("23:40");
    expect(formatClock(at(0, 0))).toBe("00:00");
  });
});

describe("deriveBelt rail", () => {
  it("puts each unfinished run on its station across environments, newest first", () => {
    const belt = deriveBelt(
      [
        environment(ENV_A, {
          active: [
            active({ id: id(1), state: "triage", last_event: "claimed" }),
            active({ id: id(2), state: "pr-open" }),
            active({ id: id(3), state: "pr-open" }),
            active({ id: id(4), last_event: "gate_command" }),
          ],
          recent: [
            row({ id: id(2), state: "pr-open", started_ts: iso(at(8)) }),
            row({ id: id(3), state: "pr-open", started_ts: iso(at(10)) }),
          ],
        }),
        environment(ENV_B, {
          active: [active({ id: id(7, 1, "acme/gadgets"), state: "pr-open" })],
          recent: [row({ id: id(7, 1, "acme/gadgets"), started_ts: iso(at(9)) })],
        }),
      ],
      NOW,
    );
    expect(belt.runs.claimed.map((run) => run.id)).toEqual([id(1)]);
    expect(belt.runs.building).toEqual([]);
    expect(belt.runs.gate.map((run) => run.id)).toEqual([id(4)]);
    expect(belt.runs.pr.map((run) => [run.environmentId, run.issue])).toEqual([
      [ENV_A, "#3"],
      [ENV_B, "#7"],
      [ENV_A, "#2"],
    ]);
  });

  it("leaves runs in other states off the rail", () => {
    const belt = deriveBelt(
      [environment(ENV_A, { active: [active({ id: id(1), state: "stuck" })] })],
      NOW,
    );
    expect(Object.values(belt.runs).flat()).toEqual([]);
  });

  it("leaves a run whose file cannot be read off the rail", () => {
    const belt = deriveBelt(
      [
        environment(ENV_A, {
          active: [active({ id: id(1), state: null, last_event: null, unreadable: true })],
        }),
      ],
      NOW,
    );
    expect(Object.values(belt.runs).flat()).toEqual([]);
  });

  it("takes title from the status, step from the recent list else the state, and when it began", () => {
    const belt = deriveBelt(
      [
        environment(ENV_A, {
          active: [
            active({ id: id(1), title: "Fix the thing", for_ms: 90_000 }),
            active({ id: id(2) }),
          ],
          recent: [row({ id: id(1), step: "launch-sending", started_ts: iso(at(11)) })],
        }),
      ],
      NOW,
    );
    const [one, two] = [belt.runs.building.find((r) => r.id === id(1))!, belt.runs.building[1]!];
    expect(one).toMatchObject({
      title: "Fix the thing",
      step: "launch-sending",
      startedMs: at(11),
      forMs: 90_000,
    });
    expect(two.id).toBe(id(2));
    expect(two.step).toBe("building");
    expect(two.startedMs).toBeNaN();
  });

  it("takes the title and pull request from the recent row when the status run has none", () => {
    const belt = deriveBelt(
      [
        environment(ENV_A, {
          active: [
            active({ id: id(1), state: "pr-open" }),
            active({ id: id(2), state: "pr-open", title: "From status", pr_url: "https://s/2" }),
          ],
          recent: [
            row({ id: id(1), title: "From the list", pr_url: "https://l/1" }),
            row({ id: id(2), title: "From the list", pr_url: "https://l/2" }),
          ],
        }),
      ],
      NOW,
    );
    const byId = (issue: number) => belt.runs.pr.find((run) => run.id === id(issue))!;
    expect(byId(1)).toMatchObject({ title: "From the list", prUrl: "https://l/1" });
    expect(byId(2)).toMatchObject({ title: "From status", prUrl: "https://s/2" });
  });

  it("can stop exactly the runs the run page can: building and not finished", () => {
    const belt = deriveBelt(
      [
        environment(ENV_A, {
          active: [
            active({ id: id(1), state: "building" }),
            active({ id: id(2), state: "building", last_event: "gate_command" }),
            active({ id: id(3), state: "pr-open" }),
            active({ id: id(4), state: "triage" }),
          ],
        }),
      ],
      NOW,
    );
    const stoppable = Object.values(belt.runs)
      .flat()
      .filter((run) => run.stoppable)
      .map((run) => run.id)
      .toSorted();
    expect(stoppable).toEqual([id(1), id(2)]);
  });
});

describe("deriveBelt done", () => {
  it("counts merged and closed runs that finished today, newest finish first", () => {
    const belt = deriveBelt(
      [
        environment(ENV_A, {
          recent: [
            finished(10, "merged", at(8), 3_600_000),
            finished(11, "closed", at(9), 3_600_000),
            finished(12, "merged", at(7), 600_000),
            finished(13, "merged", at(6), 1_800_000),
            finished(14, "merged", at(5), 600_000),
          ],
        }),
      ],
      NOW,
    );
    expect(belt.done).toMatchObject({ merged: 4, closed: 1 });
    expect(belt.done.latest).toEqual(["#11", "#10", "#12"]);
    expect(belt.runs.done.map((run) => run.issue)).toEqual(["#11", "#10", "#12", "#13", "#14"]);
  });

  it("goes by when a run finished, not when it began", () => {
    const belt = deriveBelt(
      [
        environment(ENV_A, {
          recent: [
            // Began yesterday evening, finished after midnight.
            finished(1, "merged", at(23, 0, -1), 2 * 3_600_000),
            // Began and finished yesterday.
            finished(2, "merged", at(10, 0, -1), 3_600_000),
            // Began this morning and is not over until tomorrow.
            finished(3, "merged", at(9), 24 * 3_600_000),
          ],
        }),
      ],
      NOW,
    );
    expect(belt.runs.done.map((run) => run.issue)).toEqual(["#1"]);
    expect(belt.done.merged).toBe(1);
  });

  it("counts a finish at today's first moment, and not one at the next midnight", () => {
    const belt = deriveBelt(
      [
        environment(ENV_A, {
          recent: [
            finished(1, "merged", at(0, 0, 0) - 3_600_000, 3_600_000),
            finished(2, "merged", at(0, 0, 1) - 3_600_000, 3_600_000),
          ],
        }),
      ],
      NOW,
    );
    expect(belt.runs.done.map((run) => run.issue)).toEqual(["#1"]);
  });

  it("leaves out a run that is not finished, ended without a pull request end, or lacks times", () => {
    const belt = deriveBelt(
      [
        environment(ENV_A, {
          recent: [
            row({ id: id(1), pr_end: "merged", finished: false, total_ms: 1000 }),
            finished(2, null, at(8), 1000),
            row({ id: id(3), state: "pr-open", finished: true, pr_end: "merged", total_ms: null }),
            row({
              id: id(4),
              state: "pr-open",
              finished: true,
              pr_end: "merged",
              started_ts: null,
              total_ms: 1000,
            }),
          ],
        }),
      ],
      NOW,
    );
    expect(belt.runs.done).toEqual([]);
  });

  it("counts only the newest attempt of an issue", () => {
    const belt = deriveBelt(
      [
        environment(ENV_A, {
          recent: [
            finished(1, "merged", at(8), 1000, 1),
            row({ id: id(1, 2), state: "stuck", finished: true, status: "finished" }),
          ],
        }),
      ],
      NOW,
    );
    expect(belt.runs.done).toEqual([]);
    expect(belt.stuck.map((run) => run.issue)).toEqual(["#1"]);
  });
});

describe("deriveBelt bins", () => {
  it("sorts the newest attempt of an issue into the Stuck or Needs info bin with its reason", () => {
    const belt = deriveBelt(
      [
        environment(ENV_A, {
          recent: [
            row({
              id: id(1),
              state: "stuck",
              finished: true,
              reason: "cannot push the sync branch",
              title: "Sync",
            }),
            row({
              id: id(2),
              state: "needs-info",
              finished: true,
              reason: "Which branch?",
              title: null,
            }),
            row({ id: id(3), state: "stuck", finished: true, reason: null }),
          ],
        }),
      ],
      NOW,
    );
    expect(belt.stuck.map((run) => [run.issue, run.title, run.reason]).toSorted()).toEqual([
      ["#1", "Sync", "cannot push the sync branch"],
      ["#3", null, null],
    ]);
    expect(belt.info.map((run) => [run.issue, run.title, run.reason])).toEqual([
      ["#2", null, "Which branch?"],
    ]);
  });

  it("drops an issue from the bin once a newer attempt exists", () => {
    const belt = deriveBelt(
      [
        environment(ENV_A, {
          recent: [
            row({ id: id(1, 1), state: "stuck", finished: true, reason: "old" }),
            row({ id: id(1, 2), state: "building" }),
            row({ id: id(2, 1), state: "needs-info", finished: true }),
            row({ id: id(2, 2), state: "pr-open" }),
          ],
        }),
      ],
      NOW,
    );
    expect(belt.stuck).toEqual([]);
    expect(belt.info).toEqual([]);
  });

  it("keeps an attempt count per environment: the same issue in two worlds is two runs", () => {
    const belt = deriveBelt(
      [
        environment(ENV_A, { recent: [row({ id: id(1, 1), state: "stuck", finished: true })] }),
        environment(ENV_B, { recent: [row({ id: id(1, 2), state: "building" })] }),
      ],
      NOW,
    );
    expect(belt.stuck.map((run) => run.environmentId)).toEqual([ENV_A]);
  });
});

describe("deriveBelt counters", () => {
  it("counts runs started today, merged today and stuck over every environment", () => {
    const belt = deriveBelt(
      [
        environment(ENV_A, {
          recent: [
            row({ id: id(1), started_ts: iso(at(8)) }),
            // An earlier attempt of the same issue still began today.
            row({ id: id(1, 2), started_ts: iso(at(9)) }),
            row({ id: id(2), started_ts: iso(at(10, 0, -1)) }),
            finished(3, "merged", at(7), 600_000),
            row({ id: id(4), state: "stuck", finished: true, started_ts: iso(at(6, 0, -3)) }),
          ],
        }),
        environment(ENV_B, {
          recent: [
            row({ id: id(5, 1, "acme/gadgets"), started_ts: iso(at(11)) }),
            finished(6, "closed", at(7), 600_000),
            row({ id: id(7), state: "stuck", finished: true, started_ts: iso(at(12)) }),
          ],
        }),
      ],
      NOW,
    );
    expect(belt.counters).toEqual({ runsToday: 6, mergedToday: 1, stuck: 2 });
  });

  it("reads a run with no start time as not today", () => {
    const belt = deriveBelt(
      [environment(ENV_A, { recent: [row({ id: id(1), started_ts: null })] })],
      NOW,
    );
    expect(belt.counters.runsToday).toBe(0);
  });
});

describe("deriveBelt newest station", () => {
  it("is where the run with the latest start is, among the rail and today's done runs", () => {
    const belt = deriveBelt(
      [
        environment(ENV_A, {
          active: [
            active({ id: id(1), state: "pr-open" }),
            active({ id: id(2), last_event: "gate_command" }),
          ],
          recent: [
            row({ id: id(1), started_ts: iso(at(8)) }),
            row({ id: id(2), started_ts: iso(at(10)) }),
            finished(3, "merged", at(11), 600_000),
          ],
        }),
      ],
      NOW,
    );
    expect(belt.newest).toBe("done");
    const withoutDone = deriveBelt(
      [
        environment(ENV_A, {
          active: [
            active({ id: id(1), state: "pr-open" }),
            active({ id: id(2), last_event: "gate_command" }),
          ],
          recent: [
            row({ id: id(1), started_ts: iso(at(8)) }),
            row({ id: id(2), started_ts: iso(at(10)) }),
          ],
        }),
      ],
      NOW,
    );
    expect(withoutDone.newest).toBe("gate");
  });

  it("lets the later of two runs that began together be the newest", () => {
    const together = iso(at(10));
    const belt = deriveBelt(
      [
        environment(ENV_A, {
          active: [
            active({ id: id(1), state: "pr-open" }),
            active({ id: id(2), last_event: "gate_command" }),
          ],
          recent: [
            row({ id: id(1), started_ts: together }),
            row({ id: id(2), started_ts: together }),
          ],
        }),
        environment(ENV_B, {
          active: [active({ id: id(3), state: "triage", last_event: "claimed" })],
          recent: [row({ id: id(3), started_ts: together })],
        }),
      ],
      NOW,
    );
    expect(belt.newest).toBe("claimed");
  });

  it("ignores stuck runs and yesterday's done runs", () => {
    const belt = deriveBelt(
      [
        environment(ENV_A, {
          active: [active({ id: id(1), state: "pr-open" })],
          recent: [
            row({ id: id(1), started_ts: iso(at(8)) }),
            row({ id: id(2), state: "stuck", finished: true, started_ts: iso(at(14)) }),
            finished(3, "merged", at(12, 0, -1), 600_000),
          ],
        }),
      ],
      NOW,
    );
    expect(belt.newest).toBe("pr");
  });

  it("ranks a run whose start is unknown below any that has one, and defaults to claimed", () => {
    const belt = deriveBelt(
      [
        environment(ENV_A, {
          active: [
            active({ id: id(1), state: "pr-open" }),
            active({ id: id(2), state: "triage", last_event: "claimed" }),
          ],
          recent: [row({ id: id(1), started_ts: iso(at(8)) })],
        }),
      ],
      NOW,
    );
    expect(belt.newest).toBe("pr");
    expect(deriveBelt([], NOW).newest).toBe("claimed");
    expect(deriveBelt([environment(ENV_A)], NOW).newest).toBe("claimed");
  });
});
