import type { EnvironmentId } from "@t3tools/contracts";
import { CircleDotIcon, CloudOffIcon, ExternalLinkIcon } from "lucide-react";
import { lazy, Suspense, useState } from "react";

import { PULL_REQUEST_STATE_PRESENTATION } from "~/components/pullRequest/pullRequestIcons";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

import { FactoryApiError, type FactoryGitHubPart, type FactoryRunGitHub } from "./api";
import { FactoryCard, FactoryCardHeader } from "./FactoryCard";
import type { LinkRef } from "./format";
import { gitHubView, isLongText, splitPath, topFiles } from "./gitHubView";
import { useFactoryRunGitHub } from "./useFactoryData";

type Ok<P> = Extract<NonNullable<P>, { kind: "ok" }>;
type IssueOk = Ok<FactoryRunGitHub["issue"]>;
type PrOk = Ok<FactoryRunGitHub["pr"]>;

const FILES_SHOWN = 6;

// Loaded when GitHub's text arrives, so the run page itself does not wait on the markdown renderer.
const ChatMarkdown = lazy(() => import("~/components/ChatMarkdown"));

const REVIEW: Record<string, { word: string; variant: "success" | "warning" | "secondary" }> = {
  approved: { word: "Approved", variant: "success" },
  changes_requested: { word: "Changes requested", variant: "warning" },
  review_required: { word: "Review required", variant: "secondary" },
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function OpenOnGitHub({ link }: { link: LinkRef | null }) {
  if (link?.href == null) return null;
  return (
    <Button
      render={<a href={link.href} rel="noreferrer" target="_blank" />}
      size="xs"
      variant="ghost-muted"
    >
      GitHub
      <ExternalLinkIcon aria-hidden />
    </Button>
  );
}

/** Text written on GitHub, folded to a few lines when long. Raw HTML is not rendered. */
function Written({
  text,
  cut,
  environmentId,
  empty,
}: {
  text: string;
  cut: boolean;
  environmentId: EnvironmentId;
  empty: string;
}) {
  const [open, setOpen] = useState(false);
  if (text.trim() === "") return <p className="text-sm text-muted-foreground">{empty}</p>;
  const long = isLongText(text);
  const folded = long && !open;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div
        className={cn(
          "min-w-0 text-sm",
          folded &&
            "max-h-64 overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]",
        )}
      >
        <Suspense fallback={<p className="whitespace-pre-wrap break-words">{text}</p>}>
          <ChatMarkdown
            cwd={undefined}
            environmentId={environmentId}
            headingLevelOffset={2}
            parseRawHtml={false}
            text={text}
          />
        </Suspense>
      </div>
      {long ? (
        <Button
          aria-expanded={open}
          className="self-start"
          onClick={() => setOpen(!open)}
          size="xs"
          variant="ghost-muted"
        >
          {open ? "Show less" : "Show all"}
        </Button>
      ) : null}
      {cut && open ? (
        <p className="text-xs text-muted-foreground">Cut here; the rest is on GitHub.</p>
      ) : null}
    </div>
  );
}

function IssueCard({
  issue,
  link,
  environmentId,
}: {
  issue: IssueOk;
  link: LinkRef | null;
  environmentId: EnvironmentId;
}) {
  return (
    <FactoryCard aria-label="The issue">
      <FactoryCardHeader
        eyebrow={
          <>
            The ask · issue <span className="font-mono">#{issue.number}</span>
            {issue.author ? ` by ${issue.author}` : null}
          </>
        }
        title={issue.title}
      />
      <div className="flex flex-wrap items-center gap-1 text-xs">
        <Badge variant="outline">
          <CircleDotIcon
            aria-hidden
            className={issue.closed ? "text-muted-foreground" : "text-success-foreground"}
          />
          {issue.closed ? "Closed" : "Open"}
        </Badge>
        {issue.labels.map((label) => (
          <Badge key={label} variant="secondary">
            {label}
          </Badge>
        ))}
        <span className="ml-auto">
          <OpenOnGitHub link={link} />
        </span>
      </div>
      <Written
        cut={issue.body_cut}
        empty="The issue has no description."
        environmentId={environmentId}
        text={issue.body}
      />
    </FactoryCard>
  );
}

function ChurnBar({
  additions,
  deletions,
  max,
}: {
  additions: number;
  deletions: number;
  max: number;
}) {
  const width = (n: number) => `${max > 0 ? (n / max) * 100 : 0}%`;
  return (
    <span aria-hidden className="flex h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-muted">
      <span className="h-full bg-success" style={{ width: width(additions) }} />
      <span className="h-full bg-destructive" style={{ width: width(deletions) }} />
    </span>
  );
}

function PullRequestCard({
  pr,
  link,
  environmentId,
}: {
  pr: PrOk;
  link: LinkRef | null;
  environmentId: EnvironmentId;
}) {
  const state = PULL_REQUEST_STATE_PRESENTATION[pr.state];
  const review = pr.review_decision ? REVIEW[pr.review_decision] : undefined;
  const files = topFiles(pr.files, FILES_SHOWN);
  const most = Math.max(1, ...files.map((file) => file.additions + file.deletions));
  const unlisted = pr.changed_files - files.length;
  return (
    <FactoryCard aria-label="The pull request">
      <FactoryCardHeader
        eyebrow={
          <>
            What it made · pull request <span className="font-mono">#{pr.number}</span>
          </>
        }
        title={pr.title}
      />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <Badge variant="outline">
          <state.Icon aria-hidden className={state.toneClassName} />
          {state.label}
        </Badge>
        {review ? <Badge variant={review.variant}>{review.word}</Badge> : null}
        <span className="font-mono tabular-nums">
          <span className="text-success-foreground">+{pr.additions}</span>{" "}
          <span className="text-destructive-foreground">−{pr.deletions}</span>
        </span>
        <span className="text-muted-foreground">across {plural(pr.changed_files, "file")}</span>
        <span className="ml-auto">
          <OpenOnGitHub link={link} />
        </span>
      </div>
      {files.length > 0 ? (
        <ul aria-label="Files that changed most" className="flex flex-col gap-1">
          {files.map((file) => {
            const { dir, name } = splitPath(file.path);
            return (
              <li className="flex min-w-0 items-center gap-2 text-xs" key={file.path}>
                <ChurnBar additions={file.additions} deletions={file.deletions} max={most} />
                <span className="flex min-w-0 flex-1 font-mono">
                  {dir ? (
                    <span className="min-w-[3ch] shrink-[999] truncate text-muted-foreground">
                      {dir}
                    </span>
                  ) : null}
                  <span className="min-w-0 truncate">{name}</span>
                </span>
                <span className="shrink-0 font-mono tabular-nums text-muted-foreground">
                  +{file.additions} −{file.deletions}
                </span>
              </li>
            );
          })}
          {unlisted > 0 ? (
            <li className="text-xs text-muted-foreground">and {plural(unlisted, "more file")}</li>
          ) : null}
        </ul>
      ) : null}
      <Written
        cut={pr.body_cut}
        empty="The pull request has no description."
        environmentId={environmentId}
        text={pr.body}
      />
    </FactoryCard>
  );
}

/** A part GitHub did not give, said in one line inside the grid beside the part it did. */
function PartNote({
  part,
  what,
  link,
}: {
  part: Exclude<FactoryGitHubPart<never>, { kind: "ok" }>;
  what: string;
  link: LinkRef | null;
}) {
  const said =
    part.kind === "gone"
      ? `GitHub no longer has this ${what}.`
      : `The ${what} could not be read: ${part.message}.`;
  return (
    <FactoryCard aria-label={`The ${what}`} className="justify-center">
      <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        {said}
        <OpenOnGitHub link={link} />
      </p>
    </FactoryCard>
  );
}

/**
 * The run's issue and pull request as GitHub has them, so the ask and what the factory made read
 * on the run page. Read once when the page opens; when GitHub can't be read, one line says why.
 */
export function RunGitHub({
  environmentId,
  runId,
  label,
  issue,
  pr,
}: {
  environmentId: EnvironmentId;
  runId: string;
  /** The environment's name, for saying where GitHub could not be read from. */
  label: string;
  issue: LinkRef | null;
  pr: LinkRef | null;
}) {
  const read = useFactoryRunGitHub(environmentId, runId);
  // An older server has no such route; it says nothing rather than an error.
  if (read.error instanceof FactoryApiError && read.error.status === 404) return null;
  if (read.data === null) {
    if (read.status === "loading") {
      return (
        <p aria-live="polite" className="px-1 text-xs text-muted-foreground">
          Reading {issue?.text ?? "the issue"}
          {pr ? ` and ${pr.text}` : null} from GitHub…
        </p>
      );
    }
    return null;
  }
  const view = gitHubView(read.data);
  if (view.kind === "none") return null;
  if (view.kind === "unread") {
    return (
      <FactoryCard aria-label="GitHub" className="gap-1.5">
        <p className="flex items-center gap-2 text-sm font-medium">
          <CloudOffIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          GitHub can't be read from {label}
        </p>
        <p className="text-sm text-muted-foreground">
          {view.reason.kind === "signed-out"
            ? "The factory's gh isn't signed in here, so the issue's text and the pull request's changes stay on GitHub."
            : `${view.reason.message}.`}
        </p>
        <div className="flex flex-wrap items-center gap-1">
          {[
            issue && { ...issue, text: `Issue ${issue.text}` },
            pr && { ...pr, text: `PR ${pr.text}` },
          ]
            .filter((ref) => ref?.href != null)
            .map((ref) => (
              <Button
                key={ref!.text}
                render={<a href={ref!.href!} rel="noreferrer" target="_blank" />}
                size="xs"
                variant="outline"
              >
                {ref!.text}
                <ExternalLinkIcon aria-hidden />
              </Button>
            ))}
          {view.reason.kind === "failed" ? (
            <Button onClick={read.refresh} size="xs" variant="ghost-muted">
              Try again
            </Button>
          ) : null}
        </div>
      </FactoryCard>
    );
  }
  const issueCard =
    view.issue === null ? null : view.issue.kind === "ok" ? (
      <IssueCard environmentId={environmentId} issue={view.issue} link={issue} />
    ) : (
      <PartNote link={issue} part={view.issue} what="issue" />
    );
  const prCard =
    view.pr === null ? null : view.pr.kind === "ok" ? (
      <PullRequestCard environmentId={environmentId} link={pr} pr={view.pr} />
    ) : (
      <PartNote link={pr} part={view.pr} what="pull request" />
    );
  return (
    <div className={cn("grid items-start gap-3", issueCard && prCard && "lg:grid-cols-2")}>
      {issueCard}
      {prCard}
    </div>
  );
}
