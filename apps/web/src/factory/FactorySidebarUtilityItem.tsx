import { Link, useNavigate } from "@tanstack/react-router";

import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "~/components/ui/preview-card";
import { SidebarMenuButton, SidebarMenuItem } from "~/components/ui/sidebar";

import "./belt.css";
import { STATION_META } from "./belt";
import { FactoryNavIcon } from "./FactoryNavIcon";
import { formatAge } from "./format";
import { factoryPulse, type FactoryPulse, type PulseEnvironment, type PulseRun } from "./pulse";
import {
  useFactoryAttentionCount,
  useFactoryEnvironments,
  useFactorySupported,
} from "./useFactoryData";
import { readAheadHandlers } from "./readAhead";

/** The most runs the card lists; the rest are a count that opens the belt. */
const SHOWN_RUNS = 6;

/**
 * The sidebar footer's Factory button, hidden when no environment serves the factory. Hover or
 * focus opens a card of the runs in flight, from the statuses the badge already polls: no new
 * reads. `onNavigate` runs before navigating, for closing the mobile sidebar.
 */
export function FactorySidebarUtilityItem({ onNavigate }: { onNavigate: () => void }) {
  const supported = useFactorySupported();
  const environments = useFactoryEnvironments();
  const attention = useFactoryAttentionCount();
  const navigate = useNavigate();
  if (!supported) return null;
  const pulse = factoryPulse(
    environments.map(({ environmentId, label, status }) => ({
      environmentId,
      label,
      status: status.data,
    })),
    SHOWN_RUNS,
  );
  const readAt = Math.max(0, ...environments.map(({ status }) => status.readAt));
  return (
    <SidebarMenuItem className="shrink-0">
      <PreviewCard>
        <PreviewCardTrigger
          closeDelay={150}
          delay={250}
          render={
            <SidebarMenuButton
              aria-label="Factory"
              onClick={() => {
                onNavigate();
                void navigate({ to: "/factory" });
              }}
              size="icon"
            >
              <FactoryNavIcon attention={attention} tone={pulse.tone} />
            </SidebarMenuButton>
          }
        />
        <PreviewCardPopup className="w-80 max-w-[calc(100vw-2rem)]">
          <PulseCard onNavigate={onNavigate} pulse={pulse} readAt={readAt} />
        </PreviewCardPopup>
      </PreviewCard>
    </SidebarMenuItem>
  );
}

/** `readAt` is when the newest status landed: a run's age is as of that read. */
function PulseCard({
  pulse,
  readAt,
  onNavigate,
}: {
  pulse: FactoryPulse;
  readAt: number;
  onNavigate: () => void;
}) {
  const many = pulse.environments.length > 1;
  const hidden = pulse.hidden;
  return (
    <div
      aria-label="Factory at a glance"
      className="flex flex-col overflow-hidden rounded-lg text-sm"
      role="group"
      {...readAheadHandlers}
    >
      <Link
        className="flex flex-col gap-0.5 border-b px-3 py-2.5 hover:bg-accent/40"
        onClick={onNavigate}
        to="/factory"
      >
        <span className="font-medium">Factory</span>
        <span className="text-xs text-muted-foreground">{pulse.summary}</span>
      </Link>
      {pulse.environments.map((env) =>
        many || env.hold !== null || env.runs.length > 0 ? (
          <section
            aria-label={env.label}
            className="flex flex-col border-b py-1 last:border-b-0"
            key={env.environmentId}
          >
            {many || env.hold !== null ? <EnvironmentLine env={env} many={many} /> : null}
            {env.runs.map((run) => (
              <RunLine key={run.key} nowMs={readAt} onNavigate={onNavigate} run={run} />
            ))}
          </section>
        ) : null,
      )}
      {hidden > 0 || pulse.attention > 0 ? (
        <div className="flex items-center justify-between gap-2 px-3 py-2 text-xs">
          {hidden > 0 ? (
            <Link
              className="text-muted-foreground hover:text-foreground"
              onClick={onNavigate}
              to="/factory"
            >
              +{hidden} more on the belt
            </Link>
          ) : (
            <span />
          )}
          {pulse.attention > 0 ? (
            <Link
              className="font-medium text-destructive-foreground hover:underline"
              onClick={onNavigate}
              to="/factory"
            >
              {pulse.attention} {pulse.attention === 1 ? "needs" : "need"} you
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function EnvironmentLine({ env, many }: { env: PulseEnvironment; many: boolean }) {
  return (
    <div className="flex items-center gap-2 px-3 py-1 text-xs">
      {many ? <span className="min-w-0 truncate font-medium">{env.label}</span> : null}
      {env.hold !== null ? (
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-warning-foreground first:ml-0">
          <span aria-hidden className="size-1.5 rounded-full bg-(--factory-info)" />
          {env.hold[0]!.toUpperCase() + env.hold.slice(1)}
        </span>
      ) : null}
    </div>
  );
}

function RunLine({
  run,
  nowMs,
  onNavigate,
}: {
  run: PulseRun;
  nowMs: number;
  onNavigate: () => void;
}) {
  const post = STATION_META[run.station].name;
  const elapsed = run.forMs === null ? null : formatAge(nowMs - run.forMs, nowMs);
  return (
    <Link
      className="flex items-center gap-2.5 px-3 py-1.5 hover:bg-accent/40"
      data-station={run.station}
      onClick={onNavigate}
      params={{ environmentId: run.environmentId, runId: run.id }}
      to="/factory/$environmentId/$runId"
    >
      <span aria-hidden className="h-7 w-1 shrink-0 rounded-full bg-(--factory-station)" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{run.title ?? run.repo ?? run.id}</span>
        <span className="truncate font-mono text-3xs text-muted-foreground">
          {run.issue}
          {run.title !== null && run.repo !== null ? ` · ${run.repo}` : ""}
        </span>
      </span>
      <span className="flex shrink-0 flex-col items-end text-xs">
        <span>{post}</span>
        {elapsed !== null ? (
          <span className="font-mono text-3xs text-muted-foreground">{elapsed}</span>
        ) : null}
      </span>
    </Link>
  );
}
