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
    // NFKD splits accented letters into base + mark; dropping everything
    // non-ASCII afterwards also catches letters that don't decompose (Æ, Ø,
    // ß). build.py does exactly this, and test_norm_parity.py holds them
    // together - if they drift, the join silently produces unranked players.
    .normalize("NFKD").replace(/[^\x00-\x7F]/g, "")
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

/* Whether trading is possible in this league right now, and if not, why. */
function tradeWindow(league, week) {
  const s = (league && league.settings) || {};
  const status = league && league.status;
  if (s.disable_trades === 1) return { open: false, reason: "Trades are turned off in this league." };
  if (status === "pre_draft" || status === "drafting") {
    return { open: false, reason: "The draft hasn't finished yet." };
  }
  if (status === "complete") return { open: false, reason: "This league's season is over." };
  const deadline = s.trade_deadline;
  // Sleeper stores 99 when there is no deadline.
  if (deadline && deadline !== 99 && Number(week) > Number(deadline)) {
    return { open: false, reason: `The trade deadline (week ${deadline}) has passed.`, deadline };
  }
  return { open: true, deadline: deadline && deadline !== 99 ? deadline : null };
}

/* --- trade research: shared with trades/engine.js ----------------------- */

const ORDINAL = ["", "1st", "2nd", "3rd", "4th", "5th", "6th"];
// A trade within this much of dead even, by value, reads as "Even" rather
// than favoring either side.
const EVEN_PCT = 0.03;
const isHttps = (url) => /^https:\/\//.test(url || "");

// "experts" is the week's news and what fantasy analysts are saying about
// the players involved: current sentiment is part of every published trade.
const SECTIONS = ["give", "get", "you", "them", "experts"];
// The page's heading for each why-section.
function sectionHeading(key, t) {
  switch (key) {
    case "give": return `Why trade ${t.give.map((p) => p.n).join(" + ")}`;
    case "get": return `Why get ${t.get.map((p) => p.n).join(" + ")}`;
    case "you": return "How it helps your team";
    case "them": return `Why ${t.partner.name} says yes`;
    case "experts": return "What analysts and the news say";
    default: return key;
  }
}
// The exact shape of a published trade: what finalize writes, and all the
// page reads.
const TRADE_FIELDS = ["id", "partner", "give", "get", "value", "you", "them",
                       "headline", "summary", "confidence", "why", "risks", "sources"];

if (typeof module !== "undefined") {
  module.exports = { norm, trimPlayers, statusFromRow, unavailable, benchReason,
                    scoringLabel, scorePlayer,
                    rankPositions, consensusRanks,
                    pickLineup,
                    posKey, flexKey, buildRoster, normStatus, tradeWindow,
                    SLOT_ELIGIBLE, OUT_STATUSES,
                    ORDINAL, EVEN_PCT, isHttps, SECTIONS, sectionHeading, TRADE_FIELDS };
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
    // Sleeper's own dashboard uses league_season for a user's league list: in
    // the offseason, once leagues have renewed, it's ahead of `season` (which
    // stays on the just-finished year until the new one kicks off). Dynasty
    // leagues trade in the offseason, so using the wrong one would look up
    // last year's league ids. Projections and stats stay on `season`.
    const leagueSeason = state.league_season || state.season;
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

    DATA = { season, leagueSeason, week, players, projections, rankings,
             playersFetched: fetched, liveStatuses };
    const injAge = (Date.now() - fetched) / 36e5;
    let rankSrc = "Ranks from Sleeper projections, scored by each league's settings. ";
    if (rankings && rankings.shared) {
      rankSrc = "Ranks from FantasyPros expert consensus";
      if (rankings.generated) {
        const rAge = (Date.now() - new Date(rankings.generated).getTime()) / 36e5;
        rankSrc += `, built ${rAge < 1.5 ? "under an hour" : ageText(rAge)} ago`;
      }
      rankSrc += ". ";
    }
    $("#gen").textContent = rankSrc +
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

      const leagues = await json(`${SLEEPER}/user/${user.user_id}/leagues/nfl/${data.leagueSeason}`);
      if (!leagues.length) {
        return setStatus(`${username} has no NFL leagues for ${data.leagueSeason}.`, true);
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
          trades: tradeWindow(lg, data.week),
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

  // Which tab is showing, kept across league switches and re-renders so
  // changing leagues doesn't bounce you back to the lineup.
  let ACTIVE_TAB = "lineup";
  try {
    const saved = localStorage.getItem("activeTab");
    if (saved === "lineup" || saved === "positions" || saved === "trades") ACTIVE_TAB = saved;
  } catch (e) { /* private mode */ }

  function tabBar(panels) {
    const bar = el("div", "tabs");
    bar.setAttribute("role", "tablist");
    const buttons = [];

    const select = (name) => {
      ACTIVE_TAB = name;
      try { localStorage.setItem("activeTab", name); } catch (e) { /* private mode */ }
      buttons.forEach((b) => {
        const on = b.dataset.tab === name;
        b.setAttribute("aria-selected", String(on));
        b.tabIndex = on ? 0 : -1;
      });
      for (const key in panels) panels[key].hidden = key !== name;
    };

    [["lineup", "Lineup"], ["positions", "By position"], ["trades", "Trades"]].forEach(([name, label]) => {
      const b = el("button", "tab", label);
      b.type = "button";
      b.dataset.tab = name;
      b.setAttribute("role", "tab");
      b.addEventListener("click", () => select(name));
      buttons.push(b);
      bar.appendChild(b);
    });

    bar.addEventListener("keydown", (e) => {
      const i = buttons.findIndex((b) => b.dataset.tab === ACTIVE_TAB);
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        const next = buttons[(i + (e.key === "ArrowRight" ? 1 : buttons.length - 1)) % buttons.length];
        select(next.dataset.tab);
        next.focus();
      }
    });

    select(panels[ACTIVE_TAB] ? ACTIVE_TAB : "lineup");
    return bar;
  }

  function render(idx) {
    const lg = LEAGUES[idx];
    const out = $("#results");
    out.innerHTML = "";
    if (!lg) return;
    if (CURRENT && CURRENT !== lg) closeTradeQuietly();
    CURRENT = lg;

    const head = el("div", "lh");
    head.appendChild(el("h2", null, lg.name));
    head.appendChild(el("span", "chip fmt", lg.label));
    if (lg.superflex) head.appendChild(el("span", "chip", "Superflex"));
    if (lg.teRec) head.appendChild(el("span", "chip", `TE +${lg.teRec}`));
    out.appendChild(head);

    if (lg.source === "consensus") {
      const ranked = lg.roster.filter((p) => p.posRank != null).length;
      if (lg.roster.length && ranked < lg.roster.length * 0.6) {
        out.appendChild(el("p", "note warn",
          `Only ${ranked} of ${lg.roster.length} players have a consensus rank. ` +
          `The FantasyPros plan in use returns a truncated list, so players ` +
          `outside the top few at each position show no rank.`));
      }
    }

    const { starters, bench } = pickLineup(lg.roster, lg.slots);

    // --- lineup panel: start and sit, the week's actual decision -------
    const lineup = el("div", "panel");
    if (starters.length) {
      const forced = starters.filter((s) => unavailable(s.player));
      if (forced.length) {
        const who = forced
          .map((s) => `${s.player.n} (${benchReason(s.player)})`).join(", ");
        lineup.appendChild(el("p", "note warn",
          `No healthy replacement for ${who}. ` +
          `${forced.length > 1 ? "They're" : "He's"} still listed below because ` +
          `the slot has to be filled — check waivers.`));
      }
      lineup.appendChild(table(starters.map((s) => playerRow(s.player, s.slot))));
    } else {
      lineup.appendChild(el("p", "none", "Couldn't build a lineup from this roster."));
    }

    if (bench.length) {
      lineup.appendChild(el("h3", null, "Sit"));
      const sidelined = bench.filter(
        (p) => unavailable(p) && p.posRank != null && p.posRank <= 36);
      if (sidelined.length) {
        const who = sidelined.map((p) => `${p.n} (${benchReason(p)})`).join(", ");
        lineup.appendChild(el("p", "note",
          `${who} ${sidelined.length > 1 ? "rank" : "ranks"} well but ` +
          `${sidelined.length > 1 ? "are" : "is"} not expected to play, so ` +
          `${sidelined.length > 1 ? "they were" : "he was"} left out of the lineup. ` +
          `Rankings reflect a healthy week.`));
      }
      bench.sort((a, b) => POS_ORDER.indexOf(a.p) - POS_ORDER.indexOf(b.p) || posKey(a) - posKey(b));
      lineup.appendChild(table(bench.map((p) => playerRow(p))));
    }

    // --- positions panel: the whole roster, ranked within each position
    const positions = el("div", "panel");
    for (const pos of POS_ORDER) {
      const grp = lg.roster.filter((p) => p.p === pos);
      if (!grp.length) continue;
      grp.sort((a, b) => posKey(a) - posKey(b));
      positions.appendChild(el("h4", null, pos === "DEF" ? "Defense" : pos));
      positions.appendChild(table(grp.map((p) => playerRow(p))));
    }

    // --- trades panel: filled in when the research file arrives
    const trades = el("div", "panel");
    TRADES_PANEL = trades;
    loadTrades(lg, trades);

    out.appendChild(tabBar({ lineup, positions, trades }));
    out.appendChild(lineup);
    out.appendChild(positions);
    out.appendChild(trades);
  }

  async function refresh() {
    setStatus("Refreshing player and injury data…");
    try {
      localStorage.removeItem(PLAYERS_KEY);
    } catch (e) { /* private mode */ }
    DATA = null;
    _ranksCache.clear();
    _trades.clear();
    await go($("#username").value);
  }

  function ageText(hours) {
    return hours < 36 ? `${Math.round(hours)}h` : `${Math.round(hours / 24)} days`;
  }

  /* ------------------------------------------------------------ trades */

  // Trade research is written by a scheduled Claude routine to its own branch,
  // so a run never touches the site itself. raw.githubusercontent serves it
  // with open CORS and a five-minute cache.
  const TRADE_DATA =
    "https://raw.githubusercontent.com/etanetan/sleeper-rankings/refs/heads/claude/trade-data";
  const ROUTINES_URL = "https://claude.ai/code/routines";
  const ROUTINE_NAME = "Sleeper trade research";
  const _trades = new Map();   // league id -> { at, data }
  let CURRENT = null;
  let TRADES_PANEL = null;
  let OPEN_TRADE = null;
  {
    const m = /^#trade-([\w-]+)$/.exec(location.hash);
    if (m) { OPEN_TRADE = m[1]; ACTIVE_TAB = "trades"; }
  }

  async function fetchTrades(id, force) {
    const hit = _trades.get(id);
    if (!force && hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.data;
    const r = await fetch(`${TRADE_DATA}/${encodeURIComponent(id)}.json`, { cache: "no-store" });
    if (r.status === 404) {
      _trades.set(id, { at: Date.now(), data: null });
      return null;
    }
    if (!r.ok) throw new Error(`the research file returned ${r.status}`);
    const data = await r.json();
    _trades.set(id, { at: Date.now(), data });
    return data;
  }

  async function loadTrades(lg, panel, force) {
    panel.innerHTML = "";
    panel.appendChild(el("p", "none", "Loading trade ideas…"));
    let data;
    try {
      data = await fetchTrades(lg.id, force);
    } catch (e) {
      if (CURRENT !== lg) return;
      panel.innerHTML = "";
      panel.appendChild(el("p", "note warn", `Couldn't load trade research: ${e.message}.`));
      return;
    }
    if (CURRENT !== lg || TRADES_PANEL !== panel) return;   // switched leagues meanwhile
    drawTrades(lg, panel, data);
  }

  function drawTrades(lg, panel, data) {
    panel.innerHTML = "";
    const trade = OPEN_TRADE && data && (data.trades || []).find((t) => t.id === OPEN_TRADE);
    panel.appendChild(trade ? tradeDetail(lg, data, trade) : tradeList(lg, panel, data));
  }

  function redrawTrades() {
    if (!CURRENT || !TRADES_PANEL) return;
    const hit = _trades.get(CURRENT.id);
    if (hit) drawTrades(CURRENT, TRADES_PANEL, hit.data);
  }

  function openTrade(id) {
    OPEN_TRADE = id;
    try { history.pushState({ trade: id }, "", `#trade-${id}`); } catch (e) { /* sandboxed */ }
    redrawTrades();
    const tabs = document.querySelector(".tabs");
    if (tabs && tabs.getBoundingClientRect().top < 0) tabs.scrollIntoView({ block: "start" });
  }

  function closeTrade() {
    if (history.state && history.state.trade) { history.back(); return; }   // popstate redraws
    closeTradeQuietly();
    redrawTrades();
  }

  function closeTradeQuietly() {
    OPEN_TRADE = null;
    if (/^#trade-/.test(location.hash)) {
      try { history.replaceState(null, "", location.pathname + location.search); } catch (e) { /* sandboxed */ }
    }
  }

  window.addEventListener("popstate", (e) => {
    OPEN_TRADE = (e.state && e.state.trade) || null;
    redrawTrades();
  });

  function fmtWhen(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return "";
    const old = Date.now() - d.getTime() > 6 * 864e5;
    return d.toLocaleString([], old
      ? { month: "short", day: "numeric" }
      : { weekday: "short", hour: "numeric", minute: "2-digit" });
  }

  function readRequests() {
    try { return JSON.parse(localStorage.getItem("tradeRequests") || "{}") || {}; }
    catch (e) { return {}; }
  }

  function markRequested(id) {
    try {
      const m = readRequests();
      m[id] = Date.now();
      localStorage.setItem("tradeRequests", JSON.stringify(m));
    } catch (e) { /* private mode */ }
  }

  const posLabel = (p) => (p === "DEF" ? "DST" : p);
  const signed = (n) => `${n > 0 ? "+" : ""}${n}`;
  const num = (n) => Math.round(n || 0).toLocaleString();

  function verdictClass(v) {
    if (!v) return "chip";
    return "chip " + (Math.abs(v.diffPct) <= EVEN_PCT ? "fmt" : v.diffPct > 0 ? "good" : "warn");
  }

  // The market call behind each player in a deal. "hold" never reaches a
  // published trade; "avoid" does when a deal is worth it anyway, and says so.
  const TAGS = {
    sell_high: ["SELL HIGH", "sell"],
    buy_low: ["BUY LOW", "buy"],
    avoid: ["AT PEAK", "peak"],
  };

  function tagChip(p) {
    const t = TAGS[p.tag];
    if (!t) return null;
    const chip = el("span", `tag ${t[1]}`, t[0]);
    if (p.tagBy === "research") chip.title = "Confirmed by research";
    return chip;
  }

  /* The numbers behind the call: results against projection, market move,
   * and the usage that says whether it lasts. */
  function formLine(p) {
    const f = p.form;
    const bits = [];
    if (f && f.g) bits.push(`${f.ppg} pts/g vs ${f.proj} projected`);
    if (p.trendPct) {
      bits.push(`value ${p.trendPct > 0 ? "▲" : "▼"}${Math.abs(Math.round(p.trendPct * 100))}% in 30 days`);
    }
    if (f && f.snap != null) bits.push(`${f.snap}% snaps`);
    if (f && f.touches != null) bits.push(`${f.touches} touches/g`);
    else if (f && f.tgtShare != null) bits.push(`${f.tgtShare}% of targets`);
    return bits.join(" · ");
  }

  function tradeList(lg, panel, data) {
    const v = tradesView(data, Date.now(), readRequests()[lg.id]);
    const box = el("div");
    const bar = el("div", "tr-bar");
    bar.appendChild(el("span", "meta", v.generated
      ? `Researched ${fmtWhen(v.generated)} · week ${v.week}` + (v.reviewed ? " · double-checked" : "")
      : "No research for this league yet"));
    const btn = el("button", "ghost small", "Research new trades");
    btn.type = "button";
    if (!lg.trades.open) { btn.disabled = true; btn.title = lg.trades.reason; }
    bar.appendChild(btn);
    box.appendChild(bar);

    const reqSlot = el("div");
    box.appendChild(reqSlot);
    btn.addEventListener("click", () => requestResearch(lg, reqSlot));

    if (!lg.trades.open) {
      box.appendChild(el("p", "note warn", `${lg.trades.reason} No new trade ideas for this league.`));
    }

    if (v.running === "fresh") {
      const n = el("p", "note", `Researching new trades now (started ${fmtWhen(v.started)}). ` +
        `Check back in 15–30 minutes. `);
      const again = el("a", null, "Check again");
      again.href = "#";
      again.addEventListener("click", (e) => { e.preventDefault(); loadTrades(lg, panel, true); });
      n.appendChild(again);
      box.appendChild(n);
    } else if (v.running === "stale") {
      box.appendChild(el("p", "note warn", `The research run started ${fmtWhen(v.started)} ` +
        `never finished. Tap Research new trades to try again.`));
    } else if (v.requested) {
      box.appendChild(el("p", "note", `You asked for new research at ` +
        `${fmtWhen(new Date(v.requested).toISOString())}. It shows up here once the run starts.`));
    }
    if (v.error) {
      box.appendChild(el("p", "note warn", `The last run failed (${fmtWhen(v.error.at)}): ` +
        `${v.error.reason} Showing the trades from before.`));
    }

    if (v.trades.length) {
      box.appendChild(el("p", "tr-intro", "Sell high: your players scoring above expectations. " +
        "Buy low: theirs scoring below it while still getting the ball. " +
        "Your slumping players are never offered."));
    }
    if (v.reason) box.appendChild(el("p", "note", v.reason));
    if (v.empty && !v.reason && !data) {
      box.appendChild(el("p", "none", lg.trades.open
        ? "Trade ideas are researched every Tuesday. Want some now? Tap Research new trades."
        : "Nothing to show."));
    }
    v.trades.forEach((t) => box.appendChild(tradeCard(t, () => openTrade(t.id))));
    if (v.trades.length) box.appendChild(credit(data));
    return box;
  }

  function sideSummary(label, players) {
    const d = el("span", "tc-side");
    d.appendChild(el("span", "tc-label", label));
    players.forEach((p) => {
      const line = el("span", "tc-pl", p.n);
      line.appendChild(el("span", "meta", ` ${posLabel(p.p)}`));
      const chip = tagChip(p);
      if (chip) line.appendChild(chip);
      d.appendChild(line);
    });
    return d;
  }

  function tradeCard(t, onOpen) {
    const b = el("button", "tcard");
    b.type = "button";
    const top = el("span", "tc-top");
    top.appendChild(el("span", "tc-who", `with ${t.partner.name}`));
    if (t.partner.record) top.appendChild(el("span", "meta", t.partner.record));
    top.appendChild(el("span", verdictClass(t.value), t.value.verdict));
    b.appendChild(top);
    const deal = el("span", "tc-deal");
    deal.appendChild(sideSummary("Give", t.give));
    const arrow = el("span", "tc-arrow", "→");
    arrow.setAttribute("aria-hidden", "true");
    deal.appendChild(arrow);
    deal.appendChild(sideSummary("Get", t.get));
    b.appendChild(deal);
    b.appendChild(el("span", "tc-head", t.headline));
    const foot = el("span", "tc-foot");
    foot.appendChild(el("span", null, `Your lineup ${signed(t.you.gainPct)}%`));
    foot.appendChild(el("span", null, `Theirs ${signed(t.them.gainPct)}%`));
    foot.appendChild(el("span", "tc-more", "Why ›"));
    b.appendChild(foot);
    b.addEventListener("click", onOpen);
    return b;
  }

  function dealTable(label, players) {
    const wrap = el("div", "deal-side");
    wrap.appendChild(el("h4", null, label));
    const rows = players.map((p) => {
      const tr = el("tr");
      const nm = el("td", "nm", p.n);
      if (p.status) nm.appendChild(el("span", OUT_STATUSES.has(normStatus(p.status)) ? "out" : "q", normStatus(p.status)));
      else if (p.sidelined) nm.appendChild(el("span", "out", "IR"));
      nm.appendChild(el("span", "meta", ` ${posLabel(p.p)}${p.t ? " · " + p.t : ""}`));
      const chip = tagChip(p);
      if (chip) nm.appendChild(chip);
      const line = formLine(p);
      if (line) nm.appendChild(el("span", "form", line));
      tr.appendChild(nm);
      const v = el("td", "val", num(p.v));
      v.title = "FantasyCalc value";
      tr.appendChild(v);
      return tr;
    });
    wrap.appendChild(table(rows));
    return wrap;
  }

  function bullets(title, items) {
    const sec = el("section", "why");
    sec.appendChild(el("h3", null, title));
    const ul = el("ul");
    items.forEach((t) => ul.appendChild(el("li", null, t)));
    sec.appendChild(ul);
    return sec;
  }

  function credit(data) {
    const url = (data && data.values_source && data.values_source.url) || "https://fantasycalc.com";
    const p = el("p", "credit");
    p.appendChild(document.createTextNode("Trade values from "));
    const a = el("a", null, "FantasyCalc");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    p.appendChild(a);
    p.appendChild(document.createTextNode(", built from real trades in leagues like yours. " +
      "Research and reasoning by Claude."));
    return p;
  }

  /* One line comparing a pick's market price with what picks in the same
   * round have become in this league's own past drafts. */
  function pickCheck(pk, hist) {
    const r = hist && (hist.rounds || []).find((x) => x.round === pk.round);
    if (!r || r.median == null) return "";
    const rd = ORDINAL[pk.round] || `${pk.round}th`;
    const yrs = (hist.seasons || []).slice().sort();
    const span = yrs.length > 1 ? `${yrs[0]}–${yrs[yrs.length - 1]}` : yrs[0] || "past";
    const verdict = pk.v > r.median * 1.2 ? "the market pays more than they've been worth here"
      : pk.v < r.median * 0.8 ? "they've been worth more here than the market pays" : "about what the market pays";
    return `${pk.n} (${num(pk.v)}): ${rd}-round picks in this league's ${span} drafts are worth a median ` +
      `${num(r.median)} today, and ${r.busts}% are worth almost nothing: ${verdict}.`;
  }

  function tradeDetail(lg, data, t) {
    const box = el("div", "tdetail");
    const back = el("button", "ghost small back", "‹ All trades");
    back.type = "button";
    back.addEventListener("click", closeTrade);
    box.appendChild(back);

    box.appendChild(el("h2", "td-title", t.headline));
    const who = el("p", "td-who");
    who.appendChild(document.createTextNode(`with ${t.partner.name}` +
      `${t.partner.record ? ` (${t.partner.record})` : ""} `));
    who.appendChild(el("span", "chip", `${t.confidence} confidence`));
    box.appendChild(who);
    if (t.summary) box.appendChild(el("p", "td-sum", t.summary));

    const deal = el("div", "deal");
    deal.appendChild(dealTable("You give", t.give));
    deal.appendChild(dealTable("You get", t.get));
    box.appendChild(deal);

    const v = t.value;
    const pct = Math.round(Math.abs(v.diffPct) * 100);
    const check = el("p", "vcheck");
    check.appendChild(el("span", verdictClass(v), v.verdict));
    let txt = ` FantasyCalc: you give ${num(v.give)}, you get ${num(v.get)}`;
    if (t.give.length === 1 && t.get.length === 1) {
      txt += pct ? ` (${v.diffPct > 0 ? "+" : "−"}${pct}% for you).` : ". Dead even.";
    } else {
      // The verdict is on package-adjusted values, so say why raw totals that
      // differ still count as even (or by how much they don't).
      txt += ". Counting second pieces at a discount, ";
      txt += pct ? `${v.diffPct > 0 ? "you come" : "they come"} out ${pct}% ahead.` : "it's dead even.";
    }
    check.appendChild(document.createTextNode(txt));
    box.appendChild(check);

    const impact = el("p", "impact");
    impact.textContent = `Starting lineup value: yours ${signed(t.you.gainPct)}%, ` +
      `theirs ${signed(t.them.gainPct)}%.`;
    box.appendChild(impact);
    const ch = t.you.changes || {};
    const changes = [];
    if ((ch.in || []).length) {
      changes.push(`Starts for you: ${ch.in.map((c) => `${c.n} (${SLOT_LABEL[c.slot] || c.slot})`).join(", ")}`);
    }
    if ((ch.out || []).length) changes.push(`Leaves your lineup: ${ch.out.map((c) => c.n).join(", ")}`);
    if (t.you.drop) changes.push(`You'd drop ${t.you.drop.n} to make room.`);
    if (changes.length) {
      const ul = el("ul", "changes");
      changes.forEach((c) => ul.appendChild(el("li", null, c)));
      box.appendChild(ul);
    }

    // What picks in this deal have actually turned into in this league.
    for (const pk of t.give.concat(t.get).filter((p) => p.isPick)) {
      const line = pickCheck(pk, data && data.draft_history);
      if (line) box.appendChild(el("p", "note pickcheck", line));
    }

    const why = t.why || {};
    SECTIONS.forEach((k) => {
      const items = why[k] || [];
      if (k === "experts" && !items.length) return;
      box.appendChild(bullets(sectionHeading(k, t), items));
    });
    if ((t.risks || []).length) box.appendChild(bullets("Risks", t.risks));

    if ((t.sources || []).length) {
      const sec = el("section", "why sources");
      sec.appendChild(el("h3", null, "Sources"));
      const ul = el("ul");
      t.sources.forEach((s) => {
        if (!isHttps(s.url)) return;
        const li = el("li");
        const a = el("a", null, s.title || s.url);
        a.href = s.url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        li.appendChild(a);
        ul.appendChild(li);
      });
      sec.appendChild(ul);
      box.appendChild(sec);
    }

    const back2 = el("button", "ghost small back", "‹ All trades");
    back2.type = "button";
    back2.addEventListener("click", closeTrade);
    box.appendChild(back2);
    box.appendChild(credit(data));
    return box;
  }

  /* A static page can't start a Claude run by itself (the routine API
   * doesn't allow browser calls, and its token can't live in public code),
   * so hand the request to Claude: copy it, then open the routine. */
  function requestResearch(lg, slot) {
    const text = `Research new trades for my Sleeper league "${lg.name}" (league_id ${lg.id}).`;
    slot.innerHTML = "";
    const box = el("div", "note req");
    const msg = el("p", null, "Copying the request…");
    box.appendChild(msg);
    const steps = el("ol");
    [`Open Claude below and tap “${ROUTINE_NAME}”.`, "Tap Run now, paste, and run it.",
     "Come back in 15–30 minutes. New trades land here."]
      .forEach((s) => steps.appendChild(el("li", null, s)));
    box.appendChild(steps);
    const field = el("input", "req-text");
    field.readOnly = true;
    field.value = text;
    field.setAttribute("aria-label", "Research request");
    field.addEventListener("focus", () => field.select());
    box.appendChild(field);
    const go = el("a", "btn", "Open Claude ↗");
    go.href = ROUTINES_URL;
    go.target = "_blank";
    go.rel = "noopener noreferrer";
    box.appendChild(go);
    slot.appendChild(box);
    markRequested(lg.id);

    const done = (ok) => {
      msg.textContent = ok ? "✓ Request copied." : "Copy this request:";
      if (!ok) { field.focus(); field.select(); }
    };
    try {
      navigator.clipboard.writeText(text).then(() => done(true), () => done(false));
    } catch (e) {
      done(false);
    }
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
