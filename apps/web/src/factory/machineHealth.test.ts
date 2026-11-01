import { describe, expect, it } from "vite-plus/test";

import type { FactoryHealth, FactoryStatus } from "./api";
import { machineHealthView, machineHold } from "./machineHealth";

const GIB = 1024 ** 3;

const health = (over: Partial<FactoryHealth> = {}): FactoryHealth => ({
  disk: {
    path: "/Users/jo/.t3/worktrees",
    free_bytes: 40 * GIB,
    total_bytes: 400 * GIB,
    floor_bytes: 10 * GIB,
    low: false,
  },
  load: { one_minute: 3, cores: 12, limit: 24, high: false },
  gates: { running: 0, max: 2, oldest_ms: null },
  ...over,
});

const status = (over: Partial<FactoryStatus> = {}): FactoryStatus => ({
  state: "running",
  reason: null,
  paused_by_hand: null,
  deploy_pending: null,
  runs: [],
  attention: [],
  slots: { used: 0, max: 2 },
  passes: { at: null, poll_seconds: 600, running: false, stale: false },
  problems: [],
  health: health(),
  ...over,
});

const lowDiskItem = {
  id: "low-disk",
  kind: "attention",
  repo: null,
  issue: null,
  run: null,
  message: "low disk: free space is below min_free_gib 10; …",
  first_seen: "2026-11-01T13:00:00Z",
};

const signedOutItem = (repo: string) => ({
  id: `config-not-loaded:${repo}`,
  kind: "attention",
  repo,
  issue: null,
  run: null,
  message: `${repo}: project config not loaded; last error: exited with status 4: please run: gh auth login`,
  first_seen: "2026-11-01T13:00:00Z",
});

const disk = (free: number, low: boolean, floor: number | null = 10 * GIB) =>
  health({
    disk: {
      path: "/Users/jo/.t3/worktrees",
      free_bytes: free,
      total_bytes: 400 * GIB,
      floor_bytes: floor,
      low,
    },
  });

describe("machineHealthView", () => {
  it("says nothing for a server that sends no health, or an idle one", () => {
    const { health: _, ...older } = status();
    expect(machineHealthView(older)).toBeNull();
    expect(machineHealthView(status({ health: null }))).toBeNull();
  });

  it("a machine with room, light load and no gate is healthy and holds nothing", () => {
    const view = machineHealthView(status())!;
    expect(view.verdict).toEqual({ tone: "ok", text: "Healthy" });
    expect(view.holds).toEqual([]);
    expect(view.gauges.map((g) => [g.key, g.tone, g.value, g.detail])).toEqual([
      ["disk", "ok", "40 GiB free", "of 400 GiB · holds below 10 GiB"],
      ["load", "ok", "3.0", "holds above 24 · 12 cores"],
      ["gates", "ok", "0 of 2", "none running"],
    ]);
  });

  it("a low disk holds claims, says how much to free and where, with the bar's floor marked", () => {
    const view = machineHealthView(
      status({ health: disk(7.8 * GIB, true), attention: [lowDiskItem] }),
    )!;
    expect(view.verdict).toEqual({ tone: "bad", text: "Claims held: low disk" });
    expect(view.holds).toEqual([
      {
        key: "low-disk",
        tone: "bad",
        title: "Low disk",
        detail:
          "7.8 GiB free on ~/.t3/worktrees. Nothing is claimed and no gate starts below 10 GiB: free 2.2 GiB more.",
      },
    ]);
    const gauge = view.gauges[0]!;
    expect(gauge.tone).toBe("bad");
    // The bar runs to twice the floor with the floor at its middle: 12.2 of 20 GiB short.
    expect(gauge.fill).toBeCloseTo(12.2 / 20);
    expect(gauge.mark).toBe(0.5);
    expect(view.diskPath).toBe("/Users/jo/.t3/worktrees");
  });

  it("space freed while the low-disk item is still open says the next pass claims again", () => {
    const view = machineHealthView(
      status({ health: disk(12 * GIB, false), attention: [lowDiskItem] }),
    )!;
    expect(view.holds).toEqual([
      {
        key: "low-disk",
        tone: "ok",
        title: "Space freed",
        detail: "12 GiB free now, above 10 GiB: the next pass claims again.",
      },
    ]);
    expect(view.verdict.tone).toBe("warn");
  });

  it("a disk close to its floor warns before it holds; no floor never warns", () => {
    expect(machineHealthView(status({ health: disk(13 * GIB, false) }))!.gauges[0]!.tone).toBe(
      "warn",
    );
    const off = machineHealthView(status({ health: disk(1 * GIB, false, null) }))!.gauges[0]!;
    expect([off.tone, off.detail, off.mark, off.fill]).toEqual([
      "ok",
      "of 400 GiB · no floor set",
      null,
      1 - 1 / 400,
    ]);
  });

  it("an unreadable disk says why", () => {
    const view = machineHealthView(status({ health: health({ disk: { error: "EACCES" } }) }))!;
    expect(view.gauges[0]).toMatchObject({ tone: "off", value: "Unread", detail: "EACCES" });
    expect(view.diskPath).toBeNull();
  });

  it("a high load holds claims and fills its bar past the limit's middle tick", () => {
    const view = machineHealthView(
      status({ health: health({ load: { one_minute: 30.5, cores: 12, limit: 24, high: true } }) }),
    )!;
    expect(view.verdict.text).toBe("Claims held: high load");
    expect(view.holds[0]).toMatchObject({ key: "high-load", tone: "bad" });
    expect(view.gauges[1]).toMatchObject({
      tone: "bad",
      value: "30.5",
      fill: 30.5 / 48,
      mark: 0.5,
    });
  });

  it("a gate running past 45 minutes warns, naming how long", () => {
    const view = machineHealthView(
      status({ health: health({ gates: { running: 1, max: 2, oldest_ms: 52 * 60_000 } }) }),
    )!;
    expect(view.gauges[2]).toMatchObject({
      tone: "warn",
      value: "1 of 2",
      detail: "oldest 52m",
      fill: 0.5,
    });
    expect(view.verdict).toEqual({ tone: "warn", text: "Watch: gates" });
  });

  it("a signed-out gh holds claims as one hold, in the sentence Needs attention says", () => {
    const view = machineHealthView(
      status({ attention: [signedOutItem("acme/web"), signedOutItem("acme/api")] }),
    )!;
    expect(view.holds).toEqual([
      {
        key: "signed-out",
        tone: "bad",
        title: "GitHub sign-in",
        detail:
          "The factory's gh is signed out, so it cannot read any of its 2 repos: web, api. No issue is claimed until it signs in.",
      },
    ]);
    expect(view.verdict).toEqual({ tone: "bad", text: "Claims held: gh signed out" });
    const quieted = status({ dismissed: [signedOutItem("acme/web"), signedOutItem("acme/api")] });
    expect(machineHealthView(quieted)!.holds).toEqual(view.holds);
    expect(machineHold(quieted)?.word).toBe("gh signed out");
  });

  it("a pass failing in a row is a bad verdict, open or quieted, unless it is the sign-out", () => {
    const failing = {
      id: "pass-errors",
      kind: "pass-errors",
      repo: null,
      issue: null,
      run: null,
      message: "the pass has failed 3 times in a row, last: cannot read the runs ledger",
      first_seen: "2026-11-01T13:00:00Z",
    };
    const view = machineHealthView(status({ attention: [failing] }))!;
    expect(view.holds).toEqual([
      {
        key: "pass-errors",
        tone: "bad",
        title: "Passes failing",
        detail: "The pass has failed 3 times in a row, last: cannot read the runs ledger.",
      },
    ]);
    expect(view.verdict).toEqual({ tone: "bad", text: "Claims held: passes failing" });
    const quieted = status({ dismissed: [failing] });
    expect(machineHealthView(quieted)!.holds).toEqual(view.holds);
    expect(machineHold(quieted)?.word).toBe("passes failing");

    const signedOut = { ...failing, message: `${failing.message}; please run: gh auth login` };
    const both = status({ attention: [signedOutItem("acme/web"), signedOut] });
    expect(machineHealthView(both)!.holds.map((hold) => hold.key)).toEqual(["signed-out"]);
  });

  it("lists every hold in the order a person lifts them: pause, update, sign-in, disk, load, overdue pass", () => {
    const view = machineHealthView(
      status({
        paused_by_hand: { since: "2026-11-01T04:47:00Z", for_ms: 1 },
        deploy_pending: {
          commit: null,
          since: "2026-11-01T05:00:00Z",
          waited_ms: 1,
          deploy_by: null,
          snoozed_until: null,
        },
        passes: { at: null, poll_seconds: 600, running: false, stale: true },
        attention: [signedOutItem("acme/web")],
        health: health({
          disk: { ...(disk(1 * GIB, true).disk as object), low: true } as FactoryHealth["disk"],
          load: { one_minute: 30, cores: 12, limit: 24, high: true },
        }),
      }),
    )!;
    expect(view.holds.map((hold) => hold.key)).toEqual([
      "paused",
      "update",
      "signed-out",
      "low-disk",
      "high-load",
      "pass-overdue",
    ]);
    expect(view.verdict.text).toBe(
      "Claims held: paused by hand, update waiting, gh signed out, low disk, high load, pass overdue",
    );
  });

  it("a snoozed update holds nothing", () => {
    const view = machineHealthView(
      status({
        deploy_pending: {
          commit: null,
          since: "2026-11-01T05:00:00Z",
          waited_ms: 1,
          deploy_by: null,
          snoozed_until: "2026-11-01T06:00:00Z",
        },
      }),
    )!;
    expect(view.holds).toEqual([]);
  });
});
