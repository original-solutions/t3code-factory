import { ChevronRightIcon } from "lucide-react";

import { SettingsGroup } from "../../components/settings/SettingsGroup";
import { SettingsRow, SettingsSection } from "../../components/settings/settingsLayout";
import { Badge } from "../../components/ui/badge";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../../components/ui/collapsible";
import type { RepoBlock } from "./api";
import { factoryBlockYaml, repoPlan } from "./repoPlan";
import { repoRoster, type RepoHealth } from "./repoRoster";
import { Snippet } from "../FirstRunSteps";
import { TouchLink } from "../TouchLink";

function Commands({ factory }: { readonly factory: NonNullable<RepoBlock["factory"]> }) {
  const seen = new Map<string, number>();
  // A command may repeat, so its key counts the copies before it.
  const commands = [
    ...factory.provision.map((command) => ({ command, kind: "provision" })),
    ...factory.gate.map((command) => ({ command, kind: "gate" })),
  ].map((line) => {
    const name = `${line.kind} ${line.command}`;
    const copy = seen.get(name) ?? 0;
    seen.set(name, copy + 1);
    return { ...line, key: `${name} ${copy}` };
  });
  return (
    <ol
      data-gate-commands
      className="mt-2 divide-y divide-border/50 overflow-hidden rounded-lg border border-border bg-muted/50 font-mono text-xs"
    >
      {commands.map(({ command, kind, key }) => (
        <li key={key} className="flex min-w-0 items-baseline gap-2 px-3 py-1.5">
          <span className="shrink-0 text-muted-foreground/70 select-none">$</span>
          <span className="min-w-0 flex-1 break-all">{command}</span>
          <span className="shrink-0 font-sans text-2xs text-muted-foreground">{kind}</span>
        </li>
      ))}
    </ol>
  );
}

/**
 * What the factory will do with a ready issue on this repo, step by step, each step naming the
 * config keys behind it, then the block itself to copy.
 */
function RepoPlan({
  factory,
  isDefault,
}: {
  readonly factory: NonNullable<RepoBlock["factory"]>;
  readonly isDefault: boolean;
}) {
  return (
    <div data-repo-plan className="px-3 py-3 sm:px-4">
      <p className="text-sm font-medium text-foreground">
        What the factory does with a ready issue
      </p>
      <ol className="relative mt-3">
        {repoPlan(factory).map((step, index, steps) => (
          <li
            key={step.title}
            data-plan-step={step.title}
            className="relative flex gap-3 pb-4 last:pb-0"
          >
            {index < steps.length - 1 ? (
              <span aria-hidden className="absolute top-6 bottom-0 left-2.75 w-px bg-border" />
            ) : null}
            <span
              aria-hidden
              className="relative flex size-6 shrink-0 items-center justify-center rounded-full border border-border bg-background text-2xs font-medium text-muted-foreground tabular-nums"
            >
              {index + 1}
            </span>
            <div className="min-w-0 flex-1 pt-0.5">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <span className="text-sm font-medium text-foreground">{step.title}</span>
                <span className="flex flex-wrap gap-1">
                  {step.keys.map((key) => (
                    <code
                      key={key}
                      className="rounded bg-muted px-1 py-px font-mono text-2xs text-muted-foreground"
                    >
                      {key}
                    </code>
                  ))}
                </span>
              </div>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{step.says}</p>
              {step.title === "Gate" ? <Commands factory={factory} /> : null}
            </div>
          </li>
        ))}
      </ol>
      <p className="mt-4 text-sm font-medium text-foreground">
        {isDefault ? "The block it resolved to" : "The block as the factory read it"}
      </p>
      <p className="mt-0.5 mb-2 text-xs text-muted-foreground">
        {isDefault
          ? "No factory block in .dw/config.yml: this repo runs on default_project from the machine config, with the provision and gate inferred from its default branch. Commit this as .dw/config.yml to pin it, then edit."
          : "With every default written out."}
      </p>
      <Snippet text={factoryBlockYaml(factory)} />
    </div>
  );
}

function RepoDetails({ block }: { readonly block: RepoBlock }) {
  return (
    <>
      <SettingsRow
        title="Workspace root"
        description={<code className="break-all">{block.path}</code>}
      />
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
      {block.factory !== null ? (
        <RepoPlan factory={block.factory} isDefault={block.default_config === true} />
      ) : null}
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
