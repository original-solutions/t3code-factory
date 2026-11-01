import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useEffect, useEffectEvent, useState } from "react";

import { usePreparedConnection } from "~/state/session";

import { STATION_META, STATIONS, type Station } from "./belt";
import { STATION_ICON } from "./BeltRail";
import { firstRunSteps, type FirstRunConfig } from "./firstRun";
import { FirstRunSteps } from "./FirstRunSteps";
import { fetchFactoryConfig } from "./settings/api";

/** The machine config of one environment, read once when its connection is ready. */
function useFirstRunConfig(environmentId: EnvironmentId): FirstRunConfig {
  const prepared = Option.getOrNull(usePreparedConnection(environmentId));
  const [config, setConfig] = useState<FirstRunConfig>({ kind: "loading" });
  const read = useEffectEvent(() => {
    if (prepared === null) return;
    void fetchFactoryConfig(prepared).then((result) =>
      setConfig(
        result.kind === "ok"
          ? { kind: "ok", repos: result.report.repos, watchError: result.report.watch_error }
          : {
              kind: "failed",
              message:
                result.kind === "error"
                  ? result.message
                  : result.kind === "forbidden"
                    ? "this session is not allowed to read it."
                    : "it did not load.",
            },
      ),
    );
  });
  const connected = prepared !== null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the factory config from the server once the connection is ready
  useEffect(() => {
    if (connected) read();
  }, [connected]);
  return config;
}

/** What each post does to a run, for a machine that has never sent one down the belt. */
const JOURNEY = (gate: ReadonlyArray<string>): Readonly<Record<Station, string>> => ({
  claimed: "The next pass takes the labelled issue.",
  building: "An agent builds it in its own worktree, in a thread you can open.",
  gate:
    gate.length > 0
      ? `${gate.join(" · ")} must pass before anything is pushed.`
      : "The repo's gate commands must pass before anything is pushed.",
  pr: "A pull request opens and waits for your review.",
  done: "Merged or closed. A run that stops lands in Stuck or Needs info with its next step.",
});

/**
 * In place of an empty belt on a machine that has never run anything: the steps still to take
 * before the first run, each where it stands, beside the way that run will travel.
 */
export function FirstRunGuide({
  environmentId,
  paused,
  busy,
  onResume,
}: {
  readonly environmentId: EnvironmentId;
  readonly paused: boolean;
  readonly busy: boolean;
  readonly onResume: () => void;
}) {
  const config = useFirstRunConfig(environmentId);
  const steps = firstRunSteps(config, paused);
  const journey = JOURNEY(steps.ready[0]?.factory?.gate ?? []);
  return (
    <section
      aria-label="First run"
      className="@container flex min-w-0 flex-col rounded-lg border bg-card"
      data-factory-first-run=""
    >
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b px-4 py-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-base font-semibold">Nothing built yet</h2>
          <p className="text-sm text-muted-foreground">
            Label a GitHub issue <code>factory:ready</code> and the factory turns it into a pull
            request on its own.
          </p>
        </div>
        {steps.current > 0 ? (
          <span className="text-xs text-muted-foreground tabular-nums">{`Step ${steps.current} of 4`}</span>
        ) : null}
      </header>
      <div className="grid min-w-0 @3xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <FirstRunSteps config={config} place={{ kind: "factory", busy, onResume }} steps={steps} />
        <div className="flex min-w-0 flex-col gap-3 border-t px-4 py-4 @3xl:border-t-0 @3xl:border-l">
          <h3 className="text-3xs font-semibold uppercase tracking-widest text-muted-foreground">
            How a run travels
          </h3>
          <ol className="flex flex-col gap-1.5">
            {STATIONS.map((station) => {
              const Icon = STATION_ICON[station];
              return (
                <li
                  className="flex min-w-0 gap-2.5 rounded-md border border-l-4 border-l-(--factory-station) bg-background/40 px-2.5 py-2"
                  data-station={station}
                  key={station}
                >
                  <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <p className="flex flex-wrap items-baseline gap-x-2 text-sm font-medium">
                      {STATION_META[station].name}
                      <code className="text-3xs font-normal text-muted-foreground">
                        {STATION_META[station].tag}
                      </code>
                    </p>
                    <p className="break-words text-xs text-muted-foreground">{journey[station]}</p>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      </div>
    </section>
  );
}
