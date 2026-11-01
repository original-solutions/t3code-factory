import type { FactoryStatus } from "./api";
import { signedOutLine, signedOutCause, stillTrue } from "./attentionCauses";
import { formatClock } from "./belt";

/** How a gauge reads: fine, near the line where the pass holds, over it, or unread. */
export type HealthTone = "ok" | "warn" | "bad" | "off";

export interface HealthGauge {
  readonly key: "disk" | "load" | "gates";
  readonly label: string;
  readonly tone: HealthTone;
  readonly value: string;
  readonly detail: string;
  /** How full the bar is, 0 to 1; null for no bar. */
  readonly fill: number | null;
  /** Where on the bar the pass starts holding, 0 to 1; null when the bar's end is that line. */
  readonly mark: number | null;
}

export type HoldKey =
  | "paused"
  | "update"
  | "signed-out"
  | "low-disk"
  | "high-load"
  | "pass-overdue";

/** One reason the machine claims nothing now; `ok` for one that has lifted but not yet been seen by a pass. */
export interface HealthHold {
  readonly key: HoldKey;
  readonly tone: "bad" | "ok";
  readonly title: string;
  readonly detail: string;
}

export interface MachineHealthView {
  readonly verdict: { readonly tone: "ok" | "warn" | "bad"; readonly text: string };
  readonly gauges: ReadonlyArray<HealthGauge>;
  /** In the order a person lifts them. */
  readonly holds: ReadonlyArray<HealthHold>;
  /** The directory the disk gauge read, for a command that finds what fills it. */
  readonly diskPath: string | null;
}

const GIB = 1024 ** 3;
/** A disk within this much of its floor, or a load this near its limit, is worth watching. */
export const NEAR = 1.5;
export const BUSY = 0.8;
/** A gate this old has run longer than gates usually do. */
const LONG_GATE_MS = 45 * 60_000;

/**
 * A bar that runs to twice the line the pass holds at, so the line is the bar's middle tick and a
 * bar past it holds: `amount` over `2 * line`, kept within the bar.
 */
export const pressure = (amount: number, line: number): number =>
  Math.min(1, Math.max(0, amount / (2 * line)));

/** `/Users/jo/.t3/worktrees` as `~/.t3/worktrees`, for reading; a command takes the whole path. */
const shortPath = (path: string): string => path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");

/** `7.8 GiB`, `40 GiB`, `1.8 TiB`. */
export const formatBytes = (bytes: number): string => {
  const gib = bytes / GIB;
  if (gib >= 1024) return `${(gib / 1024).toFixed(1)} TiB`;
  return gib < 10 ? `${gib.toFixed(1)} GiB` : `${Math.round(gib)} GiB`;
};

const minutes = (ms: number): string => {
  const total = Math.floor(ms / 60_000);
  return total < 60 ? `${total}m` : `${Math.floor(total / 60)}h ${total % 60}m`;
};

const since = (iso: string): string => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? "" : ` since ${formatClock(ms)}`;
};

/**
 * The hold the machine itself puts on claims, with its figures: a low disk before a high load, as
 * the pass checks them, then a signed-out gh that fails every repo read. Null when none holds.
 */
export function machineHold(status: FactoryStatus): {
  readonly word: "low disk" | "high load" | "gh signed out";
  readonly detail: string;
} | null {
  const health = status.health;
  if (health != null) {
    const { disk, load } = health;
    if (!("error" in disk) && disk.low && disk.floor_bytes !== null) {
      return {
        word: "low disk",
        detail: `${formatBytes(disk.free_bytes)} free, needs ${formatBytes(disk.floor_bytes)}`,
      };
    }
    if (load.high && load.limit !== null) {
      return {
        word: "high load",
        detail: `1-minute load ${load.one_minute.toFixed(1)}, above ${load.limit}`,
      };
    }
  }
  const repos = signedOutCause(stillTrue(status))?.repos;
  if (repos === undefined) return null;
  return {
    word: "gh signed out",
    detail:
      repos.length === 0
        ? "its passes cannot read GitHub"
        : `cannot read ${repos.length === 1 ? repos[0] : `${repos.length} repos`}`,
  };
}

const HOLD_WORD: Readonly<Record<HoldKey, string>> = {
  paused: "paused by hand",
  update: "update waiting",
  "signed-out": "gh signed out",
  "low-disk": "low disk",
  "high-load": "high load",
  "pass-overdue": "pass overdue",
};

/**
 * What the machine's health says, from one status: a gauge each for the disk, load and gates the
 * pass holds claims on, and every hold on claims, in the order a person lifts them. Null when the
 * server sends no health (an older server, or an idle factory).
 */
export function machineHealthView(status: FactoryStatus): MachineHealthView | null {
  const health = status.health;
  if (health == null) return null;
  const { disk, load, gates } = health;
  const lowDiskOpen = stillTrue(status).some((item) => item.id === "low-disk");

  const diskGauge: HealthGauge =
    "error" in disk
      ? {
          key: "disk",
          label: "Disk",
          tone: "off",
          value: "Unread",
          detail: disk.error,
          fill: null,
          mark: null,
        }
      : {
          key: "disk",
          label: "Disk",
          tone: disk.low
            ? "bad"
            : disk.floor_bytes !== null && disk.free_bytes < disk.floor_bytes * NEAR
              ? "warn"
              : "ok",
          value: `${formatBytes(disk.free_bytes)} free`,
          detail: `of ${formatBytes(disk.total_bytes)} · ${
            disk.floor_bytes === null
              ? "no floor set"
              : `holds below ${formatBytes(disk.floor_bytes)}`
          }`,
          ...(disk.floor_bytes === null || disk.floor_bytes <= 0
            ? {
                fill: disk.total_bytes > 0 ? 1 - disk.free_bytes / disk.total_bytes : null,
                mark: null,
              }
            : {
                fill: pressure(disk.floor_bytes * 2 - disk.free_bytes, disk.floor_bytes),
                mark: 0.5,
              }),
        };

  const scale = load.limit ?? load.cores;
  const loadGauge: HealthGauge = {
    key: "load",
    label: "Load",
    tone: load.high
      ? "bad"
      : load.limit !== null && load.one_minute > load.limit * BUSY
        ? "warn"
        : "ok",
    value: load.one_minute.toFixed(1),
    detail: `${load.limit === null ? "no limit" : `holds above ${load.limit}`} · ${load.cores} cores`,
    ...(load.limit === null || load.limit <= 0
      ? { fill: scale > 0 ? Math.min(1, load.one_minute / scale) : null, mark: null }
      : { fill: pressure(load.one_minute, load.limit), mark: 0.5 }),
  };

  const longGate = gates.oldest_ms !== null && gates.oldest_ms >= LONG_GATE_MS;
  const gateGauge: HealthGauge = {
    key: "gates",
    label: "Gates",
    tone: longGate ? "warn" : "ok",
    value: `${gates.running} of ${gates.max}`,
    detail: gates.oldest_ms === null ? "none running" : `oldest ${minutes(gates.oldest_ms)}`,
    fill: gates.max > 0 ? Math.min(1, gates.running / gates.max) : null,
    mark: null,
  };

  const holds: Array<HealthHold> = [];
  if (status.paused_by_hand) {
    holds.push({
      key: "paused",
      tone: "bad",
      title: "Paused by hand",
      detail: `Claims are off${since(status.paused_by_hand.since)}. The Claims switch turns them on.`,
    });
  }
  if (status.deploy_pending && status.deploy_pending.snoozed_until === null) {
    holds.push({
      key: "update",
      tone: "bad",
      title: "Update waiting",
      detail: `A build waits to install${since(status.deploy_pending.since)}; claims start again once it is installed.`,
    });
  }
  const signedOut = signedOutCause(stillTrue(status));
  if (signedOut !== null) {
    holds.push({
      key: "signed-out",
      tone: "bad",
      title: "GitHub sign-in",
      detail: `${signedOutLine(signedOut.repos)} No issue is claimed until it signs in.`,
    });
  }
  if (!("error" in disk) && disk.floor_bytes !== null) {
    if (disk.low) {
      holds.push({
        key: "low-disk",
        tone: "bad",
        title: "Low disk",
        detail: `${formatBytes(disk.free_bytes)} free on ${shortPath(disk.path)}. Nothing is claimed and no gate starts below ${formatBytes(disk.floor_bytes)}: free ${formatBytes(disk.floor_bytes - disk.free_bytes)} more.`,
      });
    } else if (lowDiskOpen) {
      holds.push({
        key: "low-disk",
        tone: "ok",
        title: "Space freed",
        detail: `${formatBytes(disk.free_bytes)} free now, above ${formatBytes(disk.floor_bytes)}: the next pass claims again.`,
      });
    }
  }
  if (load.high && load.limit !== null) {
    holds.push({
      key: "high-load",
      tone: "bad",
      title: "High load",
      detail: `The 1-minute load is ${load.one_minute.toFixed(1)}, above ${load.limit}. Nothing is claimed and a second gate waits until it drops; it needs no one.`,
    });
  }
  if (status.passes.stale === true) {
    holds.push({
      key: "pass-overdue",
      tone: "bad",
      title: "Pass overdue",
      detail:
        "The last pass ended more than three polls ago, so the pass loop may be stuck. Restarting the server starts it again.",
    });
  }

  const holding = holds.filter((hold) => hold.tone === "bad");
  const gauges = [diskGauge, loadGauge, gateGauge];
  const watch = gauges.filter((gauge) => gauge.tone === "warn" || gauge.tone === "off");
  const verdict: MachineHealthView["verdict"] =
    holding.length > 0
      ? {
          tone: "bad",
          text: `Claims held: ${holding.map((hold) => HOLD_WORD[hold.key]).join(", ")}`,
        }
      : holds.length > 0
        ? { tone: "warn", text: "Space freed: waiting for the next pass" }
        : watch.length > 0
          ? {
              tone: "warn",
              text: `Watch: ${watch.map((gauge) => gauge.label.toLowerCase()).join(", ")}`,
            }
          : { tone: "ok", text: "Healthy" };
  return {
    verdict,
    gauges,
    holds,
    diskPath: "error" in disk ? null : disk.path,
  };
}
