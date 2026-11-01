import { SettingsSection } from "../../components/settings/settingsLayout";
import { firstRunSteps } from "../firstRun";
import { FirstRunSteps } from "../FirstRunSteps";
import type { RepoBlock } from "./api";

/**
 * The first-run steps at the top of Settings → Factory until a watched repo can take work. Claims
 * and the label come after that, on the Factory page, so this page does not read claims.
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
  const config = { kind: "ok", repos, watchError } as const;
  const steps = firstRunSteps(config, null);
  if (steps.ready.length > 0) return null;
  return (
    <div data-factory-setup="">
      <SettingsSection
        headerAction={
          <span className="text-xs text-muted-foreground tabular-nums">{`Step ${steps.current} of 4`}</span>
        }
        title="Get the factory building"
      >
        <FirstRunSteps config={config} place={{ kind: "settings", file }} steps={steps} />
      </SettingsSection>
    </div>
  );
}
