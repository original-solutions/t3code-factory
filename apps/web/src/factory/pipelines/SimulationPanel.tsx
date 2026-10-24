import { RotateCcwIcon, Undo2Icon } from "lucide-react";

import { Button } from "~/components/ui/button";

import { nodeName } from "./model";
import type { KindInfo, Pipeline, Trace } from "./types";

/** The simulation's controls: where the walk is, its outcomes to pick, and the steps so far. */
export function SimulationPanel({
  pipeline,
  kinds,
  trace,
  script,
  busy,
  error,
  onPick,
  onUndo,
  onReset,
  onHappyPath,
}: {
  pipeline: Pipeline;
  kinds: ReadonlyArray<KindInfo>;
  trace: Trace | null;
  script: ReadonlyArray<string>;
  busy: boolean;
  error: string | null;
  onPick: (port: string) => void;
  onUndo: () => void;
  onReset: () => void;
  onHappyPath: () => void;
}) {
  const nameOf = (id: string) => {
    const node = pipeline.nodes.find((candidate) => candidate.id === id);
    return node === undefined ? id : nodeName(kinds, node);
  };
  const end = trace?.end;
  const outcomes = (trace?.steps ?? []).flatMap((step) =>
    step.kind === "outcome" ? [{ node: step.node, port: step.port }] : [],
  );
  // The steps only grow at the end, so a step's number is its identity.
  const numbered = outcomes.map((outcome, i) => ({ ...outcome, n: i + 1 }));
  return (
    <section aria-label="Simulation" className="flex flex-col gap-3">
      <div className="flex items-center gap-1.5">
        <h2 className="text-sm font-medium">Simulation</h2>
        <div className="ml-auto flex items-center gap-1">
          <Button disabled={busy || script.length === 0} onClick={onUndo} size="xs" variant="ghost">
            <Undo2Icon />
            Undo last
          </Button>
          <Button
            disabled={busy || script.length === 0}
            onClick={onReset}
            size="xs"
            variant="ghost"
          >
            <RotateCcwIcon />
            Reset
          </Button>
        </div>
      </div>
      {error ? (
        <p className="text-xs text-destructive-foreground" role="alert">
          {error}
        </p>
      ) : null}
      {end === undefined ? (
        error === null ? (
          <p className="text-xs text-muted-foreground" role="status">
            Simulating…
          </p>
        ) : null
      ) : end.kind === "waiting" ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm" role="status">
            At {nameOf(end.node)}. What happens next?
          </p>
          {end.ports.length === 0 ? (
            <p className="text-xs text-muted-foreground">This node has no outcomes.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {end.ports.map((port) => (
                <Button
                  disabled={busy}
                  key={port}
                  onClick={() => onPick(port)}
                  size="xs"
                  variant="outline"
                >
                  {port}
                </Button>
              ))}
            </div>
          )}
          <div>
            <Button disabled={busy} onClick={onHappyPath} size="xs" variant="secondary">
              Happy path
            </Button>
          </div>
        </div>
      ) : end.kind === "ended" ? (
        <p className="text-sm" role="status">
          {end.result === "done" ? "Ended done" : `Ended stuck: ${end.reason ?? "no reason given"}`}
        </p>
      ) : (
        <p className="text-sm" role="status">
          The pipeline has no start node.
        </p>
      )}
      {outcomes.length > 0 ? (
        <ol aria-label="Steps" className="flex flex-col gap-0.5 text-xs text-muted-foreground">
          {numbered.map((outcome) => (
            <li key={outcome.n}>
              {outcome.n}. {nameOf(outcome.node)} · {outcome.port}
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}
