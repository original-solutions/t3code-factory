import { createElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page as browser, userEvent } from "vite-plus/test/browser";

import { act } from "../../../test/render";
import { FactoryApiError } from "../api";
import { render } from "../testing";
import { __setPipelineApiForTests, type PipelineApi } from "./api";
import type { Catalog, Pipeline, Problem, RunDetail, RunSummary, Trace } from "./types";

type BlockerOptions = {
  readonly disabled?: boolean;
  readonly shouldBlockFn: () => Promise<boolean> | boolean;
};
const blocker = vi.hoisted(() => ({ options: null as BlockerOptions | null }));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ to, children }: { to: string; children?: ReactNode }) =>
    createElement("a", { "data-to": to }, children),
  // The page renders without a router (see ../testing); the latest options say what it blocks.
  useBlocker: (options: BlockerOptions) => {
    blocker.options = options;
  },
}));
const projects = vi.hoisted(() => [
  { id: "p1", environmentId: "env-1", title: "Factory", workspaceRoot: "/work/factory" },
  { id: "p2", environmentId: "env-1", title: "Site", workspaceRoot: "/work/site" },
]);
vi.mock("~/state/entities", () => ({ useProjects: () => projects }));

import { PipelineEditorPage } from "./PipelineEditorPage";

const PIPELINE: Pipeline = {
  id: "build-and-gate",
  name: "Build and gate",
  nodes: [
    { id: "start", kind: "start", x: 40, y: 200 },
    {
      id: "build",
      kind: "agent",
      label: "Build",
      x: 280,
      y: 200,
      instructions: { skill: "factory" },
    },
    { id: "done", kind: "end", result: "done", x: 520, y: 200 },
  ],
  edges: [
    { id: "e1", from: "start", port: "next", to: "build" },
    { id: "e2", from: "build", port: "done", to: "done" },
  ],
};

const CATALOG: Catalog = {
  kinds: [
    {
      kind: "start",
      label: "Start",
      description: "Where a run begins.",
      ports: [{ name: "next", meaning: "" }],
      instructions: "none",
    },
    {
      kind: "agent",
      label: "Agent",
      description: "An agent turn.",
      ports: [
        { name: "done", meaning: "" },
        { name: "questions", meaning: "" },
        { name: "stop", meaning: "" },
      ],
      instructions: "instructions",
    },
    {
      kind: "verify",
      label: "Verify",
      description: "Commands or a reviewer.",
      ports: [
        { name: "pass", meaning: "" },
        { name: "fail", meaning: "" },
      ],
      instructions: "check",
    },
    { kind: "end", label: "End", description: "The run ends.", ports: [], instructions: "none" },
  ],
  skills: [{ name: "factory", description: "Build one issue.", path: "/skills/factory" }],
  templates: [],
};

/** What the simulation answers for a script: start, then build, then done. */
const traceFor = (script: ReadonlyArray<string>): Trace => {
  if (script.length === 0)
    return {
      steps: [{ kind: "entered", node: "start" }],
      taken: {},
      end: { kind: "waiting", node: "start", ports: ["next"] },
    };
  if (script.length === 1)
    return {
      steps: [
        { kind: "entered", node: "start" },
        { kind: "outcome", node: "start", port: "next" },
        { kind: "moved", edge: "e1" },
        { kind: "entered", node: "build" },
      ],
      taken: { e1: 1 },
      end: { kind: "waiting", node: "build", ports: ["done", "questions", "stop"] },
    };
  return {
    steps: [{ kind: "entered", node: "done" }],
    taken: { e1: 1, e2: 1 },
    end: { kind: "ended", result: "done" },
  };
};

const RUN: RunSummary = {
  id: "run-1",
  pipelineId: PIPELINE.id,
  pipelineName: PIPELINE.name,
  projectRoot: "/work/factory",
  repo: null,
  issue: null,
  startedAt: "2026-10-25T09:00:00.000Z",
  endedAt: "2026-10-25T09:10:00.000Z",
  status: "done",
  node: "done",
  reason: null,
};

const RUN_DETAIL: RunDetail = {
  ...RUN,
  pipeline: {},
  events: [
    { event: "entered", node: "start", visit: 1, ms: 1 },
    { event: "moved", edge: "e1", ms: 2 },
    { event: "entered", node: "build", visit: 1, ms: 3 },
    { event: "moved", edge: "e2", ms: 4 },
    { event: "entered", node: "done", visit: 1, ms: 5 },
    { event: "ended", result: "done", reason: null, ms: 6 },
  ],
};

const REMEMBERED_KEY = "t3code:factory:pipeline-run-project:env-1";

function setup(overrides: Partial<PipelineApi> = {}) {
  window.localStorage.removeItem(REMEMBERED_KEY);
  const api: PipelineApi = {
    catalog: vi.fn(async () => CATALOG),
    list: vi.fn(),
    get: vi.fn(async () => ({
      pipeline: PIPELINE,
      problems: [],
      updatedAt: "2026-10-25T00:00:00.000Z",
    })),
    save: vi.fn(async (_environmentId, pipeline: Pipeline) => ({
      pipeline,
      problems: [],
      updatedAt: "2026-10-25T00:00:01.000Z",
    })),
    remove: vi.fn(),
    validate: vi.fn(async () => ({ problems: [] as ReadonlyArray<Problem> })),
    simulate: vi.fn(async (_environmentId, _pipeline, script: ReadonlyArray<string>) => ({
      trace: traceFor(script),
    })),
    run: vi.fn(),
    runs: vi.fn(async () => ({ runs: [] })),
    runDetail: vi.fn(),
    stopRun: vi.fn(),
    ...overrides,
  };
  __setPipelineApiForTests(api);
  return {
    api,
    [Symbol.dispose]: () => {
      __setPipelineApiForTests();
      window.localStorage.removeItem(REMEMBERED_KEY);
    },
  };
}

const mount = async () => {
  // Held by the stack until the wait succeeds, so a failed wait still unmounts.
  await using stack = new AsyncDisposableStack();
  const screen = stack.use(
    await render(
      createElement(PipelineEditorPage, {
        environmentId: "env-1" as never,
        pipelineId: PIPELINE.id,
      }),
    ),
  );
  await expect.element(browser.getByRole("button", { name: "Build node" })).toBeVisible();
  stack.move();
  return screen;
};

describe("PipelineEditorPage", () => {
  it("loads the pipeline and draws its nodes and transitions", async () => {
    using _api = setup();
    await using _screen = await mount();
    await expect.element(browser.getByRole("button", { name: "Start node" })).toBeVisible();
    await expect.element(browser.getByRole("button", { name: "Done node" })).toBeVisible();
    await expect
      .element(browser.getByRole("button", { name: "Transition next from start to build" }))
      .toBeVisible();
    await expect.element(browser.getByRole("button", { name: "Status: Valid" })).toBeVisible();
  });

  it("says why a pipeline file cannot be read", async () => {
    using _api = setup({
      get: vi.fn(async () => {
        throw new FactoryApiError(422, "invalid_pipeline", "invalid", {
          code: "invalid_pipeline",
          errors: [{ path: "edges", message: "must be a list" }],
        });
      }),
    });
    await using _screen = await render(
      createElement(PipelineEditorPage, { environmentId: "env-1" as never, pipelineId: "broken" }),
    );
    await expect.element(browser.getByText("Pipeline broken is unreadable")).toBeVisible();
    await expect.element(browser.getByRole("listitem")).toHaveTextContent("edges must be a list");
  });

  it("shows a selected node's fields", async () => {
    using _api = setup();
    await using _screen = await mount();
    await userEvent.click(browser.getByRole("button", { name: "Build node" }));
    await expect.element(browser.getByLabelText("Label")).toHaveValue("Build");
    await expect
      .element(browser.getByRole("combobox", { name: "Pick a skill" }))
      .toHaveTextContent("factory");
    await expect.element(browser.getByText("Build one issue.")).toBeVisible();
  });

  it("renames a node from the inspector and marks the pipeline unsaved", async () => {
    using _api = setup();
    await using _screen = await mount();
    const save = browser.getByRole("button", { name: "Save" });
    await expect.element(save).toBeDisabled();
    await userEvent.click(browser.getByRole("button", { name: "Build node" }));
    await userEvent.fill(browser.getByLabelText("Label"), "Implement");
    await expect.element(browser.getByRole("button", { name: "Implement node" })).toBeVisible();
    await expect.element(save).toBeEnabled();
  });

  it("adds a node of the kind picked from Add", async () => {
    using _api = setup();
    await using _screen = await mount();
    await userEvent.click(browser.getByRole("button", { name: "Add" }));
    await userEvent.click(browser.getByRole("menuitem", { name: /Verify/ }));
    await expect.element(browser.getByRole("button", { name: "Verify node" })).toBeVisible();
    // The new node is selected, so its check is what the inspector shows.
    await expect.element(browser.getByRole("button", { name: "Commands" })).toBeVisible();
  });

  it("shows the server's problems in the status chip and on their node", async () => {
    using _api = setup({
      validate: vi.fn(async () => ({
        problems: [
          { level: "error", node: "build", message: "There is no skill named nosuch." },
        ] as ReadonlyArray<Problem>,
      })),
    });
    await using _screen = await mount();
    await userEvent.fill(browser.getByLabelText("Pipeline name"), "Build and check");
    await expect.element(browser.getByRole("button", { name: "Status: 1 error" })).toBeVisible();
    await expect
      .element(browser.getByRole("img", { name: "Error: There is no skill named nosuch." }))
      .toBeInTheDocument();
  });

  it("sends a new gate with an empty command list, and shows what the server says about it", async () => {
    using api = setup({
      validate: vi.fn(async (_environmentId, pipeline: Pipeline) => ({
        problems: pipeline.nodes.some((node) => node.kind === "verify")
          ? ([
              {
                level: "error",
                node: "verify",
                message: "Verify has no commands: add at least one, one per line",
              },
            ] as ReadonlyArray<Problem>)
          : [],
      })),
    });
    await using _screen = await mount();
    await userEvent.click(browser.getByRole("button", { name: "Add" }));
    await userEvent.click(browser.getByRole("menuitem", { name: /Verify/ }));
    await expect.element(browser.getByRole("button", { name: "Status: 1 error" })).toBeVisible();
    await expect
      .element(
        browser.getByRole("img", {
          name: "Error: Verify has no commands: add at least one, one per line",
        }),
      )
      .toBeInTheDocument();
    const sent = vi.mocked(api.api.validate).mock.calls.at(-1)![1];
    expect(sent.nodes.at(-1)).toMatchObject({ kind: "verify", check: { commands: [] } });
  });

  it("sends a new agent with an empty brief", async () => {
    using api = setup();
    await using _screen = await mount();
    await userEvent.click(browser.getByRole("button", { name: "Add" }));
    await userEvent.click(browser.getByRole("menuitem", { name: /Agent/ }));
    await userEvent.click(browser.getByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(api.api.save).toHaveBeenCalledTimes(1));
    const saved = vi.mocked(api.api.save).mock.calls[0]![1];
    expect(saved.nodes.at(-1)).toMatchObject({
      kind: "agent",
      instructions: { brief: "" },
    });
  });

  it("walks the simulation through the outcomes picked", async () => {
    using api = setup();
    await using _screen = await mount();
    await userEvent.click(browser.getByRole("button", { name: "Simulate" }));
    await expect.element(browser.getByText("At Start. What happens next?")).toBeVisible();
    await userEvent.click(browser.getByRole("button", { name: "next", exact: true }));
    await expect.element(browser.getByText("At Build. What happens next?")).toBeVisible();
    await expect
      .element(browser.getByRole("button", { name: "questions", exact: true }))
      .toBeVisible();
    await userEvent.click(browser.getByRole("button", { name: "done", exact: true }));
    await expect.element(browser.getByText("Ended done")).toBeVisible();
    expect(api.api.simulate).toHaveBeenLastCalledWith("env-1", PIPELINE, ["next", "done"]);
    await userEvent.click(browser.getByRole("button", { name: "Undo last" }));
    await expect.element(browser.getByText("At Build. What happens next?")).toBeVisible();
  });

  it("saves the edited pipeline and is clean again", async () => {
    using api = setup();
    await using _screen = await mount();
    await userEvent.fill(browser.getByLabelText("Pipeline name"), "Build, gate and ship");
    const save = browser.getByRole("button", { name: "Save" });
    await userEvent.click(save);
    await expect.element(save).toBeDisabled();
    expect(api.api.save).toHaveBeenCalledWith("env-1", {
      ...PIPELINE,
      name: "Build, gate and ship",
    });
  });

  it("saves with Ctrl+S", async () => {
    using api = setup();
    await using _screen = await mount();
    await userEvent.fill(browser.getByLabelText("Pipeline name"), "Renamed");
    await userEvent.click(browser.getByRole("button", { name: "Build node" }));
    await userEvent.keyboard("{Control>}s{/Control}");
    await expect.element(browser.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(api.api.save).toHaveBeenCalledTimes(1);
  });

  it("deletes the selected node with Delete, and Escape clears the selection", async () => {
    using _api = setup();
    await using _screen = await mount();
    await userEvent.click(browser.getByRole("button", { name: "Done node" }));
    await expect.element(browser.getByRole("button", { name: "Delete node" })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect
      .element(browser.getByRole("button", { name: "Delete node" }))
      .not.toBeInTheDocument();
    await userEvent.click(browser.getByRole("button", { name: "Done node" }));
    await userEvent.keyboard("{Delete}");
    await expect
      .element(browser.getByRole("button", { name: "Done node" }))
      .not.toBeInTheDocument();
    await expect
      .element(browser.getByRole("button", { name: "Transition done from build to done" }))
      .not.toBeInTheDocument();
  });

  it("leaves the node alone when Delete or Backspace is typed in the inspector", async () => {
    using _api = setup();
    await using _screen = await mount();
    await userEvent.click(browser.getByRole("button", { name: "Build node" }));
    const label = browser.getByLabelText("Label");
    await userEvent.click(label);
    await userEvent.keyboard("{End}{Backspace}{Delete}");
    await expect.element(label).toHaveValue("Buil");
    await expect.element(browser.getByRole("button", { name: "Buil node" })).toBeVisible();
  });

  it("paints a selected run's trail and clears it on going back to Inspect", async () => {
    using _api = setup({
      runs: vi.fn(async () => ({ runs: [RUN] })),
      runDetail: vi.fn(async () => ({ run: RUN_DETAIL })),
    });
    await using _screen = await mount();
    await userEvent.click(browser.getByRole("button", { name: "Runs (1)" }));
    await userEvent.click(browser.getByRole("button", { name: /\/work\/factory/ }));
    await expect.element(browser.getByRole("list", { name: "Run events" })).toBeVisible();
    const end = browser.getByRole("button", { name: "Done node" });
    await expect.element(end).toHaveAttribute("aria-current", "step");
    await userEvent.click(browser.getByRole("button", { name: "Inspect" }));
    await expect.element(end).not.toHaveAttribute("aria-current");
  });

  it("remembers the project last run on, so the next run is one click", async () => {
    using api = setup({ run: vi.fn(async () => ({ run: RUN })) });
    {
      await using _first = await mount();
      await userEvent.click(browser.getByRole("button", { name: "Run" }));
      await userEvent.click(browser.getByRole("combobox", { name: "Project" }));
      await userEvent.click(browser.getByRole("option", { name: /Site/ }));
      await userEvent.keyboard("{Escape}");
    }
    await using _second = await mount();
    await userEvent.click(browser.getByRole("button", { name: "Run" }));
    await expect
      .element(browser.getByRole("combobox", { name: "Project" }))
      .toHaveTextContent("Site");
    expect(api.api.run).not.toHaveBeenCalled();
  });

  it("undoes and redoes an edit from the keyboard", async () => {
    using _api = setup();
    await using _screen = await mount();
    await userEvent.click(browser.getByRole("button", { name: "Done node" }));
    await userEvent.keyboard("{Delete}");
    await expect
      .element(browser.getByRole("button", { name: "Done node" }))
      .not.toBeInTheDocument();
    await userEvent.keyboard("{Control>}z{/Control}");
    await expect.element(browser.getByRole("button", { name: "Done node" })).toBeVisible();
    await expect.element(browser.getByRole("button", { name: "Save" })).toBeDisabled();
    await userEvent.keyboard("{Control>}{Shift>}z{/Shift}{/Control}");
    await expect
      .element(browser.getByRole("button", { name: "Done node" }))
      .not.toBeInTheDocument();
  });

  it("undo back to the loaded pipeline shows the problems it loaded with, not the edit's", async () => {
    using _api = setup({
      validate: vi.fn(async (_environmentId, pipeline: Pipeline) => ({
        problems: pipeline.nodes.some((node) => node.kind === "end")
          ? []
          : ([{ level: "error", message: "The pipeline has no end." }] as ReadonlyArray<Problem>),
      })),
    });
    await using _screen = await mount();
    await userEvent.click(browser.getByRole("button", { name: "Done node" }));
    await userEvent.keyboard("{Delete}");
    await expect.element(browser.getByRole("button", { name: "Status: 1 error" })).toBeVisible();
    await userEvent.keyboard("{Control>}z{/Control}");
    await expect.element(browser.getByRole("button", { name: "Done node" })).toBeVisible();
    await expect.element(browser.getByRole("button", { name: "Status: Valid" })).toBeVisible();
  });

  it("shows a failed read of the runs with a Retry that reads again", async () => {
    let failing = true;
    using _api = setup({
      runs: vi.fn(async () => {
        if (failing) throw new Error("the factory is away");
        return { runs: [RUN] };
      }),
    });
    await using _screen = await mount();
    await userEvent.click(browser.getByRole("button", { name: "Runs" }));
    await expect
      .element(browser.getByText("Could not read runs: the factory is away"))
      .toBeVisible();
    failing = false;
    await userEvent.click(browser.getByRole("button", { name: "Retry runs" }));
    await expect.element(browser.getByRole("button", { name: /\/work\/factory/ })).toBeVisible();
  });

  it("asks before leaving with unsaved edits, and not when clean", async () => {
    using _api = setup();
    await using _screen = await mount();
    expect(blocker.options?.disabled).toBe(true);
    await userEvent.fill(browser.getByLabelText("Pipeline name"), "Renamed");
    await vi.waitFor(() => expect(blocker.options?.disabled).toBe(false));
    // No themed confirm host is mounted here, so the page falls back to the browser's confirm.
    {
      using _stay = vi.spyOn(window, "confirm").mockReturnValue(false);
      expect(await blocker.options!.shouldBlockFn()).toBe(true);
    }
    using _leave = vi.spyOn(window, "confirm").mockReturnValue(true);
    expect(await blocker.options!.shouldBlockFn()).toBe(false);
  });

  it("drops a happy path still walking when the simulation is turned off", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    using api = setup({
      simulate: vi.fn(async (_environmentId, _pipeline, script: ReadonlyArray<string>) => {
        if (script.length === 1) await held;
        return { trace: traceFor(script) };
      }),
    });
    await using _screen = await mount();
    await userEvent.click(browser.getByRole("button", { name: "Simulate" }));
    await expect.element(browser.getByText("At Start. What happens next?")).toBeVisible();
    await userEvent.click(browser.getByRole("button", { name: "Happy path" }));
    await vi.waitFor(() =>
      expect(
        vi.mocked(api.api.simulate).mock.calls.some(([, , script]) => script.length === 1),
      ).toBe(true),
    );
    await userEvent.click(browser.getByRole("button", { name: "Simulate" }));
    await expect
      .element(browser.getByRole("region", { name: "Simulation" }))
      .not.toBeInTheDocument();
    const walking = vi.mocked(api.api.simulate).mock.results.at(-1)!.value as Promise<unknown>;
    release();
    // The happy path's own continuation runs first, then act flushes whatever it set.
    await act(async () => {
      await walking;
    });
    expect(document.querySelector('[aria-label="Simulation"]')).toBeNull();
    await expect
      .element(browser.getByRole("button", { name: "Simulate" }))
      .toHaveAttribute("aria-pressed", "false");
  });

  it("selects a node from the keyboard", async () => {
    using _api = setup();
    await using _screen = await mount();
    browser.getByRole("button", { name: "Done node" }).element().focus();
    await userEvent.keyboard("{Enter}");
    await expect
      .element(browser.getByRole("button", { name: "Done node" }))
      .toHaveAttribute("aria-pressed", "true");
    await expect.element(browser.getByRole("button", { name: "Delete node" })).toBeVisible();
  });
});
