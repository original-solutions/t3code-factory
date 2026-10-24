import type { EnvironmentId } from "@t3tools/contracts";
import { createFileRoute, redirect } from "@tanstack/react-router";

import { PipelineEditorPage } from "../factory/pipelines/PipelineEditorPage";

export const Route = createFileRoute("/factory_/pipelines_/$environmentId/$pipelineId")({
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: PipelineEditorRoute,
});

function PipelineEditorRoute() {
  const { environmentId, pipelineId } = Route.useParams();
  // Keyed so another pipeline starts at loading instead of editing the last one.
  return (
    <PipelineEditorPage
      environmentId={environmentId as EnvironmentId}
      key={`${environmentId} ${pipelineId}`}
      pipelineId={pipelineId}
    />
  );
}
