// @effect-diagnostics nodeBuiltinImport:off - the skill dirs are under the user's home, which only node:os names.
/**
 * The skills on this machine, for the catalog and for validation: every `<dir>/<name>/SKILL.md`
 * in the skill dirs, with the `name` and `description` of its front matter.
 */
import * as NodeOS from "node:os";

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { parse } from "yaml";

export type Skill = {
  readonly name: string;
  readonly description: string;
  /** The real path of the SKILL.md, past any symlink. */
  readonly path: string;
};

/** The longest description the catalog carries, in characters. */
export const DESCRIPTION_LIMIT = 240;

/** Where the agents look for skills. The hub dirs hold symlinks into one source dir. */
export const DEFAULT_SKILL_DIRS: ReadonlyArray<string> = [".claude", ".codex", ".agents"].map(
  (client) => `${NodeOS.homedir()}/${client}/skills`,
);

/** The dirs the routes scan for skills; a test points it at a temp dir. */
export class PipelineSkillDirs extends Context.Reference<ReadonlyArray<string>>(
  "t3/factory/pipeline/skills/PipelineSkillDirs",
  { defaultValue: () => DEFAULT_SKILL_DIRS },
) {}

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** The front matter's fields, or an empty object when there is none or it is not YAML. */
const frontMatter = (text: string): Record<string, unknown> => {
  const match = FRONT_MATTER.exec(text);
  if (match === null) return {};
  try {
    const value: unknown = parse(match[1]!);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

export const skillFromText = (folder: string, text: string, path: string): Skill => {
  const fields = frontMatter(text);
  const name = typeof fields["name"] === "string" ? fields["name"].trim() : "";
  const description =
    typeof fields["description"] === "string"
      ? fields["description"].replace(/\s+/g, " ").trim().slice(0, DESCRIPTION_LIMIT)
      : "";
  return { name: name === "" ? folder : name, description, path };
};

/**
 * Every skill in `dirs`, sorted by name. A dir that does not exist, an entry without a readable
 * SKILL.md, and a SKILL.md already reached through another dir are skipped.
 */
export const listSkills = Effect.fn("PipelineSkills.listSkills")(function* (
  dirs: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const found = yield* Effect.forEach(
    dirs,
    (dir) =>
      fs.readDirectory(dir).pipe(
        Effect.orElseSucceed((): ReadonlyArray<string> => []),
        Effect.flatMap((names) =>
          Effect.forEach(
            names.toSorted(),
            (folder) =>
              fs.realPath(path.join(dir, folder, "SKILL.md")).pipe(
                Effect.flatMap((real) =>
                  Effect.map(fs.readFileString(real), (text) => ({ folder, real, text })),
                ),
                Effect.orElseSucceed(() => null),
              ),
            // Hundreds of small files: read side by side, the scan is on every validate.
            { concurrency: 32 },
          ),
        ),
      ),
    { concurrency: "unbounded" },
  );
  const seen = new Set<string>();
  const skills: Array<Skill> = [];
  for (const entry of found.flat()) {
    if (entry === null || seen.has(entry.real)) continue;
    seen.add(entry.real);
    skills.push(skillFromText(entry.folder, entry.text, entry.real));
  }
  return skills.toSorted((a, b) => a.name.localeCompare(b.name));
});

/** The names validation accepts: the skills `listSkills` finds. */
export const skillNames = (skills: ReadonlyArray<Skill>): ReadonlySet<string> =>
  new Set(skills.map((skill) => skill.name));

/** How long a scan answers for the same dirs again. A skill installed shows within this. */
export const SKILLS_TTL_MS = 30_000;

const cache = new Map<
  string,
  { readonly expiresAt: number; readonly skills: ReadonlyArray<Skill> }
>();

/** For tests: forgets every cached scan. */
export const __resetSkillsCacheForTests = (): void => cache.clear();

/**
 * `listSkills`, answered from the last scan of the same dirs for `SKILLS_TTL_MS`. The editor
 * validates on every edit, and a scan of a few hundred skills costs about 100 ms, so the scan
 * must not run per keystroke.
 */
export const listSkillsCached = Effect.fn("PipelineSkills.listSkillsCached")(function* (
  dirs: ReadonlyArray<string>,
) {
  const key = dirs.join("\u0000");
  const now = yield* Clock.currentTimeMillis;
  const hit = cache.get(key);
  if (hit !== undefined && hit.expiresAt > now) return hit.skills;
  const skills = yield* listSkills(dirs);
  cache.set(key, { expiresAt: now + SKILLS_TTL_MS, skills });
  return skills;
});
