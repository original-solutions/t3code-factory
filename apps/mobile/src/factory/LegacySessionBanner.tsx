import { View } from "react-native";

import { Notice } from "../components/ui/Notice";
import { useLegacySessionNotices } from "./legacySessionNotices";

/** Stays while a session predates the permissions, however the one-time dialog was answered. */
export function LegacySessionBanner() {
  const notices = useLegacySessionNotices();
  if (notices.length === 0) return null;
  return (
    <View className="gap-2 px-4 pt-2">
      {notices.map(({ environmentId, label, sentence }) => (
        <Notice
          key={environmentId}
          icon="exclamationmark.triangle"
          message={label === null ? sentence : `${label}: ${sentence}`}
        />
      ))}
    </View>
  );
}
