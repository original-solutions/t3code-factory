import { CheckIcon, CopyIcon, ExternalLinkIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";

import type { LinkRef } from "./format";
import { composeReply } from "./questions";

const draftKey = (runKey: string) => `factory.answers.${runKey}`;

function readDraft(runKey: string): Array<string> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(draftKey(runKey)) ?? "[]");
    return Array.isArray(stored) ? stored.map((answer) => String(answer ?? "")) : [];
  } catch {
    return [];
  }
}

function writeDraft(runKey: string, answers: ReadonlyArray<string>) {
  try {
    if (answers.some((answer) => answer.trim() !== ""))
      localStorage.setItem(draftKey(runKey), JSON.stringify(answers));
    else localStorage.removeItem(draftKey(runKey));
  } catch {
    // A full or blocked storage only costs the draft surviving a reload.
  }
}

/**
 * A box under each of the session's questions, and the reply they make: each answered question
 * quoted above its answer, copied for a comment on the issue. The client never writes to GitHub.
 * Drafts stay in this browser per run, so stepping to the next run and back keeps them.
 */
export function RunAnswers({
  runKey,
  questions,
  issue,
}: {
  /** Names the run's draft: its environment and id. */
  runKey: string;
  questions: ReadonlyArray<string>;
  issue: LinkRef | null;
}) {
  const [answers, setAnswers] = useState<ReadonlyArray<string>>(() => readDraft(runKey));
  const [copied, setCopied] = useState<"copied" | "failed" | null>(null);
  const reply = composeReply(questions, answers);
  const items =
    questions.length > 0
      ? questions.map((question, at) => ({ n: at + 1, question }))
      : [{ n: 1, question: null }];
  const asked = Math.max(questions.length, 1);
  const answered = Array.from({ length: asked }, (_, index) => answers[index] ?? "").filter(
    (answer) => answer.trim() !== "",
  ).length;

  const answer = (index: number, value: string) => {
    const next = Array.from({ length: asked }, (_, at) =>
      at === index ? value : (answers[at] ?? ""),
    );
    setAnswers(next);
    setCopied(null);
    writeDraft(runKey, next);
  };
  const copy = () => {
    void writeTextToClipboard(reply, "reply").then(
      (done) => setCopied(done ? "copied" : "failed"),
      () => setCopied("failed"),
    );
  };
  const where = issue ? `a comment on ${issue.text}` : "a comment on the issue";

  return (
    <div className="flex flex-col gap-3">
      <ol className="flex flex-col gap-3">
        {items.map(({ n, question }) => (
          <li className="flex min-w-0 flex-col gap-1.5" data-question={n} key={n}>
            {question !== null ? (
              <p className="flex gap-2 text-sm">
                <span className="shrink-0 font-medium tabular-nums text-muted-foreground">
                  {n}.
                </span>
                {/* The session's own words: plain text, never markdown or HTML. */}
                <span className="min-w-0 whitespace-pre-wrap break-words">{question}</span>
              </p>
            ) : null}
            <Textarea
              aria-label={question !== null ? `Your answer to question ${n}` : "Your answer"}
              onChange={(event) => answer(n - 1, event.target.value)}
              placeholder={question !== null ? "Your answer" : "Your answer to the session"}
              size="sm"
              value={answers[n - 1] ?? ""}
            />
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={reply === ""} onClick={copy} size="sm">
          {copied === "copied" ? <CheckIcon /> : <CopyIcon />}
          {copied === "copied" ? "Copied" : "Copy the reply"}
        </Button>
        {issue?.href ? (
          <Button
            render={<a href={issue.href} rel="noreferrer" target="_blank" />}
            size="sm"
            variant="outline"
          >
            <ExternalLinkIcon />
            Answer on {issue.text}
          </Button>
        ) : null}
        <p className="text-xs text-muted-foreground" role="status">
          {copied === "copied"
            ? `Paste it into ${where}.`
            : questions.length > 0
              ? `${answered} of ${questions.length} answered · drafts stay in this browser`
              : "Drafts stay in this browser"}
        </p>
      </div>
      {copied === "failed" ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs text-muted-foreground">
            This browser would not copy. Select the reply here and copy it into {where}.
          </p>
          <Textarea aria-label="The reply" readOnly size="sm" value={reply} />
        </div>
      ) : null}
    </div>
  );
}
