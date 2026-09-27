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
    // knows about their DOM. Discovered from SleeperPlus/Better Sleeper-style
    // extensions; verify against the live page and update as needed.
    const SELECTORS = {
      row: ".team-roster-item",
      ariaAvatar: ".avatar-player[aria-label]",
      imgAvatar: 'img[src*="/players/"]',
      name: "[class*='playerName'], [class*='player-name']",
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
      row.appendChild(badge);
    }

    function sweep() {
      if (!CTX) return;
      document.querySelectorAll(SELECTORS.row).forEach((row) => decorate(row, findPlayerId(row)));
    }

    function showPill(check) {
      let pill = document.getElementById("sr-pill");
      if (!check || check.ok) { if (pill) pill.remove(); return; }
      if (!pill) {
        pill = document.createElement("div");
        pill.id = "sr-pill";
        document.body.appendChild(pill);
      }
      const n = check.changes.length;
      const gain = Math.round(check.gain * 10) / 10;
      pill.textContent = `${n} change${n === 1 ? "" : "s"} · ${gain > 0 ? "+" : ""}${gain}`;
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
        const outIds = new Set(view.roster.filter((p) => unavailable(p)).map((p) => p.id));
        const players = {};
        const byNameKey = {};
        view.roster.forEach((p) => { players[p.id] = p; byNameKey[norm(p.n)] = p.id; });

        CTX = { startingIds, bestIds, outIds, players, byNameKey, check: view.check };
        sweep();
        showPill(view.check);

        try { chrome.runtime.sendMessage({ type: "sr-league", id: String(lg.league_id) }); }
        catch (e) { /* no panel listening right now */ }
      } catch (e) { /* fail silently - a missing badge beats a broken page */ }
    }

    function onNavigate() {
      const m = LEAGUE_RE.exec(location.pathname);
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
