import type { EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

import { TouchLink } from "../TouchLink";
import { nodeName } from "./model";
import type { KindInfo, Pipeline, RecordedEvent, RunDetail, RunStatus, RunSummary } from "./types";

const STATUS_VARIANT: Record<RunStatus, "info" | "success" | "warning" | "error" | "outline"> = {
  running: "info",
  done: "success",
  stuck: "warning",
  stopped: "outline",
  interrupted: "warning",
  error: "error",
};

const when = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
};

function EventLine({
  event,
  nameOf,
  environmentId,
}: {
  event: RecordedEvent;
  nameOf: (id: string) => string;
  environmentId: EnvironmentId;
}) {
  switch (event.event) {
    case "started":
      return (
        <>
          Started in {event.projectRoot}
          {event.issue === null ? "" : ` on #${event.issue}`}
        </>
      );
    case "entered":
      return (
        <>
          Entered {nameOf(event.node)}
          {event.visit > 1 ? ` (visit ${event.visit})` : ""}
        </>
      );
    case "outcome":
      return (
        <>
          {nameOf(event.node)} ended with {event.port}
        </>
      );
    case "moved":
      return <>Took {event.edge}</>;
    case "waiting":
      return (
        <>
          {nameOf(event.node)} waits on {event.on}
        </>
      );
    case "thread":
      return (
        <>
          {nameOf(event.node)} thread{" "}
          <TouchLink
            render={
              <Link
                params={{ environmentId, threadId: event.threadId }}
                to="/$environmentId/$threadId"
              />
            }
          >
            Open
          </TouchLink>
        </>
      );
    case "ended":
      return (
        <>
          Ended {event.result}
          {event.reason ? `: ${event.reason}` : ""}
        </>
      );
    case "error":
      return <>Error: {event.message}</>;
  }
}

/** The pipeline's runs, newest first; the selected one's record below, with its trail on the canvas. */
export function RunsPanel({
  environmentId,
  pipeline,
  kinds,
  runs,
  error,
  selectedRunId,
  detail,
  stopping,
  onSelect,
  onStop,
}: {
  environmentId: EnvironmentId;
  pipeline: Pipeline;
  kinds: ReadonlyArray<KindInfo>;
  runs: ReadonlyArray<RunSummary> | null;
  error: string | null;
  selectedRunId: string | null;
  detail: RunDetail | null;
  stopping: boolean;
  onSelect: (id: string | null) => void;
  onStop: (id: string) => void;
}) {
  const nameOf = (id: string) => {
    const node = pipeline.nodes.find((candidate) => candidate.id === id);
    return node === undefined ? id : nodeName(kinds, node);
  };
  // A record only grows at the end, so an event's position is its identity.
  const events = (detail?.events ?? []).map((event, n) => ({ event, n }));
  if (runs === null) {
    return error ? (
      <p className="text-sm text-destructive-foreground" role="alert">
        Could not read runs: {error}
      </p>
    ) : (
      <p className="text-sm text-muted-foreground" role="status">
        Loading runs…
      </p>
    );
  }
  return (
    <section aria-label="Runs" className="flex flex-col gap-3">
      {error ? (
        <p className="text-xs text-destructive-foreground" role="alert">
          Could not refresh runs: {error}
        </p>
      ) : null}
      {runs.length === 0 ? (
        <p className="text-sm text-muted-foreground">No runs yet. Run starts one on a project.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {runs.map((run) => (
            <li key={run.id}>
              <button
                aria-pressed={run.id === selectedRunId}
                className={cn(
                  "flex w-full flex-col gap-0.5 rounded-md border px-2.5 py-1.5 text-left text-xs hover:bg-accent",
                  run.id === selectedRunId && "border-primary bg-accent",
                )}
                onClick={() => onSelect(run.id === selectedRunId ? null : run.id)}
                type="button"
              >
                <span className="flex items-center gap-2">
                  <Badge variant={STATUS_VARIANT[run.status]}>{run.status}</Badge>
                  <span className="min-w-0 truncate">{run.node ? nameOf(run.node) : "-"}</span>
                  <span className="ml-auto shrink-0 text-muted-foreground">
                    {when(run.startedAt)}
                  </span>
                </span>
                <span className="truncate text-muted-foreground">
                  {run.repo ?? run.projectRoot}
                  {run.issue === null ? "" : ` #${run.issue}`}
                </span>
                {run.reason ? (
                  <span className="break-words text-muted-foreground">{run.reason}</span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}
      {detail !== null && detail.id === selectedRunId ? (
        <div className="flex flex-col gap-2 border-t pt-3">
          <div className="flex items-center gap-2">
            <h3 className="min-w-0 truncate font-mono text-xs">{detail.id}</h3>
            {detail.status === "running" ? (
              <Button
                className="ml-auto"
                disabled={stopping}
                onClick={() => onStop(detail.id)}
                size="xs"
                variant="destructive-outline"
              >
                Stop
              </Button>
            ) : null}
          </div>
          <ol aria-label="Run events" className="flex flex-col gap-0.5 text-xs">
            {events.map(({ event, n }) => (
              <li className="break-words" key={n}>
                <EventLine environmentId={environmentId} event={event} nameOf={nameOf} />
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </section>
  );
}
