import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it, vi } from "vite-plus/test";

import { filterSettingsSections } from "../features/settings/settings-search";
import { useFactorySettingsSection } from "./FactorySettingsSection";

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate }) }));

describe("useFactorySettingsSection", () => {
  it("has a title of its own, since the Settings list keys an untitled section as tabs", () => {
    expect(useFactorySettingsSection().title).toBe("Factory");
  });

  it("opens the Factory screen from its one row", () => {
    const { rows } = useFactorySettingsSection();
    expect(rows.map((row) => row.id)).toEqual(["factory"]);
    rows[0]!.onPress?.();
    expect(navigate).toHaveBeenCalledWith("Factory");
  });

  it("is found by a Settings search for factory", () => {
    const found = filterSettingsSections([useFactorySettingsSection()], "factory");
    expect(found.flatMap((section) => section.rows.map((row) => row.id))).toEqual(["factory"]);
  });

  it("is the last section of the Settings index", () => {
    const screen = NodeFS.readFileSync(
      NodePath.resolve(import.meta.dirname, "../features/settings/SettingsRouteScreen.tsx"),
      "utf8",
    );
    const index = /function useSettingsIndexSections\(\)[\s\S]*?\n\}\n/u.exec(screen)?.[0] ?? "";
    expect(index).toMatch(/useFactorySettingsSection\(\),\n\s*\];\n\}\n$/u);
  });
});
