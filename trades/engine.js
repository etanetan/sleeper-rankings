#!/usr/bin/env node
/* Trade research engine.
 *
 * The numbers half of the weekly trade research: finds the leagues where
 * trades are open, values every rostered player with FantasyCalc (scaled to
 * each league's format), and searches for trades that are fair by market
 * value and have an angle: selling your players high, buying other teams'
 * players low, or filling a need. The research half — news, usage
 * trends, the reasons — is done by Claude on top of these candidates; see
 * .claude/skills/trade-research/SKILL.md. `finalize` merges that research back
 * in and refuses anything the numbers don't support.
 *
 *   node trades/engine.js candidates --user etanetan [--league <id|name>] [--out trades/work]
 *                                   [--targets <file>]   (with --league: research's buy/sell calls)
 *   node trades/engine.js running    --league <id> --data <dir>
 *   node trades/engine.js finalize   --league <id> --research <file> --data <dir> [--work trades/work]
 *   node trades/engine.js failed     --league <id> --data <dir> --reason "<why>"
 */

const fs = require("fs");
const path = require("path");
const { SLOT_ELIGIBLE, tradeWindow, normStatus, scorePlayer } = require("../app.js");

const SLEEPER = "https://api.sleeper.app/v1";
const STATS = "https://api.sleeper.com/stats/nfl";
const PROJ = "https://api.sleeper.com/projections/nfl";
const FORM_POSITIONS = ["QB", "RB", "WR", "TE"];
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

// Trading like a market: buy what's cheap for a fixable reason, sell what's
// expensive for an unsustainable one, and never sell at the bottom. A player
// is "cold" scoring 20% under his projections or after a 10% drop in market
// value over 30 days, "hot" 25% over or after a 10% rise. A value move must
// also be real in size, on a player worth something: a 300-point backup
// jumping 200% is noise.
const COLD_PERF = 0.8;
const HOT_PERF = 1.25;
const TREND_MOVE = 0.1;
const TREND_MIN_ABS = 250;
const TREND_MIN_VALUE = 500;
// How much an angle (each sell-high given, each buy-low received) is worth in
// ranking, and how much buying a player at his peak costs.
const ANGLE_BONUS = 0.03;
const AVOID_PENALTY = 0.03;
const MIN_TRADES = 5;
const MAX_TRADES = 8;
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
function teamPlayers(ids, players, values, taxi, reserve, forms) {
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
      form: (forms && forms[id]) || null, tag: null,
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
                       trendPct: trendPct(p), status: p.status || null, sidelined: sidelined(p),
                       tag: p.tag || null, tagBy: p.tag ? p.tagBy || "numbers" : null,
                       form: p.form || null });

/* ---------------------------------------------------------------- form */

const rowsOf = (resp) => (Array.isArray(resp) ? resp : Object.values(resp || {}));
const posQuery = FORM_POSITIONS.map((x) => `&position[]=${x}`).join("");
const statsUrl = (season, week) => `${STATS}/${season}/${week}?season_type=regular${posQuery}`;
const projUrl = (season, week) => `${PROJ}/${season}/${week}?season_type=regular${posQuery}`;

/* Weeks whose games are over. Games run Thursday to Monday, so on Tuesday and
 * Wednesday the current week is final even before Sleeper rolls over. */
function completedWeeks(week, now) {
  const w = Number(week) || 0;
  const out = [];
  for (let i = 1; i < w; i++) out.push(i);
  const day = new Date(now || Date.now())
    .toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short" });
  if (w >= 1 && (day === "Tue" || day === "Wed")) out.push(w);
  return out;
}

/* One week: each player's stat line and projection, and every team's total
 * targets so a player's share can be worked out. */
function weekData(statsRows, projRows) {
  const stats = {}, proj = {}, teamTgt = {};
  for (const r of rowsOf(statsRows)) {
    const pid = String(r.player_id || "");
    const st = r.stats || {};
    if (!pid) continue;
    stats[pid] = { s: st, team: r.team || null };
    if (r.team && st.rec_tgt) teamTgt[r.team] = (teamTgt[r.team] || 0) + st.rec_tgt;
  }
  for (const r of rowsOf(projRows)) {
    const pid = String(r.player_id || "");
    if (pid) proj[pid] = r.stats || {};
  }
  return { stats, proj, teamTgt };
}

/* How a player is doing against expectations, in this league's scoring:
 * points per game against his projections for the same games, and the usage
 * that says whether it will last (snaps, targets, touches, red-zone looks). */
function formFor(pid, pos, weeks, scoring) {
  let g = 0, pts = 0, proj = 0, snaps = 0, teamSnaps = 0, tgt = 0, teamTgt = 0, touches = 0, rz = 0;
  for (const w of weeks) {
    const row = w.stats[pid];
    if (!row) continue;
    const st = row.s;
    if (!(st.gp > 0 || st.off_snp > 0)) continue;
    g++;
    pts += scorePlayer(st, scoring, pos);
    proj += scorePlayer(w.proj[pid] || {}, scoring, pos);
    snaps += st.off_snp || 0;
    teamSnaps += st.tm_off_snp || 0;
    tgt += st.rec_tgt || 0;
    teamTgt += (row.team && w.teamTgt[row.team]) || 0;
    touches += (st.rush_att || 0) + (st.rec || 0);
    rz += (st.rec_rz_tgt || 0) + (st.rush_rz_att || 0);
  }
  if (!g) return null;
  const r1 = (x) => Math.round(x * 10) / 10;
  const ppg = pts / g, projPg = proj / g;
  return {
    g, ppg: r1(ppg), proj: r1(projPg),
    perf: projPg >= 3 ? Math.round((ppg / projPg) * 100) / 100 : null,
    snap: teamSnaps ? Math.round((snaps / teamSnaps) * 100) : null,
    tgtShare: pos !== "QB" && teamTgt ? Math.round((tgt / teamTgt) * 100) : null,
    tpg: pos !== "QB" ? r1(tgt / g) : null,
    touches: pos === "RB" ? r1(touches / g) : null,
    rz: r1(rz / g),
  };
}

/* Market value change over 30 days, as a fraction of where it started. */
function trendPct(p) {
  const before = (p.v || 0) - (p.trend || 0);
  return before > 0 ? Math.round(((p.trend || 0) / before) * 100) / 100 : 0;
}

/* Still on the field enough for bad results to be bad luck, not a lost job. */
function usageIntact(p) {
  const f = p.form;
  if (!f) return false;
  if (p.p === "QB") return (f.snap || 0) >= 80;
  if (p.p === "RB") return (f.touches || 0) >= 10 || (f.snap || 0) >= 45;
  return (f.snap || 0) >= 60 || (f.tgtShare || 0) >= 15;
}

/* The numbers' call on a player, before research confirms or overrides it.
 * Yours: "hold" when cold (never sell at the low), "sell_high" when hot.
 * Theirs: "buy_low" when cold but still getting the ball, "avoid" when hot
 * (buying at the peak). */
function marketTag(p, mine) {
  const perf = p.form && p.form.perf;
  const tp = trendPct(p);
  const moved = (p.v || 0) >= TREND_MIN_VALUE && Math.abs(p.trend || 0) >= TREND_MIN_ABS &&
    Math.abs(tp) >= TREND_MOVE;
  const cold = (perf != null && perf <= COLD_PERF) || (moved && tp < 0);
  const hot = (perf != null && perf >= HOT_PERF) || (moved && tp > 0);
  if (mine) return cold ? "hold" : hot ? "sell_high" : null;
  if (cold && !hot && usageIntact(p) && !sidelined(p)) return "buy_low";
  if (hot && !cold) return "avoid";
  return null;
}

/* Research's calls replace the numbers': `sell` and `hold` (not for trade,
 * slumping or simply too good to sell) for your players, `buy` and `avoid`
 * for everyone else's, and `neutral` to clear a call the numbers got wrong.
 * Ids that aren't on the right roster are reported, not silently ignored. */
function applyTargets(teams, myRosterId, targets) {
  const problems = [];
  if (!targets) return problems;
  const where = {};
  for (const t of teams) for (const p of t.roster) where[p.id] = { p, mine: t.roster_id === myRosterId };
  const set = (ids, tag, wantMine) => {
    for (const raw of ids || []) {
      const id = String(raw);
      const hit = where[id];
      if (!hit) { problems.push(`${id} isn't on any roster in this league`); continue; }
      if (wantMine != null && hit.mine !== wantMine) {
        problems.push(`${hit.p.n} (${id}) is on ${hit.mine ? "your" : "another"} roster; "${tag}" doesn't apply`);
        continue;
      }
      hit.p.tag = tag;
      hit.p.tagBy = "research";
    }
  };
  set(targets.sell, "sell_high", true);
  set(targets.hold, "hold", true);
  set(targets.buy, "buy_low", false);
  set(targets.avoid, "avoid", false);
  set(targets.neutral, null, null);
  return problems;
}

/* Every fair trade with one partner that makes both starting lineups better,
 * best first. `me` and `them` are roster arrays from teamPlayers. */
function tradesWith(me, them, slots, rosterSize, opts) {
  const relaxed = !!(opts && opts.relaxed);
  // Top of each roster by value, plus every player with an angle, so a
  // buy-low target further down a deep roster isn't missed. Your "hold"
  // players are never offered: that would be selling at the low.
  const pool = (r, keep) => {
    const top = r.filter((p) => p.v > 0).sort((a, b) => b.v - a.v).slice(0, POOL_SIZE);
    const extra = r.filter((p) => p.v > 0 && p.tag === keep && !top.includes(p));
    return top.concat(extra).filter((p) => p.tag !== "hold");
  };
  const myPkgs = combos(pool(me, "sell_high"), MAX_PIECES);
  const theirPkgs = combos(pool(them, "buy_low"), MAX_PIECES);
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
      const angle = give.filter((p) => p.tag === "sell_high").length +
        get.filter((p) => p.tag === "buy_low").length;
      const avoid = get.filter((p) => p.tag === "avoid").length;
      if (angle) {
        // The edge in a sell-high or buy-low deal is the market's mistake,
        // not this week's lineup: even trades are fine as long as neither
        // lineup gets meaningfully worse.
        if (myGain < -0.003 || theirGain < -0.01) continue;
      } else if (relaxed) {
        if (myGain < 0 || theirGain < -0.005) continue;
      } else if (myGain <= 0.005 || theirGain < THEIR_MIN_GAIN) {
        // A plain need trade is worth pitching only if it helps you and the
        // other side has a reason to say yes.
        continue;
      }
      found.push({
        give, get, f, myBase, myAfter, theirBase, theirAfter, myGain, theirGain,
        myAfterRoster, theirAfterRoster, angle,
        score: myGain + 0.5 * theirGain - 0.25 * Math.abs(f.diffPct) +
          ANGLE_BONUS * angle - AVOID_PENALTY * avoid,
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
  const limit = (opts && opts.limit) || 20;
  const { league, teams, myRosterId, slots } = ctx;
  const me = teams.find((t) => t.roster_id === myRosterId);
  const rosterSize = (league.roster_positions || []).filter((s) => s !== "IR" && s !== "TAXI").length;
  const profile = positionProfile(teams, slots);

  const search = (relaxed) => {
    const out = [];
    for (const t of teams) {
      if (t.roster_id === myRosterId) continue;
      for (const c of tradesWith(me.roster, t.roster, slots, rosterSize, { relaxed })) out.push({ ...c, partner: t });
    }
    return out;
  };
  // At least MIN_TRADES have to survive research, so if the strict search
  // comes up short, widen it rather than publish too few.
  let all = search(false);
  if (all.length < limit) {
    const have = new Set(all.map((c) => `${c.give.map((p) => p.id)}>${c.get.map((p) => p.id)}`));
    all = all.concat(search(true).filter((c) => !have.has(`${c.give.map((p) => p.id)}>${c.get.map((p) => p.id)}`)));
  }
  all.sort((a, b) => b.score - a.score);

  const perPartner = {}, perGet = {}, perGive = {};
  const picked = [];
  for (const c of all) {
    if (picked.length >= limit) break;
    const pk = c.partner.roster_id;
    const getKey = c.get.map((p) => p.id).sort().join("+");
    if ((perPartner[pk] || 0) >= 3) continue;
    if (c.get.some((p) => (perGet[p.id] || 0) >= 2)) continue;
    if (c.give.some((p) => (perGive[p.id] || 0) >= 3)) continue;
    perPartner[pk] = (perPartner[pk] || 0) + 1;
    c.get.forEach((p) => { perGet[p.id] = (perGet[p.id] || 0) + 1; });
    c.give.forEach((p) => { perGive[p.id] = (perGive[p.id] || 0) + 1; });
    const giveKey = c.give.map((p) => p.id).sort().join("+");
    const sells = c.give.filter((p) => p.tag === "sell_high").length;
    const buys = c.get.filter((p) => p.tag === "buy_low").length;
    picked.push({
      id: hashId(`${league.league_id}:${giveKey}>${getKey}`),
      kind: sells && buys ? "sell-high + buy-low" : sells ? "sell-high" : buys ? "buy-low" : "need",
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
  const ownerOf = {};
  for (const t of teams) for (const p of t.roster) ownerOf[p.id] = t.name;
  const others = teams.filter((t) => t.roster_id !== myRosterId).flatMap((t) => t.roster);
  const byValue = (a, b) => b.v - a.v;
  const withOwner = (p) => ({ ...slim(p), owner: ownerOf[p.id] });
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
    // The numbers' market calls, for research to confirm, reject or extend.
    market: {
      weeks: ctx.weeks || [],
      sell_high: me.roster.filter((p) => p.tag === "sell_high").sort(byValue).map(slim),
      hold: me.roster.filter((p) => p.tag === "hold").sort(byValue).map(slim),
      buy_low: others.filter((p) => p.tag === "buy_low").sort(byValue).slice(0, 30).map(withOwner),
      avoid: others.filter((p) => p.tag === "avoid").sort(byValue).slice(0, 20).map(withOwner),
    },
    targets_applied: !!ctx.targetsApplied,
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

  // Ethan wants at least five to choose from. Fewer only when there aren't
  // five fair candidates, or with a stated reason he'll see on the page.
  const need = Math.min(MIN_TRADES, (work.candidates || []).length);
  const shortReason = research && (research.short_reason || research.none_reason);
  if (list.length < need && !shortReason) {
    errors.push(`${list.length} trade(s); publish at least ${need} ` +
      `(there are ${(work.candidates || []).length} candidates), or give a short_reason.`);
  }
  if (list.length > MAX_TRADES) errors.push(`${list.length} trades; keep it to the best ${MAX_TRADES}.`);

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
    for (const p of c.give) {
      if (p.tag === "hold") errors.push(`${where}: gives ${p.n}, who's slumping (hold). Don't sell low.`);
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
      short_reason: trades.length && trades.length < MIN_TRADES ? shortReason || null : null,
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

  let targets = null;
  if (a.targets) {
    if (!a.league) throw new Error("--targets needs --league: research calls are per league");
    targets = JSON.parse(fs.readFileSync(a.targets, "utf8"));
  }

  // This season's results so far, fetched once and scored per league below.
  const now = process.env.TRADES_NOW ? new Date(process.env.TRADES_NOW) : new Date();
  const weeks = completedWeeks(week, now);
  const weekRows = [];
  for (const w of weeks) {
    const [st, pr] = await Promise.all([getJSON(statsUrl(season, w)), getJSON(projUrl(season, w))]);
    weekRows.push(weekData(st, pr));
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

    const scoring = league.scoring_settings || {};
    const forms = {};
    for (const r of rosters) {
      for (const id of r.players || []) {
        const pos = (players[id] || {}).p;
        if (FORM_POSITIONS.includes(pos)) forms[id] = formFor(String(id), pos, weekRows, scoring);
      }
    }

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
        roster: teamPlayers(r.players, players, values, r.taxi, r.reserve, forms),
      };
    });
    for (const t of teams) for (const p of t.roster) p.tag = marketTag(p, t.roster_id === mine.roster_id);
    const problems = applyTargets(teams, mine.roster_id, targets);
    if (problems.length) console.error(`Targets for ${league.name}:\n  - ${problems.join("\n  - ")}`);
    const slots = (league.roster_positions || []).filter((s) => !SKIP_SLOTS.has(s));
    const work = leagueCandidates({ league, teams, myRosterId: mine.roster_id, slots, season, week,
                                    weeks, valuesFetched: valuesCache[url].fetched,
                                    targetsApplied: !!targets });
    fs.writeFileSync(path.join(outDir, `${league.league_id}.json`), JSON.stringify(work, null, 2));
    const kinds = {};
    for (const c of work.candidates) kinds[c.kind] = (kinds[c.kind] || 0) + 1;
    summary.push({ league_id: league.league_id, name: league.name, open: true,
                   candidates: work.candidates.length, kinds,
                   sell_high: work.market.sell_high.length, hold: work.market.hold.length,
                   buy_low: work.market.buy_low.length,
                   file: path.join(outDir, `${league.league_id}.json`) });
  }
  console.log(JSON.stringify({ season, week, form_weeks: weeks, leagues: summary }, null, 2));
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
                   completedWeeks, weekData, formFor, trendPct, usageIntact, marketTag, applyTargets,
                   statsUrl, projUrl, MIN_TRADES, MAX_TRADES,
                   packageValue, fairness, tradesWith, positionProfile, leagueCandidates,
                   finalize, FAIR_PCT };
