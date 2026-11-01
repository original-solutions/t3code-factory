import { Link } from "@tanstack/react-router";
import { Fragment } from "react";

import { InlineButton } from "~/components/ui/button";

import { formatClock } from "./belt";
import type { BeltNewsItem } from "./beltNews";

const SHOWN = 3;

/**
 * The belt's latest change in words, under the rail. It is a polite live region that is always in
 * the page (empty until something moves), so a screen reader speaks each change as it happens, and
 * a viewer who turned motion off reads what the tiles would have shown.
 */
export function BeltChanges({ news, at }: { news: ReadonlyArray<BeltNewsItem>; at: number }) {
  const hidden = news.length - SHOWN;
  return (
    <p className="break-words text-xs text-muted-foreground empty:sr-only" role="status">
      {news.length === 0 ? null : (
        <>
          <span className="font-medium text-foreground">Latest change</span>{" "}
          <span className="font-mono tabular-nums">{formatClock(at)}</span>
          {": "}
          {news.slice(0, SHOWN).map(({ key, run, who, what }, index) => (
            <Fragment key={key}>
              {index > 0 ? "; " : null}
              <InlineButton
                render={
                  <Link
                    params={{ environmentId: run.environmentId, runId: run.id }}
                    to="/factory/$environmentId/$runId"
                  />
                }
              >
                {who}
              </InlineButton>{" "}
              {what}
            </Fragment>
          ))}
          {hidden > 0 ? `; and ${hidden} more` : null}.
        </>
      )}
    </p>
  );
}
