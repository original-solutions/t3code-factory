import type { EnvironmentId } from "@t3tools/contracts";
import { useRouter, type AnyRouter } from "@tanstack/react-router";
import { FactoryIcon } from "lucide-react";
import { useEffect } from "react";

import { toastManager } from "~/components/ui/toast";
import { getClientSettings } from "~/hooks/useSettings";
import {
  hasDesktopNotifications,
  hasNotificationSound,
  playNotificationSound,
} from "~/threadNotifications";

import { isFactoryPage } from "./pages";
import { attentionNews, tapOf, type ShoulderTap } from "./shoulderTap";
import { useFactoryEnvironments } from "./useFactoryData";

/** Per environment, the attention ids of the last read seen and when it landed; kept over remounts. */
const seenByEnvironment = new Map<EnvironmentId, ReadonlySet<string>>();
const readAtByEnvironment = new Map<EnvironmentId, number>();

const open = (router: AnyRouter, tap: ShoulderTap) =>
  tap.runId === null
    ? router.navigate({ to: "/factory" })
    : router.navigate({
        to: "/factory/$environmentId/$runId",
        params: { environmentId: tap.environmentId, runId: tap.runId },
      });

/**
 * Follows Settings → Notifications like thread notices do: a toast while the window has focus
 * (not on a Factory page, which already shows the item), a system notification while it does not.
 */
function present(router: AnyRouter, tap: ShoulderTap): void {
  const { notificationMode: mode, inAppNotificationsEnabled } = getClientSettings();
  if (hasNotificationSound(mode)) {
    void playNotificationSound("input", () =>
      hasNotificationSound(getClientSettings().notificationMode),
    );
  }
  const action = tap.runId === null ? "Open factory" : "Open run";
  if (document.visibilityState === "visible" && document.hasFocus()) {
    if (!inAppNotificationsEnabled || isFactoryPage(router.state.location.pathname)) return;
    const toastId = toastManager.add({
      type: "warning",
      title: tap.title,
      description: tap.body,
      // Longer than a thread's notice: it asks for a person, and the bins keep it if missed.
      timeout: 12_000,
      data: {
        hideCopyButton: true,
        leadingIcon: <FactoryIcon aria-hidden className="size-4 text-warning-foreground" />,
      },
      actionProps: {
        children: action,
        onClick: () => {
          toastManager.close(toastId);
          void open(router, tap);
        },
      },
    });
    return;
  }
  if (
    !hasDesktopNotifications(mode) ||
    typeof Notification === "undefined" ||
    Notification.permission !== "granted"
  )
    return;
  try {
    const notification = new Notification(tap.title, {
      body: tap.body,
      tag: `factory:${tap.environmentId}:${tap.runId ?? "factory"}`,
      silent: true,
    });
    notification.addEventListener("click", () => {
      notification.close();
      window.focus();
      void window.desktopBridge?.revealWindow().catch(() => undefined);
      void open(router, tap);
    });
  } catch {
    // Some browsers expose Notification but reject desktop presentation.
  }
}

/**
 * Taps you on the shoulder when a status read puts something new in Needs attention: a run
 * stuck or asking questions, a repo whose config stopped loading. Reads the statuses the
 * sidebar already polls; renders nothing.
 */
export function FactoryShoulderTap() {
  const environments = useFactoryEnvironments();
  const router = useRouter();
  const many = environments.length > 1;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- raises toasts and system notifications, outside React, once per new status read
  useEffect(() => {
    for (const { environmentId, label, status } of environments) {
      if (status.data === null || readAtByEnvironment.get(environmentId) === status.dataAt) {
        continue;
      }
      readAtByEnvironment.set(environmentId, status.dataAt);
      const { fresh, seen } = attentionNews(
        seenByEnvironment.get(environmentId),
        status.data.attention,
      );
      seenByEnvironment.set(environmentId, seen);
      if (fresh.length > 0) present(router, tapOf(environmentId, many ? label : null, fresh));
    }
  });
  return null;
}
