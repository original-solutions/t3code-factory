#!/usr/bin/env node
// Re-syncs a mac update manifest and the dmg's blockmap with a dmg changed after electron-builder
// wrote them (stapling a notarization ticket), leaving the dmg alone. Like upstream's manifests,
// it drops the top-level path and sha512, which electron-updater reads only when files is empty.
//
//   node factory/scripts/desktop-restamp-dmg.ts <dmg> <manifest.yml>
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

import { parseUpdateManifest, serializeUpdateManifest } from "../../scripts/lib/update-manifest.ts";

interface BlockMapInfo {
  readonly size: number;
  readonly sha512: string;
}

type BuildBlockMap = (
  file: string,
  compression: "gzip" | "deflate",
  outFile: string,
) => Promise<BlockMapInfo>;

const fail = (message: string): never => {
  console.error(`desktop-restamp-dmg: ${message}`);
  process.exit(1);
};

const [dmg, manifest] = process.argv.slice(2);
if (!dmg || !manifest) fail("usage: desktop-restamp-dmg.ts <dmg> <manifest.yml>");

const name = NodePath.basename(dmg!);
const parsed = parseUpdateManifest(NodeFS.readFileSync(manifest!, "utf8"), manifest!, "mac");
if (!parsed.files.some((file) => file.url === name)) {
  fail(`${manifest} has no files entry for ${name}`);
}

// electron-builder is a dependency of apps/desktop, not of the repo root.
const desktopRequire = NodeModule.createRequire(
  NodePath.resolve(import.meta.dirname, "../../apps/desktop/package.json"),
);
const blockmapModule = desktopRequire.resolve("app-builder-lib/out/targets/blockmap/blockmap.js", {
  paths: [NodePath.dirname(desktopRequire.resolve("electron-builder/package.json"))],
});
const { buildBlockMap } = desktopRequire(blockmapModule) as { buildBlockMap: BuildBlockMap };

const info = await buildBlockMap(dmg!, "gzip", `${dmg}.blockmap`);
const files = parsed.files.map((file) =>
  file.url === name ? { url: name, sha512: info.sha512, size: info.size } : file,
);
NodeFS.writeFileSync(
  manifest!,
  serializeUpdateManifest({ ...parsed, files }, { platformLabel: "mac" }),
);
console.log(`restamped ${name}: size ${info.size}`);
