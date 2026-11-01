import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { SidebarMenu, SidebarProvider } from "~/components/ui/sidebar";

import { render } from "../../test/render";
import type { FactoryStatus } from "./api";

const state = vi.hoisted(() => ({
  supported: true,
  navigate: vi.fn(),
  status: null as FactoryStatus | null,
}));
vi.mock("./useFactoryData", () => ({
  useFactoryAttentionCount: () => state.status?.attention.length ?? 0,
  useFactoryEnvironments: () =>
    state.status === null
      ? []
      : [{ environmentId: "env-a", label: "Personal Mac", status: { data: state.status } }],
  useFactorySupported: () => state.supported,
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => state.navigate,
}));

import { FactorySidebarUtilityItem } from "./FactorySidebarUtilityItem";

const status = (overrides: Partial<FactoryStatus> = {}): FactoryStatus => ({
  state: "running",
  reason: null,
  paused_by_hand: null,
  deploy_pending: null,
  runs: [],
  attention: [],
  slots: { used: 0, max: 2 },
  passes: { at: null, poll_seconds: 600, running: false, stale: false },
  problems: [],
  ...overrides,
});

function setup(next: { supported?: boolean; status?: FactoryStatus | null } = {}) {
  state.supported = next.supported ?? true;
  state.status = next.status ?? null;
  state.navigate.mockClear();
}

const item = (onNavigate = () => {}) => (
  <SidebarProvider>
    <SidebarMenu>
      <FactorySidebarUtilityItem onNavigate={onNavigate} />
    </SidebarMenu>
  </SidebarProvider>
);

describe("FactorySidebarUtilityItem", () => {
  it("renders nothing when no environment supports the factory", async () => {
    setup({ supported: false });
    await using screen = await render(<FactorySidebarUtilityItem onNavigate={() => {}} />, {
      router: false,
    });
    expect(screen.container.innerHTML).toBe("");
  });

  it("closes the sidebar, then opens the factory page on click", async () => {
    setup();
    const onNavigate = vi.fn();
    await using screen = await render(item(onNavigate));
    const button = screen.getByRole("button", { name: "Factory" });
    await expect.element(button).toBeInTheDocument();
    await button.click();
    expect(onNavigate).toHaveBeenCalledOnce();
    expect(state.navigate).toHaveBeenCalledExactlyOnceWith({ to: "/factory" });
    expect(onNavigate.mock.invocationCallOrder[0]).toBeLessThan(
      state.navigate.mock.invocationCallOrder[0]!,
    );
  });

  it("opens a card on hover with the hold and each run in flight linked to its run", async () => {
    setup({
      status: status({
        paused_by_hand: { since: "2026-11-01T00:00:00Z", for_ms: 1 },
        runs: [
          {
            id: "acme__widgets__7__1",
            state: "pr-open",
            last_event: "pr_opened",
            title: "Add the export button",
            user: "acme",
            for_ms: 120_000,
            pr_url: null,
            thread_id: null,
            unreadable: false,
          },
        ],
      }),
    });
    await using screen = await render(item());
    const button = screen.getByRole("button", { name: "Factory" });
    expect(button.element().querySelector("[data-pulse]")?.getAttribute("data-pulse")).toBe("held");
    await userEvent.hover(button);
    const card = page.getByRole("group", { name: "Factory at a glance" });
    await expect.element(card).toBeInTheDocument();
    expect(card.element().textContent).toContain("1 run in flight · claims paused");
    const run = card.getByRole("link", { name: /Add the export button/ });
    await expect.element(run).toHaveAttribute("href", "/factory/env-a/acme__widgets__7__1");
    expect(run.element().textContent).toContain("PR open");
  });
});
