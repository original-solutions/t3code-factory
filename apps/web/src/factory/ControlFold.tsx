import * as Schema from "effect/Schema";
import { ChevronDownIcon } from "lucide-react";
import { createContext, useContext, useId, type ReactNode } from "react";

import { useLocalStorage } from "~/hooks/useLocalStorage";
import { cn } from "~/lib/utils";

/** The control bar's parts that fold: each a one-line dial, its detail one tap below. */
export type ControlPart = "machine" | "catch-up";

/** The one part this browser keeps open, if any: a person who wants the gauges up keeps them up. */
const OPEN_KEY = "t3code:factory:control-open";
const OpenSchema = Schema.NullOr(Schema.Literals(["machine", "catch-up"]));

const FoldContext = createContext<{
  readonly open: ControlPart | null;
  readonly setOpen: (part: ControlPart | null) => void;
} | null>(null);

export function ControlFoldProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useLocalStorage(OPEN_KEY, null, OpenSchema);
  return <FoldContext value={{ open, setOpen }}>{children}</FoldContext>;
}

/**
 * Whether a part's detail shows, and the toggle that opens it and closes any other. Outside the
 * control bar's provider every part stays open.
 */
export function useControlFold(part: ControlPart) {
  const fold = useContext(FoldContext);
  const id = useId();
  const open = fold === null || fold.open === part;
  return { open, id, toggle: () => fold?.setOpen(open ? null : part) } as const;
}

/** A cell of the control bar's dial row; the row's 1px gaps draw the lines between cells. */
export const DIAL_CELL = "flex min-w-0 grow basis-60 bg-card";

/** A dial that opens its part's detail: the whole cell is the button. */
export function DialButton({
  open,
  controls,
  onToggle,
  label,
  children,
}: {
  open: boolean;
  controls: string;
  onToggle: () => void;
  /** What the dial opens, for a screen reader. */
  label: string;
  children: ReactNode;
}) {
  return (
    <button
      aria-controls={controls}
      aria-expanded={open}
      aria-label={label}
      className="flex min-w-0 flex-1 items-center gap-3 px-5 py-2.5 text-left outline-none transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset pointer-coarse:min-h-11"
      onClick={onToggle}
      type="button"
    >
      <span className="flex min-w-0 flex-1 flex-col gap-1">{children}</span>
      <ChevronDownIcon
        aria-hidden
        className={cn(
          "size-4 shrink-0 text-muted-foreground transition-transform",
          open && "rotate-180",
        )}
      />
    </button>
  );
}

/** An open part's detail: the dial row's full width, below every dial. */
export function DialDetail({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <section aria-label={label} className="order-last flex basis-full flex-col bg-card" id={id}>
      {children}
    </section>
  );
}
