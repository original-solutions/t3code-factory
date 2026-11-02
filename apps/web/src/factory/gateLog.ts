/**
 * The gate's failure message, read for a person: the factory's header (command, how it ended)
 * apart from the command's output, the output cleaned of terminal colour codes, and the lines
 * that say what failed picked out. The output is untrusted text; it is only ever shown as text.
 */

export type GateLineKind = "fail" | "noise" | "plain";

export interface GateLine {
  /** 1-based line number in the output. */
  readonly n: number;
  readonly text: string;
  readonly kind: GateLineKind;
}

export type ExcerptItem = GateLine | { readonly gap: number };

export interface GateFailure {
  readonly command: string | null;
  /** The factory's own words for how the command ended: `exit code 2`, `timed out after 30 s`. */
  readonly result: string | null;
  /** The output's front was dropped before it was sent. */
  readonly cut: boolean;
  readonly lines: ReadonlyArray<GateLine>;
  /** Each failing line with its neighbours, in order, with the skipped stretches counted. */
  readonly excerpt: ReadonlyArray<ExcerptItem>;
  /** The excerpt is the output's last lines because no line read as a failure. */
  readonly excerptIsTail: boolean;
  /** Failing lines past the excerpt's limit, left to the full output. */
  readonly moreFailing: number;
}

const HEADER = "The factory gate failed.";
const OUTPUT_START = "Everything below this line is the command's output";
// A failure line is usually followed by its why (a diff, a stack frame); it is read on from there.
const BEFORE = 2;
const AFTER = 6;
const EXCERPT_LIMIT = 40;
const TAIL = 15;

// The factory turns ESC into a space before the message is written, so a colour code arrives as
// ` [31;1m`: the space goes with it.
const ANSI = /(?:\u001b| )?\[(?:\?\d+[hl]|[0-9;]*\d[A-HJKSTfhlmsu])/g;
// Progress dots, test-runner ticks, box rules and bars: lines that say nothing on their own.
const NOISE = /^[\s.·•!✓✔⨯×✗✘░▒▓█─━═|\-[\]%\d/]*$/u;
const FAIL =
  /\b(?:FAIL(?:ED|URE|S)?|ERROR|ERR!|error(?!-)|panic|fatal|SQLSTATE|Traceback)\b|(?:Error|Exception)\b|[✗✘⨯]|\b[1-9]\d* (?:failed|failing|failures?|errors?)\b/;
const NOT_FAIL = /\b(?:0|no|zero) (?:errors?|failed|failures?|failing)\b/i;
// A passing test's name, or a line of source in a code frame (`  107▕`, ` 259|`), can say "error".
const QUOTED = /^\s*(?:[✓✔√]|PASS\b|(?:➜\s*)?\d+\s*[|▕])/u;

export function cleanLine(line: string): string {
  return line.replace(ANSI, "").trimEnd();
}

function kindOf(text: string): GateLineKind {
  if (NOISE.test(text)) return "noise";
  return FAIL.test(text) && !NOT_FAIL.test(text) && !QUOTED.test(text) ? "fail" : "plain";
}

const header = (lines: ReadonlyArray<string>, key: string): string | null => {
  const line = lines.find((l) => l.startsWith(`${key}: `));
  return line ? line.slice(key.length + 2).trim() || null : null;
};

function excerptOf(
  lines: ReadonlyArray<GateLine>,
): Pick<GateFailure, "excerpt" | "excerptIsTail" | "moreFailing"> {
  const failing = lines.filter((line) => line.kind === "fail").map((line) => line.n - 1);
  if (failing.length === 0) {
    const tail = lines.filter((line) => line.kind !== "noise").slice(-TAIL);
    const first = tail[0]?.n ?? 1;
    return {
      excerpt: first > 1 ? [{ gap: first - 1 }, ...tail] : tail,
      excerptIsTail: true,
      moreFailing: 0,
    };
  }
  const ranges: Array<[number, number]> = [];
  for (const at of failing) {
    const from = Math.max(0, at - BEFORE);
    const to = Math.min(lines.length - 1, at + AFTER);
    const last = ranges.at(-1);
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else ranges.push([from, to]);
  }
  const excerpt: Array<ExcerptItem> = [];
  let shown = 0;
  let next = 0;
  let lastShown = -1;
  for (const [from, to] of ranges) {
    if (shown >= EXCERPT_LIMIT) break;
    if (from > next) excerpt.push({ gap: from - next });
    for (let i = from; i <= to && shown < EXCERPT_LIMIT; i++) {
      excerpt.push(lines[i]!);
      shown++;
      lastShown = i;
    }
    next = lastShown + 1;
  }
  if (next < lines.length) excerpt.push({ gap: lines.length - next });
  return {
    excerpt,
    excerptIsTail: false,
    moreFailing: failing.filter((at) => at > lastShown).length,
  };
}

/** The gate failure in `message`, or null when it is some other message to the agent. */
export function readGateFailure(message: string): GateFailure | null {
  if (!message.startsWith(HEADER)) return null;
  const all = message.split("\n");
  const start = all.findIndex((line) => line.startsWith(OUTPUT_START));
  const head = start === -1 ? all : all.slice(0, start + 1);
  const raw = start === -1 ? [] : all.slice(start + 1);
  const output = raw.map((line) =>
    cleanLine(line.startsWith("| ") ? line.slice(2) : line.slice(1)),
  );
  const cut = output[0] === "[cut]" || (head.at(-1)?.includes(", truncated)") ?? false);
  const body = output[0] === "[cut]" ? output.slice(1) : output;
  const lines = body.map((text, i) => ({ n: i + 1, text, kind: kindOf(text) }));
  return {
    command: header(head, "Command"),
    result: header(head, "Result"),
    cut,
    lines,
    ...excerptOf(lines),
  };
}

/** The output as plain text, for the clipboard. */
export function gateFailureText(failure: GateFailure): string {
  const top = [
    failure.command ? `Command: ${failure.command}` : null,
    failure.result ? `Result: ${failure.result}` : null,
  ].filter(Boolean);
  return [...top, ...(top.length > 0 ? [""] : []), ...failure.lines.map((l) => l.text)].join("\n");
}
