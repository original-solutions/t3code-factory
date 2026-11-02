/**
 * What the machine config form's numbers mean, and what a save would change, for the settings
 * page. Pure: the page passes the form as typed.
 */
import type { FactoryHealth } from "../api";
import { BUSY, formatBytes, NEAR, pressure } from "../machineHealth";

/** The form as typed, under the YAML field names. */
export interface TuningForm {
  readonly gh_config_dir: string;
  readonly poll_seconds: string;
  readonly max_concurrent_runs: string;
  readonly max_concurrent_gates: string;
  readonly feedback_seconds: string;
  readonly min_free_gib: string;
  readonly max_load_per_core: string;
}

export type TuningKey = keyof TuningForm;

export const FIELD_LABELS: Readonly<Record<TuningKey, string>> = {
  gh_config_dir: "GitHub config directory",
  poll_seconds: "Poll seconds",
  max_concurrent_runs: "Max concurrent runs",
  max_concurrent_gates: "Max concurrent gates",
  feedback_seconds: "Feedback seconds",
  min_free_gib: "Disk floor",
  max_load_per_core: "Load limit",
};

const KEYS = Object.keys(FIELD_LABELS) as ReadonlyArray<TuningKey>;

/** The least each number may be; the same floors `parseMachineConfig` checks on the server. */
const MINIMUM: Readonly<Record<Exclude<TuningKey, "gh_config_dir">, number>> = {
  poll_seconds: 10,
  max_concurrent_runs: 1,
  max_concurrent_gates: 1,
  feedback_seconds: 0,
  min_free_gib: 0,
  max_load_per_core: 0,
};

/** The typed text as a number the server would take for `key`, else null. */
const accepted = (key: Exclude<TuningKey, "gh_config_dir">, text: string): number | null => {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= MINIMUM[key] ? value : null;
};

/** `90` → `1 min 30 s`, `5400` → `1 h 30 min`: the two largest units that are not zero. */
export const spanOf = (seconds: number): string => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours > 0) return minutes > 0 ? `${hours} h ${minutes} min` : `${hours} h`;
  if (minutes > 0) return rest > 0 ? `${minutes} min ${rest} s` : `${minutes} min`;
  return `${rest} s`;
};

/** One sentence saying what the value does, or null when the server would refuse it. */
export const readingOf = (key: TuningKey, text: string): string | null => {
  if (key === "gh_config_dir") return null;
  const value = accepted(key, text);
  if (value === null) return null;
  switch (key) {
    case "poll_seconds":
      return `Looks at GitHub at least every ${spanOf(value)}.`;
    case "max_concurrent_runs":
      return value === 1 ? "1 run builds at a time." : `${value} runs build at a time.`;
    case "max_concurrent_gates":
      return value === 1 ? "1 gate runs at a time." : `${value} gates run at a time.`;
    case "feedback_seconds":
      return value === 0
        ? "Reads feedback on every pass."
        : `Reads feedback at most every ${spanOf(value)}.`;
    case "min_free_gib":
      return value === 0
        ? "Never waits for disk."
        : `Claims and gates wait while less than ${value} GiB is free.`;
    case "max_load_per_core":
      return value === 0
        ? "Never waits for load."
        : `Claims wait while the 1-minute load is above ${value} per core.`;
  }
};

/** What the machine is doing now, from the factory's status read. */
export interface MachineNow {
  readonly slots: { readonly used: number };
  readonly health?: FactoryHealth | null;
}

/** A limit set against the machine now: a sentence and a bar, `mark` where the pass holds. */
export interface LimitNow {
  readonly tone: "ok" | "warn" | "bad";
  readonly text: string;
  readonly fill: number;
  readonly mark: number | null;
}

/**
 * The typed limit against what the machine is doing now, so a person sees whether a value would
 * hold claims before saving it. "Would" while the typed value is not the saved one. Null for a
 * key with nothing to measure, a value the server would refuse, or nothing read.
 */
export const limitNow = (
  key: TuningKey,
  form: TuningForm,
  saved: TuningForm,
  now: MachineNow | null,
): LimitNow | null => {
  if (now === null || key === "gh_config_dir") return null;
  const value = accepted(key, form[key]);
  if (value === null) return null;
  const held = form[key].trim() === saved[key].trim() ? "are held" : "would be held";
  const health = now.health ?? null;
  switch (key) {
    case "max_concurrent_runs": {
      const used = now.slots.used;
      const fill = Math.min(1, used / value);
      if (used > value) {
        return {
          tone: "bad",
          text: `${used} hold an issue now: nothing new is claimed until ${used - value + 1} end.`,
          fill,
          mark: null,
        };
      }
      return used === value
        ? {
            tone: "warn",
            text: `${used} of ${value} in use now: the next ready issue waits for one to end.`,
            fill,
            mark: null,
          }
        : { tone: "ok", text: `${used} of ${value} in use now.`, fill, mark: null };
    }
    case "max_concurrent_gates": {
      if (health === null) return null;
      const running = health.gates.running;
      const fill = Math.min(1, running / value);
      return running > value
        ? {
            tone: "warn",
            text: `${running} running now: a new gate waits until ${running - value + 1} finish.`,
            fill,
            mark: null,
          }
        : { tone: "ok", text: `${running} of ${value} running now.`, fill, mark: null };
    }
    case "min_free_gib": {
      if (health === null || "error" in health.disk) return null;
      const { free_bytes: free, total_bytes: total } = health.disk;
      if (value === 0) {
        return {
          tone: "ok",
          text: `Off. ${formatBytes(free)} free now.`,
          fill: total > 0 ? 1 - free / total : 0,
          mark: null,
        };
      }
      const floor = value * GIB;
      const fill = pressure(floor * 2 - free, floor);
      if (free < floor) {
        return {
          tone: "bad",
          text: `${formatBytes(free)} free now, under ${value} GiB: claims ${held}.`,
          fill,
          mark: 0.5,
        };
      }
      return {
        tone: free < floor * NEAR ? "warn" : "ok",
        text: `${formatBytes(free)} free now, ${formatBytes(free - floor)} above the floor.`,
        fill,
        mark: 0.5,
      };
    }
    case "max_load_per_core": {
      if (health === null) return null;
      const { one_minute: load, cores } = health.load;
      const reading = load.toFixed(1);
      if (value === 0) {
        return {
          tone: "ok",
          text: `Off. Load ${reading} now on ${cores} cores.`,
          fill: cores > 0 ? Math.min(1, load / cores) : 0,
          mark: null,
        };
      }
      const limit = value * cores;
      const fill = pressure(load, limit);
      if (load > limit) {
        return {
          tone: "bad",
          text: `Load ${reading} now, above ${limit} on ${cores} cores: claims ${held}.`,
          fill,
          mark: 0.5,
        };
      }
      return {
        tone: load > limit * BUSY ? "warn" : "ok",
        text: `Load ${reading} now; holds above ${limit} on ${cores} cores.`,
        fill,
        mark: 0.5,
      };
    }
    default:
      return null;
  }
};

const GIB = 1024 ** 3;

/** GraphQL points a GitHub login has an hour. */
export const HOURLY_POINTS = 5000;
/** About what one feedback read of one waiting pull request costs (see `DEFAULT_FEEDBACK_SECONDS`). */
const POINTS_PER_READ = 3;
/** The guide's example of a busy machine: fewer waiting pull requests than this spend it all. */
const BUSY_PULL_REQUESTS = 40;

export interface FeedbackBudget {
  /** Points an hour one waiting pull request costs in feedback reads. */
  readonly pointsPerPullRequest: number;
  /** Waiting pull requests whose feedback reads alone would spend the login's hour. */
  readonly pullRequestsToSpendAll: number;
  /** A busy machine would run out: fewer than the guide's 40 waiting pull requests spend it all. */
  readonly tight: boolean;
}

/** What the feedback reads cost at the typed values; a read happens at most once a pass. */
export const feedbackBudget = (form: TuningForm): FeedbackBudget | null => {
  const poll = accepted("poll_seconds", form.poll_seconds);
  const feedback = accepted("feedback_seconds", form.feedback_seconds);
  if (poll === null || feedback === null) return null;
  const readsPerHour = 3600 / Math.max(poll, feedback);
  const pointsPerPullRequest = Math.round(POINTS_PER_READ * readsPerHour);
  const pullRequestsToSpendAll = Math.floor(HOURLY_POINTS / pointsPerPullRequest);
  return {
    pointsPerPullRequest,
    pullRequestsToSpendAll,
    tight: pullRequestsToSpendAll < BUSY_PULL_REQUESTS,
  };
};

export interface PendingChange {
  readonly key: TuningKey;
  readonly label: string;
  readonly from: string;
  readonly to: string;
}

/** The fields whose typed value differs from what the file holds, in form order. */
export const pendingChanges = (saved: TuningForm, form: TuningForm): ReadonlyArray<PendingChange> =>
  KEYS.flatMap((key) => {
    const from = saved[key].trim();
    const to = form[key].trim();
    return from === to ? [] : [{ key, label: FIELD_LABELS[key], from, to }];
  });
