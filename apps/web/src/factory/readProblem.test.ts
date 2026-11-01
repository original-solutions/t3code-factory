import { describe, expect, it } from "vite-plus/test";

import { FactoryApiError } from "./api";
import { readProblem } from "./readProblem";

describe("readProblem", () => {
  it.each([
    [new TypeError("Failed to fetch"), "unreachable", "Can't reach Mac"],
    [new FactoryApiError(0, null, "socket hang up"), "unreachable", "Can't reach Mac"],
    [new FactoryApiError(0, "timeout", "no answer"), "timeout", "Mac is not answering"],
    [new FactoryApiError(0, "no_connection", "none"), "connecting", "Not connected to Mac yet"],
    [new FactoryApiError(0, "relay", "relay"), "relay", "Mac's factory can't be read over a relay"],
    [
      new FactoryApiError(401, null, "expired"),
      "denied",
      "Mac won't show this browser its factory",
    ],
    [
      new FactoryApiError(403, null, "Missing permission"),
      "denied",
      "Mac won't show this browser its factory",
    ],
    [new FactoryApiError(404, null, "Not found"), "missing", "Mac has no factory here"],
    [
      new FactoryApiError(500, "factory_error", "ledger locked"),
      "failed",
      "Mac's factory failed to answer",
    ],
  ])("names %s as %s", (error, kind, title) => {
    const problem = readProblem(error, "Mac");
    expect(problem.kind).toBe(kind);
    expect(problem.title).toBe(title);
    expect(problem.detail).toBe(error.message);
  });

  it("leaves a server failure to the server's own words", () => {
    expect(readProblem(new FactoryApiError(500, null, "ledger locked"), "Mac").hint).toBeNull();
  });
});
