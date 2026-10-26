import { createFileRoute } from "@tanstack/react-router";
import { FactorySettingsPanel } from "../factory/settings/FactorySettingsPanel";

export const Route = createFileRoute("/_chat/settings/factory")({
  component: FactorySettingsPanel,
});
