import { assert, it } from "@effect/vitest";

import { DEFAULT_DESKTOP_BACKEND_PORT } from "../app/DesktopApp.ts";

it("scans for the backend port from 3880, not upstream's 3773", () => {
  assert.equal(DEFAULT_DESKTOP_BACKEND_PORT, 3880);
});
