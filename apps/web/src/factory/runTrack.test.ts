import { describe, expect, it } from "vite-plus/test";

import type { FactoryEntry } from "./api";
import { runTrack, stateMark } from "./runTrack";

const entry = (event: string, data: unknown = {}): FactoryEntry => ({
  ts: new Date(0).toISOString(),
  ms: 0,
  event,
  data,
  cause: null,
});
const to = (next: string) => entry("state_changed", { to: next });
const claim = [entry("claimed"), to("triage"), entry("session_launched", { title: "feat: x" })];

describe("runTrack", () => {
  it("reaches nothing before the ledger has a line", () => {
    expect(runTrack([])).toEqual({ reached: null, halt: null, end: null });
  });

  it("follows a run down the belt to the furthest post it reached", () => {
    expect(runTrack(claim)).toMatchObject({ reached: "claimed" });
    expect(runTrack([...claim, to("building")])).toMatchObject({ reached: "building" });
    expect(runTrack([...claim, to("building"), entry("gate_checkout")])).toMatchObject({
      reached: "gate",
    });
    expect(runTrack([...claim, to("building"), entry("pr_opened", { pr: 9 })])).toMatchObject({
      reached: "pr",
    });
    expect(
      runTrack([...claim, to("building"), to("pr-open"), entry("finished", { pr_end: "merged" })]),
    ).toEqual({ reached: "done", halt: null, end: "merged" });
  });

  it("keeps where a run stopped when it is stuck or waiting on an answer", () => {
    expect(runTrack([...claim, to("building"), entry("gate_command"), to("stuck")])).toEqual({
      reached: "gate",
      halt: "stuck",
      end: null,
    });
    expect(runTrack([...claim, to("needs-info")])).toEqual({
      reached: "claimed",
      halt: "info",
      end: null,
    });
  });

  it("ends at Done for a closed pull request, and a stuck run that finished stays stuck", () => {
    expect(
      runTrack([...claim, to("building"), to("pr-open"), entry("finished", { pr_end: "closed" })]),
    ).toEqual({ reached: "done", halt: null, end: "closed" });
    expect(
      runTrack([...claim, to("building"), to("stuck"), entry("finished", { pr_end: null })]),
    ).toEqual({ reached: "building", halt: "stuck", end: null });
  });
});

describe("stateMark", () => {
  it("names each state as the belt does and wears its post's colour", () => {
    expect(stateMark("triage")).toEqual({ station: "claimed", name: "Claimed" });
    expect(stateMark("building")).toEqual({ station: "building", name: "Building" });
    expect(stateMark("pr-open")).toEqual({ station: "pr", name: "PR open" });
    expect(stateMark("merged")).toEqual({ station: "done", name: "Merged" });
    expect(stateMark("stuck")).toEqual({ station: "stuck", name: "Stuck" });
    expect(stateMark("needs-info")).toEqual({ station: "info", name: "Needs info" });
  });

  it("leaves a closed, unknown or new state uncoloured", () => {
    expect(stateMark("closed")).toEqual({ station: null, name: "Closed" });
    expect(stateMark(null)).toEqual({ station: null, name: "Unknown" });
    expect(stateMark("paused")).toEqual({ station: null, name: "paused" });
  });
});
