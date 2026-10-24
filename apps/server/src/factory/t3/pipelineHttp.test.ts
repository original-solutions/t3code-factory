// @effect-diagnostics nodeBuiltinImport:off - the tests lay out real skill dirs and read pipeline files back.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type AuthEnvironmentScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import { describe } from "vite-plus/test";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { useTempDirs } from "../ledger/testSupport.ts";
import { buildAndGate, buildAndLearn } from "../pipeline/fixtures.ts";
import { encodePipeline, KINDS, type Pipeline } from "../pipeline/model.ts";
import {
  PipelineRunError,
  PipelineRuns,
  type RunDetail,
  type RunSummary,
  type StartRequest,
} from "../pipeline/runsService.ts";
import { PipelineSkillDirs } from "../pipeline/skills.ts";
import { FactoryPaths } from "./paths.ts";
import { PipelineRoutes } from "./pipelineHttp.ts";

const layerEnvironmentAuth = EnvironmentAuth.layer.pipe(
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.layerIdentity),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-factory-pipelines-test-" })),
  Layer.provide(NodeServices.layer),
);

const layerRoutes = PipelineRoutes.pipe(
  Layer.provideMerge(
    HttpPlatform.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(Etag.layerWeak),
    ),
  ),
);

const tempDir = useTempDirs();

const SUMMARY: RunSummary = {
  id: "run-1",
  pipelineId: buildAndGate.id,
  pipelineName: buildAndGate.name,
  projectRoot: "/work/app",
  repo: "rawphp/app",
  issue: 7,
  startedAt: "2026-10-25T00:00:00.000Z",
  endedAt: null,
  status: "running",
  node: "build",
  reason: null,
};

const DETAIL: RunDetail = { ...SUMMARY, pipeline: encodePipeline(buildAndGate), events: [] };

/** What the fake PipelineRuns was asked, and how it answers. */
interface RunsWorld {
  readonly started: Array<StartRequest>;
  readonly stopped: Array<string>;
  readonly listed: Array<string | undefined>;
  /** `start` fails with this kind instead. */
  startFails?: PipelineRunError["kind"];
}

const fakeRuns = (world: RunsWorld) =>
  PipelineRuns.of({
    start: (request) => {
      world.started.push(request);
      return world.startFails === undefined
        ? Effect.succeed(SUMMARY)
        : Effect.fail(new PipelineRunError({ kind: world.startFails, message: "refused" }));
    },
    stop: (id) => {
      world.stopped.push(id);
      return id === SUMMARY.id
        ? Effect.succeed({ ...SUMMARY, status: "stopped" as const })
        : Effect.fail(new PipelineRunError({ kind: "not-found", message: `no run ${id}` }));
    },
    list: (pipelineId) => {
      world.listed.push(pipelineId);
      return Effect.succeed([SUMMARY]);
    },
    get: (id) =>
      id === SUMMARY.id
        ? Effect.succeed(DETAIL)
        : Effect.fail(new PipelineRunError({ kind: "not-found", message: `no run ${id}` })),
  });

type Call = (
  method: "GET" | "POST",
  path: string,
  token?: string,
  body?: unknown,
) => Promise<Response>;

interface Tokens {
  readonly read: string;
  readonly operate: string;
  readonly settingsWrite: string;
}

/** A skills dir holding `factory`, `session-capture` and `review-gate`, the fixtures' skills. */
const skillsDir = (root: string) => {
  const dir = NodePath.join(root, "skills");
  for (const name of ["factory", "session-capture", "review-gate"]) {
    NodeFS.mkdirSync(NodePath.join(dir, name), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(dir, name, "SKILL.md"),
      `---\nname: ${name}\ndescription: The ${name} skill.\n---\n`,
    );
  }
  return dir;
};

/**
 * Runs `use` against the pipeline routes behind T3's auth, with a factory dir and a skills dir in
 * a temp directory and a fake PipelineRuns recording into `runs`.
 */
const serving = <A>(
  use: (
    call: Call,
    context: { readonly tokens: Tokens; readonly dir: string; readonly runs: RunsWorld },
  ) => Promise<A>,
) =>
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const dir = tempDir("pipelines");
    const runs: RunsWorld = { started: [], stopped: [], listed: [] };
    const context = Context.make(EnvironmentAuth.EnvironmentAuth, auth).pipe(
      Context.add(FactoryPaths, {
        baseDir: dir,
        worktreesDir: NodePath.join(dir, "worktrees"),
        factoryDir: dir,
        machineConfigPath: NodePath.join(dir, "config.yml"),
      }),
      Context.add(PipelineRuns, fakeRuns(runs)),
      Context.add(PipelineSkillDirs, [skillsDir(dir), NodePath.join(dir, "missing")]),
    );
    // Issued on the live clock: the handler checks expiry on it, not on the test clock.
    const issue = (scope: AuthEnvironmentScope) =>
      auth.issueSession({ scopes: [scope] }).pipe(
        TestClock.withLive,
        Effect.map((session) => session.token),
      );
    const tokens: Tokens = {
      read: yield* issue(AuthOrchestrationReadScope),
      operate: yield* issue(AuthOrchestrationOperateScope),
      settingsWrite: yield* issue(AuthSettingsWriteScope),
    };
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(layerRoutes, { disableLogger: true })),
      ({ handler }) =>
        Effect.tryPromise(() =>
          use(
            (method, path, token, body) =>
              handler(
                new Request(`http://127.0.0.1${path}`, {
                  method,
                  headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
                  ...(body === undefined
                    ? {}
                    : { body: typeof body === "string" ? body : JSON.stringify(body) }),
                }),
                context,
              ),
            { tokens, dir, runs },
          ),
        ),
      ({ dispose }) => Effect.promise(dispose),
    );
  }).pipe(Effect.provide(layerEnvironmentAuth));

const json = async (response: Response) => (await response.json()) as Record<string, unknown>;

const BASE = "/api/factory/pipelines";

/** Saves `pipeline` with a settings token and checks it was accepted. */
const save = async (call: Call, tokens: Tokens, pipeline: Pipeline) => {
  const response = await call(
    "POST",
    `${BASE}/${pipeline.id}`,
    tokens.settingsWrite,
    encodePipeline(pipeline),
  );
  assert.strictEqual(response.status, 200);
  return json(response);
};

/** buildAndGate with its agent naming a skill this machine does not have: a run refuses it. */
const unknownSkill: Pipeline = {
  ...buildAndGate,
  id: "unknown-skill",
  nodes: buildAndGate.nodes.map((node) =>
    node.kind === "agent" ? { ...node, instructions: { skill: "not-installed" } } : node,
  ),
};

describe("the pipeline routes", () => {
  it.effect("answers 401 without credentials", () =>
    serving(async (call) => {
      for (const path of [BASE, `${BASE}/catalog`, `${BASE}/runs`]) {
        assert.strictEqual((await call("GET", path)).status, 401, path);
      }
    }),
  );

  it.effect("refuses a write or a run to a session with only read", () =>
    serving(async (call, { tokens, dir }) => {
      const body = encodePipeline(buildAndGate);
      for (const path of [
        `${BASE}/${buildAndGate.id}`,
        `${BASE}/${buildAndGate.id}/delete`,
        `${BASE}/${buildAndGate.id}/run`,
        `${BASE}/runs/run-1/stop`,
      ]) {
        const response = await call("POST", path, tokens.read, body);
        assert.strictEqual(response.status, 403, path);
        assert.strictEqual((await json(response)).code, "insufficient_scope");
      }
      assert.isFalse(NodeFS.existsSync(NodePath.join(dir, "pipelines")));
    }),
  );

  it.effect("needs settings:write to save, not operate", () =>
    serving(async (call, { tokens }) => {
      const response = await call(
        "POST",
        `${BASE}/${buildAndGate.id}`,
        tokens.operate,
        encodePipeline(buildAndGate),
      );
      assert.strictEqual(response.status, 403);
    }),
  );

  it.effect("serves the kinds and the skills on the machine as the catalog", () =>
    serving(async (call, { tokens }) => {
      const response = await call("GET", `${BASE}/catalog`, tokens.read);
      assert.strictEqual(response.status, 200);
      const body = await json(response);
      assert.deepStrictEqual(body["kinds"], JSON.parse(JSON.stringify(KINDS)));
      assert.deepStrictEqual(
        (body["templates"] as Array<{ id: string; pipeline: { nodes: Array<unknown> } }>).map(
          (template) => [template.id, template.pipeline.nodes.length],
        ),
        [
          ["brief-and-gate", 5],
          ["build-review-ship", 8],
          ["learning-loop", 11],
        ],
      );
      assert.deepStrictEqual(
        (body["skills"] as Array<{ name: string; description: string }>).map((skill) => [
          skill.name,
          skill.description,
        ]),
        [
          ["factory", "The factory skill."],
          ["review-gate", "The review-gate skill."],
          ["session-capture", "The session-capture skill."],
        ],
      );
    }),
  );

  it.effect("saves a pipeline and answers it back, as GET does, with its problems", () =>
    serving(async (call, { tokens, dir }) => {
      const saved = await save(call, tokens, buildAndLearn);
      assert.deepStrictEqual(saved["pipeline"], encodePipeline(buildAndLearn));
      assert.deepStrictEqual(saved["problems"], []);
      assert.isString(saved["updatedAt"]);
      assert.isTrue(NodeFS.existsSync(NodePath.join(dir, "pipelines", "build-and-learn.yml")));

      const got = await call("GET", `${BASE}/build-and-learn`, tokens.read);
      assert.strictEqual(got.status, 200);
      assert.deepStrictEqual(await json(got), saved);
    }),
  );

  it.effect(
    "saves a pipeline with errors as a draft, and lists every pipeline with its counts",
    () =>
      serving(async (call, { tokens }) => {
        await save(call, tokens, buildAndGate);
        const draft = await save(call, tokens, unknownSkill);
        assert.deepStrictEqual(
          (draft["problems"] as Array<{ level: string; node?: string }>).map((p) => [
            p.level,
            p.node,
          ]),
          [["error", "build"]],
        );
        const listed = await json(await call("GET", BASE, tokens.read));
        assert.deepStrictEqual(
          (listed["pipelines"] as Array<Record<string, unknown>>).map(
            (entry): Record<string, unknown> => ({
              ...entry,
              updatedAt: typeof entry["updatedAt"],
            }),
          ),
          [
            {
              id: "build-and-gate",
              name: "Build and gate",
              nodes: 5,
              edges: 6,
              errors: 0,
              warnings: 0,
              updatedAt: "string",
            },
            {
              id: "unknown-skill",
              name: "Build and gate",
              nodes: 5,
              edges: 6,
              errors: 1,
              warnings: 0,
              updatedAt: "string",
            },
          ],
        );
      }),
  );

  it.effect("refuses a body that is not JSON, one the model refuses, and one for another id", () =>
    serving(async (call, { tokens, dir }) => {
      const notJson = await call("POST", `${BASE}/x`, tokens.settingsWrite, "{not json");
      assert.strictEqual(notJson.status, 400);
      assert.strictEqual((await json(notJson)).code, "invalid_body");

      const bad = await call("POST", `${BASE}/x`, tokens.settingsWrite, {
        id: "x",
        name: "X",
        nodes: 1,
      });
      assert.strictEqual(bad.status, 422);
      const badBody = await json(bad);
      assert.strictEqual(badBody["code"], "invalid_pipeline");
      assert.deepStrictEqual(badBody["errors"], [
        { path: "nodes", message: "must be a list" },
        { path: "edges", message: "must be a list" },
      ]);

      const mismatch = await call(
        "POST",
        `${BASE}/other`,
        tokens.settingsWrite,
        encodePipeline(buildAndGate),
      );
      assert.strictEqual(mismatch.status, 400);
      assert.strictEqual((await json(mismatch)).code, "id_mismatch");
      assert.isFalse(NodeFS.existsSync(NodePath.join(dir, "pipelines")));
    }),
  );

  it.effect("refuses to save a pipeline whose id is one of the routes' own paths", () =>
    serving(async (call, { tokens }) => {
      const response = await call("POST", `${BASE}/runs`, tokens.settingsWrite, {
        ...encodePipeline(buildAndGate),
        id: "runs",
      });
      assert.strictEqual(response.status, 400);
      assert.strictEqual((await json(response)).code, "reserved_id");
    }),
  );

  it.effect("answers 404 for a pipeline that is not there", () =>
    serving(async (call, { tokens }) => {
      const response = await call("GET", `${BASE}/missing`, tokens.read);
      assert.strictEqual(response.status, 404);
      assert.strictEqual((await json(response)).code, "pipeline_not_found");
    }),
  );

  it.effect("answers a file edited into something the model refuses as 422 with its errors", () =>
    serving(async (call, { tokens, dir }) => {
      NodeFS.mkdirSync(NodePath.join(dir, "pipelines"));
      NodeFS.writeFileSync(
        NodePath.join(dir, "pipelines", "hand.yml"),
        "id: hand\nname: Hand\nnodes: []\nedges: 3\n",
      );
      const got = await call("GET", `${BASE}/hand`, tokens.read);
      assert.strictEqual(got.status, 422);
      const listed = await json(await call("GET", BASE, tokens.read));
      const [entry] = listed["pipelines"] as Array<Record<string, unknown>>;
      assert.strictEqual(entry?.["unreadable"], true);
      assert.deepStrictEqual(entry?.["decodeErrors"], [
        { path: "edges", message: "must be a list" },
      ]);
    }),
  );

  it.effect("deletes a pipeline, then answers 404 for it", () =>
    serving(async (call, { tokens }) => {
      await save(call, tokens, buildAndGate);
      const deleted = await call("POST", `${BASE}/build-and-gate/delete`, tokens.settingsWrite);
      assert.deepStrictEqual(await json(deleted), { deleted: true });
      assert.strictEqual((await call("GET", `${BASE}/build-and-gate`, tokens.read)).status, 404);
      const again = await call("POST", `${BASE}/build-and-gate/delete`, tokens.settingsWrite);
      assert.strictEqual(again.status, 404);
    }),
  );

  it.effect("validates a body without saving it", () =>
    serving(async (call, { tokens, dir }) => {
      const response = await call(
        "POST",
        `${BASE}/validate`,
        tokens.read,
        encodePipeline(unknownSkill),
      );
      assert.strictEqual(response.status, 200);
      const { problems } = (await json(response)) as { problems: Array<{ message: string }> };
      assert.lengthOf(problems, 1);
      assert.include(problems[0]!.message, "not-installed");
      assert.isFalse(NodeFS.existsSync(NodePath.join(dir, "pipelines")));

      const bad = await call("POST", `${BASE}/validate`, tokens.read, { id: "x" });
      assert.strictEqual(bad.status, 422);
    }),
  );

  it.effect("simulates a script of outcomes and answers the trace", () =>
    serving(async (call, { tokens }) => {
      const response = await call("POST", `${BASE}/simulate`, tokens.read, {
        pipeline: encodePipeline(buildAndGate),
        script: ["next", "done", "pass"],
      });
      assert.strictEqual(response.status, 200);
      const { trace } = (await json(response)) as {
        trace: { steps: Array<{ kind: string; node?: string }>; end: unknown };
      };
      assert.deepStrictEqual(
        trace.steps.filter((step) => step.kind === "entered").map((step) => step.node),
        ["start", "build", "gate", "done"],
      );
      assert.deepStrictEqual(trace.end, { kind: "ended", result: "done" });

      const noScript = await call("POST", `${BASE}/simulate`, tokens.read, {
        pipeline: encodePipeline(buildAndGate),
        script: [1],
      });
      assert.strictEqual(noScript.status, 400);
      const badPipeline = await call("POST", `${BASE}/simulate`, tokens.read, {
        pipeline: { id: "x" },
        script: [],
      });
      assert.strictEqual(badPipeline.status, 422);
    }),
  );

  it.effect("starts a run of a valid pipeline with the pipeline as stored", () =>
    serving(async (call, { tokens, runs }) => {
      await save(call, tokens, buildAndGate);
      const response = await call("POST", `${BASE}/build-and-gate/run`, tokens.operate, {
        projectRoot: "/work/app",
        issue: 7,
      });
      assert.strictEqual(response.status, 200);
      assert.deepStrictEqual((await json(response))["run"], SUMMARY);
      assert.deepStrictEqual(runs.started, [
        { pipeline: buildAndGate, projectRoot: "/work/app", issue: 7 },
      ]);

      await call("POST", `${BASE}/build-and-gate/run`, tokens.operate, {
        projectRoot: "/work/app",
      });
      assert.strictEqual(runs.started[1]?.issue, null);
    }),
  );

  it.effect("refuses to run a pipeline with errors, a missing one, and a bad body", () =>
    serving(async (call, { tokens, runs }) => {
      await save(call, tokens, unknownSkill);
      const invalid = await call("POST", `${BASE}/unknown-skill/run`, tokens.operate, {
        projectRoot: "/work/app",
      });
      assert.strictEqual(invalid.status, 409);
      const body = await json(invalid);
      assert.strictEqual(body["code"], "invalid_pipeline");
      assert.lengthOf(body["problems"] as Array<unknown>, 1);

      const missing = await call("POST", `${BASE}/missing/run`, tokens.operate, {
        projectRoot: "/work/app",
      });
      assert.strictEqual(missing.status, 404);
      const noRoot = await call("POST", `${BASE}/unknown-skill/run`, tokens.operate, { issue: 3 });
      assert.strictEqual(noRoot.status, 400);
      assert.deepStrictEqual(runs.started, []);
    }),
  );

  it.effect(
    "answers 404 no_project when the run has no T3 project, and 500 for an io failure",
    () =>
      serving(async (call, { tokens, runs }) => {
        await save(call, tokens, buildAndGate);
        runs.startFails = "no-project";
        const noProject = await call("POST", `${BASE}/build-and-gate/run`, tokens.operate, {
          projectRoot: "/nowhere",
        });
        assert.strictEqual(noProject.status, 404);
        assert.strictEqual((await json(noProject)).code, "no_project");

        runs.startFails = "io";
        const io = await call("POST", `${BASE}/build-and-gate/run`, tokens.operate, {
          projectRoot: "/work/app",
        });
        assert.strictEqual(io.status, 500);
        assert.deepStrictEqual(await json(io), { code: "factory_error", message: "refused" });
      }),
  );

  it.effect("lists, shows and stops runs through PipelineRuns", () =>
    serving(async (call, { tokens, runs }) => {
      const all = await json(await call("GET", `${BASE}/runs`, tokens.read));
      assert.deepStrictEqual(all["runs"], [SUMMARY]);
      await call("GET", `${BASE}/runs?pipeline=build-and-gate`, tokens.read);
      assert.deepStrictEqual(runs.listed, [undefined, "build-and-gate"]);

      const shown = await call("GET", `${BASE}/runs/run-1`, tokens.read);
      assert.deepStrictEqual((await json(shown))["run"], DETAIL);
      const unknown = await call("GET", `${BASE}/runs/run-9`, tokens.read);
      assert.strictEqual(unknown.status, 404);
      assert.strictEqual((await json(unknown)).code, "run_not_found");

      const stopped = await call("POST", `${BASE}/runs/run-1/stop`, tokens.operate);
      assert.strictEqual(((await json(stopped))["run"] as RunSummary).status, "stopped");
      assert.strictEqual(
        (await call("POST", `${BASE}/runs/run-9/stop`, tokens.operate)).status,
        404,
      );
      assert.deepStrictEqual(runs.stopped, ["run-1", "run-9"]);
    }),
  );
});
