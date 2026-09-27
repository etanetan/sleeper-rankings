/* Tests for the browser extension: manifest validity, that extension/lib/*
 * matches core.js and data.js (the same idea as test_norm_parity.py for
 * build.py - a forgotten `node extension/sync.js` should fail loudly here
 * rather than drift silently), and the pure DOM helpers in content.js. */
const fs = require("fs");
const path = require("path");
const C = require("./extension/content.js");

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}` +
    (ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
}

// --- manifest -------------------------------------------------------------
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "extension/manifest.json"), "utf8"));
check("manifest_version 3", manifest.manifest_version, 3);
check("has a Chrome side panel", !!(manifest.side_panel && manifest.side_panel.default_path), true);
check("has a Firefox sidebar_action",
      !!(manifest.sidebar_action && manifest.sidebar_action.default_panel), true);
check("declares a gecko id for Firefox",
      !!(manifest.browser_specific_settings &&
         manifest.browser_specific_settings.gecko &&
         manifest.browser_specific_settings.gecko.id), true);
check("background declares both a service worker and a script",
      !!(manifest.background && manifest.background.service_worker && manifest.background.scripts), true);
check("content script matches sleeper.com leagues",
      (manifest.content_scripts || []).some((cs) => (cs.matches || []).some((m) => m.includes("sleeper.com"))), true);
check("content script loads core.js and data.js before content.js",
      (manifest.content_scripts || [])[0].js, ["lib/core.js", "lib/data.js", "content.js"]);

// --- Firefox signing/release requirements (docs/ROADMAP.md task 1) --------
const gecko = manifest.browser_specific_settings && manifest.browser_specific_settings.gecko;
check("declares a Firefox strict_min_version", typeof (gecko || {}).strict_min_version, "string");
check("update_url is https on etanetan.github.io",
      /^https:\/\/etanetan\.github\.io\//.test((gecko || {}).update_url || ""), true);
check("declares data_collection_permissions.required as a non-empty array",
      Array.isArray((gecko || {}).data_collection_permissions &&
        gecko.data_collection_permissions.required) &&
        gecko.data_collection_permissions.required.length > 0, true);

const iconSizes = ["16", "32", "48", "128"];
check("manifest lists an icon for every standard size",
      iconSizes.every((s) => !!(manifest.icons && manifest.icons[s])), true);
for (const s of iconSizes) {
  const iconPath = manifest.icons && manifest.icons[s];
  if (iconPath) {
    check(`icon path ${iconPath} exists`,
          fs.existsSync(path.join(__dirname, "extension", iconPath)), true);
  }
}

const updatesPath = path.join(__dirname, "extension/updates.json");
if (fs.existsSync(updatesPath)) {
  const updates = JSON.parse(fs.readFileSync(updatesPath, "utf8"));
  const geckoId = (gecko || {}).id;
  const entry = updates.addons && updates.addons[geckoId];
  check("updates.json's addon id matches the manifest's gecko id", !!entry, true);
  const links = entry ? entry.updates.map((u) => u.update_link) : [];
  check("every update_link is https under extension/dist/",
        links.length > 0 && links.every((l) =>
          /^https:\/\/etanetan\.github\.io\/sleeper-rankings\/extension\/dist\//.test(l)), true);
}

// --- lib/ stays in sync with the root files --------------------------------
for (const name of ["core.js", "data.js"]) {
  const root = fs.readFileSync(path.join(__dirname, name), "utf8");
  const lib = fs.readFileSync(path.join(__dirname, "extension/lib", name), "utf8");
  check(`lib/${name} matches the root file (run node extension/sync.js)`, lib, root);
}

// --- pure DOM helpers -------------------------------------------------------
check("player id from an aria-label",
      C.playerIdFromAria("player 4046, Josh Allen, QB"), "4046");
check("no player id in an unrelated aria-label", C.playerIdFromAria("Team logo"), null);
check("no player id in an empty aria-label", C.playerIdFromAria(""), null);
check("player id from an avatar image src",
      C.playerIdFromSrc("https://sleepercdn.com/content/nfl/players/4046.jpg"), "4046");
check("player id from a thumb avatar src",
      C.playerIdFromSrc("https://sleepercdn.com/content/nfl/players/thumb/4046.jpg"), "4046");
check("no player id in an unrelated src",
      C.playerIdFromSrc("https://sleepercdn.com/images/team-logo.png"), null);

const started = new Set(["1", "3"]);
const best = new Set(["1", "2"]);
check("starting and best -> start", C.badgeClass("1", { startingIds: started, bestIds: best }), "sr-start");
check("best but not starting -> promote", C.badgeClass("2", { startingIds: started, bestIds: best }), "sr-promote");
check("starting but not best -> demote", C.badgeClass("3", { startingIds: started, bestIds: best }), "sr-demote");
check("out overrides starting and best",
      C.badgeClass("1", { startingIds: started, bestIds: best, outIds: new Set(["1"]) }), "sr-out");
check("neither starting nor best -> no badge", C.badgeClass("9", { startingIds: started, bestIds: best }), "");

// --- badge tooltips (task 3a) ----------------------------------------------
check("healthy starter tooltip: rank, points, reason",
      C.badgeTitle({ p: "WR", posRank: 8, pts: 14.23 }, "sr-start"),
      "WR8 · 14.2 proj pts · Start");
check("bench -> start promote reason",
      C.badgeTitle({ p: "RB", posRank: 3, pts: 9.5 }, "sr-promote"),
      "RB3 · 9.5 proj pts · Bench → start");
check("start -> bench demote reason",
      C.badgeTitle({ p: "TE", posRank: 12, pts: 4 }, "sr-demote"),
      "TE12 · 4 proj pts · Start → bench");
check("DEF shows as DST", C.badgeTitle({ p: "DEF", posRank: 5, pts: 7 }, ""), "DST5 · 7 proj pts");
check("no badge color -> no reason clause",
      C.badgeTitle({ p: "K", posRank: 1, pts: 6 }, ""), "K1 · 6 proj pts");
check("no projection omits the points segment", C.badgeTitle({ p: "K", posRank: 1, pts: null }, ""), "K1");
check("readable status word wins over the short code",
      C.badgeTitle({ p: "WR", posRank: 8, pts: 14.2, i: "Questionable", status: "Q" }, ""),
      "WR8 · 14.2 proj pts · Questionable");
check("bye week has no Sleeper status text, so it reads Bye",
      C.badgeTitle({ p: "RB", posRank: 20, pts: 0, onBye: true }, "sr-out"),
      "RB20 · 0 proj pts · Bye · Out");
check("an OUT status doesn't repeat itself as both the status and the reason",
      C.badgeTitle({ p: "QB", posRank: 4, pts: 0, i: "Out", status: "OUT" }, "sr-out"),
      "QB4 · 0 proj pts · Out");
check("falls back to the short status code when Sleeper sent no readable text",
      C.badgeTitle({ p: "WR", posRank: 9, pts: 2, i: "", status: "IR" }, "sr-out"),
      "WR9 · 2 proj pts · IR · Out");

// --- selector-free row detection (task 3c) ---------------------------------
// Fake DOM nodes: only .parentElement and .children are ever read, so a
// plain object graph stands in for real Elements. `_hasAvatar` is the fake
// stand-in for "el.querySelector(...) finds an avatar in here".
function fakeRow(hasAvatar) {
  const leaf = { parentElement: null, children: [] };
  const wrap = { parentElement: null, children: [leaf] };
  leaf.parentElement = wrap;
  const row = { parentElement: null, children: [wrap], _hasAvatar: hasAvatar };
  wrap.parentElement = row;
  return { row, leaf };
}
const hasAvatar = (el) => !!el._hasAvatar;

const rowA = fakeRow(true), rowB = fakeRow(true), rowC = fakeRow(true);
const list = { parentElement: null, children: [rowA.row, rowB.row, rowC.row] };
for (const r of [rowA, rowB, rowC]) r.row.parentElement = list;
check("rowFor climbs from an avatar up to the row when >=3 siblings all have one",
      C.rowFor(rowB.leaf, hasAvatar) === rowB.row, true);

const rowD = fakeRow(true), rowE = fakeRow(true);
const shortList = { parentElement: null, children: [rowD.row, rowE.row] };
rowD.row.parentElement = shortList; rowE.row.parentElement = shortList;
check("rowFor finds nothing with fewer than 3 avatar siblings", C.rowFor(rowD.leaf, hasAvatar), null);

const rowF = fakeRow(true), rowG = fakeRow(false), rowH = fakeRow(true);
const mixedList = { parentElement: null, children: [rowF.row, rowG.row, rowH.row] };
for (const r of [rowF, rowG, rowH]) r.row.parentElement = mixedList;
check("rowFor requires every sibling to have an avatar, not just most of them",
      C.rowFor(rowF.leaf, hasAvatar), null);

check("rowFor returns null instead of throwing when it runs out of ancestors",
      C.rowFor({ parentElement: null, children: [] }, hasAvatar), null);

check("a maxDepth too small for the real match returns null",
      C.rowFor(rowB.leaf, hasAvatar, 2), null);
check("raising maxDepth reaches that same match",
      C.rowFor(rowB.leaf, hasAvatar, 3) === rowB.row, true);

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
