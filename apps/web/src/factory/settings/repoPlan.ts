import type { RepoBlock } from "./api";

type FactoryBlock = NonNullable<RepoBlock["factory"]>;

/** One thing the factory does with an issue on this repo, and the config keys that shape it. */
export interface PlanStep {
  readonly title: string;
  readonly says: string;
  readonly keys: ReadonlyArray<string>;
}

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;

export const duration = (minutes: number) =>
  minutes >= 60 && minutes % 60 === 0 ? plural(minutes / 60, "hour") : plural(minutes, "minute");

const either = (items: ReadonlyArray<string>) =>
  new Intl.ListFormat("en", { type: "disjunction" }).format(items);

const both = (items: ReadonlyArray<string>) =>
  new Intl.ListFormat("en", { type: "conjunction" }).format(items);

/**
 * What the factory will do with a `factory:ready` issue on a repo, step by step, in the words of
 * the resolved block. The gate commands themselves are listed beside the gate step.
 */
export const repoPlan = (factory: FactoryBlock): ReadonlyArray<PlanStep> => {
  const { limits } = factory;
  const checks = factory.required_checks;
  return [
    {
      title: "Claim",
      says: `Takes an issue once ${either(factory.instructors.map((login) => `@${login}`))} labels it factory:ready${
        typeof factory.owner === "string"
          ? `, and only on ${factory.owner}: other machines leave it.`
          : "."
      }`,
      keys: ["instructors", "owner"],
    },
    {
      title: "Build",
      says: `An agent builds it on its own branch off ${factory.base}, for up to ${duration(limits.minutes)}. ${
        limits.interruption_resumes === 0
          ? "A session T3 itself drops is not resumed."
          : `A session T3 itself drops is resumed up to ${plural(limits.interruption_resumes, "time")}.`
      }`,
      keys: ["base", "limits.minutes", "limits.interruption_resumes"],
    },
    {
      title: "Gate",
      says: `A fresh checkout of the pull request merged with ${factory.base} runs these, each for up to 30 minutes, and every one must exit 0. ${
        limits.gate_retries === 0
          ? "The first failed gate stops the run."
          : `A failed gate goes back to the agent to fix, up to ${plural(limits.gate_retries, "time")}.`
      }`,
      keys: ["provision", "gate", "limits.gate_retries"],
    },
    {
      title: "Checks",
      says:
        checks.length === 0
          ? "No GitHub checks are required: the gate alone decides."
          : `Waits up to ${duration(limits.checks_minutes)} for ${both(checks)} to pass on GitHub.`,
      keys: ["required_checks", "limits.checks_minutes"],
    },
    {
      title: "Hand off",
      says: `Marks the pull request into ${factory.base} ready for review. A person merges it; the factory never does.`,
      keys: ["autonomy"],
    },
  ];
};

const PLAIN = /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/;
const RESERVED = /^(?:true|false|yes|no|on|off|null|~|[-+]?[0-9][0-9._]*)$/i;

/** A YAML scalar: bare when that reads back as the same string, else JSON-quoted (valid YAML). */
const scalar = (value: string) =>
  PLAIN.test(value) && !RESERVED.test(value) ? value : JSON.stringify(value);

const sequence = (items: ReadonlyArray<string>) => `[${items.map(scalar).join(", ")}]`;

/** The resolved block as `.dw/config.yml` text, defaults written out, ready to commit. */
export const factoryBlockYaml = (factory: FactoryBlock) => {
  const { limits } = factory;
  return [
    "factory:",
    `  instructors: ${sequence(factory.instructors)}`,
    ...(typeof factory.owner === "string" ? [`  owner: ${scalar(factory.owner)}`] : []),
    `  base: ${scalar(factory.base)}`,
    `  provision: ${sequence(factory.provision)}`,
    `  gate: ${sequence(factory.gate)}`,
    `  required_checks: ${sequence(factory.required_checks)}`,
    "  limits:",
    `    minutes: ${limits.minutes}`,
    `    gate_retries: ${limits.gate_retries}`,
    `    checks_minutes: ${limits.checks_minutes}`,
    `    interruption_resumes: ${limits.interruption_resumes}`,
    `  autonomy: ${factory.autonomy}`,
    "",
  ].join("\n");
};
