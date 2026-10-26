import type { EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { useMediaQuery } from "~/hooks/useMediaQuery";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";

import { FactoryApiError, factoryApi, type FactoryEntry } from "./api";
import { FactoryFrame } from "./FactoryFrame";
import { FactoryError, FactoryLoading } from "./FactoryNotices";
import {
  currentStep,
  issueRef,
  labelForState,
  lastGateOutput,
  messageOf,
  parseRunId,
  prEndOf,
  prRef,
  prUrlOf,
  runIsFinished,
  runState,
  shownState,
  stateBadgeVariant,
  threadIdOf,
  whyStopped,
} from "./format";
import { Ref } from "./Ref";
import { TouchLink } from "./TouchLink";
import { useFactoryEnvironmentLabel, useFactoryRun } from "./useFactoryData";

/** Pairs each item with a key unique within the list, though two rows may read the same. */
function keyed<T>(items: ReadonlyArray<T>, base: (item: T) => string): Array<[string, T]> {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const name = base(item);
    const n = seen.get(name) ?? 0;
    seen.set(name, n + 1);
    return [`${name}#${n}`, item];
  });
}

function GateOutput({ entries }: { entries: ReadonlyArray<FactoryEntry> }) {
  const stacked = useMediaQuery("max-sm");
  const gate = lastGateOutput(entries);
  const empty = gate.commands.length === 0 && gate.message === null;
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-medium">Last gate output</h2>
      {empty ? <p className="text-sm text-muted-foreground">No gate has run</p> : null}
      {gate.commands.length > 0 && stacked ? (
        <ul className="flex flex-col gap-2" data-layout="list">
          {keyed(gate.commands, (command) => command.command).map(([key, command]) => (
            <li
              className="flex flex-col gap-1 rounded-lg border bg-card px-3 py-2 text-sm"
              key={key}
            >
              <span className="break-all font-mono text-xs">{command.command}</span>
              <span className="flex items-center gap-3 text-xs text-muted-foreground">
                <Badge variant={command.exit_code === 0 ? "success" : "error"}>
                  {command.exit_code}
                </Badge>
                <span>{command.duration_ms} ms</span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {gate.commands.length > 0 && !stacked ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Command</TableHead>
              <TableHead>Exit code</TableHead>
              <TableHead>Duration (ms)</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {keyed(gate.commands, (command) => command.command).map(([key, command]) => (
              <TableRow key={key}>
                <TableCell>
                  <span className="font-mono text-xs">{command.command}</span>
                </TableCell>
                <TableCell>
                  <Badge variant={command.exit_code === 0 ? "success" : "error"}>
                    {command.exit_code}
                  </Badge>
                </TableCell>
                <TableCell>{command.duration_ms}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}
      {/* The session's own words: plain text in a pre, never markdown or HTML. */}
      {gate.message !== null ? (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border bg-card p-3 font-mono text-xs">
          {gate.message}
        </pre>
      ) : null}
    </section>
  );
}

function Ledger({
  entries,
  truncated,
  skipped,
}: {
  entries: ReadonlyArray<FactoryEntry>;
  truncated: boolean;
  skipped: number;
}) {
  const stacked = useMediaQuery("max-sm");
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-medium">Ledger</h2>
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">No ledger entries</p>
      ) : stacked ? (
        <ul className="flex flex-col gap-2" data-layout="list">
          {keyed(entries, (entry) => `${entry.ts} ${entry.event}`).map(([key, entry]) => (
            <li
              className="flex flex-col gap-0.5 rounded-lg border bg-card px-3 py-2 text-sm"
              key={key}
            >
              <span className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="min-w-0 break-words font-medium">{entry.event}</span>
                <span className="font-mono text-xs text-muted-foreground">{entry.ts}</span>
              </span>
              <span className="line-clamp-2 break-all font-mono text-xs">
                {JSON.stringify(entry.data)}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>Event</TableHead>
              <TableHead>Data</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {keyed(entries, (entry) => `${entry.ts} ${entry.event}`).map(([key, entry]) => {
              const data = JSON.stringify(entry.data);
              return (
                <TableRow key={key}>
                  <TableCell className="whitespace-nowrap">
                    <span className="font-mono text-xs">{entry.ts}</span>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{entry.event}</TableCell>
                  <TableCell className="max-w-md">
                    <span className="block line-clamp-2 break-all font-mono text-xs">{data}</span>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
      {truncated ? (
        <p className="text-xs text-muted-foreground">
          The last line of the ledger was unreadable and was dropped.
        </p>
      ) : null}
      {skipped > 0 ? (
        <p className="text-xs text-muted-foreground">{skipped} unreadable lines skipped.</p>
      ) : null}
    </section>
  );
}

export function FactoryRunPage({
  environmentId,
  runId,
}: {
  environmentId: EnvironmentId;
  runId: string;
}) {
  const run = useFactoryRun(environmentId, runId);
  const label = useFactoryEnvironmentLabel(environmentId);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const stop = async () => {
    setBusy(true);
    try {
      setNote((await factoryApi.stopRun(environmentId, runId)).message);
    } catch (error) {
      setNote(messageOf(error));
    } finally {
      setBusy(false);
      run.refresh();
    }
  };

  const entries = run.data?.entries ?? [];
  const state = runState(entries);
  const shown = shownState(state, prEndOf(entries));
  const canStop = run.data !== null && state === "building" && !runIsFinished(entries);
  // A finished run's last step is over; the runs list says finished too.
  const step = runIsFinished(entries) ? "finished" : currentStep(entries);
  const threadId = threadIdOf(entries);
  const parsed = parseRunId(runId);
  const issue = parsed ? issueRef(`${parsed.owner}/${parsed.repo}`, parsed.issue) : null;
  const pr = prRef(prUrlOf(entries));
  const why = whyStopped(entries);

  let body;
  if (run.status === "error" && run.data === null) {
    body =
      run.error instanceof FactoryApiError && run.error.status === 404 ? (
        <FactoryError
          message="It may be finished and cleaned up, or the id is wrong."
          title={`No run ${runId}`}
        />
      ) : (
        <FactoryError message={messageOf(run.error)} onRetry={run.refresh} />
      );
  } else if (run.data === null) {
    body = <FactoryLoading label="Loading run" />;
  } else {
    body = (
      <>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          <Badge variant={stateBadgeVariant(shown)}>{labelForState(shown)}</Badge>
          <span className="min-w-0 break-words text-muted-foreground">Step: {step ?? "-"}</span>
          {threadId ? (
            <TouchLink
              render={<Link params={{ environmentId, threadId }} to="/$environmentId/$threadId" />}
            >
              Thread
            </TouchLink>
          ) : (
            <span className="text-muted-foreground">no thread yet</span>
          )}
          {issue ? <Ref {...issue} touch /> : null}
          {pr ? <Ref {...pr} touch /> : null}
          <Button
            className="ml-auto"
            disabled={!canStop || busy}
            onClick={() => void stop()}
            size="sm"
            variant="destructive-outline"
          >
            Stop
          </Button>
        </div>
        {note ? (
          <p className="break-words text-sm text-muted-foreground" role="status">
            {note}
          </p>
        ) : null}
        {why ? (
          <section className="flex flex-col gap-2">
            <h2 className="text-sm font-medium">{why.title}</h2>
            {/* The session's own words: plain text, never markdown or HTML. */}
            <p className="whitespace-pre-wrap break-words rounded-lg border bg-card p-3 text-sm">
              {why.text}
            </p>
          </section>
        ) : null}
        <GateOutput entries={entries} />
        <Ledger entries={entries} skipped={run.data.skipped} truncated={run.data.truncated} />
      </>
    );
  }

  return (
    <FactoryFrame
      header={
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <TouchLink render={<Link to="/factory" />} tone="muted">
            Back
          </TouchLink>
          <h1 className="min-w-0 truncate font-mono text-sm font-medium">{runId}</h1>
          <span className="min-w-0 shrink-0 truncate text-sm text-muted-foreground">{label}</span>
        </div>
      }
    >
      {body}
    </FactoryFrame>
  );
}
