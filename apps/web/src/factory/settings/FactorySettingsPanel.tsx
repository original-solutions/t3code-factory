import { AuthSettingsWriteScope, type EnvironmentId } from "@t3tools/contracts";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import * as Option from "effect/Option";
import { useEffect, useEffectEvent, useState } from "react";

import { useSettingsScope } from "../../components/settings/SettingsScopeContext";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "../../components/settings/settingsLayout";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../../components/ui/input-group";
import { cn } from "../../lib/utils";
import { useEnvironmentScope, usePreparedConnection } from "~/state/session";

import { useLegacySessionNotices } from "../useLegacySessionNotices";
import {
  fetchFactoryConfig,
  fetchMachineNow,
  saveFactoryConfig,
  type ConfigError,
  type MachineConfigReport,
  type MachineConfigValues,
} from "./api";
import { FactorySetup } from "./FactorySetup";
import { SaveBar } from "./SaveBar";
import {
  FIELD_LABELS,
  feedbackBudget,
  HOURLY_POINTS,
  limitNow,
  pendingChanges,
  readingOf,
  type LimitNow,
  type MachineNow,
  type TuningForm,
  type TuningKey,
} from "./tuning";
import { WatchedRepos } from "./WatchedRepos";

/** The form keeps numbers as typed, so an empty or half-typed field is not coerced under the cursor. */
type FormState = TuningForm;

const EMPTY_FORM: FormState = {
  gh_config_dir: "",
  poll_seconds: "",
  max_concurrent_runs: "",
  max_concurrent_gates: "",
  feedback_seconds: "",
  min_free_gib: "",
  max_load_per_core: "",
};

const NUMBER_FIELDS: ReadonlyArray<{
  readonly key: Exclude<TuningKey, "gh_config_dir">;
  readonly description: string;
  readonly unit: string;
}> = [
  { key: "poll_seconds", unit: "s", description: "How often the factory looks at GitHub." },
  {
    key: "max_concurrent_runs",
    unit: "runs",
    description: "Runs that may hold an issue at once, across every repo.",
  },
  {
    key: "max_concurrent_gates",
    unit: "gates",
    description: "Gates that may check a branch at once.",
  },
  {
    key: "min_free_gib",
    unit: "GiB",
    description:
      "Free space below which nothing is claimed and no gate starts, so a build never fills the disk. 0 turns it off.",
  },
  {
    key: "max_load_per_core",
    unit: "/core",
    description:
      "1-minute load per core above which nothing is claimed and a second gate waits. 0 turns it off.",
  },
  {
    key: "feedback_seconds",
    unit: "s",
    description:
      "How often the factory looks for comments and reviews on a ready pull request. 0 reads on every pass.",
  },
];

/** Keys an older server neither reports nor takes: the page leaves them to a hand edit there. */
const NEWER_KEYS = ["min_free_gib", "max_load_per_core"] as const;

const servesKey = (report: MachineConfigReport, key: TuningKey) => key in report.defaults;

/** The keys the page does not edit; `editMachineConfig` keeps them through a save. */
const HAND_EDITED_KEYS = [
  "default_project",
  "model_fallbacks",
  "notify",
  "deploy_wait_minutes",
  "keep_versions",
  "prune_branches_after_days",
  "prune_branches_dry_run",
];

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
    min_free_gib: text(source.min_free_gib),
    max_load_per_core: text(source.max_load_per_core),
  };
};

const toNumber = (text: string) => (text.trim() === "" ? null : Number(text));

const valuesOf = (form: FormState, report: MachineConfigReport): MachineConfigValues => ({
  gh_config_dir: form.gh_config_dir,
  poll_seconds: toNumber(form.poll_seconds),
  max_concurrent_runs: toNumber(form.max_concurrent_runs),
  max_concurrent_gates: toNumber(form.max_concurrent_gates),
  feedback_seconds: toNumber(form.feedback_seconds),
  ...Object.fromEntries(
    NEWER_KEYS.filter((key) => servesKey(report, key)).map((key) => [key, toNumber(form[key])]),
  ),
});

const BAR: Record<LimitNow["tone"], string> = {
  ok: "bg-success",
  warn: "bg-warning",
  bad: "bg-destructive",
};

/** A limit against the machine now: the bar the Factory page's Machine dial draws, and a sentence. */
function NowLine({ now }: { readonly now: LimitNow }) {
  return (
    <div data-now={now.tone} className="flex max-w-96 flex-col gap-1 pt-0.5">
      <div aria-hidden className="relative h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full", BAR[now.tone])}
          style={{ width: `${Math.max(2, now.fill * 100)}%` }}
        />
        {now.mark === null ? null : (
          <div
            className="absolute inset-y-0 w-0.5 bg-foreground/70"
            style={{ left: `${now.mark * 100}%` }}
          />
        )}
      </div>
      <p
        className={cn(
          now.tone === "bad" && "text-destructive-foreground",
          now.tone === "warn" && "text-warning-foreground",
        )}
      >
        {now.text}
      </p>
    </div>
  );
}

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

/** A machine config field: a path is wide, a number is as narrow as its value and unit. */
function Field({
  name,
  errors,
  wide = false,
  children,
}: {
  readonly name: string;
  readonly errors: ReadonlyArray<ConfigError>;
  readonly wide?: boolean;
  readonly children: React.ReactNode;
}) {
  return (
    <div
      data-field={name}
      className={cn("flex w-full min-w-0 flex-col gap-1", wide ? "sm:w-144" : "sm:w-36")}
    >
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
  const [legacySession] = useLegacySessionNotices(environmentId === null ? [] : [environmentId]);

  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saved, setSaved] = useState<FormState>(EMPTY_FORM);
  const [errors, setErrors] = useState<ReadonlyArray<ConfigError>>([]);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [saveFailure, setSaveFailure] = useState<string | null>(null);

  const show = (report: MachineConfigReport) => {
    setLoad({ status: "ready", report });
    setForm(formOf(report));
    setSaved(formOf(report));
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
  // What the machine does now, read once so each limit shows against it; a refused read shows none.
  const [machineNow, setMachineNow] = useState<MachineNow | null>(null);
  const fetchOnMount = useEffectEvent(() => {
    fetchConfig();
    void fetchMachineNow(prepared).then(setMachineNow);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the factory config and status from the server once per mount
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

  const discard = () => {
    if (load.status === "ready") setErrors(load.report.errors);
    setForm(saved);
    setSaveStatus("idle");
    setSaveFailure(null);
  };

  const save = async () => {
    if (!canWrite || load.status !== "ready") return;
    setSaveStatus("saving");
    setSaveFailure(null);
    const result = await saveFactoryConfig(prepared, valuesOf(form, load.report));
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
  const inputNames = new Set<string>(Object.keys(FIELD_LABELS));
  const topErrors = errors.filter((error) => !inputNames.has(fieldKey(error) ?? ""));
  const saving = saveStatus === "saving";
  const changes = pendingChanges(saved, form);

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
            {legacySession
              ? "This session is read-only: it cannot change the factory settings (it lacks settings:write). Pair again to get it."
              : "This session is read-only: it cannot change the factory settings."}
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

      <FactorySetup
        file={report.file}
        ghConfigDir={report.config?.gh_config_dir ?? ""}
        repos={report.repos}
        watchError={report.watch_error}
      />

      <SettingsSection title="Machine config">
        <SettingsRow
          title={FIELD_LABELS.gh_config_dir}
          description="Where the factory's gh credentials live."
          control={
            <Field name="gh_config_dir" errors={errors} wide>
              <Input
                size="touch"
                font="mono"
                aria-label={FIELD_LABELS.gh_config_dir}
                value={form.gh_config_dir}
                onChange={setText("gh_config_dir")}
              />
            </Field>
          }
        />
        {NUMBER_FIELDS.filter(({ key }) => servesKey(report, key)).map(
          ({ key, description, unit }) => {
            const fallback = text(report.defaults[key]);
            const reading = readingOf(key, form[key]);
            const budget = key === "feedback_seconds" ? feedbackBudget(form) : null;
            const now = limitNow(key, form, saved, machineNow);
            return (
              <SettingsRow
                key={key}
                title={FIELD_LABELS[key]}
                description={description}
                resetAction={
                  fallback !== "" && form[key].trim() !== fallback ? (
                    <SettingResetButton
                      label={FIELD_LABELS[key]}
                      tooltip={`Reset to the default, ${fallback}`}
                      onClick={() => edit((current) => ({ ...current, [key]: fallback }))}
                    />
                  ) : undefined
                }
                status={
                  reading === null && budget === null && now === null ? undefined : (
                    <div data-reading={key} className="flex flex-col gap-0.5">
                      {reading === null ? null : <p className="text-foreground/80">{reading}</p>}
                      {now === null ? null : <NowLine now={now} />}
                      {budget === null ? null : (
                        <p
                          data-budget={budget.tight ? "tight" : "ok"}
                          className={budget.tight ? "text-warning-foreground" : undefined}
                        >
                          About {budget.pointsPerPullRequest.toLocaleString()} GraphQL points an
                          hour per pull request waiting for review, so{" "}
                          {budget.pullRequestsToSpendAll.toLocaleString()} waiting pull requests
                          would spend the login's {HOURLY_POINTS.toLocaleString()}.
                        </p>
                      )}
                    </div>
                  )
                }
                control={
                  <Field name={key} errors={errors}>
                    <InputGroup>
                      <InputGroupInput
                        size="touch"
                        type="number"
                        aria-label={FIELD_LABELS[key]}
                        value={form[key]}
                        onChange={setText(key)}
                      />
                      <InputGroupAddon align="inline-end">
                        <span className="text-xs text-muted-foreground">{unit}</span>
                      </InputGroupAddon>
                    </InputGroup>
                  </Field>
                }
              />
            );
          },
        )}
        <div className="flex flex-col gap-2 px-3 py-3 text-xs text-muted-foreground sm:px-4">
          <p>
            The rest of the file is edited by hand, and a save keeps it as written. The server reads
            the file only at start and on a save, so save here after a hand edit to apply it.
          </p>
          <p data-hand-edited className="flex flex-wrap gap-1">
            {[...HAND_EDITED_KEYS, ...NEWER_KEYS.filter((key) => !servesKey(report, key))].map(
              (key) => (
                <code key={key} className="rounded bg-muted px-1 py-px font-mono text-2xs">
                  {key}
                </code>
              ),
            )}
          </p>
        </div>
        <SaveBar
          file={report.file}
          changes={changes}
          canWrite={canWrite}
          saving={saving}
          saved={saveStatus === "saved"}
          onSave={() => void save()}
          onDiscard={discard}
        />
      </SettingsSection>

      <WatchedRepos
        repos={report.repos}
        unresolved={report.unresolved}
        watchError={report.watch_error}
      />
    </SettingsPageContainer>
  );
}
