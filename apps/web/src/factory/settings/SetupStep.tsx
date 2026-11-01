import { CheckIcon, XIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import type { SetupStepState } from "./repoRoster";

const MARKER: Record<SetupStepState, string> = {
  done: "border-success/40 bg-success/10 text-success-foreground",
  current: "border-primary bg-primary text-primary-foreground",
  todo: "border-border bg-background text-muted-foreground",
  blocked: "border-destructive/40 bg-destructive/10 text-destructive-foreground",
};

/** One numbered step on a rail that runs down to the next. */
export function Step({
  n,
  state,
  title,
  last = false,
  children,
}: {
  readonly n: number;
  readonly state: SetupStepState;
  readonly title: string;
  readonly last?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <li
      aria-current={state === "current" ? "step" : undefined}
      className="relative flex gap-3 px-3 pb-4 last:pb-3 sm:px-4"
      data-setup-step={state}
    >
      {last ? null : (
        <span aria-hidden className="absolute top-7.5 bottom-1.5 left-6 w-px bg-border sm:left-7" />
      )}
      <span
        aria-hidden
        className={cn(
          "relative flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium tabular-nums",
          MARKER[state],
        )}
      >
        {state === "done" ? (
          <CheckIcon className="size-3.5" />
        ) : state === "blocked" ? (
          <XIcon className="size-3.5" />
        ) : (
          n
        )}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2 pt-0.5">
        <p
          className={cn(
            "text-sm font-medium",
            state === "todo" ? "text-muted-foreground" : "text-foreground",
          )}
        >
          {title}
          <span className="sr-only">{` (${state})`}</span>
        </p>
        <div className="flex min-w-0 flex-col gap-2 text-xs text-muted-foreground">{children}</div>
      </div>
    </li>
  );
}
