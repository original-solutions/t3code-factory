import { useEffect, useEffectEvent } from "react";

import type { FactorySearch } from "./search";

/** One run in a list the user opened a run from. */
export interface QueuedRun {
  readonly environmentId: string;
  readonly runId: string;
  readonly title: string | null;
}

/** Where a queue came from: the Factory page's URL filters and the search typed there. */
export interface QueueOrigin {
  readonly search: FactorySearch;
  readonly query: string;
}

/**
 * The list a run page was opened from, in the order it was shown, carried in history state so the
 * run page can step through it and go back to it filtered as it was. A run opened from a link with
 * no queue (a reload keeps it; a pasted URL does not) has no stepping.
 */
export interface RunQueue extends QueueOrigin {
  readonly runs: ReadonlyArray<QueuedRun>;
}

/** What the Factory page gets back from a run page: its typed search and the run to focus. */
export interface QueueReturn {
  readonly query: string;
  readonly focus: string;
}

declare module "@tanstack/react-router" {
  interface HistoryState {
    factoryRunQueue?: RunQueue;
    factoryReturn?: QueueReturn;
  }
}

/** The key a run link carries in `data-run-link`, so a return can focus it. */
export const runLinkKey = (environmentId: string, runId: string) => `${environmentId} ${runId}`;

export const runQueue = (origin: QueueOrigin, runs: ReadonlyArray<QueuedRun>): RunQueue => ({
  ...origin,
  runs,
});

export interface QueueStep {
  /** 1-based. */
  readonly position: number;
  readonly total: number;
  readonly title: string | null;
  readonly previous: QueuedRun | null;
  readonly next: QueuedRun | null;
}

/** Where `runId` sits in `queue`, or null when there is no queue or it does not hold the run. */
export function stepInQueue(
  queue: RunQueue | undefined,
  environmentId: string,
  runId: string,
): QueueStep | null {
  if (queue === undefined) return null;
  const index = queue.runs.findIndex(
    (run) => run.environmentId === environmentId && run.runId === runId,
  );
  if (index === -1) return null;
  return {
    position: index + 1,
    total: queue.runs.length,
    title: queue.runs[index]!.title,
    previous: queue.runs[index - 1] ?? null,
    next: queue.runs[index + 1] ?? null,
  };
}

export type FactoryKey = "next" | "previous" | "back" | "search";

const KEYS: Readonly<Record<string, FactoryKey>> = {
  j: "next",
  k: "previous",
  Escape: "back",
  "/": "search",
};

/** Typing, or inside a popup that owns its own keys (a select's list, a menu, a dialog). */
const ownsKeys = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    target.closest(
      'input, textarea, select, [role="textbox"], [role="combobox"], [role="listbox"], [role="menu"], [role="dialog"], [role="alertdialog"]',
    ) !== null);

/**
 * The Factory pages' keys: j/k step (arrows stay the page's scroll), Escape goes back, `/` searches.
 * None while typing, in a popup, with a modifier held, or once something else took the key.
 */
export function factoryKey(
  event: Pick<
    KeyboardEvent,
    "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "target" | "defaultPrevented"
  >,
): FactoryKey | null {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return null;
  if (event.shiftKey && event.key !== "/") return null;
  if (ownsKeys(event.target)) return null;
  return KEYS[event.key] ?? null;
}

/** Calls `onKey` for each Factory key pressed anywhere on the page; it returns false to pass. */
export function useFactoryKeys(onKey: (key: FactoryKey) => boolean) {
  const handle = useEffectEvent((event: KeyboardEvent) => {
    const key = factoryKey(event);
    if (key !== null && onKey(key)) event.preventDefault();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- listens to the window's keys
  useEffect(() => {
    const listener = (event: KeyboardEvent) => handle(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
}
