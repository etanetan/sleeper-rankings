/* Weekly Sleeper rankings — client side.
 *
 * Rankings come from data/*.json, rebuilt by GitHub Actions (FantasyPros
 * blocks cross-origin requests, so they can't be fetched here). Rosters come
 * straight from the Sleeper API, which does allow them. */

const SLEEPER = "https://api.sleeper.app/v1";

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
const FMT_LABEL = { ppr: "Full PPR", half: "Half PPR", std: "Standard" };
// Sleeper -> FantasyPros team abbreviations.
const TEAM_ALIAS = { JAX: "JAC", WAS: "WSH", LV: "LVR" };

/* ---------------------------------------------------------------- logic */

function scoringFormat(league) {
  const rec = (league.scoring_settings && league.scoring_settings.rec) || 0;
  if (rec >= 0.75) return "ppr";
  if (rec >= 0.25) return "half";
  return "std";
}

function lookupRank(data, fmt, player) {
  const { p: pos, k: key, t: team } = player;
  if (pos === "DEF") {
    const tbl = data.rankings.shared.DST || {};
    return tbl[team] || tbl[TEAM_ALIAS[team]] || null;
  }
  if (pos === "QB" || pos === "K") {
    return (data.rankings.shared[pos] || {})[key] || null;
  }
  return ((data.rankings.formats[fmt] || {})[pos] || {})[key] || null;
}

function lookupFlex(data, fmt, player) {
  if (!["RB", "WR", "TE"].includes(player.p)) return null;
  return ((data.rankings.formats[fmt] || {}).FLEX || {})[player.k] || null;
}

/* Rank a player within their position. Unranked and unavailable players sink. */
function posKey(p) {
  const base = p.posRank != null ? p.posRank : 999;
  return base + (OUT_STATUSES.has(p.status) ? 500 : 0);
}
function flexKey(p) {
  const base = p.flexRank != null ? p.flexRank : (p.posRank != null ? p.posRank + 100 : 999);
  return base + (OUT_STATUSES.has(p.status) ? 500 : 0);
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

function buildRoster(ids, data, fmt) {
  const out = [];
  for (const id of ids || []) {
    const meta = data.players[id];
    if (!meta) continue;
    const p = { ...meta, id, status: normStatus(meta.i) };
    const hit = lookupRank(data, fmt, p);
    p.posRank = hit ? hit.posRank : null;
    p.opp = hit ? hit.opp : "";
    const fx = lookupFlex(data, fmt, p);
    p.flexRank = fx ? fx.rank : null;
    out.push(p);
  }
  return out;
}

if (typeof module !== "undefined") {
  module.exports = { scoringFormat, pickLineup, posKey, flexKey, buildRoster,
                    normStatus, SLOT_ELIGIBLE, OUT_STATUSES };
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

  let DATA = null;     // rankings + players + meta
  let LEAGUES = [];    // [{league, roster, fmt, slots}]

  const setStatus = (msg, isErr) => {
    const s = $("#status");
    s.textContent = msg || "";
    s.className = "status" + (isErr ? " err" : "");
    s.hidden = !msg;
  };

  /* Bare duration, so callers can append "ago" or "old" as the sentence needs. */
  function ageText(hours) {
    if (hours < 1.5) return "less than an hour";
    if (hours < 36) return `${Math.round(hours)} hours`;
    const d = Math.round(hours / 24);
    return `${d} day${d === 1 ? "" : "s"}`;
  }

  async function json(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url} returned ${r.status}`);
    return r.json();
  }

  async function loadData() {
    if (DATA) return DATA;
    const [meta, rankings, players] = await Promise.all([
      json("data/meta.json"), json("data/rankings.json"), json("data/players.json"),
    ]);
    DATA = { meta, rankings, players };
    $("#week").textContent = `Week ${meta.week}`;

    const when = new Date(meta.generated);
    const hours = (Date.now() - when.getTime()) / 36e5;
    $("#gen").textContent =
      `Rankings updated ${hours < 1.5 ? "just now" : ageText(hours) + " ago"} ` +
      `(${when.toLocaleString()}).`;
    // Injury flags come from Sleeper live, but the ranks themselves are only as
    // fresh as the last build - say so rather than let them look current.
    const warn = $("#stale");
    if (hours > 36) {
      warn.textContent = `These rankings are ${ageText(hours)} old. ` +
        `Re-run the build for current numbers.`;
      warn.hidden = false;
    } else {
      warn.hidden = true;
    }
    return DATA;
  }

  async function go(username) {
    username = (username || "").trim().replace(/^@/, "");
    if (!username) return setStatus("Enter your Sleeper username.", true);

    setStatus("Loading rankings…");
    $("#results").innerHTML = "";
    $("#picker").hidden = true;

    let data;
    try {
      data = await loadData();
    } catch (e) {
      return setStatus(`Couldn't load the rankings data (${e.message}).`, true);
    }

    try {
      setStatus(`Looking up ${username}…`);
      const user = await json(`${SLEEPER}/user/${encodeURIComponent(username)}`);
      if (!user || !user.user_id) return setStatus(`No Sleeper user named "${username}".`, true);

      const season = data.meta.season;
      const leagues = await json(`${SLEEPER}/user/${user.user_id}/leagues/nfl/${season}`);
      if (!leagues.length) return setStatus(`${username} has no NFL leagues for ${season}.`, true);

      setStatus(`Loading ${leagues.length} league${leagues.length > 1 ? "s" : ""}…`);
      LEAGUES = [];
      for (const lg of leagues) {
        const rosters = await json(`${SLEEPER}/league/${lg.league_id}/rosters`);
        const mine = rosters.find(
          (r) => r.owner_id === user.user_id ||
                 (r.co_owners || []).includes(user.user_id));
        if (!mine) continue;
        const fmt = scoringFormat(lg);
        const slots = (lg.roster_positions || []).filter((s) => !SKIP_SLOTS.has(s));
        LEAGUES.push({
          name: lg.name, id: lg.league_id, fmt, slots,
          superflex: slots.includes("SUPER_FLEX"),
          teRec: (lg.scoring_settings || {}).bonus_rec_te || 0,
          roster: buildRoster(mine.players, data, fmt),
        });
      }
      if (!LEAGUES.length) return setStatus(`Found leagues, but no roster owned by ${username}.`, true);

      try { localStorage.setItem("sleeperUser", username); } catch (e) { /* private mode */ }
      setStatus("");
      renderPicker();
      render(0);
    } catch (e) {
      setStatus(`Sleeper request failed: ${e.message}. ` +
        `If this keeps happening the API may be unreachable from your browser.`, true);
    }
  }

  function renderPicker() {
    const sel = $("#league");
    sel.innerHTML = "";
    LEAGUES.forEach((lg, i) => {
      const o = el("option", null, `${lg.name} — ${FMT_LABEL[lg.fmt]}`);
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
      const b = el("span", OUT_STATUSES.has(p.status) ? "out" : "q", p.status);
      nameCell.appendChild(b);
    }
    const meta = el("span", "meta", ` ${p.t || "FA"}${p.opp ? " " + p.opp : ""}`);
    nameCell.appendChild(meta);
    tr.appendChild(nameCell);
    tr.appendChild(el("td", "pos", p.p === "DEF" ? "DST" : p.p));
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
    head.appendChild(el("span", "chip fmt", FMT_LABEL[lg.fmt]));
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
      const h = el("h4", null, pos === "DEF" ? "Defense" : pos);
      out.appendChild(h);
      out.appendChild(table(grp.map((p) => playerRow(p))));
    }
  }

  window.addEventListener("DOMContentLoaded", () => {
    const form = $("#form");
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      go($("#username").value);
    });
    let saved = null;
    try { saved = localStorage.getItem("sleeperUser"); } catch (e) { /* private mode */ }
    if (saved) { $("#username").value = saved; go(saved); }
    loadData().catch(() => {});
  });
}
