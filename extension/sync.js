#!/usr/bin/env node
/* Copies core.js and data.js from the repo root into extension/lib/, kept
 * byte-identical rather than duplicated by hand - the extension's content
 * script needs its own copy of the shared logic (a content script can't
 * `require` or fetch a sibling file from the repo root), and test_extension.js
 * fails the build if these ever drift, the same idea as test_norm_parity.py
 * for build.py's normalizer.
 *
 * Run this after any change to core.js or data.js, before loading the
 * extension unpacked or running test_extension.js. */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const LIB = path.join(__dirname, "lib");

fs.mkdirSync(LIB, { recursive: true });
for (const name of ["core.js", "data.js"]) {
  fs.copyFileSync(path.join(ROOT, name), path.join(LIB, name));
  console.log(`copied ${name} -> extension/lib/${name}`);
}
