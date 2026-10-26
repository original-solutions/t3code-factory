import { createElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page as browser, userEvent } from "vite-plus/test/browser";

import { render } from "../testing";
import { __setPipelineApiForTests, type PipelineApi } from "./api";
import type { Catalog, Pipeline, PipelineListItem } from "./types";

const state = vi.hoisted(() => ({
  navigations: [] as Array<{ to: string; params?: Record<string, string> }>,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({
    to,
    params,
    children,
  }: {
    to: string;
    params?: Record<string, string>;
    children?: ReactNode;
  }) =>
    createElement("a", { "data-to": to, "data-params": JSON.stringify(params ?? {}) }, children),
  useNavigate: () => (options: { to: string; params?: Record<string, string> }) => {
    state.navigations.push(options);
    return Promise.resolve();
  },
}));
vi.mock("../useFactoryData", () => ({
  useFactoryEnvironments: () => [{ environmentId: "env-1", label: "Mac Studio", status: {} }],
  useFactorySupported: () => true,
}));

import { PipelinesPage } from "./PipelinesPage";

const ITEM: PipelineListItem = {
  id: "build-and-gate",
  name: "Build and gate",
  nodes: 5,
  edges: 6,
  errors: 2,
  warnings: 0,
  updatedAt: "2026-10-25T09:00:00.000Z",
};

const TEMPLATE_PIPELINE: Pipeline = {
  id: "brief-and-gate",
  name: "Brief and gate",
  nodes: [
    { id: "start", kind: "start", x: 40, y: 200 },
    {
      id: "build",
      kind: "agent",
      label: "Build",
      x: 280,
      y: 200,
      instructions: { brief: "Do it." },
    },
    { id: "done", kind: "end", result: "done", x: 520, y: 200 },
  ],
  edges: [
    { id: "e1", from: "start", port: "next", to: "build" },
    { id: "e2", from: "build", port: "done", to: "done" },
  ],
};

const CATALOG: Catalog = {
  kinds: [],
  skills: [],
  templates: [
    {
      id: "brief-and-gate",
      name: "Brief and gate",
      description: "The simplest useful pipeline.",
      pipeline: TEMPLATE_PIPELINE,
    },
  ],
};

function setup(pipelines: ReadonlyArray<PipelineListItem>) {
  state.navigations = [];
  const api: PipelineApi = {
    catalog: vi.fn(async () => CATALOG),
    list: vi.fn(async () => ({ pipelines })),
    get: vi.fn(),
    save: vi.fn(async (_environmentId, pipeline: Pipeline) => ({
      pipeline,
      problems: [],
      updatedAt: "2026-10-25T09:00:00.000Z",
    })),
    remove: vi.fn(async () => ({ deleted: true })),
    validate: vi.fn(),
    simulate: vi.fn(),
    run: vi.fn(),
    runs: vi.fn(),
    runDetail: vi.fn(),
    stopRun: vi.fn(),
  };
  __setPipelineApiForTests(api);
  return { api, [Symbol.dispose]: () => __setPipelineApiForTests() };
}

describe("PipelinesPage", () => {
  it("lists each pipeline with its counts and problems, linking to the editor", async () => {
    using _api = setup([ITEM]);
    await using screen = await render(createElement(PipelinesPage));
    await expect.element(browser.getByText("Build and gate")).toBeVisible();
    await expect.element(browser.getByText("5 nodes · 6 transitions")).toBeVisible();
    await expect.element(browser.getByText("2 errors")).toBeVisible();
    const link = screen
      .all("a")
      .find((a) => a.getAttribute("data-to") === "/factory/pipelines/$environmentId/$pipelineId");
    expect(JSON.parse(link!.getAttribute("data-params")!)).toEqual({
      environmentId: "env-1",
      pipelineId: "build-and-gate",
    });
  });

  it("marks a file that does not decode as unreadable and says why", async () => {
    using _api = setup([
      {
        id: "broken",
        name: "broken",
        nodes: 0,
        edges: 0,
        errors: 0,
        warnings: 0,
        updatedAt: null,
        unreadable: true,
        decodeErrors: [{ path: "nodes.0.kind", message: "must be one of start, agent" }],
      },
    ]);
    await using _screen = await render(createElement(PipelinesPage));
    await expect.element(browser.getByText("Unreadable")).toBeVisible();
    await expect
      .element(browser.getByRole("listitem").filter({ hasText: "nodes.0.kind" }).last())
      .toHaveTextContent("nodes.0.kind must be one of start, agent");
  });

  it("deletes a pipeline once confirmed and reads the list again", async () => {
    using api = setup([ITEM]);
    await using _screen = await render(createElement(PipelinesPage));
    // No themed confirm host is mounted here, so the page falls back to the browser's confirm.
    using _confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await userEvent.click(browser.getByRole("button", { name: "Delete Build and gate" }));
    await vi.waitFor(() => expect(api.api.list).toHaveBeenCalledTimes(2));
    expect(api.api.remove).toHaveBeenCalledWith("env-1", "build-and-gate");
  });

  it("creates a pipeline from the template under an id made from its name, then opens it", async () => {
    using api = setup([]);
    await using _screen = await render(createElement(PipelinesPage));
    await expect.element(browser.getByText("No pipelines yet")).toBeVisible();
    await userEvent.click(browser.getByRole("button", { name: "New pipeline" }));
    await userEvent.fill(browser.getByLabelText("Name"), "Build and learn");
    await expect.element(browser.getByText("build-and-learn")).toBeVisible();
    // Enter submits the form; the unstyled test page leaves Base UI's inert layer over the footer.
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(state.navigations).toHaveLength(1));
    const [environmentId, saved] = vi.mocked(api.api.save).mock.calls[0]!;
    expect(environmentId).toBe("env-1");
    expect(saved).toMatchObject({ id: "build-and-learn", name: "Build and learn", edges: [] });
    expect(saved.nodes.map((node) => node.kind)).toEqual(["start", "end", "end"]);
    expect(state.navigations[0]).toEqual({
      to: "/factory/pipelines/$environmentId/$pipelineId",
      params: { environmentId: "env-1", pipelineId: "build-and-learn" },
    });
  });

  it("starts a new pipeline from a template, under the new id and name", async () => {
    using api = setup([]);
    await using _screen = await render(createElement(PipelinesPage));
    await userEvent.click(browser.getByRole("button", { name: "New pipeline" }));
    await expect
      .element(browser.getByRole("radio", { name: /Brief and gate/ }))
      .toBeInTheDocument();
    // From the keyboard: the unstyled test page leaves Base UI's inert layer over the dialog.
    await userEvent.fill(browser.getByLabelText("Name"), "Ship docs");
    await userEvent.keyboard("{Tab}{ArrowDown}");
    await expect
      .element(browser.getByRole("radio", { name: /Brief and gate/ }))
      .toHaveAttribute("aria-checked", "true");
    await userEvent.fill(browser.getByLabelText("Name"), "Ship docs");
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(state.navigations).toHaveLength(1));
    expect(vi.mocked(api.api.save).mock.calls[0]![1]).toEqual({
      ...TEMPLATE_PIPELINE,
      id: "ship-docs",
      name: "Ship docs",
    });
  });
});
