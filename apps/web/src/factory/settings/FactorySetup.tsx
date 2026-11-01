import { Link } from "@tanstack/react-router";
import { CheckIcon, CopyIcon, XIcon } from "lucide-react";
import type { ReactNode } from "react";

import { SettingsSection } from "../../components/settings/settingsLayout";
import { Button } from "../../components/ui/button";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { cn } from "../../lib/utils";
import { TouchLink } from "../TouchLink";
import type { RepoBlock } from "./api";
import { setupProgress, type SetupStepState } from "./repoRoster";

const FACTORY_BLOCK = `factory:
  instructors: [your-github-login]
  base: main
  provision: [npm ci]
  gate: [npm test]
  autonomy: pr
`;

function Snippet({ text }: { readonly text: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({ timeout: 1500 });
  return (
    <div className="relative min-w-0 rounded-lg border border-border bg-muted/50">
      <pre className="overflow-x-auto px-3 py-2.5 pr-10 font-mono text-xs leading-relaxed">
        {text}
      </pre>
      <div className="absolute top-1.5 right-1.5">
        <Button
          aria-label="Copy the factory block"
          onClick={() => copyToClipboard(text, undefined)}
          size="icon-xs"
          variant="ghost"
        >
          {isCopied ? <CheckIcon /> : <CopyIcon />}
        </Button>
      </div>
    </div>
  );
}

const MARKER: Record<SetupStepState, string> = {
  done: "border-success/40 bg-success/10 text-success-foreground",
  current: "border-primary bg-primary text-primary-foreground",
  todo: "border-border bg-background text-muted-foreground",
  blocked: "border-destructive/40 bg-destructive/10 text-destructive-foreground",
};

/** One numbered step on a rail that runs down to the next. */
function Step({
  n,
  state,
  title,
  last = false,
  children,
}: {
  readonly n: number;
  readonly state: SetupStepState;
  readonly title: string;
  readonly last?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <li
      aria-current={state === "current" ? "step" : undefined}
      className="relative flex gap-3 px-3 pb-4 last:pb-3 sm:px-4"
      data-setup-step={state}
    >
      {last ? null : (
        <span aria-hidden className="absolute top-7.5 bottom-1.5 left-6 w-px bg-border sm:left-7" />
      )}
      <span
        aria-hidden
        className={cn(
          "relative flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium tabular-nums",
          MARKER[state],
        )}
      >
        {state === "done" ? (
          <CheckIcon className="size-3.5" />
        ) : state === "blocked" ? (
          <XIcon className="size-3.5" />
        ) : (
          n
        )}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2 pt-0.5">
        <p
          className={cn(
            "text-sm font-medium",
            state === "todo" ? "text-muted-foreground" : "text-foreground",
          )}
        >
          {title}
          <span className="sr-only">{` (${state})`}</span>
        </p>
        <div className="flex min-w-0 flex-col gap-2 text-xs text-muted-foreground">{children}</div>
      </div>
    </li>
  );
}

/**
 * The way from a fresh machine to its first build, at the top of Settings → Factory until a watched
 * repo can take work: add a repo, get its config read, label an issue. Each step says where it
 * stands from the config read the page already made.
 */
export function FactorySetup({
  file,
  repos,
  watchError,
}: {
  readonly file: string;
  readonly repos: ReadonlyArray<RepoBlock>;
  readonly watchError: string | null;
}) {
  const progress = setupProgress(repos, watchError);
  if (progress === null) return null;
  const { watch, read, errors, firstError } = progress;
  const stepOf = watch === "done" ? 2 : 1;
  return (
    <div data-factory-setup="">
      <SettingsSection
        headerAction={
          <span className="text-xs text-muted-foreground tabular-nums">{`Step ${stepOf} of 3`}</span>
        }
        title="Get the factory building"
      >
        <ol className="flex flex-col pt-3">
          <Step n={1} state={watch} title="Watch a repo">
            {watch === "blocked" ? (
              <p className="break-words">T3 projects could not be listed: {watchError}</p>
            ) : watch === "done" ? (
              <p>
                {repos.length === 1 ? "1 repo is watched." : `${repos.length} repos are watched.`}
              </p>
            ) : (
              <>
                <p>
                  Add a clone of the repo as a T3 project, with this block committed to its
                  .dw/config.yml on the default branch:
                </p>
                <Snippet text={FACTORY_BLOCK} />
                <p className="break-words">
                  Or put <code>default_project</code> in <code className="break-all">{file}</code>{" "}
                  to watch every T3 project with a GitHub origin.
                </p>
                <div>
                  <Button render={<Link to="/settings/projects" />} size="sm" variant="outline">
                    Add a project
                  </Button>
                </div>
              </>
            )}
          </Step>
          <Step n={2} state={read} title="Let the factory read its config">
            {read === "todo" ? (
              <p>Each pass reads the repo's .dw/config.yml; what it found shows below.</p>
            ) : errors > 0 && firstError !== null ? (
              <>
                <p>
                  {errors === repos.length
                    ? "Every watched repo has an error, so nothing can be built yet."
                    : `${errors} of ${repos.length} watched repos have an error, and the rest are not read yet.`}{" "}
                  Open a repo under Watched repos for all of them.
                </p>
                <p className="line-clamp-3 break-words rounded-md border border-destructive/24 bg-destructive/4 px-2.5 py-1.5 text-destructive-foreground">
                  <span className="font-medium">{firstError.title}:</span> {firstError.message}
                </p>
              </>
            ) : (
              <p>Not read yet: the factory reads it on its next pass.</p>
            )}
          </Step>
          <Step last n={3} state="todo" title="Label an issue factory:ready">
            <p>
              An instructor's <code>factory:ready</code> label on a GitHub issue starts a run on the
              next pass.
            </p>
            <div className="-my-2.5">
              <TouchLink render={<Link to="/factory" />}>Follow it on the Factory page</TouchLink>
            </div>
          </Step>
        </ol>
      </SettingsSection>
    </div>
  );
}
