/* Weekly Sleeper rankings - client side.
 *
 * Everything comes from Sleeper's own API. Projections are scored with each
 * league's actual scoring_settings, so a league is ranked by what it really
 * awards rather than bucketed into standard / half / full PPR. */

const SLEEPER = "https://api.sleeper.app/v1";
const PROJ = "https://api.sleeper.com/projections/nfl";

const SLOT_ELIGIBLE = {
  QB: ["QB"], RB: ["RB"], WR: ["WR"], TE: ["TE"], K: ["K"], DEF: ["DEF"],
  FLEX: ["RB", "WR", "TE"],
  WRRB_FLEX: ["RB", "WR"],
  "WRRB-FLEX": ["RB", "WR"],
  REC_FLEX: ["WR", "TE"],
  SUPER_FLEX: ["QB", "RB", "WR", "TE"],
};
const SKIP_SLOTS = new Set(["BN", "IR", "TAXI"]);
const SLOT_LABEL = {
  SUPER_FLEX: "SFLEX", WRRB_FLEX: "W/R", "WRRB-FLEX": "W/R", REC_FLEX: "W/T",
  DEF: "DST", FLEX: "FLEX",
};
const POS_ORDER = ["QB", "RB", "WR", "TE", "K", "DEF"];
// Sleeper -> FantasyPros team abbreviations.
const TEAM_ALIAS = { JAX: "JAC", WAS: "WSH", LV: "LVR" };
const FMT_OF = (settings) => {
  const rec = (settings || {}).rec || 0;
  return rec >= 0.75 ? "ppr" : rec >= 0.25 ? "half" : "std";
};

/* Sleeper sends full words ("Questionable"); show a short badge and decide
 * from the normalized form which statuses should sink in the lineup. */
const INJ_ABBR = {
  QUESTIONABLE: "Q", DOUBTFUL: "D", OUT: "OUT", IR: "IR", PUP: "PUP",
  SUS: "SUS", SUSPENDED: "SUS", COV: "COV", NA: "NA", DNR: "DNR",
};
const OUT_STATUSES = new Set(["OUT", "IR", "PUP", "SUS", "NA", "DNR", "D"]);

/* A player who won't take the field this week, for whatever reason. A bye is
 * as disqualifying as an injury and projections don't always say so. */
function unavailable(p) {
  return OUT_STATUSES.has(p.status) || p.onBye === true;
}

/* Why a player was left out, for display. */
function benchReason(p) {
  if (p.onBye) return "BYE";
  return OUT_STATUSES.has(p.status) ? p.status : "";
}

function normStatus(raw) {
  const s = (raw || "").trim().toUpperCase();
  if (!s) return "";
  return INJ_ABBR[s] || s.slice(0, 3);
}

const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);
const FANTASY_POS = new Set(["QB", "RB", "WR", "TE", "K", "DEF"]);

/* Match key for joining a Sleeper player to a rankings list by name. */
function norm(name) {
  return (name || "")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[.']/g, "").replace(/-/g, " ")
    .split(/\s+/).filter((w) => w && !SUFFIXES.has(w)).join(" ");
}

/* Injury status as reported on a projections row, if it carries one. Sleeper
 * has moved this around, so check the shapes we've seen rather than assume.
 * Returns undefined when the row says nothing, which is different from saying
 * "healthy" - an absent field must not clear a real status. */
function statusFromRow(row) {
  if (!row || typeof row !== "object") return undefined;
  const candidates = [row.injury_status, row.status,
                      row.player && row.player.injury_status,
                      row.player && row.player.status];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  return undefined;
}

/* Trim Sleeper's full player dump to the fantasy-relevant fields. The dump is
 * ~5MB; what's kept is a couple of hundred KB and fits in localStorage. */
function trimPlayers(db) {
  const out = {};
  for (const pid in db) {
    const m = db[pid];
    const pos = (m.position || "").toUpperCase();
    if (!FANTASY_POS.has(pos)) continue;
    const isDef = pos === "DEF";
    const name = isDef
      ? `${m.first_name || ""} ${m.last_name || ""}`.trim() || pid
      : m.full_name || `${m.first_name || ""} ${m.last_name || ""}`.trim();
    const team = (m.team || (isDef ? pid : "")).toUpperCase();
    out[pid] = { n: name, p: pos, t: team, k: isDef ? team : norm(name),
                 i: m.injury_status || "",
                 b: typeof m.bye_week === "number" ? m.bye_week
                    : parseInt(m.bye_week, 10) || null };
  }
  return out;
}

/* ---------------------------------------------------------------- logic */

/* Human-readable summary of a league's scoring, for the header chip. */
function scoringLabel(settings) {
  const rec = (settings || {}).rec || 0;
  if (rec >= 0.75) return "Full PPR";
  if (rec >= 0.4 && rec <= 0.6) return "Half PPR";
  // Name an unusual value rather than rounding it to the nearest familiar one.
  if (rec > 0) return `${rec} PPR`;
  return "Standard";
}

/* Project a stat line through a league's scoring settings.
 *
 * Sleeper uses the same key names in both, so most categories are a plain
 * multiply. TE premium is the exception: it's a per-reception bonus that has
 * no matching stat key, so it's applied against receptions for tight ends. */
function scorePlayer(stats, settings, pos) {
  if (!stats || !settings) return 0;
  let pts = 0;
  for (const key in settings) {
    const v = stats[key];
    if (typeof v === "number") pts += v * settings[key];
  }
  if (pos === "TE" && settings.bonus_rec_te && typeof stats.rec === "number") {
    pts += stats.rec * settings.bonus_rec_te;
  }
  return pts;
}

/* Rank every projected player within their position under one league's
 * scoring, so ranks reflect that league rather than a generic list. */
function rankPositions(projections, players, settings) {
  const byPos = {};
  for (const pid in projections) {
    const meta = players[pid];
    if (!meta) continue;
    const pts = scorePlayer(projections[pid], settings, meta.p);
    if (!(meta.p in byPos)) byPos[meta.p] = [];
    byPos[meta.p].push({ pid, pts });
  }
  const ranks = {};
  for (const pos in byPos) {
    byPos[pos].sort((a, b) => b.pts - a.pts);
    byPos[pos].forEach((r, i) => { ranks[r.pid] = { posRank: i + 1, pts: r.pts }; });
  }
  return ranks;
}

/* Consensus ranks for one league, keyed by Sleeper player id.
 *
 * FantasyPros publishes by position and scoring format; pick the format that
 * matches this league and index it by the same normalized key the build wrote
 * into players.json. Returns null when no consensus data was published, so
 * the caller falls back to ranking by projected points. */
function consensusRanks(rankings, players, settings) {
  if (!rankings || !rankings.shared) return null;
  const fmt = FMT_OF(settings);
  const scored = (rankings.formats || {})[fmt] || {};
  const shared = rankings.shared || {};

  const ranks = {};
  for (const pid in players) {
    const m = players[pid];
    let hit = null;
    if (m.p === "DEF") {
      const t = shared.DST || {};
      hit = t[m.k] || t[TEAM_ALIAS[m.k]] || null;
    } else if (m.p === "QB" || m.p === "K") {
      hit = (shared[m.p] || {})[m.k] || null;
    } else {
      hit = (scored[m.p] || {})[m.k] || null;
    }
    if (!hit || hit.posRank == null) continue;
    const flex = (scored.FLEX || {})[m.k];
    ranks[pid] = { posRank: hit.posRank, ecr: hit.rank,
                   flexRank: flex ? flex.rank : null };
  }
  return Object.keys(ranks).length ? ranks : null;
}

function buildRoster(ids, players, ranks, week) {
  const out = [];
  for (const id of ids || []) {
    const meta = players[id];
    if (!meta) continue;
    const r = ranks[id] || {};
    out.push({
      ...meta, id, status: normStatus(meta.i),
      onBye: week != null && meta.b != null && Number(meta.b) === Number(week),
      posRank: r.posRank != null ? r.posRank : null,
      pts: r.pts != null ? r.pts : null,
      flexRank: r.flexRank != null ? r.flexRank : null,
    });
  }
  return out;
}

/* Rank a player within their position. Unranked and unavailable players sink. */
function posKey(p) {
  const base = p.posRank != null ? p.posRank : 999;
  return base + (unavailable(p) ? 500 : 0);
}
/* Cross-position ordering for flex slots. Consensus FLEX rank is the right
 * yardstick when we have it: positional ranks from separate lists aren't
 * comparable. Without it, projected points are, because every player on the
 * page was scored by the same league settings. Negated points so that lower
 * is better either way, matching posKey. */
function flexKey(p) {
  const base = p.flexRank != null ? p.flexRank
             : p.pts != null ? -p.pts
             : 999;
  return base + (unavailable(p) ? 5000 : 0);
}

/* Fill the most restrictive slots first, so a lone eligible player isn't
 * taken by a flex slot that had other options. Superflex takes a QB whenever
 * one is available. */
function pickLineup(roster, slots) {
  const avail = roster.slice();
  const order = slots
    .map((s, i) => i)
    .sort((a, b) => (SLOT_ELIGIBLE[slots[a]] || []).length - (SLOT_ELIGIBLE[slots[b]] || []).length);

  const picked = {};
  for (const i of order) {
    const slot = slots[i];
    const elig = SLOT_ELIGIBLE[slot];
    if (!elig) continue;
    let pool = avail.filter((p) => elig.includes(p.p));
    if (!pool.length) continue;

    let key = elig.length > 1 ? flexKey : posKey;
    if (slot === "SUPER_FLEX") {
      const qbs = pool.filter((p) => p.p === "QB");
      if (qbs.length) { pool = qbs; key = posKey; }
    }
    const best = pool.reduce((a, b) => (key(b) < key(a) ? b : a));
    picked[i] = best;
    avail.splice(avail.indexOf(best), 1);
  }

  const starters = [];
  slots.forEach((s, i) => { if (picked[i]) starters.push({ slot: s, player: picked[i] }); });
  return { starters, bench: avail };
}

if (typeof module !== "undefined") {
  module.exports = { norm, trimPlayers, statusFromRow, unavailable, benchReason,
                    scoringLabel, scorePlayer,
                    rankPositions, consensusRanks,
                    pickLineup,
                    posKey, flexKey, buildRoster, normStatus,
                    SLOT_ELIGIBLE, OUT_STATUSES };
}

/* ------------------------------------------------------------------- ui */

if (typeof document !== "undefined") {
  const $ = (s) => document.querySelector(s);
  const el = (tag, cls, txt) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  };

  // Sleeper asks callers not to pull the player dump more than once a day.
  const PLAYERS_KEY = "sleeperPlayers.v1";
  const PLAYERS_MAX_AGE = 20 * 3600 * 1000;

  let DATA = null;
  let LEAGUES = [];

  const setStatus = (msg, isErr) => {
    const s = $("#status");
    s.textContent = msg || "";
    s.className = "status" + (isErr ? " err" : "");
    s.hidden = !msg;
  };

  async function json(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url} returned ${r.status}`);
    return r.json();
  }

  function cachedWithTime(key, maxAge) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const c = JSON.parse(raw);
      const age = Date.now() - (c.fetched || 0);
      return age >= 0 && age < maxAge ? c : null;
    } catch (e) {
      return null;   // private mode, quota, or corrupt entry
    }
  }

  function cache(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify({ fetched: Date.now(), value }));
    } catch (e) { /* over quota or private mode; not worth failing over */ }
  }

  async function loadPlayers(force) {
    if (!force) {
      const hit = cachedWithTime(PLAYERS_KEY, PLAYERS_MAX_AGE);
      if (hit) return { players: hit.value, fetched: hit.fetched };
    }
    setStatus("Fetching the player list from Sleeper (a few MB, once a day)…");
    const players = trimPlayers(await json(`${SLEEPER}/players/nfl`));
    cache(PLAYERS_KEY, players);
    return { players, fetched: Date.now() };
  }

  async function loadProjections(season, week) {
    const url = `${PROJ}/${season}/${week}?season_type=regular` +
      `&position[]=QB&position[]=RB&position[]=WR&position[]=TE` +
      `&position[]=K&position[]=DEF&order_by=pts_half_ppr`;
    const rows = await json(url);
    const list = Array.isArray(rows) ? rows : Object.values(rows);
    const out = {};
    const statuses = {};
    for (const row of list) {
      const pid = String(row.player_id || "");
      const stats = row.stats || {};
      if (!pid) continue;
      const live = statusFromRow(row);
      if (live !== undefined) statuses[pid] = live;
      const kept = {};
      for (const k in stats) if (typeof stats[k] === "number" && stats[k]) kept[k] = stats[k];
      if (Object.keys(kept).length) out[pid] = kept;
    }
    return { projections: out, statuses };
  }

  /* Ranking a full player pool is the expensive part of a render, and leagues
   * with identical scoring produce identical ranks, so key a cache on the
   * settings themselves. */
  const _ranksCache = new Map();

  function ranksFor(data, settings) {
    const key = JSON.stringify(settings || {});
    if (_ranksCache.has(key)) return _ranksCache.get(key);

    const projRanks = rankPositions(data.projections, data.players, settings);
    const consensus = consensusRanks(data.rankings, data.players, settings);
    const ranks = {};
    for (const pid in projRanks) ranks[pid] = { ...projRanks[pid] };
    if (consensus) {
      for (const pid in consensus) ranks[pid] = { ...(ranks[pid] || {}), ...consensus[pid] };
      for (const pid in ranks) if (!(pid in consensus)) ranks[pid].posRank = null;
    }
    const result = { ranks, source: consensus ? "consensus" : "projection" };
    _ranksCache.set(key, result);
    return result;
  }

  async function loadData() {
    if (DATA) return DATA;
    setStatus("Checking the NFL week…");
    const state = await json(`${SLEEPER}/state/nfl`);
    const season = state.season;
    const week = state.week || state.display_week || 1;
    $("#week").textContent = `Week ${week}`;

    const { players, fetched } = await loadPlayers();
    setStatus("Loading projections…");
    const { projections, statuses } = await loadProjections(season, week);

    // Overlay any status the live projections call reported. Injury news moves
    // faster than anything else here and must not be served from a day-old
    // cache; where projections say nothing, the cached value stands.
    let liveStatuses = 0;
    for (const pid in statuses) {
      if (players[pid]) { players[pid].i = statuses[pid]; liveStatuses++; }
    }

    // Optional: if a build has published consensus rankings, prefer them.
    // Without one this 404s and we rank by projection instead.
    let rankings = null;
    try { rankings = await json("data/rankings.json"); } catch (e) { rankings = null; }

    DATA = { season, week, players, projections, rankings,
             playersFetched: fetched, liveStatuses };
    const injAge = (Date.now() - fetched) / 36e5;
    $("#gen").textContent =
      (rankings && rankings.shared
        ? "Ranks from FantasyPros expert consensus. "
        : "Ranks from Sleeper projections, scored by each league's settings. ") +
      (liveStatuses
        ? `Injury statuses refreshed live.`
        : `Injury statuses from the player list, ` +
          `${injAge < 1 ? "under an hour" : `${Math.round(injAge)}h`} old.`);
    return DATA;
  }

  async function go(username) {
    username = (username || "").trim().replace(/^@/, "");
    if (!username) return setStatus("Enter your Sleeper username.", true);

    $("#results").innerHTML = "";
    $("#picker").hidden = true;

    let data;
    try {
      data = await loadData();
    } catch (e) {
      return setStatus(`Couldn't reach Sleeper: ${e.message}`, true);
    }

    try {
      setStatus(`Looking up ${username}…`);
      const user = await json(`${SLEEPER}/user/${encodeURIComponent(username)}`);
      if (!user || !user.user_id) return setStatus(`No Sleeper user named "${username}".`, true);

      const leagues = await json(`${SLEEPER}/user/${user.user_id}/leagues/nfl/${data.season}`);
      if (!leagues.length) {
        return setStatus(`${username} has no NFL leagues for ${data.season}.`, true);
      }

      setStatus(`Loading ${leagues.length} league${leagues.length > 1 ? "s" : ""}…`);

      // Fetch every league's rosters at once rather than one round trip at a
      // time, and keep them independent: one league failing shouldn't cost you
      // the other eleven.
      const settled = await Promise.allSettled(leagues.map(async (lg) => {
        const rosters = await json(`${SLEEPER}/league/${lg.league_id}/rosters`);
        const mine = rosters.find(
          (r) => r.owner_id === user.user_id || (r.co_owners || []).includes(user.user_id));
        if (!mine) return null;

        const settings = lg.scoring_settings || {};
        const { ranks, source } = ranksFor(data, settings);
        const slots = (lg.roster_positions || []).filter((s) => !SKIP_SLOTS.has(s));
        return {
          name: lg.name, id: lg.league_id, slots,
          label: scoringLabel(settings),
          superflex: slots.includes("SUPER_FLEX"),
          teRec: settings.bonus_rec_te || 0,
          roster: buildRoster(mine.players, data.players, ranks, data.week),
          source,
        };
      }));

      LEAGUES = [];
      const failed = [];
      settled.forEach((r, i) => {
        if (r.status === "fulfilled") { if (r.value) LEAGUES.push(r.value); }
        else failed.push(leagues[i].name || leagues[i].league_id);
      });

      if (!LEAGUES.length) {
        return setStatus(failed.length
          ? `Couldn't load any leagues (${failed.join(", ")}).`
          : `Found leagues, but no roster owned by ${username}.`, true);
      }

      try { localStorage.setItem("sleeperUser", username); } catch (e) { /* private mode */ }
      setStatus(failed.length
        ? `Couldn't load ${failed.join(", ")} — showing the rest.` : "", failed.length > 0);
      renderPicker();
      render(0);
    } catch (e) {
      setStatus(`Sleeper request failed: ${e.message}`, true);
    }
  }

  function renderPicker() {
    const sel = $("#league");
    sel.innerHTML = "";
    LEAGUES.forEach((lg, i) => {
      const o = el("option", null, `${lg.name} — ${lg.label}`);
      o.value = i;
      sel.appendChild(o);
    });
    $("#picker").hidden = LEAGUES.length < 2;
    sel.onchange = () => render(+sel.value);
  }

  function playerRow(p, slot) {
    const tr = el("tr");
    if (slot !== undefined) tr.appendChild(el("td", "slot", SLOT_LABEL[slot] || slot));
    const nameCell = el("td", "nm");
    nameCell.appendChild(document.createTextNode(p.n));
    if (p.onBye) nameCell.appendChild(el("span", "out", "BYE"));
    if (p.status) {
      nameCell.appendChild(el("span", OUT_STATUSES.has(p.status) ? "out" : "q", p.status));
    }
    nameCell.appendChild(el("span", "meta", ` ${p.t || "FA"}`));
    tr.appendChild(nameCell);
    tr.appendChild(el("td", "pos", p.p === "DEF" ? "DST" : p.p));
    tr.appendChild(el("td", "pts", p.pts != null ? p.pts.toFixed(1) : "—"));
    const inactive = unavailable(p);
    const rk = el("td", "rk" + (inactive ? " inactive" : ""));
    if (p.posRank != null) {
      const b = el("b", null, `${p.p === "DEF" ? "DST" : p.p}${p.posRank}`);
      if (inactive) b.title = `Ranked ${p.p}${p.posRank}, but ${benchReason(p)} this week`;
      rk.appendChild(b);
    } else {
      rk.className = "rk meta";
      rk.textContent = "—";
    }
    tr.appendChild(rk);
    return tr;
  }

  function table(rows) {
    const wrap = el("div", "tbl-wrap");
    const t = el("table");
    rows.forEach((r) => t.appendChild(r));
    wrap.appendChild(t);
    return wrap;
  }

  function render(idx) {
    const lg = LEAGUES[idx];
    const out = $("#results");
    out.innerHTML = "";
    if (!lg) return;

    const head = el("div", "lh");
    head.appendChild(el("h2", null, lg.name));
    head.appendChild(el("span", "chip fmt", lg.label));
    if (lg.superflex) head.appendChild(el("span", "chip", "Superflex"));
    if (lg.teRec) head.appendChild(el("span", "chip", `TE +${lg.teRec}`));
    out.appendChild(head);

    const { starters, bench } = pickLineup(lg.roster, lg.slots);

    out.appendChild(el("h3", null, "Ideal lineup"));
    if (starters.length) {
      // Every slot has to be filled by someone, so when the healthy players
      // run out an unavailable one still gets started. That's not a pick, it's
      // a gap - say so, because the answer is the waiver wire, not this page.
      const forced = starters.filter((s) => unavailable(s.player));
      if (forced.length) {
        const who = forced
          .map((s) => `${s.player.n} (${benchReason(s.player)})`).join(", ");
        out.appendChild(el("p", "note warn",
          `No healthy replacement for ${who}. ` +
          `${forced.length > 1 ? "They're" : "He's"} still listed below because ` +
          `the slot has to be filled — check waivers.`));
      }
      out.appendChild(table(starters.map((s) => playerRow(s.player, s.slot))));
    } else {
      out.appendChild(el("p", "none", "Couldn't build a lineup from this roster."));
    }

    if (bench.length) {
      out.appendChild(el("h3", null, "Sit"));
      // A strong rank next to a benched player looks wrong unless we say why.
      const sidelined = bench.filter(
        (p) => unavailable(p) && p.posRank != null && p.posRank <= 36);
      if (sidelined.length) {
        const who = sidelined.map((p) => `${p.n} (${benchReason(p)})`).join(", ");
        out.appendChild(el("p", "note",
          `${who} ${sidelined.length > 1 ? "rank" : "ranks"} well but ` +
          `${sidelined.length > 1 ? "are" : "is"} not expected to play, so ` +
          `${sidelined.length > 1 ? "they were" : "he was"} left out of the lineup. ` +
          `Rankings reflect a healthy week.`));
      }
      bench.sort((a, b) => POS_ORDER.indexOf(a.p) - POS_ORDER.indexOf(b.p) || posKey(a) - posKey(b));
      out.appendChild(table(bench.map((p) => playerRow(p))));
    }

    out.appendChild(el("h3", null, "By position"));
    for (const pos of POS_ORDER) {
      const grp = lg.roster.filter((p) => p.p === pos);
      if (!grp.length) continue;
      grp.sort((a, b) => posKey(a) - posKey(b));
      out.appendChild(el("h4", null, pos === "DEF" ? "Defense" : pos));
      out.appendChild(table(grp.map((p) => playerRow(p))));
    }
  }

  async function refresh() {
    setStatus("Refreshing player and injury data…");
    try {
      localStorage.removeItem(PLAYERS_KEY);
    } catch (e) { /* private mode */ }
    DATA = null;
    _ranksCache.clear();
    await go($("#username").value);
  }

  window.addEventListener("DOMContentLoaded", () => {
    $("#form").addEventListener("submit", (e) => {
      e.preventDefault();
      go($("#username").value);
    });
    $("#refresh").addEventListener("click", (e) => {
      e.preventDefault();
      refresh();
    });
    let saved = null;
    try { saved = localStorage.getItem("sleeperUser"); } catch (e) { /* private mode */ }
    if (saved) $("#username").value = saved;
    if (saved) go(saved);
  });
}
