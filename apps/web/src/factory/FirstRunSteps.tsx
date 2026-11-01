import { Link } from "@tanstack/react-router";
import { CheckIcon, CopyIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";

import "./belt.css";
import type { FirstRunConfig, firstRunSteps } from "./firstRun";
import { withoutRepoPrefix } from "./format";
import type { RepoBlock } from "./settings/api";
import { Step } from "./settings/SetupStep";
import { TouchLink } from "./TouchLink";

const FACTORY_BLOCK = `factory:
  instructors: [your-github-login]
  base: main
  provision: [npm ci]
  gate: [npm test]
  autonomy: pr
`;

export function Snippet({
  text,
  label = "Copy the factory block",
}: {
  readonly text: string;
  readonly label?: string;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({ timeout: 1500 });
  return (
    <div className="relative min-w-0 rounded-lg border border-border bg-muted/50">
      <pre className="overflow-x-auto px-3 py-2.5 pr-10 font-mono text-xs leading-relaxed">
        {text}
      </pre>
      <div className="absolute top-1.5 right-1.5">
        <Button
          aria-label={label}
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

const names = (repos: ReadonlyArray<RepoBlock>) => {
  const shown = repos.slice(0, 3).map(({ repo, title }) => repo || title);
  return repos.length > 3 ? `${shown.join(", ")} and ${repos.length - 3} more` : shown.join(", ");
};

const SETTINGS = (
  <div>
    <Button render={<Link to="/settings/factory" />} size="sm" variant="outline">
      Open Settings → Factory
    </Button>
  </div>
);

const FACTORY_PAGE = (label: string) => (
  <div className="-my-2.5">
    <TouchLink render={<Link to="/factory" />}>{label}</TouchLink>
  </div>
);

/** Where the steps stand: the Factory page holds the claims switch, Settings holds the config. */
export type FirstRunPlace =
  | { readonly kind: "factory"; readonly busy: boolean; readonly onResume: () => void }
  | { readonly kind: "settings"; readonly file: string };

/**
 * The four steps to a first run, worded once for both places that show them. Each place adds only
 * the action it can take: Settings the block to copy, the Factory page the claims switch.
 */
export function FirstRunSteps({
  config,
  steps,
  place,
}: {
  readonly config: FirstRunConfig;
  readonly steps: ReturnType<typeof firstRunSteps>;
  readonly place: FirstRunPlace;
}) {
  const { states, ready, broken, errors } = steps;
  const [watch, read, claims, label] = states as [
    (typeof states)[number],
    (typeof states)[number],
    (typeof states)[number],
    (typeof states)[number],
  ];
  const repos = config.kind === "ok" ? config.repos : [];
  const instructors = ready[0]?.factory?.instructors ?? [];
  const onFactory = place.kind === "factory";
  return (
    <ol aria-label="Before the first run" className="flex min-w-0 flex-col pt-4">
      <Step n={1} state={watch} title="Watch a repo">
        {config.kind === "loading" ? (
          <p>Reading this machine's config.</p>
        ) : config.kind === "failed" ? (
          <>
            <p className="break-words">The factory config could not be read: {config.message}</p>
            {onFactory ? SETTINGS : null}
          </>
        ) : config.watchError !== null ? (
          <>
            <p className="break-words">T3 projects could not be listed: {config.watchError}</p>
            {onFactory ? SETTINGS : null}
          </>
        ) : watch === "done" ? (
          <p className="break-words">{`Watching ${names(repos)}.`}</p>
        ) : (
          <>
            <p>
              Add a clone of a GitHub repo as a T3 project, with a factory block committed to its{" "}
              <code>.dw/config.yml</code> on the default branch
              {onFactory ? ". Settings → Factory has the block to copy." : ":"}
            </p>
            {place.kind === "settings" ? (
              <>
                <Snippet text={FACTORY_BLOCK} />
                <p className="break-words">
                  Or put <code>default_project</code> in{" "}
                  <code className="break-all">{place.file}</code> to watch every T3 project with a
                  GitHub origin.
                </p>
                <div>
                  <Button render={<Link to="/settings/projects" />} size="sm" variant="outline">
                    Add a project
                  </Button>
                </div>
              </>
            ) : (
              SETTINGS
            )}
          </>
        )}
      </Step>
      <Step n={2} state={read} title="Give it a config it can build from">
        {read === "done" ? (
          <p className="break-words">{`Ready to build: ${names(ready)}.`}</p>
        ) : read !== "todo" && broken !== null ? (
          <>
            <p>
              {read === "current"
                ? `${errors} of ${repos.length} watched repos have an error, and the rest are not read yet.`
                : repos.length === 1
                  ? "The watched repo has an error, so nothing can be built yet."
                  : `All ${repos.length} watched repos have an error, so nothing can be built yet.`}
              {onFactory ? null : " Each repo's errors are under Watched repos."}
            </p>
            <p className="flex min-w-0 gap-2 break-words">
              <span
                aria-hidden
                className="mt-1.5 size-2 shrink-0 rounded-full bg-(--factory-stuck)"
              />
              <span className="line-clamp-3 min-w-0">
                <span className="font-medium text-foreground">{broken.title}:</span>{" "}
                {withoutRepoPrefix(broken.errors?.[0]?.message ?? "", broken.repo)}
              </span>
            </p>
            {onFactory ? SETTINGS : null}
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
        ) : place.kind === "factory" ? (
          <>
            <p>Claims are paused, so no issue is picked up.</p>
            <div>
              <Button disabled={place.busy} onClick={place.onResume} size="sm" variant="outline">
                Turn claims on
              </Button>
            </div>
          </>
        ) : (
          <>
            <p>Claims are switched on and off on the Factory page, where these steps carry on.</p>
            {FACTORY_PAGE("Open the Factory page")}
          </>
        )}
      </Step>
      <Step last n={4} state={label} title="Label an issue factory:ready">
        <p>
          {instructors.length > 0
            ? `An instructor (${instructors.join(", ")}) adds the label; `
            : "An instructor adds the label; "}
          {`the next pass claims the issue and it appears on ${onFactory ? "this" : "the Factory page's"} belt.`}
        </p>
        {onFactory && ready.length > 0 ? (
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
  );
}
