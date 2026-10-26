import { useNavigation } from "@react-navigation/native";
import type { ComponentProps } from "react";

import type { SettingsRow } from "../features/settings/components/SettingsRow";

type FactorySettingsRow = ComponentProps<typeof SettingsRow> & { readonly id: string };

/** The Settings list's Factory section: one row that opens the Factory screen. */
export function useFactorySettingsSection(): {
  readonly title: string;
  readonly rows: readonly FactorySettingsRow[];
} {
  const navigation = useNavigation();
  return {
    title: "Factory",
    rows: [
      {
        id: "factory",
        icon: "hammer",
        label: "Factory",
        onPress: () => navigation.navigate("Factory"),
      },
    ],
  };
}
