import { CheckIcon, ChevronRightIcon, CopyIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";

import type { FactoryEntry } from "./api";
import { type GateCommand, lastGateOutput } from "./format";
import { type ExcerptItem, type GateLine, gateFailureText, readGateFailure } from "./gateLog";
import { GATE_OUTPUT_ID } from "./RunNextStep";
import { formatSpan } from "./runStory";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** A gate's commands as chips: a dot for how each ended, its exit code when not 0, its time. */
export function GateCommandChips({ commands }: { commands: ReadonlyArray<GateCommand> }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {commands.map((command) => (
        <span
          className="inline-flex max-w-full items-center gap-1.5 rounded-md border bg-card px-2 py-0.5 font-mono text-xs"
          key={`${command.command} ${command.exit_code} ${command.duration_ms}`}
        >
          <span
            aria-hidden
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              command.exit_code === 0 ? "bg-success" : "bg-destructive",
            )}
          />
          <span className="min-w-0 truncate">{command.command}</span>
          <span className="shrink-0 text-muted-foreground">
            {command.exit_code === 0 ? "" : `exit ${command.exit_code} · `}
            {formatSpan(command.duration_ms)}
          </span>
        </span>
      ))}
    </div>
  );
}

const lineAt = (item: ExcerptItem | undefined) => (item && "n" in item ? item.n : "end");

/** Output lines with their numbers; failing lines marked, progress noise dimmed to one line. */
function Lines({ items }: { items: ReadonlyArray<ExcerptItem> }) {
  return (
    <ol className="font-mono text-xs leading-5">
      {items.map((item, i) =>
        "gap" in item ? (
          <li
            className="px-3 text-muted-foreground/70 italic"
            data-gap={item.gap}
            key={`gap-before-${lineAt(items[i + 1])}`}
          >
            ⋯ {plural(item.gap, "line")}
          </li>
        ) : (
          <Line key={item.n} line={item} />
        ),
      )}
    </ol>
  );
}

function Line({ line }: { line: GateLine }) {
  return (
    <li
      className={cn(
        "grid grid-cols-[2.75rem_minmax(0,1fr)] border-l-2 border-transparent pr-3",
        line.kind === "fail" && "border-destructive bg-destructive/8",
      )}
      data-kind={line.kind}
    >
      <span className="select-none pr-3 text-right text-muted-foreground/60 tabular-nums">
        {line.n}
      </span>
      <span
        className={cn(
          line.kind === "noise"
            ? "truncate whitespace-pre text-muted-foreground/60"
            : "whitespace-pre-wrap break-words",
          line.kind === "fail" && "text-destructive-foreground",
        )}
      >
        {line.text || " "}
      </span>
    </li>
  );
}

/** Opens scrolled to the end, where a failing command says why. */
const toEnd = (node: HTMLDivElement | null) => {
  if (node) node.scrollTop = node.scrollHeight;
};

/** The failed command's output: where it failed first, the whole of it on demand. */
function FailureReader({ message }: { message: string }) {
  const failure = readGateFailure(message);
  const { copyToClipboard, isCopied } = useCopyToClipboard({ timeout: 1500 });
  // Any other message to the agent (a merge conflict, review feedback) is short plain text.
  if (failure === null) {
    return (
      <div className="flex flex-col gap-1.5">
        <h3 className="text-xs font-medium text-muted-foreground">Last message to the agent</h3>
        {/* The session's own words: plain text in a pre, never markdown or HTML. */}
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border bg-card p-3 font-mono text-xs">
          {message}
        </pre>
      </div>
    );
  }
  return (
    <div className="flex flex-col overflow-hidden rounded-lg border bg-card">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-2">
        <span className="min-w-0 text-sm font-medium">
          {failure.excerptIsTail ? "How the output ended" : "Where it failed"}
        </span>
        {failure.command ? (
          <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
            {failure.command}
            {failure.result ? ` · ${failure.result}` : ""}
          </span>
        ) : null}
        <span className="ml-auto">
          <Button
            onClick={() => copyToClipboard(gateFailureText(failure), undefined)}
            size="xs"
            variant="ghost"
          >
            {isCopied ? <CheckIcon /> : <CopyIcon />}
            {isCopied ? "Copied" : "Copy output"}
          </Button>
        </span>
      </div>
      {failure.lines.length === 0 ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">The command printed nothing.</p>
      ) : (
        <div className="py-1.5">
          <Lines items={failure.excerpt} />
          {failure.moreFailing > 0 ? (
            <p className="px-3 pt-1 text-xs text-muted-foreground">
              {plural(failure.moreFailing, "more failing line")} in the full output
            </p>
          ) : null}
        </div>
      )}
      {failure.lines.length > 0 ? (
        <div className="border-t">
          <Collapsible>
            <CollapsibleTrigger
              render={<Button size="sm" variant="ghost-muted" />}
              className="group/full m-1"
            >
              <ChevronRightIcon className="transition-transform group-data-panel-open/full:rotate-90" />
              Full output ({plural(failure.lines.length, "line")}
              {failure.cut ? ", the start was cut" : ""})
            </CollapsibleTrigger>
            <CollapsiblePanel animate={false}>
              <div className="max-h-96 overflow-auto border-t py-1.5" ref={toEnd}>
                <Lines items={failure.lines} />
              </div>
            </CollapsiblePanel>
          </Collapsible>
        </div>
      ) : null}
    </div>
  );
}

/** The last gate attempt: its commands, and why it failed when the factory sent the output on. */
export function GateOutput({ entries }: { entries: ReadonlyArray<FactoryEntry> }) {
  const gate = lastGateOutput(entries);
  if (gate.commands.length === 0 && gate.message === null) return null;
  return (
    <section className="flex scroll-mt-4 flex-col gap-2" id={GATE_OUTPUT_ID}>
      <div className="flex items-baseline gap-2">
        <h2 className="text-sm font-medium">Last gate output</h2>
        {gate.attempt !== null ? (
          <span className="text-xs text-muted-foreground">attempt {gate.attempt}</span>
        ) : null}
      </div>
      {gate.commands.length > 0 ? <GateCommandChips commands={gate.commands} /> : null}
      {gate.message !== null ? <FailureReader message={gate.message} /> : null}
    </section>
  );
}
