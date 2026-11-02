import type { EnvironmentId } from "@t3tools/contracts";

import { runOfPath } from "./pages";
import { readFactoryRunAhead } from "./useFactoryData";

/** How long a run link holds the pointer or focus before its run is read: passing over reads nothing. */
const REST_MS = 80;

let resting: ReturnType<typeof setTimeout> | undefined;

const readRunOf = (target: EventTarget | null): void => {
  const link = target instanceof Element ? target.closest<HTMLAnchorElement>("a[href]") : null;
  const run = link === null ? null : runOfPath(new URL(link.href).pathname);
  if (run !== null) readFactoryRunAhead(run.environmentId as EnvironmentId, run.runId);
};

const rest = (target: EventTarget | null): void => {
  clearTimeout(resting);
  resting = setTimeout(() => readRunOf(target), REST_MS);
};

const leave = (): void => clearTimeout(resting);

/**
 * Handlers for a container whose run links should open at once: a link the mouse rests on or the
 * keyboard stops at reads its run ahead, and a press reads it on the way to the click.
 */
export const readAheadHandlers = {
  onPointerOver: (event: { readonly pointerType: string; readonly target: EventTarget }) => {
    if (event.pointerType === "mouse") rest(event.target);
  },
  onPointerOut: leave,
  onPointerDown: (event: { readonly target: EventTarget }) => readRunOf(event.target),
  onFocus: (event: { readonly target: EventTarget }) => rest(event.target),
  onBlur: leave,
};
