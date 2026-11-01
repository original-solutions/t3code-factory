import type { FactoryStatus } from "./api";
import { formatClock } from "./belt";

export type MachineTone = "loading" | "down" | "running" | "paused" | "idle" | "held";

export interface MachineLine {
  readonly tone: MachineTone;
  readonly word: string;
  readonly detail: string | null;
  /** A build waits to install, whether or not it holds claims back. */
  readonly update: boolean;
}

const since = (iso: string): string | null => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : `since ${formatClock(ms)}`;
};

/**
 * What one machine's factory is doing, in a word: a hand pause first, as the claims switch shows
 * it, then an idle (no config to claim from), then an update holding claims. A failed read with
 * data keeps that data's word; the page names the failure.
 */
export function machineLine({
  data,
  status,
}: {
  readonly data: FactoryStatus | null;
  readonly status: "loading" | "error" | "ready";
}): MachineLine {
  if (data === null) {
    return status === "error"
      ? { tone: "down", word: "No answer", detail: null, update: false }
      : { tone: "loading", word: "Loading", detail: null, update: false };
  }
  const update = data.deploy_pending != null;
  if (data.paused_by_hand) {
    return { tone: "paused", word: "Paused", detail: since(data.paused_by_hand.since), update };
  }
  if (data.state === "idle") return { tone: "idle", word: "Idle", detail: data.reason, update };
  if (data.deploy_pending && data.deploy_pending.snoozed_until === null) {
    return {
      tone: "held",
      word: "Held for update",
      detail: since(data.deploy_pending.since),
      update,
    };
  }
  return { tone: "running", word: "Running", detail: null, update };
}
