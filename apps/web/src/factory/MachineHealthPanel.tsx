import type { EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { CheckIcon, CopyIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";

import type { FactoryStatus } from "./api";
import {
  machineHealthView,
  type HealthGauge,
  type HealthHold,
  type HealthTone,
} from "./machineHealth";
import { TouchLink } from "./TouchLink";

const DOT: Record<HealthTone, string> = {
  ok: "bg-success",
  warn: "bg-warning",
  bad: "bg-destructive",
  off: "bg-muted-foreground/40",
};

const TEXT: Record<HealthTone, string> = {
  ok: "",
  warn: "text-warning-foreground",
  bad: "text-destructive-foreground",
  off: "text-muted-foreground",
};

/** The biggest folders where the disk gauge read: old worktrees are what fills it most often. */
const diskCommand = (path: string) =>
  `du -sh '${path.replaceAll("'", "'\\''")}'/* 2>/dev/null | sort -h | tail -15`;

function Gauge({ gauge }: { gauge: HealthGauge }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 px-5 py-2.5" data-gauge={gauge.key}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs text-muted-foreground">{gauge.label}</span>
        <b className={cn("whitespace-nowrap font-mono text-sm font-semibold", TEXT[gauge.tone])}>
          {gauge.value}
        </b>
      </div>
      {gauge.fill === null ? null : (
        <div aria-hidden className="relative h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className={cn("h-full rounded-full", DOT[gauge.tone])}
            style={{ width: `${Math.max(2, gauge.fill * 100)}%` }}
          />
          {gauge.mark === null ? null : (
            <div
              className="absolute inset-y-0 w-0.5 bg-foreground/70"
              style={{ left: `${gauge.mark * 100}%` }}
            />
          )}
        </div>
      )}
      <span className="min-w-0 break-words text-xs text-muted-foreground">{gauge.detail}</span>
    </div>
  );
}

function Hold({
  hold,
  diskPath,
  environmentId,
}: {
  hold: HealthHold;
  diskPath: string | null;
  environmentId: EnvironmentId;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({ timeout: 1500 });
  const lowDisk = hold.key === "low-disk" && hold.tone === "bad";
  return (
    <li className="flex min-w-0 gap-2.5 py-2">
      <span aria-hidden className={cn("mt-1.5 size-2 shrink-0 rounded-full", DOT[hold.tone])} />
      <div className="flex min-w-0 flex-col gap-1">
        <p className="min-w-0 break-words text-sm">
          <b className="font-semibold">{hold.title}.</b>{" "}
          <span className="text-muted-foreground">{hold.detail}</span>
        </p>
        {lowDisk ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {diskPath === null ? null : (
              <Button
                aria-label="Copy a command that lists the biggest folders there"
                onClick={() => copyToClipboard(diskCommand(diskPath), undefined)}
                size="xs"
                variant="outline"
              >
                {isCopied ? <CheckIcon /> : <CopyIcon />}
                {isCopied ? "Copied" : "Copy: find what fills it"}
              </Button>
            )}
            <span className="text-xs text-muted-foreground">
              The floor is <code className="font-mono">min_free_gib</code> in{" "}
              <TouchLink
                render={<Link search={{ machine: environmentId }} to="/settings/factory" />}
              >
                Factory settings
              </TouchLink>
              .
            </span>
          </div>
        ) : null}
      </div>
    </li>
  );
}

/**
 * The machine under the factory, read with each status: a gauge each for the disk, load and gates
 * the pass holds claims on, each with the line it holds at, then every reason nothing is claimed
 * now and what lifts it. Says nothing for a server that sends no health.
 */
export function MachineHealthPanel({
  status,
  environmentId,
  label,
}: {
  status: FactoryStatus;
  environmentId: EnvironmentId;
  label: string;
}) {
  const view = machineHealthView(status);
  if (view === null) return null;
  return (
    <section aria-label={`Machine health of ${label}`} className="flex flex-col border-t">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 px-5 pt-2.5">
        <span aria-hidden className={cn("size-2 shrink-0 rounded-full", DOT[view.verdict.tone])} />
        <span className="text-xs text-muted-foreground">Machine</span>
        <b
          className={cn("min-w-0 break-words text-sm font-semibold", TEXT[view.verdict.tone])}
          data-part="verdict"
        >
          {view.verdict.text}
        </b>
      </div>
      <div className="grid grid-cols-1 @lg:grid-cols-3">
        {view.gauges.map((gauge) => (
          <Gauge gauge={gauge} key={gauge.key} />
        ))}
      </div>
      {view.holds.length === 0 ? null : (
        <ul aria-label="What holds claims" className="mx-5 mb-1 divide-y border-t">
          {view.holds.map((hold) => (
            <Hold
              diskPath={view.diskPath}
              environmentId={environmentId}
              hold={hold}
              key={hold.key}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
