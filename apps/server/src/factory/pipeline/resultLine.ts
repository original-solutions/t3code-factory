/**
 * How a pipeline reads an agent's last message. The markers are the factory's (see
 * `../domain/resultLine.ts`), but a pipeline step need not end in a pull request: `FACTORY-DONE`
 * carries any text, and a pull request URL in it, on any repo, is remembered for the `pr` node.
 */
import { pullRequestUrl, splitLastLine } from "../domain/resultLine.ts";

const DONE = "FACTORY-DONE";
const NEEDS_INFO_LINE = "FACTORY-STOP: needs-info";
const STUCK_LINE = "FACTORY-STOP: stuck";

export type AgentResult =
  | { readonly kind: "done"; readonly text: string; readonly pr: number | null }
  | { readonly kind: "questions"; readonly questions: string }
  | { readonly kind: "stop"; readonly text: string }
  | { readonly kind: "none" };

const URL_PATTERN = /https:\/\/github\.com\/[^\s<>()[\]"'`]+/g;

/** The number of the first GitHub pull request URL in `text`, or null. */
export const pullRequestIn = (text: string): number | null => {
  for (const [match] of text.matchAll(URL_PATTERN)) {
    const parsed = pullRequestUrl(match.replace(/[.,;:!?]+$/, ""));
    if (parsed !== undefined) return parsed.pr;
  }
  return null;
};

/** Reads the last non-empty line of `message`; anything but an exact marker is `none`. */
export const readResult = (message: string | null): AgentResult => {
  const split = message === null ? undefined : splitLastLine(message);
  if (split === undefined) return { kind: "none" };
  const { before, last } = split;
  if (last === DONE || last.startsWith(`${DONE}:`)) {
    const text = last.slice(DONE.length + 1).trim();
    return { kind: "done", text, pr: pullRequestIn(text) };
  }
  if (last === NEEDS_INFO_LINE) {
    const questions = before.trim();
    return questions === ""
      ? { kind: "stop", text: "the agent asked for information but gave no questions" }
      : { kind: "questions", questions };
  }
  if (last === STUCK_LINE) return { kind: "stop", text: before.trim() };
  return { kind: "none" };
};
