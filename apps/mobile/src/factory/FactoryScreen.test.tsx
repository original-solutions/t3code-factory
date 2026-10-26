import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { SavedRemoteConnection } from "../lib/connection";

const { Children, mocks } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    registry: {
      isLoadingSavedConnection: false,
      savedConnectionsById: {} as Record<string, SavedRemoteConnection>,
    },
    insetBottom: 0,
  },
}));

// Page chrome collapses to one tagged element each, so the markup is the layout tree.
vi.mock("react-native", () => ({
  View: Children,
  Linking: { openURL: () => Promise.resolve() },
}));
vi.mock("react-native-webview", () => ({ WebView: () => <div data-webview="" /> }));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: mocks.insetBottom, left: 0, right: 0 }),
}));
vi.mock("../features/settings/components/SettingsScreen", () => ({
  SettingsScreen: (props: { title: string; children?: ReactNode }) => (
    <section data-screen={props.title}>{props.children}</section>
  ),
}));
vi.mock("../components/ui/ScreenScrollView", () => ({
  ScreenScrollView: (props: {
    children?: ReactNode;
    contentInsetAdjustmentBehavior?: string;
    contentContainerClassName?: string;
    contentContainerStyle?: { paddingBottom?: number };
  }) => (
    <div
      data-scroll={props.contentInsetAdjustmentBehavior}
      data-content={props.contentContainerClassName}
      data-bottom={props.contentContainerStyle?.paddingBottom}
    >
      {props.children}
    </div>
  ),
}));
vi.mock("../components/ui/ListSection", () => ({
  ListSection: (props: { title: string; children?: ReactNode }) => (
    <ul data-section={props.title}>{props.children}</ul>
  ),
}));
vi.mock("../components/ui/ListRow", () => ({
  ListRow: (props: { label: string }) => <li>{props.label}</li>,
}));
vi.mock("../components/ui/EmptyState", () => ({
  EmptyState: (props: { title: string; detail: string }) => (
    <p data-empty={props.title}>{props.detail}</p>
  ),
}));
vi.mock("../components/ui/AppActivityIndicator", () => ({
  AppActivityIndicator: () => <progress />,
}));
vi.mock("../state/use-remote-environment-registry", () => ({
  useSavedRemoteConnections: () => mocks.registry,
}));

import { FactoryScreen } from "./FactoryScreen";
import { FACTORY_NO_ENVIRONMENT_MESSAGE, FACTORY_RELAY_ONLY_MESSAGE } from "./factoryEnvironments";

function connection(id: string, label: string, relay = false): SavedRemoteConnection {
  return {
    environmentId: id,
    environmentLabel: label,
    httpBaseUrl: `http://${id}.test`,
    bearerToken: "token",
    ...(relay ? { relayManaged: true } : {}),
  } as unknown as SavedRemoteConnection;
}

function save(...connections: SavedRemoteConnection[]) {
  mocks.registry = {
    isLoadingSavedConnection: false,
    savedConnectionsById: Object.fromEntries(connections.map((c) => [c.environmentId, c])),
  };
}

const page = (body: string) => `<section data-screen="Factory">${body}</section>`;

beforeEach(() => {
  save();
  mocks.insetBottom = 0;
});

describe("FactoryScreen", () => {
  it("lays the environment picker out as a scrolling Settings page", () => {
    save(connection("beta", "Beta"), connection("alpha", "Alpha"));
    const picker = (bottom: number) =>
      page(
        `<div data-scroll="automatic" data-content="px-5 pt-4" data-bottom="${bottom}">` +
          '<ul data-section="Environment"><li>Alpha</li><li>Beta</li></ul>' +
          "</div>",
      );

    // No home indicator: the 18pt floor plus the page's own 18pt.
    expect(renderToStaticMarkup(<FactoryScreen />)).toBe(picker(36));

    mocks.insetBottom = 34;
    expect(renderToStaticMarkup(<FactoryScreen />)).toBe(picker(52));
  });

  it("keeps the message states on the Settings page, outside any scroll view", () => {
    expect(renderToStaticMarkup(<FactoryScreen />)).toBe(
      page(`<p data-empty="Factory">${FACTORY_NO_ENVIRONMENT_MESSAGE}</p>`),
    );

    save(connection("relay", "Relay", true));
    expect(renderToStaticMarkup(<FactoryScreen />)).toBe(
      page(`<p data-empty="Factory">${FACTORY_RELAY_ONLY_MESSAGE}</p>`),
    );
  });

  it("shows the loading and probing spinners on the Settings page", () => {
    mocks.registry = { isLoadingSavedConnection: true, savedConnectionsById: {} };
    expect(renderToStaticMarkup(<FactoryScreen />)).toBe(page("<progress></progress>"));

    save(connection("alpha", "Alpha"));
    expect(renderToStaticMarkup(<FactoryScreen />)).toBe(page("<progress></progress>"));
  });
});
