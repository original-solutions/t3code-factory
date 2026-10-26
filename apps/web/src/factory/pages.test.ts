import { describe, expect, it } from "vite-plus/test";

import { isSidebarUtilityPage } from "~/components/sidebar/mainAppLocation";

import { isFactoryPage } from "./pages";

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

describe("isSidebarUtilityPage", () => {
  it("keeps Factory pages out of the main app's back target", () => {
    expect(isSidebarUtilityPage("/factory")).toBe(true);
    expect(isSidebarUtilityPage("/factory/run-123")).toBe(true);
    expect(isSidebarUtilityPage("/")).toBe(false);
  });
});
