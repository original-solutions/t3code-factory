import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    notices: [] as ReadonlyArray<{ environmentId: string; label: string | null; sentence: string }>,
  },
}));

vi.mock("react-native", () => ({
  View: (props: { children?: unknown }) => props.children,
}));
vi.mock("../components/ui/Notice", () => ({
  Notice: (props: { message: string }) => <aside data-notice="">{props.message}</aside>,
}));
vi.mock("./legacySessionNotices", () => ({ useLegacySessionNotices: () => mocks.notices }));

import { LegacySessionBanner } from "./LegacySessionBanner";

describe("LegacySessionBanner", () => {
  it("renders nothing without a legacy session", () => {
    mocks.notices = [];
    expect(renderToStaticMarkup(<LegacySessionBanner />)).toBe("");
  });

  it("names each environment with a legacy session once several are connected", () => {
    mocks.notices = [
      { environmentId: "a", label: "Studio", sentence: "Pair again." },
      { environmentId: "b", label: "Laptop", sentence: "Pair again." },
    ];
    expect(renderToStaticMarkup(<LegacySessionBanner />)).toBe(
      '<aside data-notice="">Studio: Pair again.</aside><aside data-notice="">Laptop: Pair again.</aside>',
    );
  });
});
