import { describe, expect, it } from "vite-plus/test";

import { SETTINGS_NAV_GROUPS } from "~/components/settings/settingsSearch";
import { isSidebarUtilityPage } from "~/components/sidebar/mainAppLocation";

import { isFactoryPage, runOfPath } from "./pages";

describe("isFactoryPage", () => {
  it("treats Factory and its runs as utility pages", () => {
    expect(isFactoryPage("/factory")).toBe(true);
    expect(isFactoryPage("/factory/run-123")).toBe(true);
  });

  it("does not match routes that only share the prefix", () => {
    expect(isFactoryPage("/factory-floor")).toBe(false);
    expect(isFactoryPage("/")).toBe(false);
  });
});

describe("runOfPath", () => {
  it("names the environment and run of a run page's path, and nothing for any other", () => {
    expect(runOfPath("/factory/env-1/o__r__12__1")).toEqual({
      environmentId: "env-1",
      runId: "o__r__12__1",
    });
    expect(runOfPath("/factory/env%201/o__r__12__1/")).toEqual({
      environmentId: "env 1",
      runId: "o__r__12__1",
    });
    expect(runOfPath("/factory")).toBeNull();
    expect(runOfPath("/factory/o__r__12__1")).toBeNull();
    expect(runOfPath("/factory/env-1/o__r__12__1/x")).toBeNull();
    expect(runOfPath("/settings/factory")).toBeNull();
  });
});

describe("isSidebarUtilityPage", () => {
  it("keeps Factory pages out of the main app's back target", () => {
    expect(isSidebarUtilityPage("/factory")).toBe(true);
    expect(isSidebarUtilityPage("/factory/run-123")).toBe(true);
    expect(isSidebarUtilityPage("/")).toBe(false);
  });
});

describe("SETTINGS_NAV_GROUPS", () => {
  it("lists the Factory settings section under Agents", () => {
    const agents = SETTINGS_NAV_GROUPS.find((group) => group.heading === "Agents");
    expect(agents?.paths).toContain("/settings/factory");
  });
});
