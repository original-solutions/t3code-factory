import type { EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { FactoryIcon } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";

import { Badge } from "~/components/ui/badge";
import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "~/components/ui/preview-card";

import "./belt.css";
import { factoryApi, type FactoryStatus } from "./api";
import { issueOf } from "./belt";
import { issueRef, labelForState, parseRunId, prRef } from "./format";
import { Ref } from "./Ref";
import { findThreadRun, issueOfThreadTitle, type ThreadRun, threadRunOfStatus } from "./threadRun";
import { useFactoryResource } from "./useFactoryData";

/**
 * Finished runs found per thread, kept for the session: a finished run does not change. A key is
 * in `found` from the moment its read starts (undefined until it answers), so it is read once; a
 * failed read drops the key after {@link RETRY_MS}, and a header still showing asks again.
 */
const found = new Map<string, ThreadRun | null | undefined>();
const listeners = new Set<() => void>();
const RETRY_MS = 30_000;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const lookUp = (environmentId: EnvironmentId, threadId: string, prefix: string, key: string) => {
  if (found.has(key)) return;
  found.set(key, undefined);
  findThreadRun((id) => factoryApi.run(environmentId, id), prefix, threadId).then(
    (run) => {
      found.set(key, run);
      listeners.forEach((listener) => listener());
    },
    () =>
      setTimeout(() => {
        found.delete(key);
        listeners.forEach((listener) => listener());
      }, RETRY_MS),
  );
};

/**
 * The chat header's way back to the factory: for a thread a factory run launched, a mark with the
 * run's issue and state that opens the run page, and on hover a card of its issue, pull request
 * and attempt. An unfinished run comes from the status the sidebar already polls; a finished one is
 * read once, only for a thread whose title is the factory's launch title.
 */
export function FactoryThreadLink({
  environmentId,
  threadId,
  title,
}: {
  environmentId: EnvironmentId;
  threadId: string;
  title: string;
}) {
  const status = useFactoryResource<FactoryStatus>(environmentId, "status");
  const live = threadRunOfStatus(status.data, threadId);
  const prefix = issueOfThreadTitle(title)?.prefix ?? null;
  const key = `${environmentId} ${threadId}`;
  const finished = status.data !== null && live === null ? prefix : null;
  const looked = useSyncExternalStore(subscribe, () => found.get(key));
  const asked = useSyncExternalStore(subscribe, () => found.has(key));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the factory ledger over HTTP, once per thread, for a run that is not in flight
  useEffect(() => {
    if (finished !== null && !asked) lookUp(environmentId, threadId, finished, key);
  }, [asked, environmentId, finished, key, threadId]);
  const run = live ?? (finished !== null ? (looked ?? null) : null);
  if (run === null) return null;
  return <ThreadRunMark environmentId={environmentId} run={run} />;
}

function ThreadRunMark({ environmentId, run }: { environmentId: EnvironmentId; run: ThreadRun }) {
  const parsed = parseRunId(run.id);
  const repo = parsed === null ? null : `${parsed.owner}/${parsed.repo}`;
  const issue = parsed === null || repo === null ? null : issueRef(repo, parsed.issue);
  const pr = prRef(run.prUrl);
  const state = labelForState(run.state);
  const link = (
    <Link params={{ environmentId, runId: run.id }} to="/factory/$environmentId/$runId" />
  );
  // On a phone the header's right padding is narrower than its three toggles; keep clear of them.
  return (
    <span className="flex shrink-0 max-sm:mr-4">
      <PreviewCard>
        <PreviewCardTrigger
          closeDelay={150}
          delay={250}
          render={
            <Badge
              aria-label={`Factory run ${issueOf(run.id)}: ${state}. Open the run`}
              data-station={run.place ?? undefined}
              render={link}
              size="control"
              variant="outline"
            />
          }
        >
          <FactoryIcon aria-hidden />
          <span className="hidden sm:inline">Factory</span>
          <span className="font-mono">{issueOf(run.id)}</span>
          <span
            aria-hidden
            className={
              run.place === null
                ? "size-1.5 rounded-full bg-muted-foreground"
                : "size-1.5 rounded-full bg-(--factory-station)"
            }
          />
          <span className="hidden text-muted-foreground sm:inline">{state}</span>
        </PreviewCardTrigger>
        <PreviewCardPopup align="end" className="w-80 max-w-[calc(100vw-2rem)]" side="bottom">
          <div className="flex flex-col gap-2 p-3 text-sm" data-station={run.place ?? undefined}>
            <div className="flex gap-2.5">
              <span
                aria-hidden
                className={
                  run.place === null
                    ? "w-1 shrink-0 rounded-full bg-muted-foreground"
                    : "w-1 shrink-0 rounded-full bg-(--factory-station)"
                }
              />
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-xs text-muted-foreground">
                  A factory run started this thread
                </span>
                <span className="font-medium break-words">{run.title ?? run.id}</span>
                <span className="truncate font-mono text-3xs text-muted-foreground">
                  {repo ?? run.id}
                  {parsed === null ? "" : ` · attempt ${parsed.attempt}`}
                </span>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              <Link
                className="font-medium text-foreground hover:underline"
                params={{ environmentId, runId: run.id }}
                to="/factory/$environmentId/$runId"
              >
                Open the run
              </Link>
              {issue !== null ? (
                <span className="flex gap-1 text-muted-foreground">
                  Issue <Ref {...issue} />
                </span>
              ) : null}
              {pr !== null ? (
                <span className="flex gap-1 text-muted-foreground">
                  PR <Ref {...pr} />
                </span>
              ) : null}
            </div>
          </div>
        </PreviewCardPopup>
      </PreviewCard>
    </span>
  );
}
