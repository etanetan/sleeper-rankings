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

/* Sleeper sends full words ("Questionable"); show a short badge and decide
 * from the normalized form which statuses should sink in the lineup. */
const INJ_ABBR = {
  QUESTIONABLE: "Q", DOUBTFUL: "D", OUT: "OUT", IR: "IR", PUP: "PUP",
  SUS: "SUS", SUSPENDED: "SUS", COV: "COV", NA: "NA", DNR: "DNR",
};
const OUT_STATUSES = new Set(["OUT", "IR", "PUP", "SUS", "NA", "DNR", "D"]);

function normStatus(raw) {
  const s = (raw || "").trim().toUpperCase();
  if (!s) return "";
  return INJ_ABBR[s] || s.slice(0, 3);
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

function buildRoster(ids, players, ranks) {
  const out = [];
  for (const id of ids || []) {
    const meta = players[id];
    if (!meta) continue;
    const r = ranks[id];
    out.push({
      ...meta, id, status: normStatus(meta.i),
      posRank: r ? r.posRank : null,
      pts: r ? r.pts : null,
    });
  }
  return out;
}

/* Rank a player within their position. Unranked and unavailable players sink. */
function posKey(p) {
  const base = p.posRank != null ? p.posRank : 999;
  return base + (OUT_STATUSES.has(p.status) ? 500 : 0);
}
/* Across positions, compare projected points directly - they're all scored by
 * the same league settings, so they're on one scale. Negated so that lower is
 * better, matching posKey. */
function flexKey(p) {
  const base = p.pts != null ? -p.pts : 999;
  return base + (OUT_STATUSES.has(p.status) ? 5000 : 0);
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
  module.exports = { scoringLabel, scorePlayer, rankPositions, pickLineup,
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

  let DATA = null;
  let LEAGUES = [];

  const setStatus = (msg, isErr) => {
    const s = $("#status");
    s.textContent = msg || "";
    s.className = "status" + (isErr ? " err" : "");
    s.hidden = !msg;
  };

  function ageText(hours) {
    if (hours < 1.5) return "less than an hour";
    if (hours < 36) return `${Math.round(hours)} hours`;
    const d = Math.round(hours / 24);
    return `${d} day${d === 1 ? "" : "s"}`;
  }

  async function json(url, opts) {
    const r = await fetch(url, opts);
    if (!r.ok) throw new Error(`${url} returned ${r.status}`);
    return r.json();
  }

  /* Projections are prebuilt so the page always works, but try for live ones
   * first - they move with injury news, and the prebuilt copy is only as new
   * as the last build. */
  async function liveProjections(season, week) {
    const url = `${PROJ}/${season}/${week}?season_type=regular` +
      `&position[]=QB&position[]=RB&position[]=WR&position[]=TE` +
      `&position[]=K&position[]=DEF&order_by=pts_half_ppr`;
    const rows = await json(url);
    const list = Array.isArray(rows) ? rows : Object.values(rows);
    const out = {};
    for (const row of list) {
      const pid = String(row.player_id || "");
      const stats = row.stats || {};
      if (pid && Object.keys(stats).length) out[pid] = stats;
    }
    if (!Object.keys(out).length) throw new Error("empty projection payload");
    return out;
  }

  async function loadData() {
    if (DATA) return DATA;
    const [meta, players, projections] = await Promise.all([
      json("data/meta.json"), json("data/players.json"), json("data/projections.json"),
    ]);
    DATA = { meta, players, projections, live: false };
    $("#week").textContent = `Week ${meta.week}`;

    try {
      DATA.projections = await liveProjections(meta.season, meta.week);
      DATA.live = true;
    } catch (e) {
      console.info("live projections unavailable, using prebuilt:", e.message);
    }

    const when = new Date(meta.generated);
    const hours = (Date.now() - when.getTime()) / 36e5;
    $("#gen").textContent = DATA.live
      ? "Projections fetched live from Sleeper just now."
      : `Projections from the last build, ` +
        `${hours < 1.5 ? "under an hour" : ageText(hours)} old ` +
        `(${when.toLocaleString()}).`;

    const warn = $("#stale");
    // Only the prebuilt copy can go stale; a live fetch is current by definition.
    if (!DATA.live && hours > 36) {
      warn.textContent = `These projections are ${ageText(hours)} old and ` +
        `Sleeper couldn't be reached for fresher ones. Re-run the build.`;
      warn.hidden = false;
    } else {
      warn.hidden = true;
    }
    return DATA;
  }

  async function go(username) {
    username = (username || "").trim().replace(/^@/, "");
    if (!username) return setStatus("Enter your Sleeper username.", true);

    setStatus("Loading projections…");
    $("#results").innerHTML = "";
    $("#picker").hidden = true;

    let data;
    try {
      data = await loadData();
    } catch (e) {
      return setStatus(`Couldn't load the projection data (${e.message}).`, true);
    }

    try {
      setStatus(`Looking up ${username}…`);
      const user = await json(`${SLEEPER}/user/${encodeURIComponent(username)}`);
      if (!user || !user.user_id) return setStatus(`No Sleeper user named "${username}".`, true);

      const leagues = await json(
        `${SLEEPER}/user/${user.user_id}/leagues/nfl/${data.meta.season}`);
      if (!leagues.length) {
        return setStatus(`${username} has no NFL leagues for ${data.meta.season}.`, true);
      }

      setStatus(`Loading ${leagues.length} league${leagues.length > 1 ? "s" : ""}…`);
      LEAGUES = [];
      for (const lg of leagues) {
        const rosters = await json(`${SLEEPER}/league/${lg.league_id}/rosters`);
        const mine = rosters.find(
          (r) => r.owner_id === user.user_id || (r.co_owners || []).includes(user.user_id));
        if (!mine) continue;
        const settings = lg.scoring_settings || {};
        const ranks = rankPositions(data.projections, data.players, settings);
        const slots = (lg.roster_positions || []).filter((s) => !SKIP_SLOTS.has(s));
        LEAGUES.push({
          name: lg.name, id: lg.league_id, slots,
          label: scoringLabel(settings),
          superflex: slots.includes("SUPER_FLEX"),
          teRec: settings.bonus_rec_te || 0,
          roster: buildRoster(mine.players, data.players, ranks),
        });
      }
      if (!LEAGUES.length) {
        return setStatus(`Found leagues, but no roster owned by ${username}.`, true);
      }

      try { localStorage.setItem("sleeperUser", username); } catch (e) { /* private mode */ }
      setStatus("");
      renderPicker();
      render(0);
    } catch (e) {
      setStatus(`Sleeper request failed: ${e.message}.`, true);
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
    if (p.status) {
      nameCell.appendChild(el("span", OUT_STATUSES.has(p.status) ? "out" : "q", p.status));
    }
    nameCell.appendChild(el("span", "meta", ` ${p.t || "FA"}`));
    tr.appendChild(nameCell);
    tr.appendChild(el("td", "pos", p.p === "DEF" ? "DST" : p.p));
    tr.appendChild(el("td", "pts", p.pts != null ? p.pts.toFixed(1) : "—"));
    const rk = el("td", "rk");
    if (p.posRank != null) {
      rk.appendChild(el("b", null, `${p.p === "DEF" ? "DST" : p.p}${p.posRank}`));
    } else {
      rk.className = "rk meta";
      rk.textContent = "unranked";
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
      out.appendChild(table(starters.map((s) => playerRow(s.player, s.slot))));
    } else {
      out.appendChild(el("p", "none", "Couldn't build a lineup from this roster."));
    }

    if (bench.length) {
      out.appendChild(el("h3", null, "Sit"));
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

  window.addEventListener("DOMContentLoaded", () => {
    $("#form").addEventListener("submit", (e) => {
      e.preventDefault();
      go($("#username").value);
    });
    let saved = null;
    try { saved = localStorage.getItem("sleeperUser"); } catch (e) { /* private mode */ }
    if (saved) { $("#username").value = saved; go(saved); }
    loadData().catch(() => {});
  });
}
