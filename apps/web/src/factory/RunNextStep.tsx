import type { EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ArrowDownIcon, ExternalLinkIcon, MessageSquareIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "~/components/ui/button";

import { FactoryCard, FactoryCardHeader } from "./FactoryCard";
import type { LinkRef } from "./format";
import type { NextStep } from "./nextStep";
import { splitQuestions } from "./questions";
import { RunAnswers } from "./RunAnswers";
import { formatSpan } from "./runStory";

export const GATE_OUTPUT_ID = "factory-gate-output";

function Step({ n, title, children }: { n: number; title: string; children?: ReactNode }) {
  return (
    <li className="group/next relative flex gap-3">
      <span
        aria-hidden
        className="absolute top-7 bottom-1 left-3 w-px bg-border group-last/next:hidden"
      />
      <span
        aria-hidden
        className="relative flex size-6 shrink-0 items-center justify-center rounded-full border bg-background text-xs font-medium tabular-nums"
      >
        {n}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2 pt-0.5 pb-4 group-last/next:pb-0">
        <p className="break-words text-sm font-medium">{title}</p>
        {children}
      </div>
    </li>
  );
}

const external = (href: string) => <a href={href} rel="noreferrer" target="_blank" />;

/**
 * The top of a stuck or needs-info run's page: why it stopped, the fix for that cause with the one
 * place to start it, and the label that starts a new run, with what that run will build on.
 */
export function RunNextStep({
  step,
  environmentId,
  threadId,
  issue,
  prUrl,
  runKey,
  onShowGate,
}: {
  step: NextStep;
  /** Opens the gate output and brings it into view. */
  onShowGate: () => void;
  /** Names the run's answer drafts: its environment and id. */
  runKey: string;
  environmentId: EnvironmentId;
  threadId: string | null;
  issue: LinkRef | null;
  prUrl: string | null;
}) {
  const stuck = step.kind === "stuck";
  const questions = stuck ? [] : splitQuestions(step.detail ?? "");
  let action: ReactNode = null;
  if (step.focus === "thread" && threadId !== null) {
    action = (
      <Button
        render={<Link params={{ environmentId, threadId }} to="/$environmentId/$threadId" />}
        size="sm"
        variant="outline"
      >
        <MessageSquareIcon />
        Open the session's thread
      </Button>
    );
  } else if (step.focus === "gate") {
    action = (
      <Button onClick={onShowGate} size="sm" variant="outline">
        <ArrowDownIcon />
        Show the gate output
      </Button>
    );
  } else if (step.focus === "checks" && prUrl !== null) {
    action = (
      <Button render={external(`${prUrl}/checks`)} size="sm" variant="outline">
        <ExternalLinkIcon />
        Open the PR's checks
      </Button>
    );
  }

  return (
    <FactoryCard
      aria-label="Next step"
      className="gap-0 overflow-hidden px-0 py-0"
      data-next-step={step.kind}
    >
      <div className="px-4 py-3">
        <FactoryCardHeader eyebrow="What to do next" title={step.cause} />
      </div>
      <ol className="flex flex-col px-4 pb-4">
        <Step
          n={1}
          title={
            questions.length === 0
              ? step.fix
              : `Answer ${questions.length === 1 ? "its question" : `its ${questions.length} questions`} here, then paste the reply into a comment on ${issue?.text ?? "the issue"}.`
          }
        >
          {stuck ? null : (
            <RunAnswers issue={issue} key={runKey} questions={questions} runKey={runKey} />
          )}
          {step.failedGate.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <span>Last gate failed on</span>
              {step.failedGate.map((command) => (
                <span
                  className="inline-flex max-w-full items-center gap-1.5 rounded-md border bg-background px-2 py-0.5 font-mono text-foreground"
                  key={`${command.command} ${command.exit_code}`}
                >
                  <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-destructive" />
                  <span className="min-w-0 truncate">{command.command}</span>
                  <span className="shrink-0 text-muted-foreground">
                    exit {command.exit_code} · {formatSpan(command.duration_ms)}
                  </span>
                </span>
              ))}
            </div>
          ) : null}
          {action ? <div className="flex flex-wrap gap-2">{action}</div> : null}
        </Step>
        <Step
          n={2}
          title={issue ? `Set factory:ready on ${issue.text} again` : "Set factory:ready again"}
        >
          <p className="break-words text-xs text-muted-foreground">{step.nextRun}</p>
          {stuck && issue?.href ? (
            <div className="flex flex-wrap gap-2">
              <Button render={external(issue.href)} size="sm" variant="outline">
                <ExternalLinkIcon />
                Open {issue.text}
              </Button>
            </div>
          ) : null}
        </Step>
      </ol>
      {step.detail && questions.length > 0 ? (
        <details className="border-t bg-muted/30 px-4 py-3">
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
            The session's whole comment on the issue
          </summary>
          <p className="mt-1.5 max-h-80 overflow-auto whitespace-pre-wrap break-words text-sm">
            {step.detail}
          </p>
        </details>
      ) : step.detail ? (
        <div className="flex flex-col gap-1.5 border-t bg-muted/30 px-4 py-3">
          <p className="text-xs font-medium text-muted-foreground">
            {stuck ? "What the factory and the session said" : "Questions on the issue"}
          </p>
          {/* The session's own words: plain text, never markdown or HTML. */}
          <p className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-sm">
            {step.detail}
          </p>
        </div>
      ) : null}
    </FactoryCard>
  );
}
