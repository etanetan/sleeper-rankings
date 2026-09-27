#!/usr/bin/env node
/* Trade research engine.
 *
 * The numbers half of the weekly trade research: finds the leagues where
 * trades are open, values every rostered player with FantasyCalc (scaled to
 * each league's format), and searches for trades that are fair by market
 * value and improve both starting lineups. The research half — news, usage
 * trends, the reasons — is done by Claude on top of these candidates; see
 * .claude/skills/trade-research/SKILL.md. `finalize` merges that research back
 * in and refuses anything the numbers don't support.
 *
 *   node trades/engine.js candidates --user etanetan [--league <id|name>] [--out trades/work]
 *   node trades/engine.js running    --league <id> --data <dir>
 *   node trades/engine.js finalize   --league <id> --research <file> --data <dir> [--work trades/work]
 *   node trades/engine.js failed     --league <id> --data <dir> --reason "<why>"
 */

const fs = require("fs");
const path = require("path");
const { SLOT_ELIGIBLE, tradeWindow, normStatus } = require("../app.js");

const SLEEPER = "https://api.sleeper.app/v1";
const FANTASYCALC = "https://api.fantasycalc.com/values/current";
const SKIP_SLOTS = new Set(["BN", "IR", "TAXI"]);

// A trade is "fair" when the package-adjusted values are within this much of
// each other. Generation and finalize use the same bar, so nothing the
// research step writes can drift past it.
const FAIR_PCT = 0.10;
// Extra pieces in a package are worth less than the first: roster spots are
// scarce and one good player beats two middling ones. Applied to both sides.
const PACKAGE_WEIGHTS = [1, 0.8, 0.65, 0.5];
// Bench players matter a little (byes, injuries), starters a lot.
const BENCH_WEIGHT = 0.1;
const BENCH_DEPTH = 4;
const MAX_PIECES = 2;
const POOL_SIZE = 14;
// The other side has to come out ahead too, not merely even: a pitch that
// leaves their lineup unchanged gives them no reason to accept.
const THEIR_MIN_GAIN = 0.002;
const LEAGUE_TYPES = { 0: "redraft", 1: "keeper", 2: "dynasty" };
// Out for weeks, not days: these players can't help a lineup now, whatever
// they're worth on the market. A one-week "Out" still counts.
const LONG_OUT = new Set(["IR", "PUP", "SUS", "NA", "DNR"]);

/* ------------------------------------------------------------- leagues */

/* FantasyCalc scales its values to the league's format. It only knows 0, 0.5
 * and 1 PPR and 1 or 2 starting QBs, so snap to the nearest. Keeper leagues
 * use redraft values: this season is most of what a keeper is worth. */
function fcParams(league) {
  const s = league.settings || {};
  const sc = league.scoring_settings || {};
  const slots = league.roster_positions || [];
  const qbSlots = slots.filter((x) => x === "QB").length;
  const rec = Number(sc.rec || 0);
  return {
    isDynasty: s.type === 2,
    numQbs: slots.includes("SUPER_FLEX") || qbSlots >= 2 ? 2 : 1,
    numTeams: Number(league.total_rosters || s.num_teams || 12),
    ppr: rec >= 0.75 ? 1 : rec >= 0.25 ? 0.5 : 0,
  };
}

function fcUrl(p) {
  return `${FANTASYCALC}?isDynasty=${p.isDynasty}&numQbs=${p.numQbs}` +
    `&numTeams=${p.numTeams}&ppr=${p.ppr}`;
}

/* sleeperId -> what we need from a FantasyCalc row. */
function valueMap(rows) {
  const out = {};
  for (const r of rows || []) {
    const pl = r.player || {};
    if (!pl.sleeperId) continue;
    out[String(pl.sleeperId)] = {
      v: Math.round(r.value || 0),
      pr: r.positionRank != null ? r.positionRank : null,
      trend: Math.round(r.trend30Day || 0),
      n: pl.name, p: pl.position, t: pl.maybeTeam || null,
    };
  }
  return out;
}

/* A roster as tradeable pieces. Players FantasyCalc doesn't value (kickers,
 * defenses, deep bench) stay on the roster at zero so lineups are real.
 * Taxi and IR players are tradeable but don't use a roster spot, and anyone
 * on IR or out long-term keeps his trade value but can't start. */
function teamPlayers(ids, players, values, taxi, reserve) {
  const skip = new Set(taxi || []);
  const ir = new Set(reserve || []);
  const out = [];
  for (const id of ids || []) {
    const meta = players[id] || {};
    const val = values[id] || {};
    const pos = meta.p || val.p;
    if (!pos) continue;
    const status = meta.i || null;
    out.push({
      id: String(id), n: (meta.n || val.n || String(id)).trim(), p: pos,
      t: meta.t || val.t || null, status,
      v: val.v || 0, pr: val.pr != null ? val.pr : null, trend: val.trend || 0,
      taxi: skip.has(id), ir: ir.has(id), longOut: LONG_OUT.has(normStatus(status)),
    });
  }
  return out;
}

const sidelined = (p) => p.ir || p.longOut;

/* Best lineup by value. Most restrictive slots first, like the site's
 * lineup, so a flex doesn't steal the only eligible TE. Sidelined players
 * never start: a slot with no healthy option stays empty. */
function lineup(roster, slots) {
  const avail = roster.filter((p) => !p.taxi && !sidelined(p));
  const order = slots.map((s, i) => i)
    .sort((a, b) => (SLOT_ELIGIBLE[slots[a]] || []).length - (SLOT_ELIGIBLE[slots[b]] || []).length);
  const picked = [];
  for (const i of order) {
    const elig = SLOT_ELIGIBLE[slots[i]];
    if (!elig) continue;
    let best = null;
    for (const p of avail) {
      if (elig.includes(p.p) && (!best || p.v > best.v)) best = p;
    }
    if (!best) continue;
    picked[i] = best;
    avail.splice(avail.indexOf(best), 1);
  }
  const starters = [];
  slots.forEach((s, i) => { if (picked[i]) starters.push({ slot: s, player: picked[i] }); });
  return { starters, bench: avail.concat(roster.filter((p) => p.taxi || sidelined(p))) };
}

/* One number for how good a roster is: starters, plus a little for depth. */
function strength(roster, slots) {
  const { starters, bench } = lineup(roster, slots);
  const s = starters.reduce((a, x) => a + x.player.v, 0);
  const depth = bench.filter((p) => !p.taxi && !sidelined(p)).map((p) => p.v)
    .sort((a, b) => b - a).slice(0, BENCH_DEPTH).reduce((a, v) => a + v, 0);
  return Math.round(s + BENCH_WEIGHT * depth);
}

function packageValue(vals) {
  return Math.round(vals.slice().sort((a, b) => b - a)
    .reduce((a, v, i) => a + v * PACKAGE_WEIGHTS[Math.min(i, PACKAGE_WEIGHTS.length - 1)], 0));
}

/* Market fairness from your side: positive means you get more value. The gap
 * is measured against the best player in the deal rather than the totals, so
 * adding an equal piece to each side (QB for QB) can't shrink a lopsided
 * trade's percentage until it passes. */
function fairness(giveVals, getVals) {
  const give = giveVals.reduce((a, v) => a + v, 0);
  const get = getVals.reduce((a, v) => a + v, 0);
  const giveAdj = packageValue(giveVals);
  const getAdj = packageValue(getVals);
  const top = Math.max(...giveVals, ...getVals, 1);
  const diffPct = Math.round(((getAdj - giveAdj) / top) * 1000) / 1000;
  return {
    give, get, giveAdj, getAdj, diffPct,
    fair: Math.abs(diffPct) <= FAIR_PCT,
    verdict: Math.abs(diffPct) <= 0.03 ? "Even"
      : diffPct > 0 ? "Slightly in your favor" : "You pay a little more",
  };
}

function swap(roster, out, inn) {
  const gone = new Set(out.map((p) => p.id));
  // Injuries travel with the player: someone in your IR slot is just as hurt
  // on their roster. Only taxi status is the team's own choice.
  return roster.filter((p) => !gone.has(p.id)).concat(inn.map((p) => ({ ...p, taxi: false })));
}

function combos(pool, max) {
  const out = pool.map((p) => [p]);
  if (max >= 2) {
    for (let i = 0; i < pool.length; i++) {
      for (let j = i + 1; j < pool.length; j++) out.push([pool[i], pool[j]]);
    }
  }
  return out;
}

/* Who enters and leaves the starting lineup. Net of reshuffles: a starter
 * sliding from RB2 to FLEX isn't news. */
function lineupChanges(before, after) {
  const was = new Set(before.starters.map((s) => s.player.id));
  const now = new Set(after.starters.map((s) => s.player.id));
  return {
    in: after.starters.filter((s) => !was.has(s.player.id)).map((s) => ({ n: s.player.n, slot: s.slot })),
    out: before.starters.filter((s) => !now.has(s.player.id)).map((s) => ({ n: s.player.n, slot: s.slot })),
  };
}

/* Who gets cut when a trade brings in more players than it sends out. */
function dropFor(rosterAfter, rosterSize) {
  const active = rosterAfter.filter((p) => !p.taxi && !p.ir);
  if (!rosterSize || active.length <= rosterSize) return null;
  const cut = active.slice().sort((a, b) => a.v - b.v)[0];
  return cut ? { id: cut.id, n: cut.n, p: cut.p, v: cut.v } : null;
}

function hashId(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

const slim = (p) => ({ id: p.id, n: p.n, p: p.p, t: p.t, v: p.v, pr: p.pr, trend: p.trend,
                       status: p.status || null, sidelined: sidelined(p) });

/* Every fair trade with one partner that makes both starting lineups better,
 * best first. `me` and `them` are roster arrays from teamPlayers. */
function tradesWith(me, them, slots, rosterSize) {
  const pool = (r) => r.filter((p) => p.v > 0).sort((a, b) => b.v - a.v).slice(0, POOL_SIZE);
  const myPkgs = combos(pool(me), MAX_PIECES);
  const theirPkgs = combos(pool(them), MAX_PIECES);
  const myBefore = lineup(me, slots);
  const theirBefore = lineup(them, slots);
  const myBase = strength(me, slots);
  const theirBase = strength(them, slots);

  const found = [];
  for (const give of myPkgs) {
    const giveVals = give.map((p) => p.v);
    for (const get of theirPkgs) {
      const f = fairness(giveVals, get.map((p) => p.v));
      if (!f.fair) continue;
      const myAfterRoster = swap(me, give, get);
      const theirAfterRoster = swap(them, get, give);
      const myAfter = strength(myAfterRoster, slots);
      const theirAfter = strength(theirAfterRoster, slots);
      const myGain = (myAfter - myBase) / Math.max(myBase, 1);
      const theirGain = (theirAfter - theirBase) / Math.max(theirBase, 1);
      // Worth pitching only if it helps you and the other side has a reason
      // to say yes, not just a reason not to say no.
      if (myGain <= 0.005 || theirGain < THEIR_MIN_GAIN) continue;
      found.push({
        give, get, f, myBase, myAfter, theirBase, theirAfter, myGain, theirGain,
        myAfterRoster, theirAfterRoster,
        score: myGain + 0.5 * theirGain - 0.25 * Math.abs(f.diffPct),
      });
    }
  }
  // Drop padded deals: a trade that is only a simpler trade plus a wash
  // (QB for an equal QB, junk for junk) adds pieces without adding anything.
  const sig = (give, get) => `${give.map((p) => p.id).sort()}>${get.map((p) => p.id).sort()}`;
  const bySig = new Map(found.map((c) => [sig(c.give, c.get), c]));
  const simpler = (c) => {
    const gives = [c.give, ...c.give.map((p) => c.give.filter((x) => x !== p))].filter((g) => g.length);
    const gets = [c.get, ...c.get.map((p) => c.get.filter((x) => x !== p))].filter((g) => g.length);
    for (const g of gives) {
      for (const h of gets) {
        if (g === c.give && h === c.get) continue;
        const s = bySig.get(sig(g, h));
        // Judged on what the deal does for each lineup, not on score: a wash
        // piece can nudge the value gap and so the score without mattering.
        if (s && s.myGain >= c.myGain - 0.002 && s.theirGain >= c.theirGain - 0.002) return true;
      }
    }
    return false;
  };
  const kept = found.filter((c) => !simpler(c));

  kept.sort((a, b) => b.score - a.score);
  return kept.map((c) => ({
    ...c,
    myChanges: lineupChanges(myBefore, lineup(c.myAfterRoster, slots)),
    theirChanges: lineupChanges(theirBefore, lineup(c.theirAfterRoster, slots)),
    myDrop: dropFor(c.myAfterRoster, rosterSize),
    theirDrop: dropFor(c.theirAfterRoster, rosterSize),
  }));
}

/* Starter value at each position, and where a team is thin or deep compared
 * with the rest of the league. */
function positionProfile(teams, slots) {
  const byTeam = {};
  for (const t of teams) {
    const { starters } = lineup(t.roster, slots);
    const sums = {};
    for (const s of starters) sums[s.player.p] = (sums[s.player.p] || 0) + s.player.v;
    byTeam[t.roster_id] = sums;
  }
  const positions = ["QB", "RB", "WR", "TE"];
  const avg = {};
  for (const pos of positions) {
    const vals = teams.map((t) => byTeam[t.roster_id][pos] || 0);
    avg[pos] = vals.reduce((a, v) => a + v, 0) / Math.max(vals.length, 1);
  }
  const profile = {};
  for (const t of teams) {
    const rel = {};
    for (const pos of positions) {
      rel[pos] = avg[pos] ? Math.round(((byTeam[t.roster_id][pos] || 0) / avg[pos]) * 100) : null;
    }
    const sorted = positions.filter((p) => rel[p] != null).sort((a, b) => rel[a] - rel[b]);
    profile[t.roster_id] = { vsLeague: rel, thin: sorted.slice(0, 2), deep: sorted.slice(-2).reverse() };
  }
  return profile;
}

/* The parts of a league's setup that change what a player is worth. */
function leagueNotes(league) {
  const s = league.settings || {};
  const sc = league.scoring_settings || {};
  const slots = league.roster_positions || [];
  return {
    type: LEAGUE_TYPES[s.type] || "other",
    superflex: slots.includes("SUPER_FLEX"),
    rec: Number(sc.rec || 0),
    te_premium: Number(sc.bonus_rec_te || 0),
    pass_td: sc.pass_td != null ? Number(sc.pass_td) : null,
    starters: slots.filter((x) => !SKIP_SLOTS.has(x)),
    taxi_slots: Number(s.taxi_slots || 0),
    trade_deadline: s.trade_deadline && s.trade_deadline !== 99 ? s.trade_deadline : null,
  };
}

/* Candidates for one league, spread across partners and players so the
 * research step has real choices rather than twelve versions of one deal. */
function leagueCandidates(ctx, opts) {
  const limit = (opts && opts.limit) || 12;
  const { league, teams, myRosterId, slots } = ctx;
  const me = teams.find((t) => t.roster_id === myRosterId);
  const rosterSize = (league.roster_positions || []).filter((s) => s !== "IR" && s !== "TAXI").length;
  const profile = positionProfile(teams, slots);

  const all = [];
  for (const t of teams) {
    if (t.roster_id === myRosterId) continue;
    for (const c of tradesWith(me.roster, t.roster, slots, rosterSize)) all.push({ ...c, partner: t });
  }
  all.sort((a, b) => b.score - a.score);

  const perPartner = {}, perGet = {}, perGive = {};
  const picked = [];
  for (const c of all) {
    if (picked.length >= limit) break;
    const pk = c.partner.roster_id;
    const getKey = c.get.map((p) => p.id).sort().join("+");
    if ((perPartner[pk] || 0) >= 2) continue;
    if (c.get.some((p) => (perGet[p.id] || 0) >= 2)) continue;
    if (c.give.some((p) => (perGive[p.id] || 0) >= 3)) continue;
    perPartner[pk] = (perPartner[pk] || 0) + 1;
    c.get.forEach((p) => { perGet[p.id] = (perGet[p.id] || 0) + 1; });
    c.give.forEach((p) => { perGive[p.id] = (perGive[p.id] || 0) + 1; });
    const giveKey = c.give.map((p) => p.id).sort().join("+");
    picked.push({
      id: hashId(`${league.league_id}:${giveKey}>${getKey}`),
      partner: {
        roster_id: pk, name: c.partner.name, user: c.partner.user,
        record: c.partner.record, thin: profile[pk].thin, deep: profile[pk].deep,
      },
      give: c.give.map(slim), get: c.get.map(slim),
      value: c.f,
      you: { before: c.myBase, after: c.myAfter, gainPct: Math.round(c.myGain * 1000) / 10,
             changes: c.myChanges, drop: c.myDrop },
      them: { before: c.theirBase, after: c.theirAfter, gainPct: Math.round(c.theirGain * 1000) / 10,
              changes: c.theirChanges, drop: c.theirDrop },
    });
  }

  const { starters, bench } = lineup(me.roster, slots);
  return {
    version: 1,
    league_id: league.league_id,
    league_name: league.name,
    season: ctx.season, week: ctx.week,
    window: tradeWindow(league, ctx.week),
    format: fcParams(league),
    // What FantasyCalc can't see, for the research step to weigh by hand.
    league: leagueNotes(league),
    values_source: { name: "FantasyCalc", url: "https://fantasycalc.com",
                     api: fcUrl(fcParams(league)), fetched: ctx.valuesFetched },
    me: {
      roster_id: myRosterId, name: me.name, record: me.record,
      thin: profile[myRosterId].thin, deep: profile[myRosterId].deep,
      vsLeague: profile[myRosterId].vsLeague,
      starters: starters.map((s) => ({ slot: s.slot, ...slim(s.player) })),
      bench: bench.map(slim),
    },
    candidates: picked,
  };
}

/* ------------------------------------------------------------ finalize */

const SECTIONS = ["give", "get", "you", "them"];
// The page talks to the manager: "you", never "I" or "we".
const FIRST_PERSON = /(^|[^\w'’])(I|I'm|I’m|I've|I’ve|I'd|I’d|[Mm]y|[Mm]ine|[Ww]e|[Ww]e're|[Ww]e’re|[Oo]ur|[Oo]urs|[Uu]s)(?=$|[^\w'’])/;

/* Merge Claude's research into the candidates it chose. Every number comes
 * from the candidates file, never from the research, and a trade that isn't
 * fair by FantasyCalc is rejected however well it's argued. */
function finalize(work, research, now) {
  const errors = [];
  const byId = {};
  for (const c of work.candidates || []) byId[c.id] = c;
  const trades = [];
  const list = (research && research.trades) || [];

  if (!list.length && !(research && research.none_reason)) {
    errors.push("No trades and no none_reason: say why nothing was worth proposing.");
  }
  if (list.length > 6) errors.push(`${list.length} trades; keep it to the best 6 or fewer.`);

  const nonEmpty = (a) => Array.isArray(a) && a.length > 0 &&
    a.every((s) => typeof s === "string" && s.trim().length > 0);

  list.forEach((r, i) => {
    const where = `trades[${i}]`;
    const c = byId[r.candidate];
    if (!c) { errors.push(`${where}: unknown candidate "${r.candidate}".`); return; }
    if (!r.headline || r.headline.length > 120) errors.push(`${where}: headline missing or over 120 chars.`);
    const why = r.why || {};
    for (const k of SECTIONS) {
      if (!nonEmpty(why[k])) errors.push(`${where}: why.${k} needs at least one bullet.`);
      else if (why[k].length > 6) errors.push(`${where}: why.${k} has ${why[k].length} bullets; max 6.`);
    }
    if (r.risks != null && !nonEmpty(r.risks)) errors.push(`${where}: risks must be a list of strings.`);
    const sources = r.sources || [];
    if (!sources.length) errors.push(`${where}: cite at least one source.`);
    sources.forEach((s, j) => {
      if (!s || !/^https:\/\//.test(s.url || "") || !s.title) {
        errors.push(`${where}: sources[${j}] needs a title and an https url.`);
      }
    });
    const prose = [["headline", r.headline], ["summary", r.summary]]
      .concat(SECTIONS.flatMap((k) => (why[k] || []).map((b, j) => [`why.${k}[${j}]`, b])))
      .concat((r.risks || []).map((b, j) => [`risks[${j}]`, b]));
    for (const [field, text] of prose) {
      if (typeof text === "string" && FIRST_PERSON.test(text)) {
        errors.push(`${where}: ${field} says "${text.match(FIRST_PERSON)[2]}"; write to the manager as "you"/"your".`);
      }
    }
    if (r.confidence && !["high", "medium", "low"].includes(r.confidence)) {
      errors.push(`${where}: confidence must be high, medium or low.`);
    }
    // Re-validate against the market rather than trusting the file.
    const f = fairness(c.give.map((p) => p.v), c.get.map((p) => p.v));
    if (!f.fair) errors.push(`${where}: not fair by FantasyCalc (${Math.round(f.diffPct * 100)}%).`);

    trades.push({
      ...c, value: f,
      headline: r.headline, summary: r.summary || "",
      confidence: r.confidence || "medium",
      why: { give: why.give, get: why.get, you: why.you, them: why.them },
      risks: r.risks || [], sources,
    });
  });

  const seen = new Set();
  for (const t of trades) {
    if (seen.has(t.id)) errors.push(`Trade ${t.id} is listed twice.`);
    seen.add(t.id);
  }

  return {
    errors,
    data: {
      version: 1, status: "ready",
      league_id: work.league_id, league_name: work.league_name,
      season: work.season, week: work.week,
      generated: (now || new Date()).toISOString(),
      values_source: work.values_source,
      me: { name: work.me.name, record: work.me.record, thin: work.me.thin, deep: work.me.deep },
      trades,
      none_reason: trades.length ? null : (research && research.none_reason) || null,
    },
  };
}

/* ----------------------------------------------------------------- cli */

async function getJSON(url) {
  if (process.env.TRADES_FIXTURES) {
    const map = JSON.parse(fs.readFileSync(process.env.TRADES_FIXTURES, "utf8"));
    if (!(url in map)) throw new Error(`no fixture for ${url}`);
    return map[url];
  }
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(url, { headers: { "user-agent": "sleeper-rankings trade research" } });
      if (r.ok) return r.json();
      if (r.status < 500 && r.status !== 429) throw new Error(`${url} returned ${r.status}`);
      if (attempt >= 3) throw new Error(`${url} returned ${r.status}`);
    } catch (e) {
      if (attempt >= 3 || /returned 4/.test(e.message)) throw e;
    }
    await new Promise((res) => setTimeout(res, 1500 * attempt));
  }
}

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[i + 1], i++;
    else out._.push(argv[i]);
  }
  return out;
}

function trimName(meta) {
  if (meta.position === "DEF") return `${meta.first_name || ""} ${meta.last_name || ""}`.trim();
  return meta.full_name || `${meta.first_name || ""} ${meta.last_name || ""}`.trim();
}

async function cmdCandidates(a) {
  const user = a.user || "etanetan";
  const outDir = a.out || path.join(__dirname, "work");
  const state = await getJSON(`${SLEEPER}/state/nfl`);
  const season = state.league_season || state.season;
  const week = state.week || state.display_week || 1;
  const who = await getJSON(`${SLEEPER}/user/${encodeURIComponent(user)}`);
  if (!who || !who.user_id) throw new Error(`No Sleeper user "${user}"`);
  let leagues = await getJSON(`${SLEEPER}/user/${who.user_id}/leagues/nfl/${season}`);
  if (a.league) {
    const q = String(a.league).toLowerCase();
    leagues = leagues.filter((l) => l.league_id === a.league || (l.name || "").toLowerCase() === q);
    if (!leagues.length) throw new Error(`No league "${a.league}" for ${user} in ${season}`);
  }

  const dump = await getJSON(`${SLEEPER}/players/nfl`);
  const players = {};
  for (const id in dump) {
    const m = dump[id];
    players[id] = { n: trimName(m), p: m.position, t: m.team || null,
                    i: m.injury_status || null };
  }

  fs.mkdirSync(outDir, { recursive: true });
  const valuesCache = {};
  const summary = [];
  for (const league of leagues) {
    const win = tradeWindow(league, week);
    if (!win.open) { summary.push({ league_id: league.league_id, name: league.name, open: false, reason: win.reason }); continue; }

    const [rosters, users] = await Promise.all([
      getJSON(`${SLEEPER}/league/${league.league_id}/rosters`),
      getJSON(`${SLEEPER}/league/${league.league_id}/users`),
    ]);
    const mine = rosters.find((r) => r.owner_id === who.user_id || (r.co_owners || []).includes(who.user_id));
    if (!mine) { summary.push({ league_id: league.league_id, name: league.name, open: false, reason: "No roster of yours here." }); continue; }

    const url = fcUrl(fcParams(league));
    if (!valuesCache[url]) valuesCache[url] = { rows: await getJSON(url), fetched: new Date().toISOString() };
    const values = valueMap(valuesCache[url].rows);

    const userById = {};
    for (const u of users || []) userById[u.user_id] = u;
    const teams = rosters.map((r) => {
      const u = userById[r.owner_id] || {};
      const st = r.settings || {};
      return {
        roster_id: r.roster_id,
        user: u.display_name || null,
        name: ((u.metadata && u.metadata.team_name) || u.display_name || `Team ${r.roster_id}`).trim(),
        record: `${st.wins || 0}-${st.losses || 0}${st.ties ? `-${st.ties}` : ""}`,
        roster: teamPlayers(r.players, players, values, r.taxi, r.reserve),
      };
    });
    const slots = (league.roster_positions || []).filter((s) => !SKIP_SLOTS.has(s));
    const work = leagueCandidates({ league, teams, myRosterId: mine.roster_id, slots, season, week,
                                    valuesFetched: valuesCache[url].fetched });
    fs.writeFileSync(path.join(outDir, `${league.league_id}.json`), JSON.stringify(work, null, 2));
    summary.push({ league_id: league.league_id, name: league.name, open: true,
                   candidates: work.candidates.length, file: path.join(outDir, `${league.league_id}.json`) });
  }
  console.log(JSON.stringify({ season, week, leagues: summary }, null, 2));
}

function dataFile(a) {
  if (!a.league || !a.data) throw new Error("--league and --data are required");
  return path.join(a.data, `${a.league}.json`);
}

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return null; }
}

/* Mark a league as being researched, keeping last week's trades visible. */
function cmdRunning(a) {
  const file = dataFile(a);
  const prev = readJSON(file) || { version: 1, league_id: a.league, trades: [] };
  prev.status = "running";
  prev.started = new Date().toISOString();
  delete prev.error;
  fs.mkdirSync(a.data, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(prev, null, 2));
  console.log(`${file}: running`);
}

function cmdFailed(a) {
  const file = dataFile(a);
  const prev = readJSON(file) || { version: 1, league_id: a.league, trades: [] };
  prev.status = "ready";
  prev.error = { at: new Date().toISOString(), reason: a.reason || "Research didn't finish." };
  delete prev.started;
  fs.writeFileSync(file, JSON.stringify(prev, null, 2));
  console.log(`${file}: failed (${prev.error.reason})`);
}

function cmdFinalize(a) {
  const file = dataFile(a);
  const workDir = a.work || path.join(__dirname, "work");
  const work = readJSON(path.join(workDir, `${a.league}.json`));
  if (!work) throw new Error(`No candidates for ${a.league} in ${workDir}; run candidates first.`);
  const research = readJSON(a.research);
  if (!research) throw new Error(`Can't read research file ${a.research}`);
  const { errors, data } = finalize(work, research);
  if (errors.length) {
    console.error(`Not written. Fix these in ${a.research}:\n  - ${errors.join("\n  - ")}`);
    process.exit(2);
  }
  fs.mkdirSync(a.data, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  console.log(`${file}: ${data.trades.length} trade(s) written`);
}

async function main() {
  // Node's fetch ignores HTTPS_PROXY unless told otherwise; cloud sessions
  // route everything through one.
  if (process.env.HTTPS_PROXY && !process.env.NODE_USE_ENV_PROXY && !process.env.TRADES_FIXTURES) {
    const { spawnSync } = require("child_process");
    const r = spawnSync(process.execPath, process.argv.slice(1),
      { stdio: "inherit", env: { ...process.env, NODE_USE_ENV_PROXY: "1", NODE_NO_WARNINGS: "1" } });
    process.exit(r.status == null ? 1 : r.status);
  }
  const a = args(process.argv.slice(2));
  const cmd = a._[0];
  if (cmd === "candidates") return cmdCandidates(a);
  if (cmd === "running") return cmdRunning(a);
  if (cmd === "failed") return cmdFailed(a);
  if (cmd === "finalize") return cmdFinalize(a);
  console.error("usage: engine.js candidates|running|finalize|failed [options] (see top of file)");
  process.exit(1);
}

if (require.main === module) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}

module.exports = { tradeWindow, fcParams, fcUrl, valueMap, teamPlayers, lineup, strength, leagueNotes,
                   packageValue, fairness, tradesWith, positionProfile, leagueCandidates,
                   finalize, FAIR_PCT };
