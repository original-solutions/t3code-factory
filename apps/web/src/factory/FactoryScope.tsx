import { XIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

/** One choice of a scope select: its name, and in the list a dot and a word on how it is doing. */
export interface ScopeChoice {
  readonly value: string;
  readonly label: string;
  /** A CSS colour for the dot; none for a choice the page knows nothing more about. */
  readonly tone?: string;
  /** The dot as a class, where the tone is a theme colour. */
  readonly toneClass?: string;
  readonly note?: string;
}

function ScopeSelect({
  label,
  all,
  choices,
  value,
  onChange,
}: {
  label: string;
  all: string;
  choices: ReadonlyArray<ScopeChoice>;
  value: string | null;
  onChange: (value: string | null) => void;
}) {
  const items = [{ value: null, label: all }, ...choices];
  return (
    <div className="min-w-0 max-w-full">
      <Select items={items} onValueChange={onChange} value={value}>
        <SelectTrigger aria-label={label} size="sm">
          <SelectValue />
        </SelectTrigger>
        <SelectPopup
          alignItemWithTrigger={false}
          className="max-w-[calc(100vw-2rem)]"
          matchTriggerWidth={false}
        >
          <SelectItem value={null}>{all}</SelectItem>
          {choices.map((choice) => (
            <SelectItem
              aria-label={choice.note ? `${choice.label}, ${choice.note}` : choice.label}
              key={choice.value}
              value={choice.value}
            >
              <span className="flex min-w-0 items-center gap-2">
                {choice.tone || choice.toneClass ? (
                  <span
                    aria-hidden
                    className={`size-2 shrink-0 rounded-full ${choice.toneClass ?? ""}`}
                    style={choice.tone ? { background: choice.tone } : undefined}
                  />
                ) : (
                  <span aria-hidden className="size-2 shrink-0" />
                )}
                <span className="min-w-0 truncate">{choice.label}</span>
                {choice.note ? (
                  <span
                    className="ml-auto shrink-0 pl-4 text-xs text-muted-foreground"
                    data-scope-note
                  >
                    {choice.note}
                  </span>
                ) : null}
              </span>
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
}

/**
 * What the page shows, as one sentence under its title: "Showing [repo] on [machine]". Each part is
 * there only when there is more than one to choose or it is set, so it can be cleared. Live and
 * Trends both follow it; it stays in view while the page scrolls, as the title bar does.
 */
export function FactoryScope({
  repos,
  repo,
  onRepo,
  machines,
  machine,
  onMachine,
  onClear,
}: {
  repos: ReadonlyArray<ScopeChoice> | null;
  repo: string | null;
  onRepo: (value: string | null) => void;
  machines: ReadonlyArray<ScopeChoice> | null;
  machine: string | null;
  onMachine: (value: string | null) => void;
  onClear: () => void;
}) {
  if (repos === null && machines === null) return null;
  const clear =
    repo !== null || machine !== null ? (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button aria-label="Show everything" onClick={onClear} size="icon-xs" variant="ghost" />
          }
        >
          <XIcon />
        </TooltipTrigger>
        <TooltipPopup>Show everything</TooltipPopup>
      </Tooltip>
    ) : null;
  // Each part keeps its words beside its select, so on a phone a part wraps whole.
  return (
    <nav
      aria-label="What the page shows"
      className="sticky top-0 z-10 -mx-5 -mt-6 -mb-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 bg-background px-5 py-3 text-sm text-muted-foreground sm:-mx-6 sm:px-6"
    >
      <span className="flex min-w-0 max-w-full items-center gap-2">
        <span className="shrink-0">Showing</span>
        {repos === null ? (
          <span className="shrink-0">every repo</span>
        ) : (
          <ScopeSelect
            all="All repos"
            choices={repos}
            label="Repo"
            onChange={onRepo}
            value={repo}
          />
        )}
        {machines === null ? clear : null}
      </span>
      {machines === null ? null : (
        <span className="flex min-w-0 max-w-full items-center gap-2">
          <span className="shrink-0">{machine === null ? "across" : "on"}</span>
          <ScopeSelect
            all="All environments"
            choices={machines}
            label="Environment"
            onChange={onMachine}
            value={machine}
          />
          {clear}
        </span>
      )}
    </nav>
  );
}
