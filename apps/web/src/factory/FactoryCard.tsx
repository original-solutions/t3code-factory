import type { ComponentProps, ReactNode } from "react";

import { cn } from "~/lib/utils";

/**
 * The factory's one card: a rounded panel whose only colour is an optional top rail in its
 * station's colour (`--factory-station`, set by a `data-station` on it or a parent).
 */
export function FactoryCard({
  rail = false,
  className,
  ...props
}: ComponentProps<"section"> & { rail?: boolean }) {
  return (
    <section
      {...props}
      className={cn(
        "flex min-w-0 flex-col gap-3 rounded-xl border bg-card px-4 py-3",
        rail && "border-t-3 border-t-(--factory-station)",
        className,
      )}
    />
  );
}

/** A card's head: a muted line naming what it is, the heading, and anything that sits at its right. */
export function FactoryCardHeader({
  eyebrow,
  title,
  aside,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end gap-x-3 gap-y-1">
      <div className="flex min-w-0 flex-col gap-0.5">
        {eyebrow ? <p className="text-xs text-muted-foreground">{eyebrow}</p> : null}
        <h2 className="flex flex-wrap items-center gap-x-2 break-words text-base font-medium">
          {title}
        </h2>
      </div>
      {aside ? <div className="ml-auto flex items-center gap-2">{aside}</div> : null}
    </header>
  );
}
