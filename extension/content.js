/* On-page badges for sleeper.com/leagues/*: a rank badge (e.g. "WR8") and a
 * start/sit color on every player row this page shows, plus a small pill
 * summarizing pending lineup changes. Runs after core.js and data.js (listed
 * before this file in manifest.json's content_scripts, so their top-level
 * functions are already in scope) and needs the Sleeper username set once
 * from the side panel's first-run field (chrome.storage.sync).
 *
 * The pure id/class helpers are exported for Node tests; the DOM-watching
 * part below only runs on an actual sleeper.com page. If Sleeper's markup
 * doesn't match SELECTORS, this fails silently rather than breaking the
 * page - a missing badge is fine, a broken league page is not. */

/* A Sleeper avatar's aria-label reads like "player 4046, Josh Allen, QB". */
function playerIdFromAria(label) {
  const m = /player\s+(\d+)/i.exec(label || "");
  return m ? m[1] : null;
}

/* An avatar image's src embeds the player id, optionally through /thumb/. */
function playerIdFromSrc(src) {
  const m = /players\/(?:thumb\/)?(\d+)\.jpg/i.exec(src || "");
  return m ? m[1] : null;
}

/* Which color a badge gets, given the sets of ids Sleeper currently starts
 * and the best lineup would start. `outIds` (optional) wins regardless -
 * unavailable is worth flagging whether or not the player happens to be
 * starting or benched right now. */
function badgeClass(pid, ctx) {
  if (ctx.outIds && ctx.outIds.has(pid)) return "sr-out";
  const starting = ctx.startingIds.has(pid);
  const best = ctx.bestIds.has(pid);
  if (starting && best) return "sr-start";
  if (!starting && best) return "sr-promote";
  if (starting && !best) return "sr-demote";
  return "";
}

if (typeof module !== "undefined") {
  module.exports = { playerIdFromAria, playerIdFromSrc, badgeClass };
}

if (typeof document !== "undefined" && typeof chrome !== "undefined" && chrome.storage) {
  (function () {
    const LEAGUE_RE = /\/leagues\/(\d+)/;

    // Adjust here if Sleeper's markup changes - this is the one place that
    // knows about their DOM. `.team-roster-item` is confirmed against a live
    // team page (and matches what SleeperPlus itself uses); the rest of
    // `row` beyond it is an unverified guess at the Players/free-agent
    // search page's row, since neither a live page nor another extension's
    // source turned up its real class name. querySelectorAll silently
    // ignores whichever guesses don't match, so this is zero-risk to try -
    // but still needs checking against the real page and fixing from there.
    const SELECTORS = {
      row: [".team-roster-item", ".player-row", ".players-table-row",
            ".search-player-row", ".player-list-item"].join(", "),
      ariaAvatar: ".avatar-player[aria-label]",
      imgAvatar: 'img[src*="/players/"]',
      name: "[class*='playerName' i], [class*='player-name' i]",
    };

    const storage = {
      async getItem(key) {
        const obj = await chrome.storage.local.get(key);
        return obj[key] != null ? obj[key] : null;
      },
      async setItem(key, value) { await chrome.storage.local.set({ [key]: value }); },
      async removeItem(key) { await chrome.storage.local.remove(key); },
    };
    const loader = createLoader({ storage });

    let LEAGUE_ID = null;
    let CTX = null;   // { startingIds, bestIds, outIds, players, byNameKey, check }

    // The x position of the "OWN %" column header, so every row's badge can
    // sit just to its left instead of crowding the player name - found by
    // its text, not a guessed class name, since that's stable across a CSS
    // rebuild the way a hashed class name isn't. Cached per page (reset on
    // navigation): a horizontal position doesn't change between rows or on
    // vertical scroll, and re-scanning every element on every row would be
    // needlessly expensive. Pages without that header (the Players page,
    // most likely) just fall back to placement next to the name.
    let OWN_PCT_X = null;
    function ownPctX() {
      if (OWN_PCT_X != null) return OWN_PCT_X;
      for (const el of document.querySelectorAll("div, span, th")) {
        if (el.children.length === 0 && /^own\s*%$/i.test(el.textContent.trim())) {
          OWN_PCT_X = el.getBoundingClientRect().left;
          return OWN_PCT_X;
        }
      }
      return null;
    }

    function findPlayerId(row) {
      const aria = row.querySelector(SELECTORS.ariaAvatar);
      if (aria) {
        const pid = playerIdFromAria(aria.getAttribute("aria-label"));
        if (pid) return pid;
      }
      const img = row.querySelector(SELECTORS.imgAvatar);
      if (img) {
        const pid = playerIdFromSrc(img.getAttribute("src"));
        if (pid) return pid;
      }
      const nameEl = row.querySelector(SELECTORS.name);
      if (nameEl && CTX) {
        const pid = CTX.byNameKey[norm(nameEl.textContent)];
        if (pid) return pid;
      }
      return null;
    }

    function decorate(row, pid) {
      if (!pid || row.dataset.sr || !CTX) return;
      const meta = CTX.players[pid];
      if (!meta || meta.posRank == null) return;
      row.dataset.sr = "1";
      const cls = badgeClass(pid, CTX);
      const badge = document.createElement("span");
      badge.className = "sr-badge" + (cls ? ` ${cls}` : "");
      badge.textContent = `${meta.p === "DEF" ? "DST" : meta.p}${meta.posRank}`;

      const nameEl = row.querySelector(SELECTORS.name);
      if (!nameEl) { row.appendChild(badge); return; }

      // Append inline after the name first - not the whole row - so it
      // takes no extra slot in the row's own layout (avatar / name / own% /
      // start% / pts) and can't shift those columns. Then, next frame,
      // measure where that put it and switch to absolute positioning at
      // that same x but vertically centered on the row's full height:
      // pinned to the name's own line otherwise reads high, since the row
      // is taller than one line (a game-info line sits under the name).
      nameEl.appendChild(badge);
      requestAnimationFrame(() => {
        if (!badge.isConnected) return;
        const rowRect = row.getBoundingClientRect();
        const badgeRect = badge.getBoundingClientRect();
        if (getComputedStyle(row).position === "static") row.style.position = "relative";
        badge.style.position = "absolute";
        const ownX = ownPctX();
        // Just left of OWN% when that header exists; otherwise where it
        // already naturally landed, right after the name.
        badge.style.left = ownX != null
          ? `${ownX - rowRect.left - badgeRect.width - 14}px`
          : `${badgeRect.left - rowRect.left}px`;
        badge.style.marginLeft = "0";
        badge.style.top = "50%";
        badge.style.transform = "translateY(-50%)";
      });
    }

    function sweep() {
      if (!CTX) return;
      document.querySelectorAll(SELECTORS.row).forEach((row) => decorate(row, findPlayerId(row)));
    }

    // A small fixed pill is the only always-visible sign the extension is
    // doing anything on this page, so it shows a state whenever there's
    // context loaded - green when the lineup's already set, amber with the
    // pending changes otherwise - rather than only appearing for a warning.
    function showPill(check) {
      let pill = document.getElementById("sr-pill");
      if (!check) { if (pill) pill.remove(); return; }
      if (!pill) {
        pill = document.createElement("div");
        pill.id = "sr-pill";
        document.body.appendChild(pill);
      }
      if (check.ok) {
        pill.className = "sr-ok";
        pill.textContent = "✓ Lineup set";
      } else {
        pill.className = "";
        const n = check.changes.length;
        const gain = Math.round(check.gain * 10) / 10;
        pill.textContent = `${n} change${n === 1 ? "" : "s"} · ${gain > 0 ? "+" : ""}${gain}`;
      }
    }

    async function loadContext(leagueId) {
      try {
        const { sleeperUser } = await chrome.storage.sync.get("sleeperUser");
        if (!sleeperUser) return;   // no first-run username set yet

        const data = await loader.loadData();
        const user = await loader.fetchUser(sleeperUser);
        if (!user) return;
        const leagues = await loader.fetchLeagues(user.user_id, data.leagueSeason);
        const lg = leagues.find((l) => String(l.league_id) === String(leagueId));
        if (!lg) return;
        const view = await loader.buildLeagueView(lg, user, data);
        if (!view) return;

        const startingIds = new Set(
          (view.current || []).map((e) => e.player && e.player.id).filter(Boolean));
        const bestIds = new Set(
          (view.best ? view.best.starters : []).map((s) => s.player.id));
        // Every ranked player in the league, not just this user's roster, so
        // free agents on the Players page and opponents on the matchup view
        // get badged too - only starting/best/out are roster-specific.
        const pool = view.pool || view.roster;
        const outIds = new Set(pool.filter((p) => unavailable(p)).map((p) => p.id));
        const players = {};
        const byNameKey = {};
        pool.forEach((p) => { players[p.id] = p; byNameKey[norm(p.n)] = p.id; });

        CTX = { startingIds, bestIds, outIds, players, byNameKey, check: view.check };
        sweep();
        showPill(view.check);

        try { chrome.runtime.sendMessage({ type: "sr-league", id: String(lg.league_id) }); }
        catch (e) { /* no panel listening right now */ }
      } catch (e) { /* fail silently - a missing badge beats a broken page */ }
    }

    let LAST_PATH = null;
    function onNavigate() {
      const path = location.pathname;
      if (path !== LAST_PATH) {
        LAST_PATH = path;
        // Switching tabs within the same league (Team -> Players) doesn't
        // change LEAGUE_ID below, but the column header can still differ.
        OWN_PCT_X = null;
      }
      const m = LEAGUE_RE.exec(path);
      const id = m ? m[1] : null;
      if (id === LEAGUE_ID) return;
      LEAGUE_ID = id;
      CTX = null;
      document.querySelectorAll("[data-sr]").forEach((el) => delete el.dataset.sr);
      const pill = document.getElementById("sr-pill");
      if (pill) pill.remove();
      if (id) loadContext(id);
    }

    const debouncedSweep = (() => {
      let t;
      return () => { clearTimeout(t); t = setTimeout(sweep, 400); };
    })();
    new MutationObserver(debouncedSweep).observe(document.body, { childList: true, subtree: true });

    // Sleeper is a client-routed SPA: the URL changes without a full page
    // load, so there's no navigation event to listen for - poll instead.
    setInterval(onNavigate, 1000);
    onNavigate();
  })();
}
