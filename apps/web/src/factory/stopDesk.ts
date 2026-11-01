import type { EnvironmentId } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

import { toastManager } from "~/components/ui/toast";

import { factoryApi, type FactoryStopResult } from "./api";
import { messageOf, parseRunId } from "./format";
import { runLinkKey } from "./runQueue";

/** How long a Stop waits before it is sent, so a mis-click can be taken back. */
export const STOP_GRACE_MS = 5_000;

/**
 * A stop waiting out its grace (`pending`), sent and not yet answered (`sending`), or taken by the
 * server (`sent`), which it stays until the run leaves building and its Stop with it.
 */
export type StopPhase = "pending" | "sending" | "sent";

interface Desk {
  readonly environmentId: EnvironmentId;
  readonly runId: string;
  phase: StopPhase;
  timer: ReturnType<typeof setTimeout> | null;
  toastId: ReturnType<typeof toastManager.add> | null;
}

/**
 * The stops of this tab, by `runLinkKey`. Module state, so a stop waiting out its grace is sent
 * even when the page that asked for it has gone, and every surface showing the run shows its Undo.
 */
const desks = new Map<string, Desk>();
let phases: ReadonlyMap<string, StopPhase> = new Map();
const listeners = new Set<() => void>();
const answerListeners = new Set<(environmentId: EnvironmentId) => void>();

const changed = () => {
  phases = new Map([...desks].map(([key, desk]) => [key, desk.phase]));
  for (const listener of listeners) listener();
};

/** `watchalong #158`, or the run id when it is not one. */
const stopName = (runId: string): string => {
  const parsed = parseRunId(runId);
  return parsed ? `${parsed.repo} #${parsed.issue}` : runId;
};

export interface StopNews {
  readonly type: "warning" | "info" | "success" | "error";
  readonly title: string;
  readonly description: string;
}

const AFTER_STOP =
  "On the factory's next pass its session is archived, its worktree removed and the issue set to factory:stuck. The branch is kept.";

/** What a toast says at each point of a stop: waiting, taken back, or the server's answer. */
export function stopNews(
  runId: string,
  at:
    | { readonly kind: "pending" }
    | { readonly kind: "undone" }
    | { readonly kind: "answered"; readonly result: FactoryStopResult }
    | { readonly kind: "failed"; readonly message: string },
): StopNews {
  const name = stopName(runId);
  switch (at.kind) {
    case "pending":
      return {
        type: "warning",
        title: `Stopping ${name}`,
        description: `Sent in ${STOP_GRACE_MS / 1000} seconds. ${AFTER_STOP}`,
      };
    case "undone":
      return {
        type: "info",
        title: `${name} keeps building`,
        description: "The stop was not sent.",
      };
    case "answered":
      return {
        type: "success",
        title: at.result.already ? `${name} was already stopping` : `Stop sent for ${name}`,
        description: `${AFTER_STOP} To build it again, set factory:ready on the issue.`,
      };
    case "failed":
      return { type: "error", title: `${name} was not stopped`, description: at.message };
  }
}

const show = (news: StopNews, extra: Parameters<typeof toastManager.add>[0] = {}) =>
  toastManager.add({
    ...news,
    data: { hideCopyButton: news.type !== "error" },
    ...extra,
  });

const send = (key: string, desk: Desk) => {
  desk.phase = "sending";
  desk.timer = null;
  if (desk.toastId !== null) toastManager.close(desk.toastId);
  desk.toastId = null;
  changed();
  void factoryApi.stopRun(desk.environmentId, desk.runId).then(
    (result) => answer(key, desk, { kind: "answered", result }),
    // The server's refusal (a run no longer building) arrives here with its reason.
    (error: unknown) => answer(key, desk, { kind: "failed", message: messageOf(error) }),
  );
};

const answer = (key: string, desk: Desk, at: Parameters<typeof stopNews>[1]) => {
  if (at.kind === "answered") desk.phase = "sent";
  else desks.delete(key);
  changed();
  show(stopNews(desk.runId, at), { timeout: at.kind === "failed" ? 0 : 10_000 });
  for (const listener of answerListeners) listener(desk.environmentId);
};

/**
 * Stops a building run after {@link STOP_GRACE_MS}, with a toast that says what will happen and
 * offers Undo. A run already waiting or being sent is left as it is.
 */
export function requestStop(environmentId: EnvironmentId, runId: string): void {
  const key = runLinkKey(environmentId, runId);
  if (desks.has(key)) return;
  const desk: Desk = { environmentId, runId, phase: "pending", timer: null, toastId: null };
  desks.set(key, desk);
  desk.timer = setTimeout(() => send(key, desk), STOP_GRACE_MS);
  desk.toastId = show(stopNews(runId, { kind: "pending" }), {
    // Closed by the desk when the stop is sent or taken back, not by its own clock.
    timeout: 0,
    actionProps: { children: "Undo", onClick: () => undoStop(environmentId, runId) },
  });
  changed();
}

/** Takes back a stop still waiting out its grace; one already sent cannot be. */
export function undoStop(environmentId: EnvironmentId, runId: string): void {
  const key = runLinkKey(environmentId, runId);
  const desk = desks.get(key);
  if (desk?.phase !== "pending") return;
  if (desk.timer !== null) clearTimeout(desk.timer);
  if (desk.toastId !== null) toastManager.close(desk.toastId);
  desks.delete(key);
  changed();
  show(stopNews(runId, { kind: "undone" }), { timeout: 4_000 });
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Every stop of this tab waiting or in flight, by `runLinkKey`. */
export const useStopPhases = (): ReadonlyMap<string, StopPhase> =>
  useSyncExternalStore(subscribe, () => phases);

/** Called with the environment of each stop the server answers, to read it again. */
export function onStopAnswered(listener: (environmentId: EnvironmentId) => void): () => void {
  answerListeners.add(listener);
  return () => answerListeners.delete(listener);
}

/** Forgets every stop, for a test that starts from none. */
export function __resetStopDeskForTests(): void {
  for (const desk of desks.values()) if (desk.timer !== null) clearTimeout(desk.timer);
  desks.clear();
  changed();
}
