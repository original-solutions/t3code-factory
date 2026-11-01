import type { EnvironmentId } from "@t3tools/contracts";

import type { FactoryStatus } from "./api";
import { issueOf, stationOf, STATIONS, type Station } from "./belt";
import { parseRunId } from "./format";
import { machineHold } from "./machineHealth";

/** Why an environment takes no new issue now; the order is the one a person reads first. */
export type PulseHold =
  | "claims paused"
  | "held for update"
  | "low disk"
  | "high load"
  | "pass overdue";

export interface PulseRun {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly id: string;
  readonly issue: string;
  readonly repo: string | null;
  readonly title: string | null;
  readonly station: Exclude<Station, "done">;
  readonly forMs: number | null;
}

export interface PulseEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly hold: PulseHold | null;
  readonly runs: ReadonlyArray<PulseRun>;
  readonly attention: number;
}

/**
 * What the sidebar glyph shows besides the attention badge: a held factory before a busy one, since
 * a busy one takes no more work once its runs end; nothing while idle.
 */
export type PulseTone = "held" | "working" | "idle";

export interface FactoryPulse {
  readonly tone: PulseTone;
  readonly inFlight: number;
  /** Runs in flight past `maxRuns`, left out of the environments' lists. */
  readonly hidden: number;
  readonly attention: number;
  readonly environments: ReadonlyArray<PulseEnvironment>;
  /** One line for the card's head: `1 run in flight · claims paused`. */
  readonly summary: string;
}

export interface PulseInput {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly status: FactoryStatus | null;
}

const holdOf = (status: FactoryStatus): PulseHold | null =>
  status.paused_by_hand
    ? "claims paused"
    : status.deploy_pending && status.deploy_pending.snoozed_until === null
      ? "held for update"
      : (machineHold(status)?.word ?? (status.passes.stale === true ? "pass overdue" : null));

/** Nearest to done first, then the longest at it. */
const order = (a: PulseRun, b: PulseRun): number =>
  STATIONS.indexOf(b.station) - STATIONS.indexOf(a.station) || (b.forMs ?? 0) - (a.forMs ?? 0);

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The factory at a glance over every environment that answered, for the sidebar's Factory item;
 * the environments list at most `maxRuns` runs between them, in their order.
 */
export function factoryPulse(
  inputs: ReadonlyArray<PulseInput>,
  maxRuns: number = Number.POSITIVE_INFINITY,
): FactoryPulse {
  const read = inputs.flatMap(({ environmentId, label, status }): PulseEnvironment[] => {
    if (status === null) return [];
    const runs = status.runs.flatMap((run): PulseRun[] => {
      if (run.unreadable) return [];
      const station = stationOf(run);
      if (station === null) return [];
      const parsed = parseRunId(run.id);
      return [
        {
          key: `${environmentId} ${run.id}`,
          environmentId,
          id: run.id,
          issue: issueOf(run.id),
          repo: parsed?.repo ?? null,
          title: run.title ?? null,
          station,
          forMs: run.for_ms,
        },
      ];
    });
    return [
      {
        environmentId,
        label,
        hold: holdOf(status),
        runs: runs.toSorted(order),
        attention: status.attention.length,
      },
    ];
  });
  const inFlight = read.reduce((sum, env) => sum + env.runs.length, 0);
  const environments = read.map((env, i) => {
    const before = read.slice(0, i).reduce((sum, earlier) => sum + earlier.runs.length, 0);
    return { ...env, runs: env.runs.slice(0, Math.max(0, maxRuns - before)) };
  });
  const attention = environments.reduce((sum, env) => sum + env.attention, 0);
  const holds = [...new Set(environments.flatMap((env) => (env.hold ? [env.hold] : [])))];
  const tone: PulseTone = holds.length > 0 ? "held" : inFlight > 0 ? "working" : "idle";
  const parts = [
    environments.length === 0
      ? "not read yet"
      : inFlight > 0
        ? `${plural(inFlight, "run", "runs")} in flight`
        : "nothing in flight",
    ...holds,
    ...(attention > 0 ? [`${attention} ${attention === 1 ? "needs" : "need"} you`] : []),
  ];
  return {
    tone,
    inFlight,
    hidden: Math.max(0, inFlight - maxRuns),
    attention,
    environments,
    summary: parts.join(" · "),
  };
}
