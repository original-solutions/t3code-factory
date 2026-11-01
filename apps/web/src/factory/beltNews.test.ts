import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { FactoryRunRow, FactoryStatus } from "./api";
import { deriveBelt, placesOf, type BeltEnvironment } from "./belt";
import { beltNews } from "./beltNews";

const ENV = "env-a" as EnvironmentId;
const NOW = new Date(2026, 9, 27, 15).getTime();
const id = (issue: number) => `acme__widgets__${issue}__1`;

const active = (
  issue: number,
  overrides: Partial<FactoryStatus["runs"][number]> = {},
): FactoryStatus["runs"][number] => ({
  id: id(issue),
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

const row = (issue: number, overrides: Partial<FactoryRunRow> = {}): FactoryRunRow => ({
  id: id(issue),
  started_ts: new Date(NOW - 3_600_000).toISOString(),
  state: "pr-open",
  last_event: "pr_merged",
  step: null,
  status: "finished",
  pr_url: null,
  finished: true,
  total_ms: 1_800_000,
  unreadable: false,
  ...overrides,
});

const beltOf = (parts: Partial<BeltEnvironment>) =>
  deriveBelt([{ environmentId: ENV, label: "Desktop", active: [], recent: [], ...parts }], NOW);

const sentences = (
  before: Partial<BeltEnvironment>,
  after: Partial<BeltEnvironment>,
  env = false,
) =>
  beltNews(placesOf(beltOf(before)), beltOf(after), env).map(({ who, what }) => `${who} ${what}`);

describe("beltNews", () => {
  it("says nothing on the first read, or when no run changed place", () => {
    const belt = beltOf({ active: [active(1)] });
    expect(beltNews(null, belt, false)).toEqual([]);
    expect(beltNews(placesOf(belt), belt, false)).toEqual([]);
  });

  it("names the post a run moved to, and a newly claimed run", () => {
    expect(
      sentences(
        { active: [active(1)] },
        {
          active: [
            active(1, { last_event: "gate_command" }),
            active(2, { state: "triage", last_event: "claimed" }),
          ],
        },
      ),
    ).toEqual(["widgets #2 was claimed", "widgets #1 moved from Building to Gate"]);
  });

  it("says how a finished run ended: merged, closed, stuck with its cause, or waiting on an answer", () => {
    expect(
      sentences(
        { active: [active(1, { state: "pr-open" }), active(2), active(3), active(4)] },
        {
          recent: [
            row(1, { pr_end: "merged" }),
            row(2, { pr_end: "closed" }),
            row(3, {
              state: "stuck",
              step: "stuck",
              last_event: "stuck",
              reason: "run passed its time limit (180 min)\n\nI ran out of time.",
            }),
            row(4, { state: "needs-info", last_event: "questions_posted" }),
          ],
        },
      ),
    ).toEqual([
      "widgets #1 merged",
      "widgets #2 closed",
      "widgets #3 is stuck: Run passed its time limit",
      "widgets #4 needs an answer",
    ]);
  });

  it("is silent while a finished run is off the rail and in no bin yet, and speaks when a bin has it", () => {
    const gone = beltOf({});
    expect(beltNews(placesOf(beltOf({ active: [active(1)] })), gone, false)).toEqual([]);
    expect(
      beltNews(placesOf(gone), beltOf({ recent: [row(1, { pr_end: "merged" })] }), false).map(
        (item) => item.what,
      ),
    ).toEqual(["merged"]);
  });

  it("names the machine when there are several", () => {
    expect(
      sentences({ active: [active(1)] }, { active: [active(1, { state: "pr-open" })] }, true),
    ).toEqual(["widgets #1 moved from Building to PR open on Desktop"]);
  });
});
