import { AuthStandardClientScopes } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const LEGACY = ["orchestration:read", "orchestration:operate", "terminal:operate"];

const { alerts, store, state } = vi.hoisted(() => ({
  alerts: [] as Array<{ title: string; press: () => void }>,
  store: new Map<string, string>(),
  state: { sessions: new Map<string, unknown>() },
}));

vi.mock("../components/ui/Dialog", () => ({
  alert: (
    title: string,
    _message: string,
    buttons: ReadonlyArray<{ text: string; onPress: () => void }>,
  ) => alerts.push({ title, press: () => buttons[0]!.onPress() }),
}));
vi.mock("expo-secure-store", () => ({
  getItemAsync: async (key: string) => store.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => void store.set(key, value),
}));
vi.mock("../lib/protectedData", () => ({ whenProtectedDataAvailable: async () => {} }));
vi.mock("../state/atom-registry", async () => {
  const { AtomRegistry } = await import("effect/reactivity");
  return { appAtomRegistry: AtomRegistry.make() };
});
vi.mock("../state/environments", () => ({
  projectEnvironmentPresentation: (environmentId: string, presentation: { label: string }) => ({
    environmentId,
    label: presentation.label,
  }),
}));
vi.mock("../state/presentation", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentPresentations: {
      presentationsAtom: Atom.make(
        new Map([
          ["alpha", { label: "Alpha" }],
          ["beta", { label: "Beta" }],
        ]),
      ),
    },
  };
});
vi.mock("../state/session", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentSession: {
      sessionStateAtom: (id: string) => Atom.make(state.sessions.get(id)),
    },
  };
});

import { appAtomRegistry } from "../state/atom-registry";
import { installPermissionUpdateNotice } from "../features/connection/permissionUpdateNotice";
import { legacySessionNoticesAtom } from "./legacySessionNotices";

const session = (permissions: ReadonlyArray<string>) =>
  AsyncResult.success({ authenticated: true, auth: {}, permissions });

// The notice loads its dismissals through a few awaited promises; this lets them all run.
const settle = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

beforeEach(() => {
  alerts.length = 0;
  store.clear();
  state.sessions = new Map([
    ["alpha", session(LEGACY)],
    ["beta", session(LEGACY)],
  ]);
});

describe("the permission update dialog", () => {
  it("shows once per environment, one dialog at a time", async () => {
    const dispose = installPermissionUpdateNotice();
    await settle();
    expect(alerts.map((a) => a.title)).toEqual(["Permissions have changed for Alpha"]);

    alerts[0]!.press();
    expect(alerts.map((a) => a.title)).toEqual([
      "Permissions have changed for Alpha",
      "Permissions have changed for Beta",
    ]);
    alerts[1]!.press();
    dispose();

    const again = installPermissionUpdateNotice();
    await settle();
    expect(alerts).toHaveLength(2);
    again();
  });
});

describe("the legacy session banner source", () => {
  it("still lists the environment after its dialog was dismissed", async () => {
    const dispose = installPermissionUpdateNotice();
    await settle();
    alerts[0]!.press();
    alerts[1]!.press();
    dispose();

    const notices = appAtomRegistry.get(legacySessionNoticesAtom);
    expect(notices.map((n) => [n.environmentId, n.label])).toEqual([
      ["alpha", "Alpha"],
      ["beta", "Beta"],
    ]);
    expect(notices[0]!.sentence).toContain("settings:write");
  });

  it("lists no environment whose session holds every permission", () => {
    state.sessions = new Map([
      ["alpha", session(AuthStandardClientScopes)],
      ["beta", session(LEGACY)],
    ]);
    expect(appAtomRegistry.get(legacySessionNoticesAtom).map((n) => n.environmentId)).toEqual([
      "beta",
    ]);
  });
});
