const ITEM = /^(\d+)[.)]\s+/;
const QUESTIONS_HEADING = /^\s*(?:#+\s*|\*\*)?\s*(?:open\s+)?questions?\b[^a-z]*$/i;

interface NumberedList {
  /** The line index the list starts on. */
  readonly start: number;
  readonly items: ReadonlyArray<string>;
}

const plain = (text: string) => text.replaceAll("**", "");

/** Every top-level numbered list: an item keeps its indented lines and the blank lines between items. */
function numberedLists(lines: ReadonlyArray<string>): Array<NumberedList> {
  const lists: Array<NumberedList> = [];
  let current: { start: number; items: Array<Array<string>> } | null = null;
  const close = () => {
    if (current)
      lists.push({
        start: current.start,
        items: current.items.map((item) => plain(item.join("\n").trim())),
      });
    current = null;
  };
  for (const [index, line] of lines.entries()) {
    const item = ITEM.exec(line);
    if (item) {
      current ??= { start: index, items: [] };
      current.items.push([line.slice(item[0].length)]);
    } else if (current && line.trim() === "") {
      current.items.at(-1)!.push("");
    } else if (current && /^\s/.test(line)) {
      current.items.at(-1)!.push(line.trim());
    } else {
      close();
    }
  }
  close();
  return lists.map((list) => ({
    ...list,
    items: list.items.map((item) => item.replace(/\n{2,}/g, "\n")),
  }));
}

/**
 * The questions in a session's needs-info post, each as plain text: the numbered list under a
 * "Questions" heading, else the last numbered list whose every item asks something. Empty when the
 * post has no numbered questions, so the post is answered as a whole.
 */
export function splitQuestions(text: string): ReadonlyArray<string> {
  const lines = text.split("\n");
  const lists = numberedLists(lines);
  const heading = lines.findLastIndex((line) => QUESTIONS_HEADING.test(line));
  if (heading !== -1) {
    const under = lists.find((list) => list.start > heading);
    if (under) return under.items;
  }
  return lists.findLast((list) => list.items.every((item) => item.includes("?")))?.items ?? [];
}

/**
 * A comment that answers the questions: each answered question quoted with its number, its answer
 * under it. Unanswered ones are left out. With no questions, the one answer is the comment.
 */
export function composeReply(
  questions: ReadonlyArray<string>,
  answers: ReadonlyArray<string>,
): string {
  if (questions.length === 0) {
    const answer = answers[0]?.trim() ?? "";
    return answer === "" ? "" : `${answer}\n`;
  }
  const parts = questions.flatMap((question, index) => {
    const answer = answers[index]?.trim() ?? "";
    if (answer === "") return [];
    const quoted = question
      .split("\n")
      .map((line, at) => (at === 0 ? `> **${index + 1}.** ${line}` : `> ${line}`))
      .join("\n");
    return [`${quoted}\n\n${answer}`];
  });
  return parts.length === 0 ? "" : `${parts.join("\n\n")}\n`;
}
