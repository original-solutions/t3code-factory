import type { EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { Button, InlineButton } from "~/components/ui/button";
import { cn } from "~/lib/utils";

import { factoryApi } from "./api";
import { messageOf } from "./format";
import { Ref } from "./Ref";
import type { RunAction } from "./runActions";
import { runLinkKey } from "./runQueue";
import { TouchLink } from "./TouchLink";

/** A stop the caller can make, and whether one for this run is in flight. */
export interface RunStop {
  readonly busy: boolean;
  readonly onStop: () => void;
}

/**
 * A run's actions, the same on the belt's readout, in the runs list and on the run page: only
 * the ones {@link runActions} says can work, Stop last. Without `stop` the caller cannot stop
 * runs, and Stop is left out. `touch` makes each link a 44 px tap target on a phone.
 */
export function RunActions({
  environmentId,
  runId,
  label,
  actions,
  stop,
  touch = false,
  className,
}: {
  environmentId: EnvironmentId;
  runId: string;
  /** How the run is named to a screen reader on its Stop, such as `#20`. */
  label: string;
  actions: ReadonlyArray<RunAction>;
  stop?: RunStop | undefined;
  touch?: boolean;
  /** Layout only, such as where the row stops wrapping. */
  className?: string | undefined;
}) {
  const Inline = touch ? TouchLink : InlineButton;
  const items = actions.flatMap((action) => {
    switch (action.kind) {
      case "thread":
        return [
          <Inline
            key="thread"
            render={
              <Link
                params={{ environmentId, threadId: action.threadId }}
                to="/$environmentId/$threadId"
              />
            }
          >
            Thread
          </Inline>,
        ];
      case "next":
        return [
          <Inline
            key="next"
            render={<Link params={{ environmentId, runId }} to="/factory/$environmentId/$runId" />}
          >
            {action.tone === "stuck" ? "Next step" : "Answer"}
          </Inline>,
        ];
      case "issue":
        return [
          <Ref key="issue" {...action.ref} text={`Issue ${action.ref.text}`} touch={touch} />,
        ];
      case "pr":
        return [
          <Ref
            key="pr"
            {...action.ref}
            text={action.ref.text.startsWith("#") ? `PR ${action.ref.text}` : action.ref.text}
            touch={touch}
          />,
        ];
      case "stop":
        return stop
          ? [
              <Button
                aria-label={`Stop ${label}`}
                disabled={stop.busy}
                key="stop"
                onClick={stop.onStop}
                size="sm"
                variant="destructive-outline"
              >
                Stop
              </Button>,
            ]
          : [];
    }
  });
  if (items.length === 0) return null;
  return (
    <span
      className={cn("inline-flex flex-wrap items-center gap-x-3 gap-y-1", className)}
      data-run-actions=""
    >
      {items}
    </span>
  );
}

/**
 * Stops runs from a list of them: which stops are in flight, by `runLinkKey`, so one row's Stop
 * never disables another's, and the server's answer for the caller to show and refresh after.
 */
export function useRunStop(
  onAnswer: (answer: {
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly message: string;
  }) => void,
) {
  const [stopping, setStopping] = useState<ReadonlySet<string>>(() => new Set());
  const mark = (key: string, member: boolean) =>
    setStopping((current) => {
      const next = new Set(current);
      if (member) next.add(key);
      else next.delete(key);
      return next;
    });
  const stopOf = (environmentId: EnvironmentId, runId: string, label: string): RunStop => {
    const key = runLinkKey(environmentId, runId);
    return {
      busy: stopping.has(key),
      onStop: () => {
        mark(key, true);
        // No try/finally: the React Compiler cannot compile one.
        void factoryApi
          .stopRun(environmentId, runId)
          .then(
            (result) => result.message,
            (error: unknown) => messageOf(error),
          )
          .then((message) => {
            mark(key, false);
            onAnswer({ environmentId, label, message });
          });
      },
    };
  };
  return stopOf;
}
