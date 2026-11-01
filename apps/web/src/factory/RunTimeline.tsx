import type { EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";

import { InlineButton } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

import type { FactoryEntry } from "./api";
import { GateCommandChips } from "./GateOutput";
import { Ref } from "./Ref";
import { formatSpan, runStory, type StoryTone } from "./runStory";

const DOT: Record<StoryTone, string> = {
  info: "bg-info",
  success: "bg-success",
  warning: "bg-warning",
  error: "bg-destructive",
  muted: "bg-muted-foreground/40",
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const when = (ts: string) =>
  new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

/** The run's ledger told as a story: one line per thing that happened, on a rail. */
export function RunTimeline({
  entries,
  environmentId,
}: {
  entries: ReadonlyArray<FactoryEntry>;
  environmentId: EnvironmentId;
}) {
  const story = runStory(entries);
  const summary = [
    entries[0] ? `Started ${when(entries[0].ts)}` : null,
    story.tookMs === null ? null : `took ${formatSpan(story.tookMs)}`,
    story.sessions > 0 ? plural(story.sessions, "agent session") : null,
    story.gateRuns.total > 0
      ? `${plural(story.gateRuns.total, "gate run")}${story.gateRuns.failed > 0 ? `, ${story.gateRuns.failed} failed` : ""}`
      : null,
  ].filter(Boolean);
  return (
    <section aria-label="Timeline" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-sm font-medium">Timeline</h2>
        {summary.length > 0 ? (
          <p className="text-xs text-muted-foreground">{summary.join(" · ")}</p>
        ) : null}
      </div>
      {story.steps.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing has happened yet</p>
      ) : (
        <ol className="flex flex-col">
          {story.steps.map((step) => (
            <li className="group/step flex gap-3" data-tone={step.tone} key={step.key}>
              <span aria-hidden className="relative flex w-2.5 shrink-0 justify-center">
                <span className="absolute top-4 -bottom-1 w-px bg-border group-last/step:hidden" />
                <span
                  className={cn(
                    "relative mt-1.5 size-2.5 rounded-full ring-4 ring-background",
                    DOT[step.tone],
                  )}
                />
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-1 pb-4 group-last/step:pb-0">
                <div className="flex items-baseline justify-between gap-3">
                  <span
                    className={cn(
                      "min-w-0 break-words text-sm",
                      step.tone === "muted" ? "text-muted-foreground" : "font-medium",
                    )}
                  >
                    {step.title}
                    {step.link ? (
                      <>
                        {" "}
                        <Ref {...step.link} />
                      </>
                    ) : null}
                  </span>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <time
                          className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground"
                          dateTime={step.ts}
                        />
                      }
                    >
                      {step.at}
                    </TooltipTrigger>
                    <TooltipPopup side="left">{when(step.ts)}</TooltipPopup>
                  </Tooltip>
                </div>
                {/* Session and tracker text: plain text, never markdown or HTML. */}
                {step.detail ? (
                  <p className="line-clamp-3 break-words text-xs text-muted-foreground">
                    {step.detail}
                  </p>
                ) : null}
                {step.commands && step.commands.length > 0 ? (
                  <GateCommandChips commands={step.commands} />
                ) : null}
                {step.threadId ? (
                  <span className="text-xs">
                    <InlineButton
                      render={
                        <Link
                          params={{ environmentId, threadId: step.threadId }}
                          to="/$environmentId/$threadId"
                        />
                      }
                    >
                      Open thread
                    </InlineButton>
                  </span>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
