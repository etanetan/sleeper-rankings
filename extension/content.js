/* On-page badges for sleeper.com/leagues/*: a rank badge (e.g. "WR8") and a
 * start/sit color on every player row this page shows, plus a small pill
 * summarizing pending lineup changes. Runs after core.js, data.js and
 * storage.js (listed before this file in manifest.json's content_scripts,
 * so their top-level functions are already in scope) and needs the Sleeper
 * username set once from the side panel's first-run field (chrome.storage.sync).
 *
 * The pure id/class/text helpers are exported for Node tests; the
 * DOM-watching part below only runs on an actual sleeper.com page. If
 * Sleeper's markup doesn't match SELECTORS, this fails silently rather than
 * breaking the page - a missing badge is fine, a broken league page is not. */

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

/* The readable status word for a badge tooltip: what Sleeper actually sent
 * (`i`, e.g. "Questionable") when there is one - already a real word, not
 * the short code core.js's `status` normalizes it to - falling back to that
 * short code when Sleeper sent nothing but the player's still unavailable
 * (a bye week alone has no `i`). `meta` is a pool/roster player object
 * (buildRoster's shape: n, p, t, i, status, onBye, posRank, pts, ...). */
function statusText(meta) {
  if (meta.onBye) return "Bye";
  const raw = (meta.i || "").trim();
  if (raw) return raw;
  return meta.status || "";
}

// What each badge color means, for the tooltip's last clause.
const BADGE_REASON = {
  "sr-start": "Start",
  "sr-promote": "Bench → start",
  "sr-demote": "Start → bench",
  "sr-out": "Out",
};

/* The badge's hover tooltip, e.g. "WR8 · 14.2 proj pts ·
 * Questionable · Start". Points and status are both optional; the
 * color's reason is dropped when it would just repeat the status word
 * (an OUT player whose badge reason is also "Out"). */
function badgeTitle(meta, cls) {
  const parts = [`${meta.p === "DEF" ? "DST" : meta.p}${meta.posRank}`];
  if (meta.pts != null) parts.push(`${Math.round(meta.pts * 10) / 10} proj pts`);
  const status = statusText(meta);
  if (status) parts.push(status);
  const reason = BADGE_REASON[cls];
  if (reason && reason.toLowerCase() !== status.toLowerCase()) parts.push(reason);
  return parts.join(" · ");
}

/* Walks up from a player avatar element until it finds the row that holds
 * it: the ancestor whose parent has >=3 element children that each contain
 * an avatar - a list of player rows looks like that no matter what Sleeper
 * names its classes this week. `hasAvatar(el)` reports whether `el`
 * contains an avatar - injected so this runs against hand-built fake nodes
 * in tests (Node has no DOM) as well as the real page, where it's
 * `el.querySelector(SELECTORS.ariaAvatar) || el.querySelector(SELECTORS.imgAvatar)`.
 * Reads only `.parentElement`/`.children`. Capped at `maxDepth` levels
 * (default 8) so an unrecognized page fails fast instead of climbing all
 * the way to <body> and matching something meaningless. */
function rowFor(el, hasAvatar, maxDepth) {
  const cap = maxDepth == null ? 8 : maxDepth;
  let node = el;
  for (let i = 0; i < cap && node; i++) {
    const parent = node.parentElement;
    if (!parent) return null;
    const siblings = Array.from(parent.children || []);
    if (siblings.length >= 3 && siblings.every((s) => hasAvatar(s))) return node;
    node = parent;
  }
  return null;
}

if (typeof module !== "undefined") {
  module.exports = { playerIdFromAria, playerIdFromSrc, badgeClass, badgeTitle, rowFor };
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
    // and sweep() below also falls back to rowFor() for any avatar these
    // guesses miss, so a wrong guess costs nothing but still needs checking
    // against the real page (alt+click the pill - see buildDebugDump below).
    const SELECTORS = {
      row: [".team-roster-item", ".player-row", ".players-table-row",
            ".search-player-row", ".player-list-item"].join(", "),
      ariaAvatar: ".avatar-player[aria-label]",
      imgAvatar: 'img[src*="/players/"]',
      name: "[class*='playerName' i], [class*='player-name' i]",
    };

    function hasAvatarEl(el) {
      return !!(el.querySelector &&
        (el.querySelector(SELECTORS.ariaAvatar) || el.querySelector(SELECTORS.imgAvatar)));
    }

    // `storage` comes from storage.js, loaded before this file (manifest's
    // content_scripts js list) - shared with the background script now too.
    const loader = createLoader({ storage });

    let LEAGUE_ID = null;
    let CTX = null;   // { startingIds, bestIds, outIds, players, byNameKey, check, matchup }

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
      badge.title = badgeTitle(meta, cls);

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
      const rows = Array.from(document.querySelectorAll(SELECTORS.row));
      rows.forEach((row) => decorate(row, findPlayerId(row)));

      // Fallback for pages where SELECTORS.row's guessed classes don't
      // match (the Players and matchup pages are unverified guesses - see
      // docs/ROADMAP.md task 3c): walk up from any avatar SELECTORS.row
      // missed instead of guessing yet another class name.
      document.querySelectorAll(`${SELECTORS.ariaAvatar}, ${SELECTORS.imgAvatar}`).forEach((avatarEl) => {
        if (rows.some((r) => r.contains(avatarEl))) return;
        const row = rowFor(avatarEl, hasAvatarEl);
        if (row) decorate(row, findPlayerId(row));
      });
    }

    // Clears every badge and its row marker, so a redraw - a refresh after
    // the lineup changed, or leaving the league - starts clean instead of
    // leaving stale colors or having decorate() skip rows it thinks it
    // already handled.
    function resetBadges() {
      document.querySelectorAll(".sr-badge").forEach((el) => el.remove());
      document.querySelectorAll("[data-sr]").forEach((el) => delete el.dataset.sr);
    }

    // The matchup page's URL is unverified (see docs/ROADMAP.md task 4d) -
    // matches any path containing "/matchup" rather than a guessed exact
    // route, so a wrong guess just means the pill falls back to the lineup
    // text below instead of showing nothing.
    function onMatchupPage() {
      return /\/matchup/.test(location.pathname);
    }

    // A small fixed pill is the only always-visible sign the extension is
    // doing anything on this page, so it shows a state whenever there's
    // context loaded - green when the lineup's already set, amber with the
    // pending changes otherwise - rather than only appearing for a warning.
    // On the matchup page it shows the projected score and win chance
    // instead, since the lineup check isn't what that page is about.
    // Alt+click copies a debug dump (see buildDebugDump) for pages whose
    // layout we can't see ourselves.
    function showPill(check, matchup) {
      let pill = document.getElementById("sr-pill");
      if (!check && !(onMatchupPage() && matchup)) { if (pill) pill.remove(); return; }
      if (!pill) {
        pill = document.createElement("div");
        pill.id = "sr-pill";
        pill.title = "Alt+click to copy debug info";
        pill.addEventListener("click", (e) => {
          if (!e.altKey) return;
          e.preventDefault();
          const dump = buildDebugDump();
          console.log(dump);
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(dump).then(
              () => flashPill(pill, "Copied debug info"),
              () => flashPill(pill, "See console (copy failed)"));
          } else {
            flashPill(pill, "See console");
          }
        });
        document.body.appendChild(pill);
      }
      if (onMatchupPage() && matchup) {
        pill.className = matchup.win >= 0.5 ? "sr-ok" : "";
        const winPct = Math.round(matchup.win * 100);
        pill.textContent = `Proj ${Math.round(matchup.myProj)}–${Math.round(matchup.oppProj)} · ${winPct}%`;
      } else if (check.ok) {
        pill.className = "sr-ok";
        pill.textContent = "✓ Lineup set";
      } else {
        pill.className = "";
        const n = check.changes.length;
        const gain = Math.round(check.gain * 10) / 10;
        pill.textContent = `${n} change${n === 1 ? "" : "s"} · ${gain > 0 ? "+" : ""}${gain}`;
      }
    }

    function flashPill(pill, msg) {
      const prevText = pill.textContent;
      const prevCls = pill.className;
      pill.textContent = msg;
      setTimeout(() => { pill.textContent = prevText; pill.className = prevCls; }, 1500);
    }

    // The tag/class chain from `fromRow` down to `toEl`, e.g.
    // "div.team-roster-item > div.name-wrap > span.playerName". Only used
    // for the debug dump below, so it's fine to build with a plain string
    // rather than anything fancier.
    function chainDown(fromRow, toEl) {
      if (!toEl) return "(name element not found)";
      const parts = [];
      let node = toEl;
      while (node) {
        const cls = typeof node.className === "string" && node.className.trim()
          ? `.${node.className.trim().split(/\s+/).slice(0, 2).join(".")}` : "";
        parts.unshift(`${node.tagName.toLowerCase()}${cls}`);
        if (node === fromRow) break;
        node = node.parentElement;
      }
      return parts.join(" > ");
    }

    // A short text report on how this page's rows were found, for a page
    // the developer can't see themselves (sleeper.com is behind the
    // owner's own login) - alt+click the pill to copy it, then paste it
    // into a session instead of guessing at SELECTORS from a screenshot.
    function buildDebugDump() {
      const lines = [`path: ${location.pathname}`];
      const selectorRows = Array.from(document.querySelectorAll(SELECTORS.row));
      lines.push(`SELECTORS.row matches: ${selectorRows.length}`);

      const avatars = Array.from(
        document.querySelectorAll(`${SELECTORS.ariaAvatar}, ${SELECTORS.imgAvatar}`));
      const fallbackRows = new Set();
      for (const av of avatars) {
        if (selectorRows.some((r) => r.contains(av))) continue;
        const row = rowFor(av, hasAvatarEl);
        if (row) fallbackRows.add(row);
      }
      lines.push(`rowFor() fallback matches (avatars SELECTORS.row missed): ${fallbackRows.size}`);
      lines.push(`avatars on page total: ${avatars.length}`);

      const sample = selectorRows.length ? selectorRows : Array.from(fallbackRows);
      lines.push("", "First 3 rows, tag/class chain from row to name element:");
      sample.slice(0, 3).forEach((row, i) => {
        const nameEl = row.querySelector(SELECTORS.name);
        const pid = findPlayerId(row);
        lines.push(`  row ${i + 1}: ${chainDown(row, nameEl || row)}`);
        lines.push(`    player id found: ${pid || "(none)"}`);
      });
      return lines.join("\n");
    }

    async function loadContext(leagueId) {
      LAST_RELOAD = Date.now();
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

        CTX = { startingIds, bestIds, outIds, players, byNameKey, check: view.check, matchup: view.matchup };
        // Redraw from scratch, not just over whatever's already there - this
        // runs again after the user edits their lineup on Sleeper itself
        // (see maybeReload below), when the same rows are still on the page
        // but need new colors, not a second badge next to the old one.
        resetBadges();
        sweep();
        showPill(view.check, view.matchup);

        try { chrome.runtime.sendMessage({ type: "sr-league", id: String(lg.league_id) }); }
        catch (e) { /* no panel listening right now */ }
      } catch (e) { /* fail silently - a missing badge beats a broken page */ }
    }

    // Re-fetches and redraws the current league, but not more than once
    // every 30s. Sleeper doesn't tell this extension when the user sets
    // their lineup, so without this the pill and badge colors go stale
    // until they navigate away and back; loadData() is cached, so a reload
    // is only ~2 fresh API calls (rosters + matchups), not the full load.
    let LAST_RELOAD = 0;
    const RELOAD_MIN_INTERVAL_MS = 30000;
    function maybeReload() {
      if (!LEAGUE_ID) return;
      if (Date.now() - LAST_RELOAD < RELOAD_MIN_INTERVAL_MS) return;
      loadContext(LEAGUE_ID);
    }

    let LAST_PATH = null;
    function onNavigate() {
      const path = location.pathname;
      if (path !== LAST_PATH) {
        LAST_PATH = path;
        // Switching tabs within the same league (Team -> Players) doesn't
        // change LEAGUE_ID below, but the column header can still differ.
        OWN_PCT_X = null;
        // The pill shows different content on the matchup page, so it needs
        // a redraw on any path change, not just a league change - from
        // whatever's already loaded, no re-fetch needed for that alone.
        if (CTX) showPill(CTX.check, CTX.matchup);
      }
      const m = LEAGUE_RE.exec(path);
      const id = m ? m[1] : null;
      if (id === LEAGUE_ID) return;
      LEAGUE_ID = id;
      CTX = null;
      resetBadges();
      const pill = document.getElementById("sr-pill");
      if (pill) pill.remove();
      if (id) loadContext(id);
    }

    // Coming back to this tab is one of the two moments most likely to mean
    // "I just set my lineup on Sleeper and tabbed back to check it".
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) maybeReload();
    });

    const debouncedSweep = (() => {
      let t;
      return () => { clearTimeout(t); t = setTimeout(sweep, 400); };
    })();
    // Separate from the sweep debounce above: sweeps are cheap and should
    // run on every settle (new rows loading in, etc.), but a reload hits
    // the API, so it's also gated by the 30s throttle in maybeReload.
    const debouncedMaybeReload = (() => {
      let t;
      return () => { clearTimeout(t); t = setTimeout(maybeReload, 400); };
    })();
    new MutationObserver(() => { debouncedSweep(); debouncedMaybeReload(); })
      .observe(document.body, { childList: true, subtree: true });

    // Sleeper is a client-routed SPA: the URL changes without a full page
    // load, so there's no navigation event to listen for - poll instead.
    setInterval(onNavigate, 1000);
    onNavigate();
  })();
}
