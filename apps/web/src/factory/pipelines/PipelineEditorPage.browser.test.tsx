import { createElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page as browser, userEvent } from "vite-plus/test/browser";

import { FactoryApiError } from "../api";
import { render } from "../testing";
import { __setPipelineApiForTests, type PipelineApi } from "./api";
import type { Catalog, Pipeline, Problem, Trace } from "./types";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ to, children }: { to: string; children?: ReactNode }) =>
    createElement("a", { "data-to": to }, children),
}));
vi.mock("~/state/entities", () => ({ useProjects: () => [] }));

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
      fresh: false,
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

function setup(overrides: Partial<PipelineApi> = {}) {
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
  return { api, [Symbol.dispose]: () => __setPipelineApiForTests() };
}

const mount = async () => {
  const screen = await render(
    createElement(PipelineEditorPage, { environmentId: "env-1" as never, pipelineId: PIPELINE.id }),
  );
  await expect.element(browser.getByRole("button", { name: "Build node" })).toBeVisible();
  return screen;
};

describe("PipelineEditorPage", () => {
  it("loads the pipeline and draws its nodes and transitions", async () => {
    using _api = setup();
    await using _screen = await mount();
    await expect.element(browser.getByRole("button", { name: "Start node" })).toBeVisible();
    await expect.element(browser.getByRole("button", { name: "End node" })).toBeVisible();
    await expect
      .element(browser.getByRole("button", { name: "Transition next from start to build" }))
      .toBeVisible();
    await expect.element(browser.getByRole("button", { name: "Status: Valid" })).toBeVisible();
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
    await expect.element(browser.getByRole("switch")).not.toBeChecked();
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

  it("marks the fields the server could not decode on their node", async () => {
    using _api = setup({
      validate: vi.fn(async () => {
        throw new FactoryApiError(422, "invalid_pipeline", "invalid", {
          code: "invalid_pipeline",
          errors: [
            {
              path: "nodes.3.check.commands",
              message: "must be a list of at least one command line",
            },
          ],
        });
      }),
    });
    await using _screen = await mount();
    await userEvent.click(browser.getByRole("button", { name: "Add" }));
    await userEvent.click(browser.getByRole("menuitem", { name: /Verify/ }));
    await expect.element(browser.getByRole("button", { name: "Status: 1 error" })).toBeVisible();
    await expect
      .element(
        browser.getByRole("img", {
          name: "Error: check.commands must be a list of at least one command line",
        }),
      )
      .toBeInTheDocument();
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
    await userEvent.click(browser.getByRole("button", { name: "End node" }));
    await expect.element(browser.getByRole("button", { name: "Delete node" })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect
      .element(browser.getByRole("button", { name: "Delete node" }))
      .not.toBeInTheDocument();
    await userEvent.click(browser.getByRole("button", { name: "End node" }));
    await userEvent.keyboard("{Delete}");
    await expect.element(browser.getByRole("button", { name: "End node" })).not.toBeInTheDocument();
    await expect
      .element(browser.getByRole("button", { name: "Transition done from build to done" }))
      .not.toBeInTheDocument();
  });
});
