/**
 * version-bump.mjs
 *
 * Keeps package.json, manifest.json, and versions.json in sync when you release.
 *
 * Usage:
 *   node version-bump.mjs 1.1.0
 *
 * Then tag and push:
 *   git add .
 *   git commit -m "chore: bump to 1.1.0"
 *   git tag -a 1.1.0 -m "1.1.0"
 *   git push --follow-tags
 *
 * The GitHub Actions workflow picks up the tag and creates the release automatically.
 */

import { readFileSync, writeFileSync } from "fs";

const newVersion = process.argv[2];

if (!newVersion || !/^\d+\.\d+\.\d+$/.test(newVersion)) {
    console.error("Usage: node version-bump.mjs <major.minor.patch>");
    console.error("Example: node version-bump.mjs 1.1.0");
    process.exit(1);
}

// ── package.json ──────────────────────────────────────────────────────────────
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const oldVersion = pkg.version;
pkg.version = newVersion;
writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
console.log(`package.json   ${oldVersion} → ${newVersion}`);

// ── manifest.json ─────────────────────────────────────────────────────────────
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = manifest;
manifest.version = newVersion;
writeFileSync("manifest.json", JSON.stringify(manifest, null, 2) + "\n");
console.log(`manifest.json  ${oldVersion} → ${newVersion}`);

// ── versions.json ─────────────────────────────────────────────────────────────
// Maps each plugin version to the minimum Obsidian version it needs.
// We inherit the same minAppVersion as the current manifest.
const versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[newVersion] = minAppVersion;
writeFileSync("versions.json", JSON.stringify(versions, null, 2) + "\n");
console.log(`versions.json  added "${newVersion}": "${minAppVersion}"`);

console.log("\n✅  Done. Next steps:");
console.log(`   git add package.json manifest.json versions.json`);
console.log(`   git commit -m "chore: bump to ${newVersion}"`);
console.log(`   git tag -a ${newVersion} -m "${newVersion}"`);
console.log(`   git push --follow-tags`);
