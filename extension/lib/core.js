/* Pure ranking and lineup logic - shared by the page, the trade engine and
 * the browser extension.
 *
 * Everything here is DOM-free and side-effect-free: given the same inputs it
 * returns the same output, so it's plain to unit test and safe to load in a
 * content script. Loaded as a plain script in the browser (app.js and the
 * extension's content script both run after it and use its top-level
 * functions directly) and required for its `module.exports` in Node. */

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
 * one is available.
 *
 * `fixed` (optional) pre-fills some slots, e.g. { 2: player }, and removes
 * those players from the pool before the rest are picked - used to hold a
 * locked starter in place while still choosing the best lineup around them. */
function pickLineup(roster, slots, fixed) {
  const avail = roster.slice();
  const picked = {};
  if (fixed) {
    for (const key in fixed) {
      const player = fixed[key];
      if (!player) continue;
      picked[key] = player;
      const pos = avail.indexOf(player);
      if (pos !== -1) avail.splice(pos, 1);
    }
  }

  const order = slots
    .map((s, i) => i)
    .filter((i) => !(i in picked))
    .sort((a, b) => (SLOT_ELIGIBLE[slots[a]] || []).length - (SLOT_ELIGIBLE[slots[b]] || []).length);

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
  // Same as `starters`, but one entry per slot (null where nothing could be
  // filled) so callers can line it up positionally against another per-slot
  // lineup, e.g. currentLineup's output, for lineupCheck.
  const bySlot = slots.map((s, i) => {
    if (picked[i]) starters.push({ slot: s, player: picked[i] });
    return { slot: s, player: picked[i] || null };
  });
  return { starters, bench: avail, bySlot };
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

/* --- lineup check: what Sleeper has set vs. the best lineup ------------- */

/* The lineup Sleeper will actually score, as a per-slot array lined up with
 * `slots` (roster_positions minus BN/IR/TAXI, same order the matchup's
 * `starters` array uses). "0" and a missing id both mean an empty slot. */
function currentLineup(starterIds, slots, roster) {
  const byId = {};
  for (const p of roster || []) byId[p.id] = p;
  return slots.map((slot, i) => {
    const id = (starterIds || [])[i];
    return { slot, player: id && id !== "0" ? byId[id] || null : null };
  });
}

/* Player ids whose team's game has already started this week, so their spot
 * in the lineup can no longer be changed. DEF is keyed by its own team code,
 * same as every other player's `t`. No schedule means nothing is locked yet. */
function lockedIds(roster, schedule, week) {
  const locked = new Set();
  if (!schedule) return locked;
  const started = new Set();
  for (const g of schedule) {
    if (Number(g.week) !== Number(week)) continue;
    if (g.status !== "in_game" && g.status !== "complete") continue;
    if (g.home) started.add(g.home);
    if (g.away) started.add(g.away);
  }
  for (const p of roster || []) {
    if (p.t && started.has(p.t)) locked.add(p.id);
  }
  return locked;
}

/* Bye weeks per team, read off the full-season schedule rather than the
 * player dump's `b` field (sometimes null mid-season): for every week that
 * has games at all, a team missing from that week's games but present in
 * some other week is on bye then. Returns `{ teamAbbr: Set(weekNumbers) }`.
 * A missing/empty schedule returns `{}` - callers fall back to `b` then. */
function byeWeeks(schedule) {
  const byes = {};
  if (!schedule || !schedule.length) return byes;

  const teamsByWeek = {};   // week -> Set(team)
  const allTeams = new Set();
  for (const g of schedule) {
    const week = Number(g.week);
    if (!Number.isFinite(week)) continue;
    if (!teamsByWeek[week]) teamsByWeek[week] = new Set();
    if (g.home) { teamsByWeek[week].add(g.home); allTeams.add(g.home); }
    if (g.away) { teamsByWeek[week].add(g.away); allTeams.add(g.away); }
  }
  for (const team of allTeams) byes[team] = new Set();
  for (const week in teamsByWeek) {
    const playing = teamsByWeek[week];
    for (const team of allTeams) {
      if (!playing.has(team)) byes[team].add(Number(week));
    }
  }
  return byes;
}

// Long-term-out statuses worth planning weeks ahead around - unlike
// Q/D/OUT (this week's news only, and often stale a month out), a player
// tagged one of these isn't coming back on any particular schedule.
const LONG_TERM_OUT = new Set(["IR", "PUP", "SUS", "NA"]);

/* Bye and long-term-injury holes over the next few weeks, so a gap shows up
 * with enough notice to grab a replacement instead of discovering it on
 * Saturday. For each week `w` in `week+1 .. week+horizon`: a player is
 * available in `w` unless their team's on bye then (`byes`) or they're
 * long-term out now (IR/PUP/SUS/NA - not a this-week-only Q/D/OUT, which
 * says nothing about a month from now). Runs pickLineup on whoever's left;
 * any slot pickLineup can't fill (`bySlot` entry with a null player) is a
 * hole. Separately flags this week's best-lineup starters who are on bye
 * in `w`, since 2+ starters gone the same week is worth a heads up even
 * when the bench covers every slot. Only weeks with a hole or 2+ bye
 * starters are returned: `[{ week, holes: ["TE"], byes: [player, …] }]`. */
function upcomingHoles(roster, slots, week, byes, horizon) {
  horizon = horizon == null ? 4 : horizon;
  const out = [];
  const bestNow = pickLineup(roster, slots).starters;
  // The schedule (`byes`) is authoritative for any team it actually covers
  // - trust it fully, `has(w)` or not, rather than also consulting `p.b`
  // for a team the schedule already answered for, since `b` is exactly the
  // field that goes stale mid-season (see byeWeeks above) and a live
  // schedule saying "playing" should win over a stale "bye" on file. `b`
  // only fills in for a team the schedule has nothing on at all (a missing
  // or unreachable schedule, most likely), so a bad fetch doesn't just
  // silently report no upcoming byes.
  const onByeIn = (p, w) =>
    byes[p.t] ? byes[p.t].has(w) : p.b != null && Number(p.b) === w;
  for (let w = week + 1; w <= week + horizon; w++) {
    const available = (roster || []).filter((p) => !LONG_TERM_OUT.has(p.status) && !onByeIn(p, w));
    const bySlot = pickLineup(available, slots).bySlot;
    const holes = bySlot.filter((e) => !e.player).map((e) => e.slot);
    const byeStarters = bestNow.filter((s) => onByeIn(s.player, w)).map((s) => s.player);
    if (holes.length || byeStarters.length >= 2) {
      out.push({ week: w, holes, byes: byeStarters });
    }
  }
  return out;
}

/* Sum of `player.pts` over a currentLineup-shaped array (one entry per
 * slot, `{slot, player}`, player possibly null): an empty slot or a null
 * projection counts 0. The lineup's total projected points. */
function projectedTotal(entries) {
  return entries.reduce(
    (t, e) => t + (e.player && e.player.pts != null ? e.player.pts : 0), 0);
}

/* Compare the lineup Sleeper has set (`current`) with the best lineup this
 * roster supports (`best`) - both per-slot arrays shaped like
 * currentLineup's output, one entry per slot, player possibly null.
 *
 * "ok" means the same set of starters; which flex slot a player landed in
 * doesn't matter, so a pure reshuffle between equally-eligible flex spots
 * reports no changes. Everything else is read off `current`: an empty slot
 * or a starter who's OUT/bye is a problem with the lineup Sleeper has set,
 * regardless of whether the set otherwise matches. */
function lineupCheck(current, best) {
  const idSet = (arr) => arr.map((e) => e.player && e.player.id).filter(Boolean).sort();

  const empty = [];
  const unavailableList = [];
  current.forEach((e) => {
    if (!e.player) empty.push(e.slot);
    else if (unavailable(e.player)) unavailableList.push(e.player);
  });

  const ok = JSON.stringify(idSet(current)) === JSON.stringify(idSet(best));
  const changes = [];
  let gain = 0;
  if (!ok) {
    const n = Math.max(current.length, best.length);
    for (let i = 0; i < n; i++) {
      const c = current[i] || { slot: best[i] && best[i].slot, player: null };
      const b = best[i] || { slot: c.slot, player: null };
      const cid = c.player && c.player.id;
      const bid = b.player && b.player.id;
      if (cid === bid) continue;
      const g = (b.player && b.player.pts != null ? b.player.pts : 0) -
                (c.player && c.player.pts != null ? c.player.pts : 0);
      changes.push({ slot: c.slot || b.slot, out: c.player || null, in: b.player || null, gain: g });
    }
    gain = projectedTotal(best) - projectedTotal(current);
  }

  return { ok, changes, gain, empty, unavailable: unavailableList };
}

/* --- waiver upgrades: free agents who'd beat your weakest starter ------- */

/* Free agents (in `pool` but not `rostered`) who'd outscore your weakest
 * current starter at a slot they're eligible for - the standard "who should
 * I pick up" check. `pool` is every ranked player under this league's
 * scoring (buildRoster over every id in `ranks`, roster or not); `best` is
 * pickLineup's result. Sorted by gain, top 5. */
function waiverUpgrades(pool, rostered, best) {
  const startersBySlot = {};
  for (const s of (best && best.starters) || []) {
    (startersBySlot[s.slot] = startersBySlot[s.slot] || []).push(s.player);
  }

  const out = [];
  for (const p of pool) {
    if (rostered.has(p.id) || p.pts == null || unavailable(p)) continue;

    let weakest = null;
    let weakestPts = Infinity;
    for (const slot in SLOT_ELIGIBLE) {
      if (!SLOT_ELIGIBLE[slot].includes(p.p)) continue;
      for (const starter of startersBySlot[slot] || []) {
        const sp = starter.pts != null ? starter.pts : 0;
        if (sp < weakestPts) { weakest = starter; weakestPts = sp; }
      }
    }
    if (!weakest) continue;

    const gain = p.pts - weakestPts;
    if (gain > 0) out.push({ ...p, gain, weakest });
  }

  out.sort((a, b) => b.gain - a.gain);
  return out.slice(0, 5);
}

/* The bench player worth dropping for a waiver add: whoever isn't in the
 * best lineup's starters and isn't stashed on IR/taxi (`reserveIds` - a
 * reserve spot is a deliberate hold, not a throwaway), with the lowest
 * `pts`. A player with no projection at all (`pts` null - unranked, or off
 * the radar entirely) sorts below every ranked player, since an unknown
 * quantity is exactly the kind of roster spot worth giving up first. Null
 * when there's nothing eligible to drop (an empty bench, or everyone on
 * it is starting or reserved). */
function dropCandidate(roster, best, reserveIds) {
  const startingIds = new Set(((best && best.starters) || []).map((s) => s.player.id));
  const reserved = reserveIds || new Set();
  const candidates = (roster || []).filter(
    (p) => !startingIds.has(p.id) && !reserved.has(p.id));
  if (!candidates.length) return null;

  const key = (p) => (p.pts != null ? p.pts : -Infinity);
  return candidates.reduce((worst, p) => (key(p) < key(worst) ? p : worst));
}

/* League power rankings: every roster's projected starters total for this
 * week (build the roster, pick the best lineup, sum pts - the same "how
 * good is this team right now" measure used everywhere else on the page),
 * next to their actual record and points-for for context. Ranked by that
 * projected total, not the record - wins/losses say what already
 * happened; this says who's actually strong right now, which is the more
 * useful read on how scary an opponent is or what a trade partner can
 * really offer. `rosters` is the league's raw Sleeper roster list (the
 * same one buildLeagueView already fetches); each entry keeps its
 * `roster_id` so the caller can join in team names and mark the viewer's
 * own row. */
function powerRanks(rosters, players, ranks, week, slots) {
  const out = (rosters || []).map((r) => {
    const roster = buildRoster(r.players, players, ranks, week);
    const { starters } = pickLineup(roster, slots);
    const settings = r.settings || {};
    return {
      rosterId: r.roster_id,
      proj: projectedTotal(starters),
      wins: settings.wins || 0,
      losses: settings.losses || 0,
      ties: settings.ties || 0,
      pf: (settings.fpts || 0) + (settings.fpts_decimal || 0) / 100,
    };
  });
  out.sort((a, b) => b.proj - a.proj);
  return out;
}

/* --- matchup: projected score and win chance ---------------------------- */

/* Standard normal CDF via the Abramowitz-Stegun 7.1.26 erf approximation
 * (max error ~1.5e-7) - good enough for a win-probability estimate, and
 * avoids pulling in a math library for one function. */
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const p = 0.3275911;
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741,
        a4 = -1.453152027, a5 = 1.061405429;
  const t = 1 / (1 + p * ax);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}
function normalCdf(z) {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/* Rough win probability from both teams' projected totals - not a real
 * simulation, just enough to turn "118.4 vs 104.2" into a number a person
 * can react to. Each team's spread scales with its own projection (a
 * bigger number has more that could go right or wrong), floored at 10 so a
 * near-zero projection - a bye week, or before any projections load -
 * isn't treated as a lock either way. The two spreads combine in
 * quadrature, and the gap between the totals is measured in that combined
 * spread and run through the normal CDF. */
function winProb(mine, theirs) {
  const sigma = (p) => Math.max(0.2 * p, 10);
  const combined = Math.sqrt(sigma(mine) ** 2 + sigma(theirs) ** 2);
  return normalCdf((mine - theirs) / combined);
}

/* --- recap: did the rankings help, for a week that's already over ------- */

/* How the rankings would have done for a past week, against what actually
 * happened - trust the numbers instead of the pitch. `entry` is that
 * week's raw matchup entry as Sleeper returns it: player ids in `players`,
 * the score as actually set in `points`, and `players_points` (each
 * player's actual points under this league's scoring - Sleeper computes
 * this itself, so no separate stats endpoint is needed). `projRanks` is
 * that week's positional ranks from that week's own projections
 * (rankPositions over them - the same shape ranksFor produces), used to
 * rebuild what the tool would have recommended at the time, before anyone
 * knew the results.
 *
 * `ours`: sum of actual points over pickLineup's picks using that week's
 * projected ranks - what following the tool that week would have scored.
 * `best`: perfect hindsight - re-ranked by what actually happened instead
 * of what was projected, then picked again. A benched player who
 * outscored the projected starter at his own position can win that slot
 * here, which a bare swap of `pts` alone wouldn't do: a dedicated slot (no
 * FLEX competition) is picked by `posRank`, not `pts` (see posKey), so the
 * position groups are freshly ranked by actual points first.
 *
 * Known limitation, worth surfacing wherever this is shown: injury
 * statuses here are today's, not that week's - there's no way to ask
 * Sleeper for a past week's injury news. In practice this mostly washes
 * out, since a player who was actually ruled out that week almost always
 * had an already-near-zero projection, so pickLineup rarely wanted them
 * regardless. */
function recap(entry, slots, players, projRanks) {
  const playersPoints = (entry && entry.players_points) || {};
  const roster = buildRoster((entry && entry.players) || [], players, projRanks);
  const actualOf = (s) => playersPoints[s.player.id] || 0;

  const ours = pickLineup(roster, slots).starters.reduce((t, s) => t + actualOf(s), 0);

  const byPos = {};
  roster.forEach((p) => { (byPos[p.p] = byPos[p.p] || []).push(p); });
  const hindsightPosRank = {};
  for (const pos in byPos) {
    byPos[pos]
      .slice()
      .sort((a, b) => (playersPoints[b.id] || 0) - (playersPoints[a.id] || 0))
      .forEach((p, i) => { hindsightPosRank[p.id] = i + 1; });
  }
  const hindsightRoster = roster.map((p) => ({
    ...p, pts: playersPoints[p.id] || 0, posRank: hindsightPosRank[p.id] || null,
  }));
  const best = pickLineup(hindsightRoster, slots).starters.reduce((t, s) => t + actualOf(s), 0);

  return { actual: (entry && entry.points) || 0, ours, best };
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
                    pickLineup, currentLineup, lockedIds, lineupCheck, waiverUpgrades,
                    projectedTotal, winProb, byeWeeks, upcomingHoles, recap, dropCandidate, powerRanks,
                    posKey, flexKey, buildRoster, normStatus, tradeWindow,
                    SLOT_ELIGIBLE, SLOT_LABEL, SKIP_SLOTS, POS_ORDER, OUT_STATUSES,
                    ORDINAL, EVEN_PCT, isHttps, SECTIONS, sectionHeading, TRADE_FIELDS };
}
