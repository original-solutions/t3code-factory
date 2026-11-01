// Factory and its run pages replace the sidebar utility row with a Back
// button, like Settings. `isSidebarUtilityPage` calls this first.
export function isFactoryPage(pathname: string): boolean {
  return pathname === "/factory" || pathname.startsWith("/factory/");
}

const RUN_PATH = /^\/factory\/([^/]+)\/([^/]+)\/?$/;

/** The environment and run a run page's path names, or null for any other path. */
export function runOfPath(
  pathname: string,
): { readonly environmentId: string; readonly runId: string } | null {
  const match = RUN_PATH.exec(pathname);
  if (match === null) return null;
  try {
    return { environmentId: decodeURIComponent(match[1]!), runId: decodeURIComponent(match[2]!) };
  } catch {
    return null;
  }
}
