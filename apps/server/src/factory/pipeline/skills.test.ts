// @effect-diagnostics nodeBuiltinImport:off - the tests lay out real skill dirs and symlinks.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { describe } from "vite-plus/test";

import { useTempDirs } from "../ledger/testSupport.ts";
import {
  __resetSkillsCacheForTests,
  DESCRIPTION_LIMIT,
  listSkills,
  listSkillsCached,
  skillNames,
  SKILLS_TTL_MS,
} from "./skills.ts";

const tempDir = useTempDirs();

const writeSkill = (dir: string, folder: string, text: string) => {
  NodeFS.mkdirSync(NodePath.join(dir, folder), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(dir, folder, "SKILL.md"), text);
};

describe("listSkills", () => {
  it.effect("lists each skill once, by its front matter, across dirs and symlinks", () =>
    Effect.gen(function* () {
      const root = tempDir("skills");
      const source = NodePath.join(root, "source");
      const hub = NodePath.join(root, "hub");
      const client = NodePath.join(root, "client");
      writeSkill(
        source,
        "factory",
        "---\nname: factory\ndescription: >\n  Build one issue\n  into a pull request.\n---\n\n# Factory\n",
      );
      writeSkill(source, "retro", "---\nname: session-capture\ndescription: Capture.\n---\n");
      NodeFS.mkdirSync(hub);
      NodeFS.mkdirSync(client);
      NodeFS.symlinkSync(NodePath.join(source, "factory"), NodePath.join(hub, "factory"));
      NodeFS.symlinkSync(NodePath.join(source, "retro"), NodePath.join(client, "retro"));
      writeSkill(client, "plain", "# No front matter\n");
      writeSkill(client, "broken", "---\nname: [unclosed\n---\n");
      NodeFS.mkdirSync(NodePath.join(client, "empty"));
      NodeFS.writeFileSync(NodePath.join(client, "README.md"), "not a skill");

      const skills = yield* listSkills([hub, client, NodePath.join(root, "missing"), source]);
      assert.deepStrictEqual(
        skills.map((skill) => [skill.name, skill.description]),
        [
          ["broken", ""],
          ["factory", "Build one issue into a pull request."],
          ["plain", ""],
          ["session-capture", "Capture."],
        ],
      );
      const real = NodeFS.realpathSync(NodePath.join(source, "factory", "SKILL.md"));
      assert.strictEqual(skills[1]!.path, real);
      assert.deepStrictEqual(
        [...skillNames(skills)],
        ["broken", "factory", "plain", "session-capture"],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("cuts a long description to the limit on one line", () =>
    Effect.gen(function* () {
      const dir = tempDir("skills");
      const long = "word ".repeat(100);
      writeSkill(dir, "long", `---\ndescription: |\n  ${long}\n  second line\n---\n`);
      const [skill] = yield* listSkills([dir]);
      assert.strictEqual(skill?.description.length, DESCRIPTION_LIMIT);
      assert.notInclude(skill?.description ?? "", "\n");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("lists nothing when no dir exists", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* listSkills([NodePath.join(tempDir("skills"), "nope")]), []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("answers from the last scan until the TTL passes", () =>
    Effect.gen(function* () {
      __resetSkillsCacheForTests();
      const dir = tempDir("skills-cache");
      writeSkill(dir, "one", "---\nname: one\n---\n");
      const first = yield* listSkillsCached([dir]);
      assert.deepStrictEqual(
        first.map((skill) => skill.name),
        ["one"],
      );
      writeSkill(dir, "two", "---\nname: two\n---\n");
      const within = yield* listSkillsCached([dir]);
      assert.strictEqual(within, first);
      yield* TestClock.adjust(SKILLS_TTL_MS);
      const after = yield* listSkillsCached([dir]);
      assert.deepStrictEqual(
        after.map((skill) => skill.name),
        ["one", "two"],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
