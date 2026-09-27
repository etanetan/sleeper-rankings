#!/usr/bin/env node
/* Signs the extension for permanent, self-distributed install in release
 * Firefox (Chrome needs none of this - "Load unpacked" already persists).
 *
 * Mozilla only keeps an extension installed if it's signed by
 * addons.mozilla.org (AMO). The "unlisted" channel signs it for free
 * without publishing it to the public store; review is automated and
 * usually takes a few minutes. See docs/ROADMAP.md task 1 for the full
 * picture, and CLAUDE.md's "Releasing the Firefox build" section for the
 * short version.
 *
 * This needs the owner's own AMO API credentials - never run it with keys
 * pasted into a chat, and never commit them. Get them at
 * https://addons.mozilla.org/developers/addon/api/key/ (free Firefox
 * account) and export before running:
 *
 *   export WEB_EXT_API_KEY='user:12345:678'
 *   export WEB_EXT_API_SECRET='...'
 *   node extension/release.js
 *
 * On success this writes extension/dist/sleeper-rankings-<version>.xpi and
 * updates extension/updates.json so installed copies pick up the new
 * version on their own (Firefox checks update_url roughly once a day).
 * Commit both and push main + gh-pages. */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const EXT_DIR = __dirname;
const DIST_DIR = path.join(EXT_DIR, "dist");
const MANIFEST_PATH = path.join(EXT_DIR, "manifest.json");
const UPDATES_PATH = path.join(EXT_DIR, "updates.json");
const UPDATE_BASE = "https://etanetan.github.io/sleeper-rankings/extension/dist";

function die(msg) {
  console.error(`\n${msg}\n`);
  process.exit(1);
}

if (!process.env.WEB_EXT_API_KEY || !process.env.WEB_EXT_API_SECRET) {
  die(
    "WEB_EXT_API_KEY and WEB_EXT_API_SECRET must be set.\n" +
    "Get them (free) at https://addons.mozilla.org/developers/addon/api/key/\n" +
    "then:\n" +
    "  export WEB_EXT_API_KEY='user:12345:678'\n" +
    "  export WEB_EXT_API_SECRET='...'\n" +
    "  node extension/release.js"
  );
}

const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
const version = manifest.version;
const geckoId = manifest.browser_specific_settings &&
  manifest.browser_specific_settings.gecko && manifest.browser_specific_settings.gecko.id;
if (!version) die("manifest.json has no version.");
if (!geckoId) die("manifest.json has no browser_specific_settings.gecko.id.");

const finalXpiName = `sleeper-rankings-${version}.xpi`;
const finalXpiPath = path.join(DIST_DIR, finalXpiName);
if (fs.existsSync(finalXpiPath)) {
  die(
    `${path.relative(process.cwd(), finalXpiPath)} already exists - AMO refuses to ` +
    `re-sign a version it's already signed.\nBump "version" in extension/manifest.json ` +
    "(and bump extension/lib parity by re-running sync) before releasing again."
  );
}

console.log("Syncing extension/lib/ from the root core.js/data.js...");
let r = spawnSync("node", [path.join(EXT_DIR, "sync.js")], { stdio: "inherit" });
if (r.status !== 0) die("extension/sync.js failed.");

fs.mkdirSync(DIST_DIR, { recursive: true });

console.log(`Signing v${version} for unlisted (self-distributed) release...`);
r = spawnSync(
  "npx",
  [
    "--yes", "web-ext@8", "sign",
    "--channel=unlisted",
    "--source-dir", EXT_DIR,
    "--artifacts-dir", DIST_DIR,
    "--ignore-files", "release.js", "sync.js", "dist", "updates.json",
  ],
  { stdio: "inherit", env: process.env }
);
if (r.status !== 0) die("web-ext sign failed - see its output above.");

// web-ext names the artifact after the manifest's name/version; find
// whatever .xpi it just produced and rename it to our stable scheme.
const produced = fs.readdirSync(DIST_DIR).filter((f) => f.endsWith(".xpi"));
const newest = produced
  .map((f) => ({ f, t: fs.statSync(path.join(DIST_DIR, f)).mtimeMs }))
  .sort((a, b) => b.t - a.t)[0];
if (!newest) die("web-ext sign reported success but no .xpi was found in extension/dist/.");
if (newest.f !== finalXpiName) {
  fs.renameSync(path.join(DIST_DIR, newest.f), finalXpiPath);
}
console.log(`Signed: extension/dist/${finalXpiName}`);

// Append this version to updates.json (never drop older entries - an
// install that missed a version still needs a path forward).
let updates = { addons: { [geckoId]: { updates: [] } } };
if (fs.existsSync(UPDATES_PATH)) {
  try { updates = JSON.parse(fs.readFileSync(UPDATES_PATH, "utf8")); }
  catch (e) { die(`extension/updates.json exists but isn't valid JSON: ${e.message}`); }
}
updates.addons = updates.addons || {};
updates.addons[geckoId] = updates.addons[geckoId] || { updates: [] };
const list = updates.addons[geckoId].updates;
const already = list.some((u) => u.version === version);
if (!already) {
  list.push({ version, update_link: `${UPDATE_BASE}/${finalXpiName}` });
}
fs.writeFileSync(UPDATES_PATH, JSON.stringify(updates, null, 2) + "\n");
console.log(`Updated extension/updates.json (${list.length} version(s) listed).`);

console.log(
  "\nDone. Next steps:\n" +
  "  git add extension/dist extension/updates.json\n" +
  `  git commit -m "Sign Firefox ${version}"\n` +
  "  git push origin main main:gh-pages\n\n" +
  "Then in Firefox: remove any temporary add-on in about:debugging, and open\n" +
  `  ${UPDATE_BASE}/${finalXpiName}\n` +
  "to install the signed build. It will survive restarts and auto-update from\n" +
  "then on (Firefox checks update_url roughly once a day; to force it sooner,\n" +
  "about:addons -> gear icon -> Check for Updates)."
);
