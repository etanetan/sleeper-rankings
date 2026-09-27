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

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
