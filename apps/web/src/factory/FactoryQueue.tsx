import type { EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ExternalLinkIcon, PauseIcon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";

import { FactoryApiError, type FactoryRunRow } from "./api";
import "./belt.css";
import { formatClock } from "./belt";
import { FactoryCard, FactoryCardHeader } from "./FactoryCard";
import { FactoryLoading, FactoryReadFailure } from "./FactoryNotices";
import { Snippet } from "./FirstRunSteps";
import { formatAge, issueRef, shownState } from "./format";
import {
  ISSUE_TEMPLATE,
  newIssueUrl,
  queueView,
  type QueueGroup,
  type QueueSource,
  type QueueView,
} from "./queueView";
import { Ref } from "./Ref";
import { TouchLink } from "./TouchLink";
import { useFactoryQueues } from "./useFactoryData";

/** The belt colour each wait wears: the station it waits to enter, or the one that parks it. */
const STATION: Readonly<Record<string, string>> = {
  postponed: "info",
  blocked: "gate",
  limit: "claimed",
  other: "claimed",
};

/** Rows a wait group shows before Show all: a stack of dependent issues runs to dozens. */
const FOLD = 10;

const when = (ms: number, nowMs: number) =>
  nowMs - ms < 86_400_000
    ? formatClock(ms)
    : new Date(ms).toLocaleString(undefined, {
        weekday: "short",
        day: "numeric",
        month: "short",
        hourCycle: "h23",
        hour: "2-digit",
        minute: "2-digit",
      });

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** A big number in its station's colour, as the catch-up card counts. */
function Count({ station, value, word }: { station: string; value: number; word: string }) {
  return (
    <span className="inline-flex items-baseline gap-1.5" data-station={station}>
      <span aria-hidden className="inline-block size-2 rounded-full bg-(--factory-station)" />
      <b className="font-mono text-lg font-semibold leading-none">{value}</b>
      <span className="text-sm text-muted-foreground">{word}</span>
    </span>
  );
}

function WaitGroup({
  group,
  nowMs,
  showEnvironment,
}: {
  group: QueueGroup;
  nowMs: number;
  showEnvironment: boolean;
}) {
  const [all, setAll] = useState(false);
  return (
    <FactoryCard aria-label={group.title} data-station={STATION[group.reason]} rail>
      <FactoryCardHeader
        title={
          <>
            {group.title}
            <span className="font-mono text-sm text-muted-foreground">{group.issues.length}</span>
          </>
        }
      />
      <p className="-mt-1 text-sm text-muted-foreground">{group.help}</p>
      <ul className="flex flex-col divide-y border-t">
        {(all ? group.issues : group.issues.slice(0, FOLD)).map((wait) => {
          const ref = issueRef(wait.repo, wait.issue);
          const last = wait.lastRun;
          return (
            <li
              className="flex min-w-0 flex-col gap-0.5 py-2 text-sm last:pb-0"
              data-queue-issue={`${wait.repo}#${wait.issue}`}
              key={`${wait.environmentId} ${wait.repo}#${wait.issue}`}
            >
              <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                <span className="font-mono font-semibold">
                  <Ref {...ref} />
                </span>
                <span className="min-w-0 break-words">
                  {wait.title ?? <span className="break-all font-mono text-xs">{wait.repo}</span>}
                </span>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
                  held {formatAge(wait.sinceMs, wait.checkedMs)}
                </span>
              </div>
              <span className="flex min-w-0 flex-wrap gap-x-1.5 text-xs text-muted-foreground">
                {wait.title === null ? null : (
                  <span className="break-all font-mono">{wait.repo}</span>
                )}
                {wait.title === null ? null : <span aria-hidden>·</span>}
                <span>
                  {wait.passes} {wait.passes === 1 ? "pass" : "passes"} in a row since{" "}
                  {when(wait.sinceMs, nowMs)}
                </span>
                {showEnvironment ? <span>· {wait.label}</span> : null}
                {last === null ? null : <LastRun environmentId={wait.environmentId} run={last} />}
              </span>
            </li>
          );
        })}
      </ul>
      {group.issues.length > FOLD ? (
        <div>
          <Button onClick={() => setAll((open) => !open)} size="sm" variant="ghost">
            {all ? "Show fewer" : `Show all ${group.issues.length}`}
          </Button>
        </div>
      ) : null}
    </FactoryCard>
  );
}

function LastRun({ environmentId, run }: { environmentId: EnvironmentId; run: FactoryRunRow }) {
  return (
    <span className="-my-2.5">
      ·{" "}
      <TouchLink
        render={
          <Link params={{ environmentId, runId: run.id }} to="/factory/$environmentId/$runId" />
        }
      >
        ran before: {shownState(run.state, run.pr_end) ?? run.status}
      </TouchLink>
    </span>
  );
}

/** Why the queue is not moving at all, per machine; the list under it is as of its last read. */
function Holds({
  view,
  nowMs,
  showEnvironment,
}: {
  view: QueueView;
  nowMs: number;
  showEnvironment: boolean;
}) {
  return view.holds.map((hold) => (
    <Alert key={hold.environmentId} variant="warning">
      <PauseIcon aria-hidden />
      <AlertTitle>
        {showEnvironment
          ? `${hold.label} claims nothing right now`
          : "Nothing is claimed right now"}
      </AlertTitle>
      <AlertDescription>
        <p>{sentence(hold.words.join("; "))}.</p>
        {hold.checkedMs === null ? null : (
          <p>
            The last pass that read the ready issues ended {when(hold.checkedMs, nowMs)} (
            {formatAge(hold.checkedMs, nowMs)} ago), so the list below is from then.
          </p>
        )}
      </AlertDescription>
    </Alert>
  ));
}

/** How to give the factory work: the four headings, and GitHub's new-issue page for a repo. */
function FileWork({ repos }: { repos: ReadonlyArray<string> }) {
  const [picked, setPicked] = useState<string | null>(null);
  const repo = picked ?? repos[0] ?? null;
  return (
    <FactoryCard aria-label="File work" data-station="claimed">
      <FactoryCardHeader eyebrow="File work" title="Give the factory an issue" />
      <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-sm">
        <li>
          Write it on GitHub with these four headings. The session builds exactly what it says, so
          say what done looks like, one change per issue.
        </li>
        <li>Leave it unassigned: an assigned ready issue is skipped.</li>
        <li>
          An instructor from the repo's <code>.dw/config.yml</code> labels it{" "}
          <code>factory:ready</code>. A label or a later edit by anyone else sends it back to{" "}
          <code>factory:proposed</code>.
        </li>
        <li>The next pass claims it, or this list says why it waits.</li>
      </ol>
      <Snippet label="Copy the issue template" text={ISSUE_TEMPLATE} />
      {repo === null ? null : (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {repos.length > 1 ? (
            <div className="min-w-0 max-w-full">
              <Select
                items={repos.map((value) => ({ value, label: value }))}
                onValueChange={setPicked}
                value={repo}
              >
                <SelectTrigger aria-label="Repo for the new issue" size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false} matchTriggerWidth={false}>
                  {repos.map((value) => (
                    <SelectItem key={value} value={value}>
                      {value}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          ) : null}
          <Button
            render={<a href={newIssueUrl(repo)} rel="noreferrer" target="_blank" />}
            size="sm"
            variant="outline"
          >
            New issue in {repos.length > 1 ? "this repo" : repo}
            <ExternalLinkIcon aria-hidden />
          </Button>
        </div>
      )}
    </FactoryCard>
  );
}

/**
 * The Queue view: the `factory:ready` issues the passes held back and why, what stops claims
 * machine-wide, the repos a pass could not read, the issues sent back to proposed, and how to file
 * one. Read from each machine's log when the view opens and on Read again; never polled.
 */
export function FactoryQueue({
  environments,
  recent,
  repo,
  repos,
  showEnvironment,
}: {
  environments: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly label: string }>;
  recent: ReadonlyMap<EnvironmentId, ReadonlyArray<FactoryRunRow>>;
  repo: string | null;
  repos: ReadonlyArray<string>;
  showEnvironment: boolean;
}) {
  const reads = useFactoryQueues(environments.map(({ environmentId }) => environmentId));
  const sources: Array<QueueSource> = [];
  environments.forEach(({ environmentId, label }, i) => {
    const queue = reads[i]?.data;
    if (queue) sources.push({ environmentId, label, queue, runs: recent.get(environmentId) ?? [] });
  });
  // Ages count to the last read, as the page's other ages do: the view does not tick between reads.
  const nowMs = Math.max(0, ...reads.map(({ readAt }) => readAt));
  const failures = environments.flatMap(({ label }, i) => {
    const read = reads[i];
    // An older server has no queue route: it says nothing here rather than an error.
    return read?.status === "error" &&
      !(read.error instanceof FactoryApiError && read.error.status === 404)
      ? [{ label, read }]
      : [];
  });
  if (sources.length === 0 && reads.some(({ status }) => status === "loading")) {
    return <FactoryLoading label="Reading the ready queue" />;
  }
  const older = reads.filter(
    ({ error }) => error instanceof FactoryApiError && error.status === 404,
  ).length;
  const view = queueView(sources, repo);
  const fileRepos = repo === null ? repos : [repo];
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {failures.map(({ label, read }) => (
        <FactoryReadFailure
          dataAt={read.dataAt}
          error={read.error}
          key={label}
          label={label}
          onRetry={read.refresh}
          verb={read.dataAt > 0 ? "refresh" : "read"}
        />
      ))}
      {older > 0 ? (
        <p className="text-sm text-muted-foreground">
          {older === reads.length ? "This factory's server" : `${older} of these servers`} predates
          the ready queue; it shows once the server is updated.
        </p>
      ) : null}
      <FactoryCard aria-label="Ready queue" data-station="claimed" rail>
        <FactoryCardHeader
          aside={
            <Button
              onClick={() => reads.forEach((read) => read.refresh())}
              size="sm"
              variant="ghost"
            >
              <RefreshCwIcon aria-hidden />
              Read again
            </Button>
          }
          eyebrow="Ready queue"
          title={
            view.waiting === 0
              ? "No ready issue is waiting"
              : `${view.waiting} ready ${view.waiting === 1 ? "issue waits" : "issues wait"} to be claimed`
          }
        />
        {view.waiting + view.turnedAway.length === 0 ? null : (
          <div className="flex flex-wrap items-baseline gap-x-5 gap-y-2" aria-label="By reason">
            {view.groups.map((group) => (
              <Count
                key={group.reason}
                station={STATION[group.reason]!}
                value={group.issues.length}
                word={group.title.toLowerCase()}
              />
            ))}
            {view.turnedAway.length === 0 ? null : (
              <Count station="stuck" value={view.turnedAway.length} word="sent back" />
            )}
          </div>
        )}
        <p className="text-sm text-muted-foreground">
          {view.waiting === 0
            ? "Every factory:ready issue the last pass read was claimed, or there was none."
            : null}
          {view.checkedMs === null
            ? " No pass has read the ready issues in the last two weeks."
            : `${view.waiting === 0 ? " " : ""}Read from the factory's log; the last pass that read the ready issues ended ${when(view.checkedMs, nowMs)}.`}
        </p>
        {view.skipped.length === 0 ? null : (
          <div className="flex flex-col gap-1 border-t pt-2 text-sm">
            <p className="font-medium">
              Not read on the last pass: their ready issues are not listed here or claimed
            </p>
            <ul className="flex flex-col gap-0.5">
              {view.skipped.map((skip) => (
                <li className="min-w-0 break-words" key={`${skip.environmentId} ${skip.repo}`}>
                  <span className="break-all font-mono text-xs">{skip.repo}</span>
                  <span className="text-muted-foreground">
                    {" "}
                    · {skip.words}
                    {showEnvironment ? ` · ${skip.label}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </FactoryCard>
      <Holds nowMs={nowMs} showEnvironment={showEnvironment} view={view} />
      {view.groups.map((group) => (
        <WaitGroup
          group={group}
          key={group.reason}
          nowMs={nowMs}
          showEnvironment={showEnvironment}
        />
      ))}
      {view.turnedAway.length === 0 ? null : (
        <FactoryCard aria-label="Sent back to proposed" data-station="stuck" rail>
          <FactoryCardHeader
            title={
              <>
                Sent back to factory:proposed
                <span className="font-mono text-sm text-muted-foreground">
                  {view.turnedAway.length}
                </span>
              </>
            }
          />
          <p className="-mt-1 text-sm text-muted-foreground">
            Labelled ready, or edited after the label, by someone who is not an instructor. The
            factory commented why. An instructor reads the text and labels it factory:ready again.
          </p>
          <ul className="flex flex-col divide-y border-t">
            {view.turnedAway.map((away) => (
              <li
                className="flex min-w-0 flex-wrap items-baseline gap-x-2 py-2 text-sm last:pb-0"
                key={`${away.environmentId} ${away.repo}#${away.issue}`}
              >
                <span className="font-mono font-semibold">
                  <Ref {...issueRef(away.repo, away.issue)} />
                </span>
                <span className="min-w-0 break-all font-mono text-xs">{away.repo}</span>
                <span className="ml-auto text-xs text-muted-foreground">
                  {formatAge(away.atMs, nowMs)} ago{showEnvironment ? ` · ${away.label}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </FactoryCard>
      )}
      <FileWork key={fileRepos.join(" ")} repos={fileRepos} />
    </div>
  );
}
