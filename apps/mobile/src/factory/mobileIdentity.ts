// The fork's hook into upstream's app.config.ts: called once on the finished config, it swaps
// upstream's identity for the fork's and cuts the links to upstream's Expo project and
// over-the-air updates.
import type { ExpoConfig } from "expo/config";
import {
  FORK_APPLE_TEAM_ID,
  FORK_MOBILE_ASSOCIATED_DOMAIN,
  FORK_MOBILE_VARIANTS,
} from "@t3tools/shared/forkIdentity";

type AppVariant = keyof typeof FORK_MOBILE_VARIANTS;
type PluginEntry = NonNullable<ExpoConfig["plugins"]>[number];

function resolveVariant(value: unknown): AppVariant {
  return value === "development" || value === "preview" ? value : "production";
}

export function applyForkMobileIdentity(config: ExpoConfig): void {
  const fork = FORK_MOBILE_VARIANTS[resolveVariant(config.extra?.appVariant)];
  // A personal-team build keeps the bundle id its owner chose, as upstream does.
  const iosBundleIdentifier =
    config.extra?.iosPersonalTeamBuild === true && config.ios?.bundleIdentifier
      ? config.ios.bundleIdentifier
      : fork.appId;

  config.name = fork.appName;
  config.scheme = fork.scheme;
  config.ios = {
    ...config.ios,
    bundleIdentifier: iosBundleIdentifier,
    appleTeamId: FORK_APPLE_TEAM_ID,
    associatedDomains: [
      `applinks:${FORK_MOBILE_ASSOCIATED_DOMAIN}`,
      `webcredentials:${FORK_MOBILE_ASSOCIATED_DOMAIN}`,
    ],
    entitlements: {
      ...config.ios?.entitlements,
      "keychain-access-groups": [`$(AppIdentifierPrefix)${fork.appId}`],
    },
  };
  config.android = { ...config.android, package: fork.appId };
  config.plugins = config.plugins?.map((plugin) => withForkIds(plugin, iosBundleIdentifier));

  config.updates = { enabled: false };
  delete config.owner;
  if (config.extra?.eas) delete config.extra.eas.projectId;
}

function withForkIds(plugin: PluginEntry, iosBundleIdentifier: string): PluginEntry {
  if (!Array.isArray(plugin)) return plugin;
  const [name, options] = plugin;
  if (name === "expo-widgets") {
    return [
      name,
      {
        ...options,
        bundleIdentifier: `${iosBundleIdentifier}.widgets`,
        groupIdentifier: `group.${iosBundleIdentifier}`,
      },
    ];
  }
  if (name === "expo-sharing") {
    return [
      name,
      {
        ...options,
        ios: {
          ...options?.ios,
          extensionBundleIdentifier: `${iosBundleIdentifier}.sharing`,
          appGroupId: `group.${iosBundleIdentifier}`,
        },
      },
    ];
  }
  return plugin;
}
