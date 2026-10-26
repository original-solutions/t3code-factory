import { isRedirect } from "@tanstack/react-router";
import { describe, expect, it } from "vite-plus/test";

import tree from "../routeTree.gen.ts?raw";
import { Route as oldRunRoute } from "../routes/factory_.$runId";

// Building the real router in a unit test pulls in the whole app (workers, browser globals), so
// this pins the generated tree's structure: the run route must not nest under the runs list,
// which renders no Outlet and would show the list for a run URL.

describe("factory routes", () => {
  it("hangs the run route off the root route, not the runs list", () => {
    const update =
      /const \w+ =\s*\w+RouteImport\.update\(\{\s*id: '\/factory_\/\$environmentId\/\$runId',[\s\S]*?as any\)/.exec(
        tree,
      );
    expect(update?.[0]).toContain("getParentRoute: () => rootRouteImport");
    expect(tree).not.toContain("FactoryRouteChildren");
  });

  it("makes /factory/$environmentId/$runId the run route's full path", () => {
    expect(tree).toMatch(
      /'\/factory_\/\$environmentId\/\$runId': \{[^}]*fullPath: '\/factory\/\$environmentId\/\$runId'/,
    );
  });

  it("keeps /factory/$runId off the root route, so an old run link does not reach the chat route", () => {
    const update =
      /const \w+ =\s*\w+RouteImport\.update\(\{\s*id: '\/factory_\/\$runId',[\s\S]*?as any\)/.exec(
        tree,
      );
    expect(update?.[0]).toContain("getParentRoute: () => rootRouteImport");
    expect(tree).toMatch(/'\/factory_\/\$runId': \{[^}]*fullPath: '\/factory\/\$runId'/);
  });

  it("keeps the Factory settings page under the settings layout, where the scope provider is", () => {
    const update = /const \w+ =\s*ChatSettingsFactoryRouteImport\.update\(\{[\s\S]*?as any\)/.exec(
      tree,
    );
    expect(update?.[0]).toContain("getParentRoute: () => ChatSettingsRoute");
    expect(tree).toMatch(/'\/_chat\/settings\/factory': \{[^}]*fullPath: '\/settings\/factory'/);
  });

  it("sends an old /factory/<runId> link to the runs list", () => {
    let thrown: unknown;
    try {
      oldRunRoute.options.beforeLoad?.({} as never);
    } catch (error) {
      thrown = error;
    }
    expect(isRedirect(thrown)).toBe(true);
    expect((thrown as { options: { to?: string; replace?: boolean } }).options).toMatchObject({
      to: "/factory",
      replace: true,
    });
  });
});
