import { ChevronRightIcon } from "lucide-react";

import { SettingsGroup } from "../../components/settings/SettingsGroup";
import { SettingsRow, SettingsSection } from "../../components/settings/settingsLayout";
import { Badge } from "../../components/ui/badge";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../../components/ui/collapsible";
import type { RepoBlock } from "./api";
import { repoRoster, type RepoHealth } from "./repoRoster";
import { TouchLink } from "../TouchLink";

const list = (items: ReadonlyArray<string>) => (items.length === 0 ? "None" : items.join(", "));

function ProjectConfigRows({ factory }: { readonly factory: NonNullable<RepoBlock["factory"]> }) {
  const { limits } = factory;
  return (
    <>
      <SettingsRow title="Instructors" description={list(factory.instructors)} />
      <SettingsRow title="Base branch" description={factory.base} />
      <SettingsRow title="Provision" description={list(factory.provision)} />
      <SettingsRow title="Gate" description={list(factory.gate)} />
      <SettingsRow title="Required checks" description={list(factory.required_checks)} />
      <SettingsRow
        title="Limits"
        description={`${limits.minutes} minutes, ${limits.gate_retries} gate retries, ${limits.checks_minutes} check minutes, ${limits.interruption_resumes} interruption resumes`}
      />
      <SettingsRow title="Autonomy" description={factory.autonomy} />
    </>
  );
}

function RepoDetails({ block }: { readonly block: RepoBlock }) {
  return (
    <>
      <SettingsRow
        title="Workspace root"
        description={<code className="break-all">{block.path}</code>}
      />
      {block.default_config === true ? (
        <SettingsRow
          title="Default config"
          description="No factory block in .dw/config.yml: this repo runs on default_project from the machine config, with the provision and gate inferred from its default branch. Add a factory block to override it."
        />
      ) : null}
      {block.errors !== null ? (
        <SettingsRow
          title="Errors"
          description={block.errors.map((error) => (
            // The description sits in a paragraph, which a list cannot.
            <span key={`${error.file}:${error.field ?? ""}:${error.message}`} className="block">
              {error.message}
            </span>
          ))}
        />
      ) : null}
      {block.factory !== null ? <ProjectConfigRows factory={block.factory} /> : null}
      {block.factory === null && block.errors === null ? (
        <SettingsRow
          title="Project config"
          description="Not read yet (the factory reads it on its next pass)"
        />
      ) : null}
      {block.default_config === true ? null : (
        <SettingsRow
          title="Project config on GitHub"
          control={
            <TouchLink
              render={
                <a
                  href={`https://github.com/${block.repo}/blob/${block.factory?.base ?? "HEAD"}/.dw/config.yml`}
                  target="_blank"
                  rel="noreferrer"
                />
              }
            >
              View .dw/config.yml on GitHub
            </TouchLink>
          }
        />
      )}
    </>
  );
}

const HEALTH: Record<
  RepoHealth,
  { readonly label: string; readonly variant: "error" | "secondary" | "info" | "success" }
> = {
  error: { label: "Error", variant: "error" },
  unread: { label: "Not read yet", variant: "secondary" },
  default: { label: "Defaults", variant: "info" },
  ready: { label: "Ready", variant: "success" },
};

/** One watched repo as a line that opens to everything the factory read of it. */
function RepoEntry({
  block,
  health,
  defaultOpen,
}: {
  readonly block: RepoBlock;
  readonly health: RepoHealth;
  readonly defaultOpen: boolean;
}) {
  const { label, variant } = HEALTH[health];
  const firstError = block.errors?.[0]?.message;
  const gate = block.factory?.gate.length ?? 0;
  return (
    <Collapsible defaultOpen={defaultOpen} data-repo={block.repo} data-health={health}>
      <CollapsibleTrigger className="group/repo flex min-h-14 w-full items-start gap-3 px-3 py-3 text-left outline-none hover:bg-accent/40 focus-visible:bg-accent/40 sm:px-4">
        <ChevronRightIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform group-data-panel-open/repo:rotate-90" />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-medium text-foreground">{block.title}</span>
            <Badge variant={variant}>{label}</Badge>
            <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
              {block.repo}
            </span>
          </span>
          {firstError !== undefined ? (
            <span className="line-clamp-1 break-all text-xs text-muted-foreground">
              {firstError}
            </span>
          ) : null}
        </span>
        {block.factory !== null ? (
          <span className="hidden shrink-0 text-xs text-muted-foreground sm:block">
            {`${block.factory.base} · ${gate} gate ${gate === 1 ? "command" : "commands"}`}
          </span>
        ) : null}
      </CollapsibleTrigger>
      <CollapsiblePanel animate={false}>
        <SettingsGroup variant="plain" className="border-t border-border/50 bg-muted/24 pl-7">
          <RepoDetails block={block} />
        </SettingsGroup>
      </CollapsiblePanel>
    </Collapsible>
  );
}

/**
 * The watched T3 projects and what the factory last read of each one's `.dw/config.yml`, read-only:
 * one line per repo, the ones that need a look first, each opening to its details. A list the
 * factory could not make, or checkouts it could not settle, are said as such: the "none yet" hint
 * is only for a list that really is empty.
 */
export function WatchedRepos({
  repos,
  unresolved,
  watchError,
}: {
  readonly repos: ReadonlyArray<RepoBlock>;
  readonly unresolved: ReadonlyArray<string>;
  readonly watchError: string | null;
}) {
  const none = repos.length === 0 && unresolved.length === 0 && watchError === null;
  const roster = repoRoster(repos);
  return (
    <SettingsSection
      title="Watched repos"
      headerAction={
        roster.summary === "" ? null : (
          <span
            data-testid="repo-summary"
            className="hidden text-xs text-muted-foreground sm:inline"
          >
            {roster.summary}
          </span>
        )
      }
    >
      <p className="px-3 py-2 text-xs text-muted-foreground sm:px-4">
        Repos are added as T3 projects: the factory watches every project on this environment whose
        checkout has a .dw/config.yml with a factory block. With default_project in the machine
        config, it watches every project with a GitHub origin, and a factory block only overrides
        the default.
        {none ? " No T3 project on this environment has one yet." : null}
      </p>
      {watchError !== null ? (
        <SettingsRow title="T3 projects not listed" description={watchError} />
      ) : null}
      {unresolved.length > 0 ? (
        <SettingsRow
          title="Not settled on the last read"
          description={
            <>
              {unresolved.map((path) => (
                <span key={path} className="block">
                  <code className="break-all">{path}</code>
                </span>
              ))}
              <span className="block">
                The factory could not tell whether these checkouts are watched: a .dw/config.yml
                that could not be read or parsed, an origin that could not be identified, or a git
                that would not run. Nothing is dropped for them; their attention items stay, and the
                next pass reads them again.
              </span>
            </>
          }
        />
      ) : null}
      {roster.rows.map(({ block, health }) => (
        <RepoEntry
          key={`${block.repo} ${block.path}`}
          block={block}
          health={health}
          defaultOpen={roster.rows.length === 1}
        />
      ))}
    </SettingsSection>
  );
}
