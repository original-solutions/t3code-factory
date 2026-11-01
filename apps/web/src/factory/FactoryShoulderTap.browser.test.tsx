import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import type { FactoryAttentionItem, FactoryStatus } from "./api";

const state = vi.hoisted(() => ({
  environmentId: "env",
  read: null as { data: FactoryStatus; dataAt: number } | null,
  toasts: [] as Array<string>,
  notifications: [] as Array<string>,
}));
vi.mock("./useFactoryData", () => ({
  useFactoryEnvironments: () =>
    state.read === null
      ? []
      : [{ environmentId: state.environmentId, label: "Personal Mac", status: state.read }],
}));
vi.mock("~/components/ui/toast", () => ({
  toastManager: {
    add: (toast: { title: string }) => {
      state.toasts.push(toast.title);
      return "toast";
    },
    close: () => {},
  },
}));
vi.mock("~/hooks/useSettings", () => ({
  getClientSettings: () => ({ notificationMode: "all", inAppNotificationsEnabled: true }),
}));
vi.mock("~/threadNotifications", () => ({
  hasDesktopNotifications: () => true,
  hasNotificationSound: () => false,
  playNotificationSound: async () => {},
}));

import { FactoryShoulderTap } from "./FactoryShoulderTap";

const stuck = (issue: number): FactoryAttentionItem => ({
  id: `stuck:a__b__${issue}__1`,
  kind: "stuck",
  repo: "a/b",
  issue,
  run: `a__b__${issue}__1`,
  message: "the gate failed",
  first_seen: "2026-11-01T00:00:00Z",
});

const status = (attention: ReadonlyArray<FactoryAttentionItem>): FactoryStatus => ({
  state: "running",
  reason: null,
  paused_by_hand: null,
  deploy_pending: null,
  runs: [],
  attention,
  slots: { used: 0, max: 2 },
  passes: { at: null, poll_seconds: 600, running: false, stale: false },
  problems: [],
});

/** The tap remembers what it saw per environment across mounts, so each test uses its own. */
function setup(environmentId: string) {
  state.environmentId = environmentId;
  state.read = { data: status([]), dataAt: 1 };
  state.toasts.length = 0;
  state.notifications.length = 0;
  vi.stubGlobal(
    "Notification",
    class {
      static permission = "granted";
      constructor(title: string) {
        state.notifications.push(title);
      }
      addEventListener() {}
    },
  );
  return { [Symbol.dispose]: () => vi.unstubAllGlobals() };
}

const read = (attention: ReadonlyArray<FactoryAttentionItem>, dataAt: number) => {
  state.read = { data: status(attention), dataAt };
};

describe("FactoryShoulderTap", () => {
  it("toasts once for a new item while focused, and not again for the same read", async () => {
    using _globals = setup("env-focused");
    using _focus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    await using screen = await render(<FactoryShoulderTap />, { router: "/" });
    expect(state.toasts).toEqual([]);

    read([stuck(3)], 2);
    await screen.rerender(<FactoryShoulderTap />);
    await vi.waitFor(() => expect(state.toasts).toHaveLength(1));

    read([stuck(3), stuck(4)], 2);
    await screen.rerender(<FactoryShoulderTap />);
    expect(state.toasts).toHaveLength(1);
    expect(state.notifications).toEqual([]);
  });

  it("stays quiet on a Factory page, which already shows the item", async () => {
    using _globals = setup("env-on-factory");
    using _focus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    await using screen = await render(<FactoryShoulderTap />, { router: "/factory" });

    read([stuck(3)], 2);
    await screen.rerender(<FactoryShoulderTap />);
    expect(state.toasts).toEqual([]);
    expect(state.notifications).toEqual([]);
  });

  it("sends one system notification while the window is not focused", async () => {
    using _globals = setup("env-blurred");
    using _focus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    await using screen = await render(<FactoryShoulderTap />, { router: "/" });

    read([stuck(3)], 2);
    await screen.rerender(<FactoryShoulderTap />);
    await vi.waitFor(() => expect(state.notifications).toHaveLength(1));
    await screen.rerender(<FactoryShoulderTap />);
    expect(state.notifications).toHaveLength(1);
    expect(state.toasts).toEqual([]);
  });
});
