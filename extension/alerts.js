/* Which lineup problems are worth a desktop notification, for the
 * background script's periodic check (bg.js). Pure and DOM-free like
 * core.js, loaded after it (lib/core.js) in the manifest's background
 * script list so `unavailable` and `SLOT_LABEL` are already in scope in
 * the browser - alertsFor below reads them as bare globals, the same way
 * data.js reads core.js's exports, and never declares its own bindings for
 * them. That matters here specifically: declaring so much as an unused
 * `var unavailable` at this file's top level - even inside a branch that
 * never runs in the browser - still gets hoisted, and hoisting a `var`
 * over core.js's `const SLOT_LABEL` throws a SyntaxError the moment the
 * browser parses this file, silently breaking everything after it in the
 * shared background script list. (Caught live: Node's require() isolates
 * modules from each other, so only loading this for real in a browser -
 * importScripts, via Playwright - surfaced it; the exported alertsFor
 * still passed every offline test while quietly never running at all.)
 * In Node, where nothing is global yet, pull core.js's exports onto the
 * shared `global` object instead - an assignment, not a declaration. */
if (typeof require !== "undefined" && typeof unavailable === "undefined") {
  const core = require("./lib/core.js");
  global.unavailable = core.unavailable;
  global.SLOT_LABEL = core.SLOT_LABEL;
}

/* A starter who won't play (unavailable() - OUT/IR/PUP/SUS/bye/...) or an
 * empty slot is worth flagging, as long as it isn't already too late to
 * act on: a player whose game already started (`view.locked`) is left
 * alone, since swapping them out is no longer possible anyway.
 *
 * `key` embeds the league, week, the player (or the slot index, for an
 * empty slot with no player to key on) and the specific status, so a
 * repeat check doesn't re-notify for the same problem but a changed one
 * (Questionable -> OUT) does - the caller (bg.js) tracks which keys it's
 * already shown. */
function alertsFor(view) {
  const out = [];
  const locked = (view && view.locked) || new Set();
  (view && view.current || []).forEach((e, i) => {
    const p = e.player;
    if (p && locked.has(p.id)) return;   // game's already started - too late to swap
    const bad = !p || unavailable(p);
    if (!bad) return;

    const status = !p ? "empty" : p.onBye ? "BYE" : (p.status || "OUT");
    const key = `${view.id}:${view.week}:${p ? p.id : "slot" + i}:${status}`;
    const slotLabel = SLOT_LABEL[e.slot] || e.slot;
    const title = p
      ? `${view.name}: ${p.n} is ${status === "BYE" ? "on bye" : status}`
      : `${view.name}: empty ${slotLabel} slot`;
    const message = p
      ? `${p.n} (${p.p === "DEF" ? "DST" : p.p}) won't play this week - swap them out before kickoff.`
      : `Your ${slotLabel} slot is empty - set a lineup before kickoff.`;
    out.push({ key, title, message, url: view.sleeperUrl });
  });
  return out;
}

if (typeof module !== "undefined") {
  module.exports = { alertsFor };
}
