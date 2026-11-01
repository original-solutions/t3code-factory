import { describe, expect, it } from "vite-plus/test";

import type { FactoryEntry } from "./api";
import { runDetails } from "./runDetailTabs";

let ms = 0;
const entry = (event: string, data: unknown = {}): FactoryEntry => {
  ms += 1000;
  return { ts: new Date(ms).toISOString(), ms, event, data, cause: null };
};
const to = (state: string) => entry("state_changed", { to: state });
const gate = (...exits: ReadonlyArray<number>) =>
  exits.map((exit_code, i) =>
    entry("gate_command", { attempt: 1, command: `cmd${i}`, exit_code, duration_ms: 10 }),
  );
const prOpened = entry("pr_opened", { url: "https://github.com/o/r/pull/7" });
const stuck = (reason: string) => [entry("stuck", { reason }), to("stuck")];

describe("runDetails", () => {
  it("offers the gate only once a gate ran, GitHub only with an issue or PR to read", () => {
    expect(runDetails([to("building")], { gitHub: true }).tabs).toEqual([
      "timeline",
      "github",
      "ledger",
    ]);
    expect(runDetails([to("building"), ...gate(0)], { gitHub: false }).tabs).toEqual([
      "timeline",
      "gate",
      "ledger",
    ]);
  });

  it.each([
    ["a run still building", [to("building"), ...gate(1)], "timeline"],
    ["a run waiting on review", [to("building"), ...gate(0), prOpened, to("pr-open")], "github"],
    [
      "a merged run",
      [to("building"), prOpened, to("pr-open"), entry("finished", { pr_end: "merged" })],
      "github",
    ],
    ["a run that asked questions", [to("building"), to("needs-info")], "github"],
    ["a run stuck on its gate", [...gate(1), ...stuck("the gate failed after 3 attempts")], "gate"],
    [
      "a run stuck on the PR's checks",
      [prOpened, ...stuck("the required checks failed after 1 attempt")],
      "github",
    ],
    [
      "a run whose session gave up",
      stuck("the session stopped and said it was stuck\n\nI need a product call."),
      "timeline",
    ],
    ["a run that failed before a PR", [to("building"), entry("finished", {})], "timeline"],
  ] as const)("leads %s with its %s", (_name, entries, lead) => {
    expect(runDetails(entries, { gitHub: true }).lead).toBe(lead);
  });

  it("falls back to the timeline when the lead's tab is not there", () => {
    expect(runDetails([to("building"), to("needs-info")], { gitHub: false }).lead).toBe("timeline");
    expect(runDetails(stuck("the gate failed after 3 attempts"), { gitHub: true }).lead).toBe(
      "timeline",
    );
  });
});
