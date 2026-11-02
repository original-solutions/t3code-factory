import type { EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useEffect, useEffectEvent } from "react";

import { Button, InlineButton } from "~/components/ui/button";
import { cn } from "~/lib/utils";

import { AgentDot, useQuietRunAgent } from "./RunAgent";
import { Ref } from "./Ref";
import type { RunAction } from "./runActions";
import { runLinkKey } from "./runQueue";
import { onStopAnswered, requestStop, type StopPhase, undoStop, useStopPhases } from "./stopDesk";
import { TouchLink } from "./TouchLink";

/** A stop the caller can make, and where this run's stop is: see {@link StopPhase}. */
export interface RunStop {
  readonly phase: StopPhase | undefined;
  readonly onStop: () => void;
  readonly onUndo: () => void;
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
          action.live ? (
            <LiveThreadLink
              environmentId={environmentId}
              key="thread"
              threadId={action.threadId}
              touch={touch}
            />
          ) : (
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
            </Inline>
          ),
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
        if (!stop) return [];
        return [
          stop.phase === "pending" ? (
            <Button
              aria-label={`Undo stop ${label}`}
              key="stop"
              onClick={stop.onUndo}
              size="sm"
              variant="outline"
            >
              Undo stop
            </Button>
          ) : (
            <Button
              aria-label={`Stop ${label}`}
              disabled={stop.phase !== undefined}
              key="stop"
              onClick={stop.onStop}
              size="sm"
              variant="destructive-outline"
            >
              {stop.phase === "sent" ? "Stop sent" : stop.phase === "sending" ? "Stopping" : "Stop"}
            </Button>
          ),
        ];
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

/** An unfinished run's Thread link, with its agent's state beside it when this client holds it. */
function LiveThreadLink({
  environmentId,
  threadId,
  touch,
}: {
  environmentId: EnvironmentId;
  threadId: string;
  touch: boolean;
}) {
  const pulse = useQuietRunAgent(environmentId, threadId);
  const Inline = touch ? TouchLink : InlineButton;
  return (
    <Inline
      aria-label={pulse ? `Thread, agent ${pulse.word}` : undefined}
      data-agent-tone={pulse?.tone}
      render={<Link params={{ environmentId, threadId }} to="/$environmentId/$threadId" />}
      title={pulse?.title}
    >
      <span className="inline-flex items-center gap-1.5">
        {pulse ? <AgentDot tone={pulse.tone} /> : null}
        Thread
        {pulse ? <span className="font-normal text-muted-foreground">{pulse.word}</span> : null}
      </span>
    </Inline>
  );
}

/**
 * Stops runs from a list of them through the tab's stop desk: a Stop waits a few seconds with
 * Undo before it is sent, and every surface showing the run shows the same state. `onAnswered`
 * hears the environment of each answered stop, to read it again.
 */
export function useRunStop(onAnswered: (environmentId: EnvironmentId) => void) {
  const phases = useStopPhases();
  const answered = useEffectEvent(onAnswered);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a stop's answer can land after the page that asked for it has gone; the desk's listeners are how a mounted page hears it
  useEffect(() => onStopAnswered((environmentId) => answered(environmentId)), []);
  const stopOf = (environmentId: EnvironmentId, runId: string): RunStop => {
    return {
      phase: phases.get(runLinkKey(environmentId, runId)),
      onStop: () => requestStop(environmentId, runId),
      onUndo: () => undoStop(environmentId, runId),
    };
  };
  return stopOf;
}
