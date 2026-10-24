import { createFileRoute, redirect } from "@tanstack/react-router";

import { PipelinesPage } from "../factory/pipelines/PipelinesPage";

export const Route = createFileRoute("/factory_/pipelines")({
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: PipelinesPage,
});
