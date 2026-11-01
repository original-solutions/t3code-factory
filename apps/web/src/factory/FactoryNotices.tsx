import { Link } from "@tanstack/react-router";
import { CloudOffIcon, HourglassIcon, LockIcon, TriangleAlertIcon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "~/components/ui/empty";
import { Skeleton } from "~/components/ui/skeleton";

import { formatClock } from "./belt";
import { readProblem, type ReadProblem } from "./readProblem";

/** What a page shows while its first read is in flight. */
export function FactoryLoading({ label }: { label: string }) {
  return (
    <div aria-label={label} className="flex flex-col gap-3" role="status">
      <Skeleton className="h-6 w-48" />
      <Skeleton className="h-9 w-full" />
      <Skeleton className="h-9 w-full" />
      <Skeleton className="h-9 w-full" />
    </div>
  );
}

/** The words of a failed read: what it likely means, then the server's own, if they add anything. */
function ProblemText({ problem, stale }: { problem: ReadProblem; stale: string | null }) {
  const lead = [problem.hint, stale].filter((part) => part !== null).join(" ");
  return (
    <>
      {lead ? <p>{lead}</p> : null}
      <p className="break-words font-mono text-xs">{problem.detail}</p>
    </>
  );
}

const PROBLEM_ICONS = {
  unreachable: CloudOffIcon,
  timeout: HourglassIcon,
  connecting: CloudOffIcon,
  relay: CloudOffIcon,
  denied: LockIcon,
  missing: CloudOffIcon,
  failed: TriangleAlertIcon,
} satisfies Record<ReadProblem["kind"], unknown>;

/**
 * One environment's read that failed while the page stays: what went wrong in plain words, what to
 * do, what the page still shows, the raw message, and a Retry.
 */
export function FactoryReadFailure({
  label,
  verb,
  error,
  dataAt,
  onRetry,
}: {
  label: string;
  /** `read` before any data, `refresh` after. */
  verb: "read" | "refresh";
  error: unknown;
  /** When the data still shown landed; 0 for none. */
  dataAt: number;
  onRetry: () => void;
}) {
  const problem = readProblem(error, label);
  const Icon = PROBLEM_ICONS[problem.kind];
  const stale =
    verb === "refresh" && dataAt > 0
      ? `Showing what it said at ${formatClock(dataAt)}; the page keeps trying.`
      : null;
  return (
    <Alert controlAlignment="first-line" variant="error">
      <Icon aria-hidden />
      <AlertTitle>{problem.title}</AlertTitle>
      <AlertDescription>
        <ProblemText problem={problem} stale={stale} />
        {/* Under the words, not beside them: beside, a phone leaves the text a third of the width. */}
        <div className="flex flex-wrap gap-2">
          <Button aria-label={`Retry ${label}`} onClick={onRetry} size="sm" variant="outline">
            Retry
          </Button>
          {problem.kind === "denied" ? (
            <Button render={<Link to="/settings/connections" />} size="sm" variant="ghost">
              Connections
            </Button>
          ) : null}
        </div>
      </AlertDescription>
    </Alert>
  );
}

/** A page with nothing to show, and why: no factory, or no such run. */
export function FactoryError({ title, message }: { title: string; message: string }) {
  return (
    <Empty size="compact">
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{message}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
