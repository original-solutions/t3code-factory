import { AuthSettingsWriteScope, type EnvironmentId } from "@t3tools/contracts";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import * as Option from "effect/Option";
import { useEffect, useEffectEvent, useState } from "react";

import { useSettingsScope } from "../../components/settings/SettingsScopeContext";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "../../components/settings/settingsLayout";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { useEnvironmentScope, usePreparedConnection } from "~/state/session";
import {
  fetchFactoryConfig,
  saveFactoryConfig,
  type ConfigError,
  type MachineConfigReport,
  type MachineConfigValues,
} from "./api";
import { FactorySetup } from "./FactorySetup";
import { WatchedRepos } from "./WatchedRepos";

/** The form keeps numbers as typed, so an empty or half-typed field is not coerced under the cursor. */
interface FormState {
  readonly gh_config_dir: string;
  readonly poll_seconds: string;
  readonly max_concurrent_runs: string;
  readonly max_concurrent_gates: string;
  readonly feedback_seconds: string;
}

const EMPTY_FORM: FormState = {
  gh_config_dir: "",
  poll_seconds: "",
  max_concurrent_runs: "",
  max_concurrent_gates: "",
  feedback_seconds: "",
};

const text = (value: unknown) => (value === undefined || value === null ? "" : String(value));

/** The file's values, or when it does not load the defaults under whatever the file does hold. */
const formOf = (report: MachineConfigReport): FormState => {
  const source = report.config ?? { ...report.defaults, ...report.draft };
  return {
    gh_config_dir: text(source.gh_config_dir),
    poll_seconds: text(source.poll_seconds),
    max_concurrent_runs: text(source.max_concurrent_runs),
    max_concurrent_gates: text(source.max_concurrent_gates),
    feedback_seconds: text(source.feedback_seconds),
  };
};

const toNumber = (text: string) => (text.trim() === "" ? null : Number(text));

const valuesOf = (form: FormState): MachineConfigValues => ({
  gh_config_dir: form.gh_config_dir,
  poll_seconds: toNumber(form.poll_seconds),
  max_concurrent_runs: toNumber(form.max_concurrent_runs),
  max_concurrent_gates: toNumber(form.max_concurrent_gates),
  feedback_seconds: toNumber(form.feedback_seconds),
});

type Load =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly report: MachineConfigReport };

type SaveStatus = "idle" | "saving" | "saved";

/** `poll_seconds` is a field name the server reports; the wrapper's key. */
const fieldKey = (error: ConfigError) => error.field?.replace(/\s/g, "");

function FieldErrors({
  name,
  errors,
}: {
  readonly name: string;
  readonly errors: ReadonlyArray<ConfigError>;
}) {
  return errors
    .filter((error) => fieldKey(error) === name)
    .map((error) => (
      <p key={error.message} role="alert" className="text-xs text-destructive-foreground">
        {error.message}
      </p>
    ));
}

/** A machine config field is a fixed width. */
function Field({
  name,
  errors,
  children,
}: {
  readonly name: string;
  readonly errors: ReadonlyArray<ConfigError>;
  readonly children: React.ReactNode;
}) {
  return (
    <div data-field={name} className="flex w-full min-w-0 flex-col gap-1 sm:w-144">
      {children}
      <FieldErrors name={name} errors={errors} />
    </div>
  );
}

export function FactorySettingsPanel() {
  const { environment } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const prepared = Option.getOrNull(usePreparedConnection(environmentId));

  if (environmentId === null || prepared === null) {
    return (
      <SettingsPageContainer>
        <p className="px-3 text-sm text-muted-foreground sm:px-4">
          Select an environment to edit its factory settings.
        </p>
      </SettingsPageContainer>
    );
  }

  // Another environment starts over at loading, and an answer for the last one lands nowhere.
  return (
    <MachineConfigForm key={environmentId} environmentId={environmentId} prepared={prepared} />
  );
}

function MachineConfigForm({
  environmentId,
  prepared,
}: {
  readonly environmentId: EnvironmentId;
  readonly prepared: PreparedConnection;
}) {
  const canWrite = useEnvironmentScope(environmentId, AuthSettingsWriteScope);

  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [errors, setErrors] = useState<ReadonlyArray<ConfigError>>([]);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [saveFailure, setSaveFailure] = useState<string | null>(null);

  const show = (report: MachineConfigReport) => {
    setLoad({ status: "ready", report });
    setForm(formOf(report));
    setErrors(report.errors);
  };

  const fetchConfig = () => {
    void fetchFactoryConfig(prepared).then((result) => {
      if (result.kind === "ok") {
        show(result.report);
      } else {
        setLoad({
          status: "error",
          message:
            result.kind === "error"
              ? result.message
              : result.kind === "forbidden"
                ? "This session is not allowed to read the factory config."
                : "The factory config could not be read.",
        });
      }
    });
  };
  // The connection object is replaced when a credential renews; a reload then would drop edits.
  const fetchOnMount = useEffectEvent(fetchConfig);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the factory config from the server once per mount
  useEffect(() => {
    fetchOnMount();
  }, []);
  const retry = () => {
    setLoad({ status: "loading" });
    fetchConfig();
  };

  const edit = (change: (form: FormState) => FormState) => {
    setForm(change);
    setSaveStatus("idle");
  };
  const setText = (key: keyof FormState) => (event: { target: { value: string } }) =>
    edit((current) => ({ ...current, [key]: event.target.value }));

  const save = async () => {
    if (!canWrite) return;
    setSaveStatus("saving");
    setSaveFailure(null);
    const result = await saveFactoryConfig(prepared, valuesOf(form));
    if (result.kind === "ok") {
      show(result.report);
      setSaveStatus("saved");
      return;
    }
    setSaveStatus("idle");
    if (result.kind === "invalid") {
      setErrors(result.errors);
    } else {
      setSaveFailure(
        result.kind === "forbidden"
          ? "This session is not allowed to change settings."
          : result.message,
      );
    }
  };

  if (load.status === "loading") {
    return (
      <SettingsPageContainer>
        <p className="px-3 text-sm text-muted-foreground sm:px-4">Loading the machine config</p>
      </SettingsPageContainer>
    );
  }

  if (load.status === "error") {
    return (
      <SettingsPageContainer>
        <div className="flex flex-wrap items-center gap-3 px-3 text-sm sm:px-4">
          <p role="alert" className="text-destructive-foreground">
            {load.message}
          </p>
          <Button size="sm" variant="outline" onClick={retry}>
            Retry
          </Button>
        </div>
      </SettingsPageContainer>
    );
  }

  const { report } = load;
  // An error that names no rendered input would otherwise show nowhere.
  const inputNames = new Set<string>([
    "gh_config_dir",
    "poll_seconds",
    "max_concurrent_runs",
    "max_concurrent_gates",
    "feedback_seconds",
  ]);
  const topErrors = errors.filter((error) => !inputNames.has(fieldKey(error) ?? ""));
  const saving = saveStatus === "saving";

  return (
    <SettingsPageContainer>
      <div className="flex flex-col gap-2 px-3 text-sm sm:px-4">
        {!report.exists ? (
          <p className="min-w-0 text-muted-foreground">
            No config file exists at <code className="break-all">{report.file}</code>. Saving
            creates it.
          </p>
        ) : null}
        {!canWrite ? (
          <p className="text-muted-foreground">
            This session is read-only: it cannot change the factory settings.
          </p>
        ) : null}
        {topErrors.length > 0 ? (
          <ul data-testid="form-errors" className="list-disc pl-5 text-destructive-foreground">
            {topErrors.map((error) => (
              <li key={`${error.field ?? ""}:${error.message}`}>{error.message}</li>
            ))}
          </ul>
        ) : null}
        {saveFailure !== null ? (
          <p role="alert" className="text-destructive-foreground">
            {saveFailure}
          </p>
        ) : null}
      </div>

      <FactorySetup file={report.file} repos={report.repos} watchError={report.watch_error} />

      <SettingsSection title="Machine config">
        <SettingsRow
          title="GitHub config directory"
          description="Where the factory's gh credentials live."
          control={
            <Field name="gh_config_dir" errors={errors}>
              <Input
                size="touch"
                font="mono"
                aria-label="GitHub config directory"
                value={form.gh_config_dir}
                onChange={setText("gh_config_dir")}
              />
            </Field>
          }
        />
        <SettingsRow
          title="Poll seconds"
          description="How often the factory looks at GitHub."
          control={
            <Field name="poll_seconds" errors={errors}>
              <Input
                size="touch"
                type="number"
                aria-label="Poll seconds"
                value={form.poll_seconds}
                onChange={setText("poll_seconds")}
              />
            </Field>
          }
        />
        <SettingsRow
          title="Max concurrent runs"
          control={
            <Field name="max_concurrent_runs" errors={errors}>
              <Input
                size="touch"
                type="number"
                aria-label="Max concurrent runs"
                value={form.max_concurrent_runs}
                onChange={setText("max_concurrent_runs")}
              />
            </Field>
          }
        />
        <SettingsRow
          title="Max concurrent gates"
          control={
            <Field name="max_concurrent_gates" errors={errors}>
              <Input
                size="touch"
                type="number"
                aria-label="Max concurrent gates"
                value={form.max_concurrent_gates}
                onChange={setText("max_concurrent_gates")}
              />
            </Field>
          }
        />
        <SettingsRow
          title="Feedback seconds"
          description="How often the factory looks for comments and reviews on a ready pull request. 0 reads on every pass."
          control={
            <Field name="feedback_seconds" errors={errors}>
              <Input
                size="touch"
                type="number"
                aria-label="Feedback seconds"
                value={form.feedback_seconds}
                onChange={setText("feedback_seconds")}
              />
            </Field>
          }
        />
      </SettingsSection>

      <div className="flex items-center gap-3 px-3 sm:px-4">
        <Button size="sm" disabled={!canWrite || saving} onClick={() => void save()}>
          Save
        </Button>
        {saveStatus === "saved" ? (
          <span role="status" className="text-sm text-muted-foreground">
            Saved
          </span>
        ) : null}
      </div>

      <WatchedRepos
        repos={report.repos}
        unresolved={report.unresolved}
        watchError={report.watch_error}
      />
    </SettingsPageContainer>
  );
}
