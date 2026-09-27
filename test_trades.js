/* Offline tests for the trade engine: windows, FantasyCalc params, fairness,
 * candidate search, and the finalize gate the research has to pass. */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const T = require("./trades/engine.js");
const results = [];

function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}` +
    (ok ? "" : `\n        got ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`));
  results.push(ok);
}

/* --- when trades are open --------------------------------------------- */
const lg = (settings, status) => ({ settings, status: status || "in_season" });
check("open with a future deadline", T.tradeWindow(lg({ trade_deadline: 11 }), 4).open, true);
check("open on deadline week", T.tradeWindow(lg({ trade_deadline: 11 }), 11).open, true);
check("closed after the deadline", T.tradeWindow(lg({ trade_deadline: 11 }), 12).open, false);
check("99 means no deadline", T.tradeWindow(lg({ trade_deadline: 99 }), 17).open, true);
check("no deadline set", T.tradeWindow(lg({}), 17).open, true);
check("trades disabled", T.tradeWindow(lg({ disable_trades: 1 }), 2).open, false);
check("pre-draft closed", T.tradeWindow(lg({}, "pre_draft"), 1).open, false);
check("season over closed", T.tradeWindow(lg({}, "complete"), 18).open, false);
check("deadline reported", T.tradeWindow(lg({ trade_deadline: 11 }), 3).deadline, 11);

/* --- FantasyCalc format mapping --------------------------------------- */
const fmt = (rec, slots, type, teams) => T.fcParams({
  settings: { type }, scoring_settings: { rec }, roster_positions: slots, total_rosters: teams });
check("half ppr 1QB redraft", fmt(0.5, ["QB", "RB", "FLEX", "BN"], 0, 12),
  { isDynasty: false, numQbs: 1, numTeams: 12, ppr: 0.5 });
check("superflex counts as 2 QBs", fmt(1, ["QB", "SUPER_FLEX"], 0, 10).numQbs, 2);
check("2QB counts as 2 QBs", fmt(1, ["QB", "QB"], 0, 10).numQbs, 2);
check("dynasty flagged", fmt(1, ["QB"], 2, 12).isDynasty, true);
check("keeper treated as redraft", fmt(1, ["QB"], 1, 12).isDynasty, false);
check("standard scoring", fmt(0, ["QB"], 0, 12).ppr, 0);
check("odd ppr snaps to nearest", fmt(0.8, ["QB"], 0, 12).ppr, 1);
check("url shape", T.fcUrl({ isDynasty: false, numQbs: 1, numTeams: 12, ppr: 0.5 }),
  "https://api.fantasycalc.com/values/current?isDynasty=false&numQbs=1&numTeams=12&ppr=0.5");

const notes = T.leagueNotes({ settings: { type: 1, taxi_slots: 3, trade_deadline: 99 },
  scoring_settings: { rec: 0, bonus_rec_te: 1, pass_td: 6 }, roster_positions: ["QB", "SUPER_FLEX", "BN", "TAXI"] });
check("league notes: keeper, TE premium, no deadline",
  [notes.type, notes.te_premium, notes.superflex, notes.trade_deadline, notes.starters],
  ["keeper", 1, true, null, ["QB", "SUPER_FLEX"]]);
check("league notes: dynasty", T.leagueNotes({ settings: { type: 2 } }).type, "dynasty");

check("value map keyed by sleeper id", T.valueMap([
  { player: { sleeperId: "4046", name: "Patrick Mahomes", position: "QB", maybeTeam: "KC" },
    value: 6012.4, positionRank: 3, trend30Day: -120 },
  { player: { name: "No Sleeper Id" }, value: 100 },
]), { "4046": { v: 6012, pr: 3, trend: -120, n: "Patrick Mahomes", p: "QB", t: "KC" } });

/* --- fairness ---------------------------------------------------------- */
check("1-for-1 even", T.fairness([5000], [5000]).verdict, "Even");
check("1-for-1 within 10% is fair", T.fairness([5000], [4600]).fair, true);
check("1-for-1 past 10% is not", T.fairness([5000], [4400]).fair, false);
check("sign is from your side", T.fairness([4000], [4300]).diffPct > 0, true);
check("two mid pieces don't buy a star at face value",
  [T.fairness([3800, 3800], [8000]).fair, 7600 / 8000 > 0.9], [false, true]);
check("equal padding can't launder a lopsided deal",
  [T.fairness([5000], [6000]).fair, T.fairness([5000, 5000], [6000, 5000]).fair], [false, false]);
check("package weights discount the second piece",
  T.packageValue([4000, 4000]), 7200);

/* --- a small league where the fit is obvious --------------------------- */
// You're deep at WR and thin at RB; Team B is the mirror image.
const slots = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX"];
const P = (id, p, v) => ({ id, n: `${p}-${id}`, p, t: "NFL", v, pr: null, trend: 0, taxi: false });
const me = [P("q1", "QB", 5000), P("r1", "RB", 5200), P("r2", "RB", 900),
            P("w1", "WR", 6000), P("w2", "WR", 5600), P("w3", "WR", 5000), P("w4", "WR", 4800),
            P("t1", "TE", 3000)];
const b = [P("q2", "QB", 5000), P("r3", "RB", 6000), P("r4", "RB", 5300), P("r5", "RB", 4900),
           P("r6", "RB", 4600), P("w5", "WR", 5000), P("w6", "WR", 900), P("t2", "TE", 3000)];
const c = [P("q3", "QB", 5000), P("r7", "RB", 5000), P("r8", "RB", 5000), P("w7", "WR", 5000),
           P("w8", "WR", 5000), P("w9", "WR", 4000), P("t3", "TE", 3000), P("r9", "RB", 3000)];

const withB = T.tradesWith(me, b, slots, 12);
check("finds trades with the mirror team", withB.length > 0, true);
const top = withB[0];
check("top trade sends a WR", top.give.some((p) => p.p === "WR"), true);
check("top trade brings back a RB", top.get.some((p) => p.p === "RB"), true);
check("top trade is fair", top.f.fair, true);
check("top trade helps you", top.myAfter > top.myBase, true);
check("top trade helps them too", top.theirAfter > top.theirBase, true);
check("every candidate gives them a reason to say yes", withB.every((x) => x.theirGain >= 0.002), true);
check("lineup changes named", top.myChanges.in.length > 0 && top.myChanges.out.length > 0, true);
check("a starter who only changes slot isn't listed as new",
  top.myChanges.in.some((x) => x.n === "RB-r1"), false);

check("padded deals dropped (no QB-for-equal-QB add-ons)",
  withB.some((x) => x.give.some((p) => p.id === "q1") && x.get.some((p) => p.id === "q2")), false);
check("simplest version of a deal kept",
  withB.some((x) => x.give.length === 1 && x.give[0].id === "w1" && x.get.length === 1 && x.get[0].id === "r3"), true);

// Nothing sensible to do with a team built like yours.
const clone = me.map((p) => ({ ...p, id: p.id + "x" }));
check("no trades with an identical roster", T.tradesWith(me, clone, slots, 12).length, 0);

// Uneven trade: the side taking two players has to cut someone.
const tight = T.tradesWith(me, b, slots, me.length).find((x) => x.get.length > x.give.length);
if (tight) check("drop suggested when roster overflows", tight.myDrop != null, true);

check("IR players don't take a roster spot",
  T.teamPlayers(["a", "b"], { a: { n: "A", p: "RB" }, b: { n: "B", p: "WR" } }, {}, [], ["b"])
    .map((p) => p.ir), [false, true]);

const league = { league_id: "L1", name: "Test League", status: "in_season",
                 settings: { trade_deadline: 11, type: 0 }, scoring_settings: { rec: 1 },
                 roster_positions: slots.concat(["BN", "BN", "BN", "BN", "BN"]), total_rosters: 3 };
const teams = [
  { roster_id: 1, name: "Mine", user: "etanetan", record: "2-1", roster: me },
  { roster_id: 2, name: "Team B", user: "bee", record: "1-2", roster: b },
  { roster_id: 3, name: "Team C", user: "sea", record: "3-0", roster: c },
];
const work = T.leagueCandidates({ league, teams, myRosterId: 1, slots, season: "2026", week: 4,
                                  valuesFetched: "2026-09-29T12:00:00Z" });
check("candidates produced", work.candidates.length > 0, true);
check("never more than three per partner",
  Object.values(work.candidates.reduce((a, x) => (a[x.partner.roster_id] = (a[x.partner.roster_id] || 0) + 1, a), {}))
    .every((n) => n <= 3), true);
check("ids are unique", new Set(work.candidates.map((x) => x.id)).size, work.candidates.length);
check("ids are stable", T.leagueCandidates({ league, teams, myRosterId: 1, slots, season: "2026",
  week: 4 }).candidates.map((x) => x.id), work.candidates.map((x) => x.id));
check("my thin spots include RB", work.me.thin.includes("RB"), true);
check("partner needs carried", Array.isArray(work.candidates[0].partner.thin), true);
check("format recorded", work.format.ppr, 1);
check("league type recorded", work.league.type, "redraft");
check("source is FantasyCalc", work.values_source.name, "FantasyCalc");
const profile = T.positionProfile(teams, slots);
check("Team B is deep at RB", profile[2].deep.includes("RB"), true);

/* --- injured players ---------------------------------------------------- */
const hurt = [P("h1", "QB", 8000), P("h2", "QB", 3000), P("h3", "RB", 5000), P("h4", "RB", 4000),
              P("h5", "WR", 5000), P("h6", "WR", 4000), P("h7", "TE", 2000), P("h8", "WR", 3500)];
const onIR = hurt.map((p) => (p.id === "h1" ? { ...p, longOut: true } : p));
check("a player on IR doesn't start",
  T.lineup(onIR, slots).starters.some((s) => s.player.id === "h1"), false);
check("his backup starts instead",
  T.lineup(onIR, slots).starters.find((s) => s.slot === "QB").player.id, "h2");
check("an IR player adds nothing to lineup strength",
  T.strength(onIR, slots) < T.strength(hurt, slots), true);
check("empty slot when no healthy option",
  T.lineup(onIR.filter((p) => p.id !== "h2"), slots).starters.some((s) => s.slot === "QB"), false);
// Trading an injured player away can't be sold as helping the other side.
const hurtMe = me.map((p) => (p.id === "w1" ? { ...p, ir: true } : p));
{
  // Give them w1 (hurt) plus someone healthy: w1 must add nothing to their lineup.
  const gets = new Set(["r3"]);
  const theirs = b.filter((p) => !gets.has(p.id));
  const withHurt = theirs.concat([hurtMe.find((p) => p.id === "w1"), me.find((p) => p.id === "r2")]);
  const without = theirs.concat([me.find((p) => p.id === "r2")]);
  check("an injured player doesn't count as healthy on his new team",
    T.strength(withHurt, slots), T.strength(without, slots));
}
const injuredOnly = T.tradesWith(hurtMe, b, slots, 12).filter((x) => x.give.length === 1 && x.give[0].id === "w1");
check("an injured player alone buys nothing", injuredOnly.length, 0);
check("long-term statuses flagged from Sleeper's words",
  T.teamPlayers(["a", "b", "c"], { a: { n: "A", p: "RB", i: "IR" }, b: { n: "B", p: "RB", i: "Out" },
    c: { n: "C", p: "RB", i: "Suspended" } }, {}).map((p) => p.longOut), [true, false, true]);
check("sidelined flag carried to the work file",
  T.teamPlayers(["a"], { a: { n: " A ", p: "RB", i: "PUP" } }, {}).map((p) => [p.n, p.longOut]), [["A", true]]);

/* --- form: results against expectations ------------------------------- */
check("weeks: mid-week counts only finished weeks",
  T.completedWeeks(4, new Date("2026-09-26T16:00:00Z")), [1, 2, 3]);            // Saturday
check("weeks: Tuesday counts the week just played",
  T.completedWeeks(4, new Date("2026-09-29T14:00:00Z")), [1, 2, 3, 4]);         // Tuesday ET
check("weeks: nothing before week 1 is over", T.completedWeeks(1, new Date("2026-09-12T16:00:00Z")), []);

const scoring = { rec: 1, rec_yd: 0.1, rec_td: 6 };
const wk = (stats, proj) => T.weekData(stats, proj);
const w1 = wk([
  { player_id: "x", team: "KC", stats: { gp: 1, off_snp: 60, tm_off_snp: 70, rec_tgt: 10, rec: 8, rec_yd: 100, rec_td: 1, rec_rz_tgt: 2 } },
  { player_id: "y", team: "KC", stats: { gp: 1, off_snp: 30, tm_off_snp: 70, rec_tgt: 10, rec: 2, rec_yd: 10 } },
], [{ player_id: "x", stats: { rec: 5, rec_yd: 60, rec_td: 0.5 } }, { player_id: "y", stats: { rec: 5, rec_yd: 50 } }]);
const w2 = wk([{ player_id: "x", team: "KC", stats: { gp: 0 } }], []);
check("team targets summed across players", w1.teamTgt.KC, 20);
const fx = T.formFor("x", "WR", [w1, w2], scoring);
check("form: games only where he played", fx.g, 1);
check("form: points in this league's scoring", fx.ppg, 24);                 // 8 + 10 + 6
check("form: projected points for the same games", fx.proj, 14);          // 5 + 6 + 3
check("form: points against projection", fx.perf, 1.71);
check("form: snap share", fx.snap, 86);
check("form: target share", fx.tgtShare, 50);
check("form: red-zone looks", fx.rz, 2);
check("form: none for a player who hasn't played", T.formFor("z", "WR", [w1], scoring), null);

check("trend as a share of the old value", T.trendPct({ v: 1100, trend: 100 }), 0.1);
const tp = (o) => ({ id: "t", n: "T", p: "WR", v: 5000, trend: 0, ir: false, longOut: false,
                     form: { g: 2, perf: 1, snap: 80, tgtShare: 20 }, ...o });
check("yours, slumping: hold, never sold low", T.marketTag(tp({ form: { g: 2, perf: 0.6, snap: 80 } }), true), "hold");
check("yours, value falling: hold", T.marketTag(tp({ trend: -700 }), true), "hold");
check("yours, overperforming: sell high", T.marketTag(tp({ form: { g: 2, perf: 1.5, snap: 80 } }), true), "sell_high");
check("yours, value rising: sell high", T.marketTag(tp({ trend: 600 }), true), "sell_high");
check("yours, steady: no call", T.marketTag(tp({}), true), null);
check("theirs, slumping but still used: buy low",
  T.marketTag(tp({ form: { g: 2, perf: 0.6, snap: 85, tgtShare: 24 } }), false), "buy_low");
check("theirs, slumping and lost his job: no call",
  T.marketTag(tp({ form: { g: 2, perf: 0.6, snap: 30, tgtShare: 8 } }), false), null);
check("theirs, slumping but hurt: no call",
  T.marketTag(tp({ longOut: true, form: { g: 2, perf: 0.6, snap: 85, tgtShare: 24 } }), false), null);
check("theirs, on a heater: avoid buying high", T.marketTag(tp({ form: { g: 2, perf: 1.6, snap: 80 } }), false), "avoid");
check("a real jump on a real player counts", T.marketTag(tp({ v: 900, trend: 300 }), true), "sell_high");
check("tiny values: a big percentage on a small number is noise",
  T.marketTag(tp({ v: 400, trend: 300 }), true), null);
check("tiny moves: under 250 points of movement doesn't count",
  T.marketTag(tp({ v: 1500, trend: 240 }), true), null);
check("players worth almost nothing get no call",
  T.marketTag(tp({ v: 200, form: { g: 2, perf: 2.1, snap: 70 } }), true), null);
check("RB usage counts touches", T.usageIntact({ p: "RB", form: { touches: 14, snap: 40 } }), true);
check("QB usage needs the snaps", T.usageIntact({ p: "QB", form: { snap: 50 } }), false);

{
  const teamsT = [
    { roster_id: 1, roster: [{ id: "a", n: "A", tag: null }, { id: "b", n: "B", tag: "hold" }] },
    { roster_id: 2, roster: [{ id: "c", n: "C", tag: null }, { id: "d", n: "D", tag: "avoid" }] },
  ];
  const probs = T.applyTargets(teamsT, 1, { sell: ["a"], buy: ["c", "a"], neutral: ["d"], hold: ["zz"] });
  check("research: sell and buy calls applied", [teamsT[0].roster[0].tag, teamsT[1].roster[0].tag], ["sell_high", "buy_low"]);
  check("research: neutral clears a call", teamsT[1].roster[1].tag, null);
  check("research: wrong-roster and unknown ids reported", probs.length, 2);
}

/* --- angles in the search ---------------------------------------------- */
{
  const tagged = (r, tags) => r.map((p) => ({ ...p, tag: tags[p.id] || null }));
  const mine = tagged(me, { w2: "hold", w3: "sell_high" });
  const theirs = tagged(b, { r4: "buy_low", r3: "avoid" });
  const found = T.tradesWith(mine, theirs, slots, 12);
  check("a slumping player of yours is never offered", found.some((x) => x.give.some((p) => p.id === "w2")), false);
  check("sell-high and buy-low deals are found", found.some((x) => x.angle > 0), true);
  const plain = T.tradesWith(me, b, slots, 12);
  const sig = (x) => `${x.give.map((p) => p.id)}>${x.get.map((p) => p.id)}`;
  const same = found.find((x) => sig(x) === "w3>r4");
  const base = plain.find((x) => sig(x) === "w3>r4");
  if (same && base) check("an angle ranks a deal higher", same.score > base.score, true);
  // Same deals with only the peak tag set, so nothing else moves the score.
  const peak = T.tradesWith(me, tagged(b, { r3: "avoid" }), slots, 12);
  const bought = peak.find((x) => x.get.some((p) => p.id === "r3"));
  const unbought = bought && plain.find((x) => sig(x) === sig(bought));
  check("buying at the peak ranks lower", !!bought && !!unbought && bought.score < unbought.score, true);
}

/* --- draft picks --------------------------------------------------------- */
const fcPickRows = [
  { player: { sleeperId: "FP_2027_early_0", name: "2027 1st (Early)", position: "PICK" }, value: 4800, trend30Day: 300 },
  { player: { sleeperId: "FP_2027_mid_0", name: "2027 1st (Mid)", position: "PICK" }, value: 3200, trend30Day: 200 },
  { player: { sleeperId: "FP_2027_late_0", name: "2027 1st (Late)", position: "PICK" }, value: 2400, trend30Day: 100 },
  { player: { sleeperId: "FP_2027_1", name: "2027 1st", position: "PICK" }, value: 3000, trend30Day: 150 },
  { player: { sleeperId: "FP_2028_1", name: "2028 1st", position: "PICK" }, value: 2200, trend30Day: 50 },
  { player: { sleeperId: "FP_2027_mid_1", name: "2027 2nd (Mid)", position: "PICK" }, value: 1600, trend30Day: 0 },
  { player: { sleeperId: "FP_2028_2", name: "2028 2nd", position: "PICK" }, value: 1300, trend30Day: 0 },
  { player: { sleeperId: "4046", name: "Not A Pick", position: "QB" }, value: 5000 },
];
const pv = T.pickValueMap(fcPickRows);
check("pick prices keyed by FantasyCalc's pick ids", [pv.FP_2027_mid_0.v, pv.FP_2028_2.v, pv["4046"]], [3200, 1300, undefined]);
check("next year is always tradeable", T.futurePickSeasons("2026", []), [2027]);
check("as far out as the league has traded", T.futurePickSeasons("2026", [{ season: "2029" }, { season: "2026" }]), [2027, 2028, 2029]);
check("never past three years", T.futurePickSeasons("2026", [{ season: "2031" }]), [2027, 2028, 2029]);
{
  const teamsP = [
    { roster_id: 1, roster: [P("a1", "QB", 9000), P("a2", "RB", 9000)] },
    { roster_id: 2, roster: [P("b1", "QB", 1000), P("b2", "RB", 1000)] },
    { roster_id: 3, roster: [P("c1", "QB", 5000), P("c2", "RB", 5000)] },
  ];
  check("weakest roster picks early, strongest late", T.projectedSlots(teamsP, slots), { 1: "late", 2: "early", 3: "mid" });
  const assets = T.pickAssets({
    season: "2026", rounds: 2, rosterIds: [1, 2, 3], pickValues: pv,
    traded: [{ season: "2027", round: 1, roster_id: 2, owner_id: 1 }, { season: "2028", round: 2, roster_id: 3, owner_id: 2 }],
    slotOf: { 1: "late", 2: "early", 3: "mid" }, nameOf: { 1: "Mine", 2: "Bee", 3: "Sea" },
  });
  const byId = Object.fromEntries(assets.map((a) => [a.id, a]));
  check("a traded pick belongs to its new owner", byId.pick_2027_1_2.holder, 1);
  check("and says where it came from", byId.pick_2027_1_2.t, "via Bee");
  check("own picks say so", byId.pick_2027_1_1.t, "own");
  check("next year's pick priced by projected slot", [byId.pick_2027_1_2.n, byId.pick_2027_1_2.v], ["2027 1st (Early)", 4800]);
  check("later years priced by round", [byId.pick_2028_1_3.n, byId.pick_2028_1_3.v], ["2028 1st", 2200]);
  check("slot falls back to the round price", byId.pick_2027_2_1, undefined);   // no 2027 late 2nd or generic 2nd priced
  check("rounds the market doesn't price are left out", assets.every((a) => a.v > 0), true);

  const withPicks = me.concat([{ ...byId.pick_2027_1_2 }]);
  check("picks never start", T.lineup(withPicks, slots).starters.some((x) => x.player.isPick), false);
  check("picks don't sit on the bench list", T.lineup(withPicks, slots).bench.some((x) => x.isPick), false);
  check("picks count a little toward strength",
    T.strength(withPicks, slots) - T.strength(me, slots), Math.round(0.15 * 4800));
  const found = T.tradesWith(withPicks, b, slots, 12);
  check("picks can be part of a trade", found.some((x) => x.give.some((p) => p.isPick)), true);
}

check("draft history: what each round turned into", T.summarizeDrafts([
  { season: "2025", teams: 3, picks: [
    { round: 1, draft_slot: 1, player_id: "h1", metadata: { first_name: "Hit", last_name: "One", position: "RB" } },
    { round: 1, draft_slot: 2, player_id: "h2", metadata: { first_name: "Hit", last_name: "Two", position: "WR" } },
    { round: 1, draft_slot: 3, player_id: "bust", metadata: { first_name: "Bust", last_name: "Three", position: "WR" } },
  ] }], { h1: { v: 6000 }, h2: { v: 3000 }, bust: { v: 100 } }, pv, 2027).rounds[0],
  { round: 1, n: 3, median: 3000, early: 6000, mid: 3000, late: 100, busts: 33,
    best: [{ name: "Hit One", pos: "RB", season: "2025", pick: "1.01", v: 6000 },
           { name: "Hit Two", pos: "WR", season: "2025", pick: "1.02", v: 3000 },
           { name: "Bust Three", pos: "WR", season: "2025", pick: "1.03", v: 100 }],
    market: { early: 4800, mid: 3200, late: 2400, any: 3000 } });

/* --- finalize: the research has to clear the numbers ------------------- */
const cid = work.candidates[0].id;
const good = {
  short_reason: "A one-trade test.",
  trades: [{
    candidate: cid, headline: "Turn WR depth into a starting RB", confidence: "high",
    summary: "Short version.",
    why: { give: ["Fourth WR rarely starts."], get: ["Bell-cow role."],
           you: ["RB2 goes from a 900 to a starter."], them: ["They start one real WR."],
           experts: ["Analysts rank him a top-10 back rest of season."] },
    risks: ["RB injury rates."],
    sources: [{ title: "News", url: "https://example.com/a" }],
  }],
};
const ok = T.finalize(work, good, new Date("2026-09-29T13:00:00Z"));
check("valid research passes", ok.errors, []);
check("numbers come from the candidates, not the research",
  ok.data.trades[0].value.giveAdj, work.candidates[0].value.giveAdj);
check("status ready", ok.data.status, "ready");
check("unreviewed research says so", ok.data.review, { checked: false });
check("experts section required", T.finalize(work, { ...good, trades: [{ ...good.trades[0],
  why: { ...good.trades[0].why, experts: [] } }] }).errors.some((e) => /why.experts/.test(e)), true);
check("a second agent's review is published",
  T.finalize(work, { ...good, review: { checked: true, notes: ["Fixed a snap share."] } }).data.review,
  { checked: true, notes: ["Fixed a snap share."] });
check("timestamp written", ok.data.generated, "2026-09-29T13:00:00.000Z");

const bad = JSON.parse(JSON.stringify(good));
bad.trades[0].candidate = "nope";
check("unknown candidate rejected", T.finalize(work, bad).errors.length > 0, true);

const thin = JSON.parse(JSON.stringify(good));
thin.trades[0].why.them = [];
check("missing section rejected", T.finalize(work, thin).errors.some((e) => /why.them/.test(e)), true);

const nosrc = JSON.parse(JSON.stringify(good));
nosrc.trades[0].sources = [{ title: "x", url: "http://insecure" }];
check("non-https source rejected", T.finalize(work, nosrc).errors.some((e) => /sources\[0\]/.test(e)), true);

const lopsided = JSON.parse(JSON.stringify(work));
lopsided.candidates[0].get[0].v *= 3;
check("unfair trade rejected even if the file says fair",
  T.finalize(lopsided, good).errors.some((e) => /not fair/.test(e)), true);

check("empty needs a reason", T.finalize(work, { trades: [] }).errors.length, 1);
check("empty with a reason is fine", T.finalize(work, { trades: [], none_reason: "Nothing fair." }).errors, []);
for (const [label, bullet] of [["my", "Frees up my flex spot."], ["we", "We are deep at WR."],
                               ["our", "Fills our RB2."], ["I", "I like this deal."]]) {
  const fp = JSON.parse(JSON.stringify(good));
  fp.trades[0].why.you = [bullet];
  check(`first person rejected: "${label}"`, T.finalize(work, fp).errors.some((e) => /write to the manager/.test(e)), true);
}
const ok2 = JSON.parse(JSON.stringify(good));
ok2.trades[0].why.you = ["Your RB2 improves; the U.S. Bank Stadium matchup is soft and yours to win."];
check("second person and 'U.S.' are fine", T.finalize(work, ok2).errors, []);

{
  const need = Math.min(T.MIN_TRADES, work.candidates.length);
  const make = (n) => ({ trades: work.candidates.slice(0, n).map((c) => ({ ...good.trades[0], candidate: c.id })) });
  check("test league has enough candidates to need five", need, T.MIN_TRADES);
  check("five trades pass without a reason", T.finalize(work, make(need)).errors, []);
  check("fewer than five need a reason",
    T.finalize(work, make(need - 1)).errors.some((e) => /at least 5/.test(e)), true);
  const short = { ...make(need - 1), short_reason: "Only four fair deals exist." };
  check("fewer than five with a reason pass", T.finalize(work, short).errors, []);
  check("the reason is published", T.finalize(work, short).data.short_reason, "Only four fair deals exist.");
  check("five or more carry no reason", T.finalize(work, make(need)).data.short_reason, null);
  const many = { trades: Array.from({ length: T.MAX_TRADES + 1 },
    (_, i) => ({ ...good.trades[0], candidate: work.candidates[i % work.candidates.length].id })) };
  check("no more than eight", T.finalize(work, many).errors.some((e) => /best 8/.test(e)), true);
  const held = JSON.parse(JSON.stringify(work));
  held.candidates[0].give[0].tag = "hold";
  check("selling a slumping player is refused",
    T.finalize(held, good).errors.some((e) => /Don't sell low/.test(e)), true);
}

const dup = JSON.parse(JSON.stringify(good));
dup.trades.push(dup.trades[0]);
check("duplicate trade rejected", T.finalize(work, dup).errors.some((e) => /twice/.test(e)), true);

/* --- CLI end to end, against canned Sleeper and FantasyCalc responses -- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trades-"));
const S = "https://api.sleeper.app/v1";
const fcRows = [...me, ...b, ...c].map((p) => ({
  player: { sleeperId: p.id, name: p.n, position: p.p, maybeTeam: "NFL" },
  value: p.v, positionRank: 1, trend30Day: 0 }));
const dumpPlayers = {};
[...me, ...b, ...c].forEach((p) => { dumpPlayers[p.id] = { full_name: p.n, position: p.p, team: "NFL" }; });
const closed = { ...league, league_id: "L2", name: "Closed", settings: { trade_deadline: 3 } };
const fixtures = {
  [`${S}/state/nfl`]: { season: "2026", week: 4 },
  [`${S}/user/etanetan`]: { user_id: "u1" },
  [`${S}/user/u1/leagues/nfl/2026`]: [league, closed],
  [`${S}/players/nfl`]: dumpPlayers,
  [`${S}/league/L1/rosters`]: [
    { roster_id: 1, owner_id: "u1", players: me.map((p) => p.id), settings: { wins: 2, losses: 1 } },
    { roster_id: 2, owner_id: "u2", players: b.map((p) => p.id), settings: { wins: 1, losses: 2 } },
    { roster_id: 3, owner_id: "u3", players: c.map((p) => p.id), settings: { wins: 3, losses: 0 } },
  ],
  [`${S}/league/L1/users`]: [
    { user_id: "u1", display_name: "etanetan", metadata: { team_name: "Mine" } },
    { user_id: "u2", display_name: "bee" }, { user_id: "u3", display_name: "sea" }],
  [T.fcUrl(T.fcParams(league))]: fcRows,
};
// A dynasty version of the same league, to exercise picks and draft history.
const dyn = { ...league, league_id: "L3", name: "Dyn", season: "2026", settings: { trade_deadline: 11, type: 2, draft_rounds: 2 },
              draft_id: "D2", previous_league_id: "L3old" };
fixtures[`${S}/user/u1/leagues/nfl/2026`].push(dyn);
fixtures[`${S}/league/L3/rosters`] = fixtures[`${S}/league/L1/rosters`];
fixtures[`${S}/league/L3/users`] = fixtures[`${S}/league/L1/users`];
fixtures[`${S}/league/L3/traded_picks`] = [{ season: "2027", round: 1, roster_id: 2, owner_id: 1, previous_owner_id: 2 }];
fixtures[`${S}/league/L3/drafts`] = [
  { draft_id: "200", status: "complete", settings: { rounds: 2 } },    // the main rookie draft
  { draft_id: "300", status: "complete", settings: { rounds: 2 } },    // a later side draft
];
fixtures[`${S}/draft/200/picks`] = [{ round: 1, draft_slot: 1, player_id: "r3", metadata: { first_name: "RB", last_name: "r3", position: "RB" } }];
fixtures[`${S}/league/L3old`] = { league_id: "L3old", season: "2025", total_rosters: 3, previous_league_id: null };
fixtures[`${S}/league/L3old/drafts`] = [{ draft_id: "100", status: "complete", settings: { rounds: 30 } }];  // startup: skipped
fixtures[T.fcUrl(T.fcParams(dyn))] = fcRows.concat(fcPickRows);
for (const w of [1, 2, 3]) {
  fixtures[T.statsUrl("2026", w)] = [];
  fixtures[T.projUrl("2026", w)] = [];
}
const fxFile = path.join(tmp, "fixtures.json");
fs.writeFileSync(fxFile, JSON.stringify(fixtures));
const env = { ...process.env, TRADES_FIXTURES: fxFile, TRADES_NOW: "2026-09-26T16:00:00Z" };
const run = (...a) => execFileSync(process.execPath, ["trades/engine.js", ...a],
  { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const out = JSON.parse(run("candidates", "--user", "etanetan", "--out", path.join(tmp, "work")));
check("cli: week read from Sleeper", out.week, 4);
check("cli: form from the finished weeks", out.form_weeks, [1, 2, 3]);
{
  const dw = JSON.parse(fs.readFileSync(path.join(tmp, "work", "L3.json"), "utf8"));
  check("cli: your own 1st and the 1st traded to you are both yours",
    ["pick_2027_1_1", "pick_2027_1_2"].every((id) => dw.me.picks.some((p) => p.id === id)), true);
  check("cli: another team's own 1st stays theirs", dw.me.picks.some((p) => p.id === "pick_2027_1_3"), false);
  check("cli: draft history from the main rookie draft only", dw.draft_history.seasons, ["2026"]);
  check("cli: redraft leagues have no picks", JSON.parse(fs.readFileSync(path.join(tmp, "work", "L1.json"), "utf8")).me.picks, []);
}
check("cli: closed league skipped with reason", out.leagues.find((l) => l.league_id === "L2").open, false);
check("cli: open league has candidates", out.leagues.find((l) => l.league_id === "L1").candidates > 0, true);
const cliWork = JSON.parse(fs.readFileSync(path.join(tmp, "work", "L1.json"), "utf8"));
check("cli: partner named from team_name or display name",
  cliWork.candidates.every((x) => ["bee", "sea"].includes(x.partner.name)), true);
check("cli: records carried", cliWork.me.record, "2-1");
check("cli: market sheet written", Object.keys(cliWork.market).sort(), ["avoid", "buy_low", "hold", "sell_high", "weeks"]);
check("cli: every candidate labelled", cliWork.candidates.every((x) => ["need", "sell-high", "buy-low", "sell-high + buy-low"].includes(x.kind)), true);

{
  // Research calls re-run the search for one league.
  const tFile = path.join(tmp, "targets.json");
  fs.writeFileSync(tFile, JSON.stringify({ sell: ["w3"], hold: ["w1"], buy: ["r4"] }));
  run("candidates", "--user", "etanetan", "--league", "L1", "--targets", tFile, "--out", path.join(tmp, "work"));
  const tw = JSON.parse(fs.readFileSync(path.join(tmp, "work", "L1.json"), "utf8"));
  check("cli: targets applied", tw.targets_applied, true);
  check("cli: held player never offered", tw.candidates.some((x) => x.give.some((p) => p.id === "w1")), false);
  check("cli: research calls marked as research",
    tw.market.sell_high.map((p) => [p.id, p.tagBy]), [["w3", "research"]]);
  let needsLeague = false;
  try { run("candidates", "--user", "etanetan", "--targets", tFile, "--out", path.join(tmp, "work")); }
  catch (e) { needsLeague = /needs --league/.test(e.stderr); }
  check("cli: targets need a league", needsLeague, true);
  run("candidates", "--user", "etanetan", "--out", path.join(tmp, "work"));   // back to the plain search
}

const dataDir = path.join(tmp, "data");
run("running", "--league", "L1", "--data", dataDir);
check("cli: running status", JSON.parse(fs.readFileSync(path.join(dataDir, "L1.json"))).status, "running");
const rFile = path.join(tmp, "research.json");
fs.writeFileSync(rFile, JSON.stringify({ short_reason: "Test.", trades: [{ ...good.trades[0], candidate: cliWork.candidates[0].id }] }));
run("finalize", "--league", "L1", "--research", rFile, "--data", dataDir, "--work", path.join(tmp, "work"));
const final = JSON.parse(fs.readFileSync(path.join(dataDir, "L1.json")));
check("cli: finalize writes ready", final.status, "ready");
check("cli: one trade", final.trades.length, 1);

fs.writeFileSync(rFile, JSON.stringify({ trades: [{ candidate: "nope" }] }));
let rejected = false;
try { run("finalize", "--league", "L1", "--research", rFile, "--data", dataDir, "--work", path.join(tmp, "work")); }
catch (e) { rejected = e.status === 2; }
check("cli: bad research exits 2 and leaves the file alone", rejected &&
  JSON.parse(fs.readFileSync(path.join(dataDir, "L1.json"))).trades.length === 1, true);

run("failed", "--league", "L1", "--data", dataDir, "--reason", "Sleeper was down");
const failed = JSON.parse(fs.readFileSync(path.join(dataDir, "L1.json")));
check("cli: failure keeps last trades and records why",
  [failed.status, failed.trades.length, failed.error.reason], ["ready", 1, "Sleeper was down"]);

fs.rmSync(tmp, { recursive: true, force: true });

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
