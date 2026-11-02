import { FactoryApiError } from "./api";
import { messageOf } from "./format";

export type ReadProblemKind =
  | "unreachable"
  | "timeout"
  | "connecting"
  | "relay"
  | "denied"
  | "missing"
  | "failed";

export interface ReadProblem {
  readonly kind: ReadProblemKind;
  /** What went wrong, naming the environment. */
  readonly title: string;
  /** What it likely means and what to do; null when only the server's own words help. */
  readonly hint: string | null;
  /** What the server or the browser said, word for word. */
  readonly detail: string;
}

const kindOf = (error: unknown): ReadProblemKind => {
  if (!(error instanceof FactoryApiError)) return "unreachable";
  if (error.status === 0) {
    if (error.code === "timeout") return "timeout";
    if (error.code === "no_connection") return "connecting";
    if (error.code === "relay") return "relay";
    return "unreachable";
  }
  if (error.status === 401 || error.status === 403) return "denied";
  if (error.status === 404) return "missing";
  return "failed";
};

const TITLES: Record<ReadProblemKind, (label: string) => string> = {
  unreachable: (label) => `Can't reach ${label}`,
  timeout: (label) => `${label} is not answering`,
  connecting: (label) => `Not connected to ${label} yet`,
  relay: (label) => `${label}'s factory can't be read over a relay`,
  denied: (label) => `${label} won't show this browser its factory`,
  missing: (label) => `${label} has no factory here`,
  failed: (label) => `${label}'s factory failed to answer`,
};

const HINTS: Record<ReadProblemKind, string | null> = {
  unreachable: "The machine may be asleep, restarting or off the network.",
  timeout: "It may be busy, asleep or on a slow network.",
  connecting: "T3 is still connecting to it.",
  relay: "Connect to it directly, on the local network or over Tailscale, to see its factory.",
  denied:
    "This browser's access doesn't cover the factory. Pair it again in Settings → Connections.",
  missing: "Its T3 server may be a build without the factory.",
  failed: null,
};

/** A failed factory read in plain words: what happened, what it likely means, and the raw message. */
export const readProblem = (error: unknown, label: string): ReadProblem => {
  const kind = kindOf(error);
  return { kind, title: TITLES[kind](label), hint: HINTS[kind], detail: messageOf(error) };
};
