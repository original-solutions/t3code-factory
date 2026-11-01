import type { EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";

import { Badge } from "~/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { cn } from "~/lib/utils";

import { STATION_META, type BeltRun, type Station } from "./belt";
import { BeltDot } from "./BeltDot";
import { formatAge } from "./format";
import { RunActions, type RunStop } from "./RunActionBar";
import { runActions } from "./runActions";

/** The id of the one open readout, which the picked post names in `aria-controls`. */
export const READOUT_ID = "factory-readout";

/** A column the narrow belt folds into the title's cell instead. */
const WIDE_ONLY = "hidden @3xl:table-cell";

/**
 * The open post's runs as a table under the rail, with a notch in the post's own column. A row
 * links to its run, stretched over the row; the run's actions (thread, PR, Stop where they can work,
 * as everywhere a run is shown) sit above it. Narrow, env and step stack under the title.
 */
export function BeltReadout({
  station,
  runs,
  selectedId,
  nowMs,
  column,
  stopOf,
}: {
  station: Station;
  runs: ReadonlyArray<BeltRun>;
  selectedId: EnvironmentId;
  nowMs: number;
  /** The wide belt's column class of the picked post, which the notch takes. */
  column: string;
  /** How a row's Stop stops its run; a row shows Stop only when {@link runActions} offers it. */
  stopOf: (run: BeltRun) => RunStop;
}) {
  const { name, tag } = STATION_META[station];

  return (
    <section
      aria-label={`${name} readout`}
      className="relative col-span-2 mt-2 min-w-0 rounded-lg border border-(--factory-station) bg-card @3xl:col-span-5 @3xl:mt-4 @3xl:col-start-1 @3xl:row-start-3"
      data-readout=""
      data-station={station}
      id={READOUT_ID}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 -top-2 grid grid-cols-1 gap-x-2 @3xl:grid-cols-(--factory-cols)"
      >
        <span
          className={cn(
            "ml-6 size-3.5 rotate-45 border-t border-l border-(--factory-station) bg-card @3xl:ml-0 @3xl:justify-self-center",
            column,
          )}
          data-part="notch"
        />
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2.5">
        <span aria-hidden className="size-2.5 rounded-xs bg-(--factory-station)" />
        <h2 className="text-sm font-semibold">{name}</h2>
        <span className="font-mono text-xs text-muted-foreground">{tag}</span>
        <Badge variant="secondary">
          {runs.length} {runs.length === 1 ? "run" : "runs"}
        </Badge>
      </div>
      {runs.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted-foreground">Nothing at {name}.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Issue</TableHead>
              <TableHead>Title</TableHead>
              <TableHead className={WIDE_ONLY}>Env</TableHead>
              <TableHead className={WIDE_ONLY}>Step</TableHead>
              <TableHead>Elapsed</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.map((run) => {
              const actions = runActions(run).filter((action) => action.kind !== "issue");
              return (
                <TableRow className="relative" key={run.key}>
                  <TableCell>
                    <Link
                      className="font-mono font-semibold after:absolute after:inset-0 hover:underline"
                      params={{ environmentId: run.environmentId, runId: run.id }}
                      to="/factory/$environmentId/$runId"
                    >
                      {run.issue}
                    </Link>
                  </TableCell>
                  <TableCell className="w-full max-w-0">
                    <span className="block truncate">{run.title ?? run.issue}</span>
                    <span className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs text-muted-foreground @3xl:hidden">
                      <span className="inline-flex items-center gap-1.5">
                        <BeltDot selected={run.environmentId === selectedId} />
                        {run.label}
                      </span>
                      <span className="font-mono">{run.step ?? "-"}</span>
                    </span>
                  </TableCell>
                  <TableCell className={WIDE_ONLY}>
                    <span className="inline-flex items-center gap-1.5">
                      <BeltDot selected={run.environmentId === selectedId} />
                      {run.label}
                    </span>
                  </TableCell>
                  <TableCell className={WIDE_ONLY}>
                    <span className="font-mono">{run.step ?? "-"}</span>
                  </TableCell>
                  <TableCell>
                    <span className="font-mono">
                      {run.forMs === null ? "-" : formatAge(nowMs - run.forMs, nowMs)}
                    </span>
                  </TableCell>
                  <TableCell className="text-right">
                    <span className="relative z-10">
                      <RunActions
                        actions={actions}
                        className="justify-end @3xl:flex-nowrap"
                        environmentId={run.environmentId}
                        label={run.issue}
                        runId={run.id}
                        stop={stopOf(run)}
                      />
                    </span>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
