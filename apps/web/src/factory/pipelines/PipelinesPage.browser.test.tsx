import { createElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page as browser, userEvent } from "vite-plus/test/browser";

import { render } from "../testing";
import { __setPipelineApiForTests, type PipelineApi } from "./api";
import type { Pipeline, PipelineListItem } from "./types";

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

function setup(pipelines: ReadonlyArray<PipelineListItem>) {
  state.navigations = [];
  const api: PipelineApi = {
    catalog: vi.fn(),
    list: vi.fn(async () => ({ pipelines })),
    get: vi.fn(),
    save: vi.fn(async (_environmentId, pipeline: Pipeline) => ({
      pipeline,
      problems: [],
      updatedAt: "2026-10-25T09:00:00.000Z",
    })),
    remove: vi.fn(),
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
});
