import type { EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { useEffect, useEffectEvent, useState } from "react";

import { Button } from "~/components/ui/button";
import { usePreparedConnection } from "~/state/session";

import { STATION_META, STATIONS, type Station } from "./belt";
import { STATION_ICON } from "./BeltRail";
import { firstRunSteps, type FirstRunConfig } from "./firstRun";
import { fetchFactoryConfig, type RepoBlock } from "./settings/api";
import { Step } from "./settings/SetupStep";
import { TouchLink } from "./TouchLink";

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

const names = (repos: ReadonlyArray<RepoBlock>) => {
  const shown = repos.slice(0, 3).map(({ repo, title }) => repo || title);
  return repos.length > 3 ? `${shown.join(", ")} and ${repos.length - 3} more` : shown.join(", ");
};

const SETTINGS = (
  <Button render={<Link to="/settings/factory" />} size="sm" variant="outline">
    Open Settings → Factory
  </Button>
);

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
  const { states, current, ready, broken } = firstRunSteps(config, paused);
  const [watch, read, claims, label] = states as [
    (typeof states)[number],
    (typeof states)[number],
    (typeof states)[number],
    (typeof states)[number],
  ];
  const repos = config.kind === "ok" ? config.repos : [];
  const first = ready[0]?.factory ?? null;
  const journey = JOURNEY(first?.gate ?? []);
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
        {current > 0 ? (
          <span className="text-xs text-muted-foreground tabular-nums">{`Step ${current} of 4`}</span>
        ) : null}
      </header>
      <div className="grid min-w-0 @3xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <ol aria-label="Before the first run" className="flex min-w-0 flex-col pt-4">
          <Step n={1} state={watch} title="Watch a repo">
            {config.kind === "loading" ? (
              <p>Reading this machine's config.</p>
            ) : config.kind === "failed" ? (
              <>
                <p className="break-words">
                  The factory config could not be read: {config.message}
                </p>
                <div>{SETTINGS}</div>
              </>
            ) : config.watchError !== null ? (
              <>
                <p className="break-words">T3 projects could not be listed: {config.watchError}</p>
                <div>{SETTINGS}</div>
              </>
            ) : watch === "done" ? (
              <p className="break-words">{`Watching ${names(repos)}.`}</p>
            ) : (
              <>
                <p>
                  Add a clone of a GitHub repo as a T3 project, with a factory block in its{" "}
                  <code>.dw/config.yml</code>. Settings has the block to copy.
                </p>
                <div>{SETTINGS}</div>
              </>
            )}
          </Step>
          <Step n={2} state={read} title="Give it a config it can build from">
            {read === "done" ? (
              <p className="break-words">{`Ready to build: ${names(ready)}.`}</p>
            ) : read === "blocked" && broken !== null ? (
              <>
                <p>
                  {repos.length === 1
                    ? "The watched repo has an error, so nothing can be built yet."
                    : `All ${repos.length} watched repos have an error, so nothing can be built yet.`}
                </p>
                <p className="break-words rounded-md border border-destructive/24 bg-destructive/4 px-2.5 py-1.5 text-destructive-foreground">
                  <span className="line-clamp-3">
                    <span className="font-medium">{broken.title}:</span>{" "}
                    {broken.errors?.[0]?.message ?? ""}
                  </span>
                </p>
                <div>{SETTINGS}</div>
              </>
            ) : read === "current" ? (
              <p>Not read yet: the factory reads each repo's config at its next pass.</p>
            ) : (
              <p>Each pass reads the watched repos' configs.</p>
            )}
          </Step>
          <Step n={3} state={claims} title="Turn claims on">
            {claims === "done" ? (
              <p>Claims are on: each pass looks for labelled issues.</p>
            ) : (
              <>
                <p>Claims are paused, so no issue is picked up.</p>
                <div>
                  <Button disabled={busy} onClick={onResume} size="sm" variant="outline">
                    Turn claims on
                  </Button>
                </div>
              </>
            )}
          </Step>
          <Step last n={4} state={label} title="Label an issue factory:ready">
            <p>
              {first !== null && first.instructors.length > 0
                ? `An instructor (${first.instructors.join(", ")}) adds the label; `
                : "An instructor adds the label; "}
              the next pass claims the issue and it appears on this belt.
            </p>
            {ready.length > 0 ? (
              <ul className="-my-2.5 flex flex-wrap gap-x-4">
                {ready.slice(0, 3).map(({ repo }) => (
                  <li key={repo}>
                    <TouchLink
                      render={
                        <a
                          href={`https://github.com/${repo}/issues`}
                          rel="noreferrer"
                          target="_blank"
                        />
                      }
                    >
                      {`${repo} issues`}
                    </TouchLink>
                  </li>
                ))}
              </ul>
            ) : null}
          </Step>
        </ol>
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
