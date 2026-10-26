#!/usr/bin/env node
// Switches a prebuilt iOS project to manual signing for an App Store build: each bundle id's build
// configurations get the Apple Distribution identity and its profile; Pods and the project level
// are left alone. A target without a profile, or the reverse, fails before xcodebuild does.
//
//   node factory/scripts/mobile-sign-project.ts <mobile app dir> <team id> <bundle id>=<profile name>...
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

type BuildConfiguration = { buildSettings?: Record<string, string> };
type Pbxproj = {
  filepath: string;
  pbxXCBuildConfigurationSection: () => Record<string, BuildConfiguration | string>;
  writeSync: () => string;
};

// expo/config-plugins is installed for apps/mobile, not for the repo root.
const requireFromMobile = NodeModule.createRequire(
  NodePath.resolve(import.meta.dirname, "../../apps/mobile/package.json"),
);
const { IOSConfig } = requireFromMobile("expo/config-plugins") as {
  IOSConfig: { XcodeUtils: { getPbxproj: (projectRoot: string) => Pbxproj } };
};

const fail = (message: string): never => {
  console.error(`::error::${message}`);
  process.exit(1);
};

const [projectRoot, team, ...pairs] = process.argv.slice(2);
if (!projectRoot || !team || pairs.length === 0) {
  fail("Usage: mobile-sign-project.ts <mobile app dir> <team id> <bundle id>=<profile name>...");
}

const profiles = new Map(
  pairs.map((pair) => {
    const at = pair.indexOf("=");
    if (at <= 0 || at === pair.length - 1) fail(`Not <bundle id>=<profile name>: ${pair}`);
    return [pair.slice(0, at), pair.slice(at + 1)] as const;
  }),
);

const unquote = (value: string) => value.replace(/^"(.*)"$/, "$1");
const quote = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

const project = IOSConfig.XcodeUtils.getPbxproj(projectRoot!);
const configurations = Object.values(project.pbxXCBuildConfigurationSection()).filter(
  (value): value is Required<BuildConfiguration> =>
    typeof value === "object" && value.buildSettings?.PRODUCT_BUNDLE_IDENTIFIER !== undefined,
);

const bundleIds = new Set(
  configurations.map(({ buildSettings }) => unquote(buildSettings.PRODUCT_BUNDLE_IDENTIFIER!)),
);
for (const bundleId of bundleIds) {
  if (!profiles.has(bundleId)) fail(`No profile for ${bundleId}, a target in the iOS project.`);
}
for (const bundleId of profiles.keys()) {
  if (!bundleIds.has(bundleId)) fail(`No target has bundle id ${bundleId}.`);
}

for (const { buildSettings } of configurations) {
  const profile = profiles.get(unquote(buildSettings.PRODUCT_BUNDLE_IDENTIFIER!))!;
  buildSettings.CODE_SIGN_STYLE = "Manual";
  buildSettings.DEVELOPMENT_TEAM = team!;
  buildSettings.CODE_SIGN_IDENTITY = quote("Apple Distribution");
  buildSettings.PROVISIONING_PROFILE_SPECIFIER = quote(profile);
}

NodeFS.writeFileSync(project.filepath, project.writeSync());
for (const [bundleId, profile] of profiles) console.log(`signed ${bundleId} with "${profile}"`);
