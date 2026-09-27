/* Offline tests for the client-side scoring, ranking and lineup logic. */
const app = require("./core.js");
const results = [];

function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}` +
    (ok ? "" : `\n        got ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`));
  results.push(ok);
}

/* --- name normalization (now client-side) ----------------------------- */
check("suffix stripped", app.norm("Marvin Harrison Jr."), "marvin harrison");
check("apostrophe", app.norm("De'Von Achane"), "devon achane");
check("hyphen", app.norm("Amon-Ra St. Brown"), "amon ra st brown");
check("roman numeral", app.norm("Kenneth Walker III"), "kenneth walker");
check("accents folded", app.norm("José Peña"), "jose pena");
check("case and spacing", app.norm("  JOSH   ALLEN "), "josh allen");
check("empty safe", app.norm(""), "");
check("null safe", app.norm(null), "");

/* --- trimming Sleeper's player dump ----------------------------------- */
const dump = {
  "1": { full_name: "Josh Allen", position: "QB", team: "buf", injury_status: null },
  "2": { first_name: "Bijan", last_name: "Robinson", position: "RB", team: "ATL" },
  "JAX": { first_name: "Jacksonville", last_name: "Jaguars", position: "DEF", team: null },
  "9": { full_name: "Some Guard", position: "OL", team: "NYG" },
  "8": { full_name: "Hurt Guy", position: "WR", team: "KC", injury_status: "Questionable" },
};
dump["1"].bye_week = 12;
const trimmed = app.trimPlayers(dump);
check("bye week kept", trimmed["1"].b, 12);
check("missing bye week is null", trimmed["2"].b, null);
check("non-fantasy positions dropped", Object.keys(trimmed).sort(), ["1", "2", "8", "JAX"]);
check("full_name preferred", trimmed["1"].n, "Josh Allen");
check("name assembled from parts", trimmed["2"].n, "Bijan Robinson");
check("team uppercased", trimmed["1"].t, "BUF");
check("defense falls back to its id for team", trimmed.JAX.t, "JAX");
check("defense keyed by team", trimmed.JAX.k, "JAX");
check("player keyed by normalized name", trimmed["2"].k, "bijan robinson");
check("injury carried through", trimmed["8"].i, "Questionable");
check("missing injury becomes empty", trimmed["1"].i, "");
check("empty dump safe", app.trimPlayers({}), {});

/* --- live injury status from a projections row ------------------------ */
check("top-level injury_status", app.statusFromRow({ injury_status: "Questionable" }), "Questionable");
check("top-level status", app.statusFromRow({ status: "Out" }), "Out");
check("nested under player", app.statusFromRow({ player: { injury_status: "IR" } }), "IR");
check("injury_status preferred over status",
      app.statusFromRow({ injury_status: "Doubtful", status: "Active" }), "Doubtful");
check("whitespace trimmed", app.statusFromRow({ injury_status: "  Out  " }), "Out");
// An absent field means "no information", not "healthy" - returning "" here
// would wipe a real status off a cached player.
check("absent field is undefined, not empty", app.statusFromRow({ stats: {} }), undefined);
check("empty string is undefined", app.statusFromRow({ injury_status: "   " }), undefined);
check("non-string ignored", app.statusFromRow({ injury_status: 3 }), undefined);
check("null row safe", app.statusFromRow(null), undefined);
check("non-object safe", app.statusFromRow("nope"), undefined);

/* --- scoring a stat line through league settings ---------------------- */
const PPR = { rec: 1, rec_yd: 0.1, rec_td: 6, rush_yd: 0.1, rush_td: 6,
              pass_yd: 0.04, pass_td: 4, pass_int: -2, fum_lost: -2 };
const HALF = { ...PPR, rec: 0.5 };
const STD = { ...PPR, rec: 0 };

const wr = { rec: 8, rec_yd: 100, rec_td: 1 };
check("full PPR scoring", app.scorePlayer(wr, PPR, "WR"), 24);
check("half PPR scoring", app.scorePlayer(wr, HALF, "WR"), 20);
check("standard scoring", app.scorePlayer(wr, STD, "WR"), 16);

const qb = { pass_yd: 300, pass_td: 3, pass_int: 1, rush_yd: 20 };
check("qb under 4pt passing", app.scorePlayer(qb, PPR, "QB"), 24);
check("qb under 6pt passing",
      app.scorePlayer(qb, { ...PPR, pass_td: 6 }, "QB"), 30);

check("te premium applies to TEs",
      app.scorePlayer({ rec: 6, rec_yd: 60 }, { ...HALF, bonus_rec_te: 0.5 }, "TE"), 12);
check("te premium ignored for WRs",
      app.scorePlayer({ rec: 6, rec_yd: 60 }, { ...HALF, bonus_rec_te: 0.5 }, "WR"), 9);

check("unknown stat keys ignored",
      app.scorePlayer({ rec: 1, nonsense: 99 }, { rec: 1 }, "WR"), 1);
check("settings without matching stats", app.scorePlayer({ rec: 1 }, { rush_td: 6 }, "WR"), 0);
check("null stats safe", app.scorePlayer(null, PPR, "WR"), 0);
check("null settings safe", app.scorePlayer(wr, null, "WR"), 0);
check("negative scoring applies",
      app.scorePlayer({ pass_int: 3 }, { pass_int: -2 }, "QB"), -6);

/* --- scoring labels ---------------------------------------------------- */
check("full ppr label", app.scoringLabel({ rec: 1 }), "Full PPR");
check("half ppr label", app.scoringLabel({ rec: 0.5 }), "Half PPR");
check("standard label", app.scoringLabel({ rec: 0 }), "Standard");
check("odd ppr value named", app.scoringLabel({ rec: 0.25 }), "0.25 PPR");
check("no settings", app.scoringLabel(null), "Standard");

/* --- per-league ranking ------------------------------------------------ */
const players = {
  a: { n: "Volume WR", p: "WR", t: "AAA", i: "" },   // catches a lot, few yards
  b: { n: "Deep WR", p: "WR", t: "BBB", i: "" },     // few catches, big yards
  c: { n: "RB One", p: "RB", t: "CCC", i: "" },
  d: { n: "Tight End", p: "TE", t: "DDD", i: "" },
};
const proj = {
  a: { rec: 14, rec_yd: 90 },
  b: { rec: 3, rec_yd: 120, rec_td: 1 },
  c: { rush_yd: 90, rush_td: 1, rec: 2, rec_yd: 15 },
  d: { rec: 5, rec_yd: 50 },
};

const pprRanks = app.rankPositions(proj, players, PPR);
const stdRanks = app.rankPositions(proj, players, STD);
check("PPR favors the volume receiver", pprRanks.a.posRank, 1);
check("standard favors the deep threat", stdRanks.b.posRank, 1);
check("the same league ranks both WRs", [pprRanks.a.posRank, pprRanks.b.posRank].sort(), [1, 2]);
check("ranks are per position, not overall", pprRanks.c.posRank, 1);
check("TE ranked within TEs", pprRanks.d.posRank, 1);
check("points carried alongside rank", Math.round(pprRanks.a.pts * 10) / 10, 23);
check("same player scores differently by league",
      Math.round(stdRanks.a.pts * 10) / 10, 9);

/* a player with no projection gets no rank rather than rank 0 */
const partial = app.rankPositions({ a: proj.a }, players, PPR);
check("unprojected players omitted", partial.b, undefined);
check("unknown player ids skipped", app.rankPositions({ zzz: { rec: 5 } }, players, PPR), {});

/* --- consensus ranks --------------------------------------------------- */
const RANKINGS = {
  shared: {
    QB: { "josh allen": { rank: 1, posRank: 1 } },
    K: { "brandon aubrey": { rank: 120, posRank: 2 } },
    DST: { JAC: { rank: 140, posRank: 7 } },
  },
  formats: {
    half: {
      RB: { "volume wr": null, "rb one": { rank: 12, posRank: 5 } },
      WR: { "volume wr": { rank: 8, posRank: 4 } },
      TE: { "tight end": { rank: 40, posRank: 9 } },
      FLEX: { "rb one": { rank: 14, posRank: 14 }, "volume wr": { rank: 9, posRank: 9 } },
    },
    ppr: {
      RB: { "rb one": { rank: 20, posRank: 8 } },
      WR: { "volume wr": { rank: 4, posRank: 2 } },
      TE: {}, FLEX: {},
    },
    std: { RB: {}, WR: {}, TE: {}, FLEX: {} },
  },
};
const cPlayers = {
  qb1: { n: "Josh Allen", p: "QB", t: "BUF", k: "josh allen", i: "" },
  k1: { n: "Brandon Aubrey", p: "K", t: "DAL", k: "brandon aubrey", i: "" },
  d1: { n: "Jacksonville Jaguars", p: "DEF", t: "JAX", k: "JAX", i: "" },
  wr1: { n: "Volume WR", p: "WR", t: "AAA", k: "volume wr", i: "" },
  rb1: { n: "RB One", p: "RB", t: "CCC", k: "rb one", i: "" },
  ghost: { n: "Nobody", p: "WR", t: "ZZZ", k: "nobody", i: "" },
};

const cHalf = app.consensusRanks(RANKINGS, cPlayers, { rec: 0.5 });
check("QB read from the shared list", cHalf.qb1.posRank, 1);
check("K read from the shared list", cHalf.k1.posRank, 2);
check("DST matched through team alias JAX->JAC", cHalf.d1.posRank, 7);
check("WR read from the half-PPR list", cHalf.wr1.posRank, 4);
check("flex rank attached separately", cHalf.wr1.flexRank, 9);
check("unranked player omitted", cHalf.ghost, undefined);

const cPpr = app.consensusRanks(RANKINGS, cPlayers, { rec: 1 });
check("scoring format changes the consensus rank", cPpr.wr1.posRank, 2);
check("RB rank differs by format too", [cHalf.rb1.posRank, cPpr.rb1.posRank], [5, 8]);
check("QB unchanged across formats", cPpr.qb1.posRank, 1);

check("no rankings published -> null", app.consensusRanks({}, cPlayers, { rec: 1 }), null);
check("null rankings -> null", app.consensusRanks(null, cPlayers, { rec: 1 }), null);
check("rankings with no matches -> null",
      app.consensusRanks(RANKINGS, { x: { p: "WR", k: "unknown guy" } }, { rec: 0.5 }), null);

/* flex ordering prefers consensus FLEX rank over projected points */
const F = (n, p, posRank, pts, flexRank = null) => ({ n, p, posRank, pts, flexRank, status: "", t: "X" });
const flexLu = app.pickLineup(
  [F("High points low rank", "RB", 5, 30, 40), F("Low points high rank", "WR", 6, 9, 3)],
  ["FLEX"]);
check("flex uses consensus rank when present",
      Object.fromEntries(flexLu.starters.map(s => [s.slot, s.player.n])).FLEX,
      "Low points high rank");

const noFlexRank = app.pickLineup(
  [F("More points", "RB", 5, 30), F("Fewer points", "WR", 6, 9)], ["FLEX"]);
check("flex falls back to points without consensus",
      Object.fromEntries(noFlexRank.starters.map(s => [s.slot, s.player.n])).FLEX,
      "More points");

/* --- roster assembly --------------------------------------------------- */
players.e = { n: "Hurt Guy", p: "WR", t: "EEE", i: "Questionable" };
const roster = app.buildRoster(["a", "b", "e", "nope"], players, pprRanks);
check("roster keeps known players", roster.length, 3);
check("rank attached", roster[0].posRank, 1);
check("injury normalized", roster[2].status, "Q");
check("unprojected player kept but unranked", roster[2].posRank, null);

/* --- bye weeks --------------------------------------------------------- */
const byePlayers = {
  onbye: { n: "Bye Guy", p: "WR", t: "AAA", k: "bye guy", i: "", b: 7 },
  playing: { n: "Playing Guy", p: "WR", t: "BBB", k: "playing guy", i: "", b: 11 },
  nobye: { n: "No Bye Data", p: "WR", t: "CCC", k: "no bye data", i: "", b: null },
};
const byeRanks = { onbye: { posRank: 1, pts: 20 }, playing: { posRank: 40, pts: 6 },
                   nobye: { posRank: 50, pts: 4 } };
const wk7 = app.buildRoster(["onbye", "playing", "nobye"], byePlayers, byeRanks, 7);
check("player on bye flagged", wk7[0].onBye, true);
check("player not on bye clear", wk7[1].onBye, false);
check("missing bye data is not a bye", wk7[2].onBye, false);
check("bye counts as unavailable", app.unavailable(wk7[0]), true);
check("bye reason reported", app.benchReason(wk7[0]), "BYE");

const wk11 = app.buildRoster(["onbye", "playing"], byePlayers, byeRanks, 11);
check("bye is week-specific", [wk11[0].onBye, wk11[1].onBye], [false, true]);
check("no week given means no bye flag",
      app.buildRoster(["onbye"], byePlayers, byeRanks, undefined)[0].onBye, false);
check("string bye week still matches",
      app.buildRoster(["s"], { s: { n: "S", p: "WR", k: "s", i: "", b: "7" } }, {}, 7)[0].onBye,
      true);

// the whole point: a WR1 on bye must not be started over a healthy WR40
const byeLu = app.pickLineup(wk7, ["WR"]);
check("top-ranked player on bye is benched",
      byeLu.starters[0].player.n, "Playing Guy");
check("bye player loses a flex slot too",
      app.pickLineup(wk7, ["FLEX"]).starters[0].player.n, "Playing Guy");

/* injury reason still reported when there is no bye */
check("injury reason reported",
      app.benchReason({ status: "OUT", onBye: false }), "OUT");
check("healthy player has no reason",
      app.benchReason({ status: "", onBye: false }), "");
check("bye takes precedence over a status",
      app.benchReason({ status: "Q", onBye: true }), "BYE");

/* --- lineup ------------------------------------------------------------ */
const P = (n, p, posRank, pts, status = "") => ({ n, p, posRank, pts, status, t: "XXX" });
const names = (lu) => Object.fromEntries(lu.starters.map((s) => [s.slot, s.player.n]));

const full = [
  P("QB1", "QB", 1, 22), P("QB2", "QB", 20, 14),
  P("RB1", "RB", 2, 18), P("RB2", "RB", 9, 14), P("RB3", "RB", 30, 7),
  P("WR1", "WR", 1, 20), P("WR2", "WR", 12, 13), P("WR3", "WR", 25, 10),
  P("TE1", "TE", 4, 11), P("K1", "K", 5, 8), P("DST1", "DEF", 6, 7),
];
const lu = app.pickLineup(full, ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DEF"]);
check("starter count", lu.starters.length, 9);
check("best QB starts", names(lu).QB, "QB1");
check("flex takes highest projected points", names(lu).FLEX, "WR3");
check("bench is the remainder", lu.bench.map((p) => p.n).sort(), ["QB2", "RB3"]);

const sf = app.pickLineup(full, ["QB", "SUPER_FLEX", "RB", "WR"]);
check("superflex starts a QB", names(sf).SUPER_FLEX, "QB2");

const noQb = app.pickLineup([P("Only QB", "QB", 3, 20), P("WR A", "WR", 4, 15)],
                            ["QB", "SUPER_FLEX"]);
check("superflex without a spare QB uses a flex body", names(noQb).SUPER_FLEX, "WR A");

check("OUT player benched",
      names(app.pickLineup([P("Hurt", "RB", 1, 20, "OUT"), P("Fit", "RB", 15, 9)], ["RB"])).RB,
      "Fit");
check("doubtful benched",
      names(app.pickLineup([P("Doubt", "RB", 1, 20, "D"), P("Fit", "RB", 15, 9)], ["RB"])).RB,
      "Fit");
check("questionable still starts",
      names(app.pickLineup([P("Ques", "RB", 1, 20, "Q"), P("Fit", "RB", 15, 9)], ["RB"])).RB,
      "Ques");
check("OUT flex player benched too",
      names(app.pickLineup([P("Hurt", "WR", 1, 30, "OUT"), P("Fit", "RB", 20, 8)], ["FLEX"])).FLEX,
      "Fit");

const lone = app.pickLineup([P("Only TE", "TE", 30, 6), P("Good RB", "RB", 5, 16)],
                            ["TE", "FLEX"]);
check("lone TE keeps the TE slot", names(lone).TE, "Only TE");
check("flex takes the RB", names(lone).FLEX, "Good RB");

check("unprojected loses to projected",
      names(app.pickLineup([P("None", "WR", null, null), P("Some", "WR", 50, 4)], ["WR"])).WR,
      "Some");
check("empty roster", app.pickLineup([], ["QB"]).starters.length, 0);
check("more slots than players", app.pickLineup([P("A", "QB", 1, 20)], ["QB", "RB"]).starters.length, 1);

/* --- injury normalization ---------------------------------------------- */
check("Questionable -> Q", app.normStatus("Questionable"), "Q");
check("Doubtful -> D", app.normStatus("Doubtful"), "D");
check("Out -> OUT", app.normStatus("Out"), "OUT");
check("empty stays empty", app.normStatus(""), "");
check("null safe", app.normStatus(null), "");
check("doubtful counts as out", app.OUT_STATUSES.has(app.normStatus("Doubtful")), true);
check("questionable does not", app.OUT_STATUSES.has(app.normStatus("Questionable")), false);

/* --- currentLineup: zipping Sleeper's starters onto our slot list ------ */
const clRoster = [
  { id: "1", n: "QB A", p: "QB", t: "BUF", pts: 20 },
  { id: "2", n: "RB A", p: "RB", t: "ATL", pts: 15 },
  { id: "3", n: "WR A", p: "WR", t: "KC", pts: 12 },
];
check("zips starters with slots in order",
      app.currentLineup(["1", "2", "3"], ["QB", "RB", "WR"], clRoster).map((e) => e.player.n),
      ["QB A", "RB A", "WR A"]);
check("\"0\" becomes an empty slot",
      app.currentLineup(["1", "0", "3"], ["QB", "RB", "WR"], clRoster).map((e) => e.player && e.player.n),
      ["QB A", null, "WR A"]);
check("a missing starter id is also empty",
      app.currentLineup(["1"], ["QB", "RB"], clRoster).map((e) => e.player && e.player.n),
      ["QB A", null]);
check("an unknown starter id is empty rather than throwing",
      app.currentLineup(["999"], ["QB"], clRoster)[0].player, null);
check("works with a superflex slot",
      app.currentLineup(["1"], ["SUPER_FLEX"], clRoster)[0].player.n, "QB A");
// A dynasty league's roster_positions include IR/TAXI, but by the time
// currentLineup sees `slots` those are already filtered out (app.js does
// that once, the same way for both this and matchup.starters), so the two
// arrays stay in lockstep even with a longer, odder slot list.
const dynastySlots = ["QB", "RB", "WR", "TE", "FLEX", "DEF"];
const dynastyStarters = ["1", "2", "3", "0", "0", "0"];
check("stays aligned with a longer dynasty slot list",
      app.currentLineup(dynastyStarters, dynastySlots, clRoster).map((e) => e.slot),
      dynastySlots);
check("trailing empty slots line up correctly",
      app.currentLineup(dynastyStarters, dynastySlots, clRoster).map((e) => e.player && e.player.n),
      ["QB A", "RB A", "WR A", null, null, null]);

/* --- lockedIds: whose game has already started -------------------------- */
const schedRoster = [
  { id: "1", n: "P1", t: "BUF" }, { id: "2", n: "P2", t: "KC" },
  { id: "3", n: "P3", t: "ATL" }, { id: "d", n: "Niners D", p: "DEF", t: "SF" },
];
const schedule = [
  { week: 5, home: "BUF", away: "KC", status: "in_game" },
  { week: 5, home: "ATL", away: "NYG", status: "pre_game" },
  { week: 6, home: "SF", away: "LAR", status: "complete" },
];
check("locks both teams of an in-progress game",
      Array.from(app.lockedIds(schedRoster, schedule, 5)).sort(), ["1", "2"]);
check("leaves a pre-game matchup unlocked",
      app.lockedIds(schedRoster, schedule, 5).has("3"), false);
check("DEF locks by its own team code",
      app.lockedIds(schedRoster, schedule, 6).has("d"), true);
check("no schedule means nothing is locked", app.lockedIds(schedRoster, null, 5).size, 0);

/* --- pickLineup with a fixed (locked) slot ------------------------------ */
const lockedWeak = P("Locked but weak", "RB", 20, 3);
const strongerRB = P("Stronger RB", "RB", 2, 18);
const fixedLu = app.pickLineup([lockedWeak, strongerRB], ["RB", "FLEX"], { 0: lockedWeak });
check("a fixed slot keeps the locked player in place",
      fixedLu.starters.find((s) => s.slot === "RB").player.n, "Locked but weak");
check("the locked player is removed from the pool for the rest of the picks",
      fixedLu.starters.find((s) => s.slot === "FLEX").player.n, "Stronger RB");
check("a player simply left out of the roster is never picked",
      app.pickLineup([strongerRB], ["RB", "FLEX"]).starters.length, 1);
check("calling with no fixed argument still behaves exactly as before",
      JSON.stringify(app.pickLineup(full, ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DEF"]).starters),
      JSON.stringify(lu.starters));

/* --- lineupCheck: comparing Sleeper's lineup with the best one --------- */
const PL = (id, n, p, pts, status = "") => ({ id, n, p, pts, status, t: "XXX" });
const qbGood = PL("q1", "QB Good", "QB", 22);
const rbA = PL("r1", "RB A", "RB", 15);
const rbB = PL("r2", "RB B", "RB", 12);
const wrFlex = PL("w1", "WR Flex", "WR", 14);

const reordered = [{ slot: "RB", player: rbA }, { slot: "FLEX", player: rbB }];
const reorderedBest = [{ slot: "RB", player: rbB }, { slot: "FLEX", player: rbA }];
const rSame = app.lineupCheck(reordered, reorderedBest);
check("same set in a different flex order is ok", rSame.ok, true);
check("no changes needed when the set already matches", rSame.changes, []);
check("no point gain when the set already matches", rSame.gain, 0);

const swapCur = [{ slot: "RB", player: rbA }, { slot: "FLEX", player: rbB }];
const swapBest = [{ slot: "RB", player: rbA }, { slot: "FLEX", player: wrFlex }];
const rSwap = app.lineupCheck(swapCur, swapBest);
check("a genuine swap is not ok", rSwap.ok, false);
check("a genuine swap is reported as one change", rSwap.changes.length, 1);
check("the change names who's out and in",
      [rSwap.changes[0].out.n, rSwap.changes[0].in.n], ["RB B", "WR Flex"]);
check("gain is the point difference of the swap", rSwap.gain, 14 - 12);

const emptyCur = [{ slot: "RB", player: null }, { slot: "FLEX", player: rbB }];
const emptyBest = [{ slot: "RB", player: rbA }, { slot: "FLEX", player: rbB }];
const rEmpty = app.lineupCheck(emptyCur, emptyBest);
check("an empty current slot is reported", rEmpty.empty, ["RB"]);

const outStarter = PL("o1", "Hurt Starter", "RB", 20, "OUT");
const outCur = [{ slot: "RB", player: outStarter }];
const rOut = app.lineupCheck(outCur, outCur);
check("an OUT starter is flagged even when the set already matches",
      rOut.unavailable.map((p) => p.n), ["Hurt Starter"]);

/* --- waiverUpgrades: free agents who'd beat your weakest starter -------- */
const wBest = { starters: [
  { slot: "RB", player: PL("o1", "Owned RB", "RB", 8) },
  { slot: "WR", player: PL("o2", "Owned WR", "WR", 15) },
  { slot: "FLEX", player: PL("o3", "Owned Flex TE", "TE", 10) },
] };
const wRostered = new Set(["o1", "o2", "o3"]);

const faRB = PL("fa1", "FA RB", "RB", 12);          // beats RB slot's 8, not FLEX's 10
const faWR = PL("fa2", "FA WR", "WR", 11);           // loses to WR slot's 15, beats FLEX's 10
const faWRlow = PL("fa3", "FA WR low", "WR", 9);     // loses to both eligible slots
const faTElow = PL("fa4", "FA TE low", "TE", 9);     // only eligible for FLEX (10); loses
const faTEhigh = PL("fa5", "FA TE high", "TE", 13);  // only eligible for FLEX (10); beats it
const faOut = PL("fa6", "FA Hurt RB", "RB", 99, "OUT");
const faNoPts = { ...PL("fa7", "FA No Projection", "RB", null) };
const faRosteredDup = PL("o1", "Somehow Also FA", "RB", 99);   // same id as a starter - excluded

const pool = [faRB, faWR, faWRlow, faTElow, faTEhigh, faOut, faNoPts, faRosteredDup];
const up = app.waiverUpgrades(pool, wRostered, wBest);
const byName = Object.fromEntries(up.map((w) => [w.n, w]));

check("a free agent beating the weakest eligible starter is suggested", "FA RB" in byName, true);
check("gain is measured against the weakest eligible slot, not any slot",
      byName["FA RB"].gain, 12 - 8);
check("the weakest starter is attached for display", byName["FA RB"].weakest.n, "Owned RB");
check("cross-position eligibility uses the weakest of all slots that fit",
      byName["FA WR"].gain, 11 - 10);
check("a free agent that loses at every eligible slot is left out", "FA WR low" in byName, false);
check("no eligible slot at all (no bare TE slot here) means no suggestion",
      "FA TE low" in byName, false);
check("a free agent with no eligible slot is never force-matched to one",
      "FA TE high" in byName, true);
check("an OUT free agent is never suggested regardless of gain", "FA Hurt RB" in byName, false);
check("a free agent with no projection is never suggested", "FA No Projection" in byName, false);
check("a rostered player id is excluded even with a different name", "Somehow Also FA" in byName, false);

const manyFAs = [];
for (let i = 0; i < 8; i++) manyFAs.push(PL(`m${i}`, `Many ${i}`, "RB", 8 + i));
check("only the top 5 by gain are kept", app.waiverUpgrades(manyFAs, wRostered, wBest).length, 5);
check("kept ones are sorted by descending gain",
      app.waiverUpgrades(manyFAs, wRostered, wBest).map((w) => w.n),
      ["Many 7", "Many 6", "Many 5", "Many 4", "Many 3"]);

check("no eligible starters at all means nothing is suggested",
      app.waiverUpgrades([faRB], wRostered, { starters: [] }), []);

/* --- matchup: projectedTotal, winProb (Phase 4) ------------------------ */
const mtPlayerA = PL("mtA", "Player A", "RB", 12.5);
const mtPlayerB = PL("mtB", "Player B", "WR", 7.5);
check("projectedTotal sums player.pts across slots",
      app.projectedTotal([{ slot: "RB", player: mtPlayerA }, { slot: "WR", player: mtPlayerB }]),
      20);
check("an empty slot counts 0",
      app.projectedTotal([{ slot: "RB", player: mtPlayerA }, { slot: "WR", player: null }]),
      12.5);
check("a player with no projection counts 0",
      app.projectedTotal([{ slot: "RB", player: PL("mtC", "No Proj", "RB", null) }]),
      0);
check("an empty lineup totals 0", app.projectedTotal([]), 0);

// Rounded: the A&S 7.1.26 erf approximation isn't exact at x=0 (its
// coefficients are tuned to minimize max error over the whole domain, not
// to zero out at any one point), so this lands a few billionths off 0.5.
const round6 = (x) => Math.round(x * 1e6) / 1e6;
check("equal projections are a coin flip", round6(app.winProb(100, 100)), 0.5);
check("both teams at 0 is still a coin flip", round6(app.winProb(0, 0)), 0.5);
check("a bigger lead means a higher win chance",
      app.winProb(130, 100) > app.winProb(110, 100), true);
check("trailing means below even odds", app.winProb(90, 110) < 0.5, true);
{
  const sum = app.winProb(118.4, 104.2) + app.winProb(104.2, 118.4);
  check("winProb(a,b) + winProb(b,a) is ~1", Math.round(sum * 1000) / 1000, 1);
}
check("win probability is bounded above by 1", app.winProb(500, 0) <= 1, true);
check("win probability is bounded below by 0", app.winProb(0, 500) >= 0, true);

/* --- coming up: byeWeeks, upcomingHoles (Phase 5) ----------------------- */
{
  // 4 teams, 5 scheduled weeks; T3 and T4 share a bye in week 7 (only one
  // game that week, T1 @ T2), everyone else plays every week.
  const schedule = [
    { week: 5, home: "T1", away: "T2" }, { week: 5, home: "T3", away: "T4" },
    { week: 6, home: "T1", away: "T3" }, { week: 6, home: "T2", away: "T4" },
    { week: 7, home: "T1", away: "T2" },
    { week: 8, home: "T1", away: "T4" }, { week: 8, home: "T2", away: "T3" },
    { week: 9, home: "T1", away: "T3" }, { week: 9, home: "T2", away: "T4" },
  ];
  const byes = app.byeWeeks(schedule);
  check("a team missing from a week it should've played is on bye that week",
        Array.from(byes.T3 || []).sort(), [7]);
  check("both teams sharing a bye week are flagged", Array.from(byes.T4 || []).sort(), [7]);
  check("a team playing every scheduled week has no byes", Array.from(byes.T1 || []).sort(), []);
  check("an empty schedule returns no byes at all", app.byeWeeks([]), {});
  check("a missing schedule returns no byes at all", app.byeWeeks(null), {});
}
{
  const roster = [
    { id: "q1", n: "QB1", p: "QB", t: "T1", status: "", pts: 20, posRank: 1 },
    { id: "r1", n: "RB1", p: "RB", t: "T1", status: "", pts: 15, posRank: 1 },
    { id: "w1", n: "WR1", p: "WR", t: "T1", status: "", pts: 12, posRank: 1 },
    { id: "t1", n: "TE1", p: "TE", t: "T4", status: "", pts: 8, posRank: 1 },
  ];
  const slots = ["QB", "RB", "WR", "TE"];
  const holes = app.upcomingHoles(roster, slots, 5, { T4: new Set([7]) }, 4);
  check("only the TE's bye week is reported when nothing else is wrong",
        holes.map((h) => h.week), [7]);
  check("the empty TE slot is named as the hole", holes[0].holes, ["TE"]);
  check("the bye'd starter is listed", holes[0].byes.map((p) => p.id), ["t1"]);
}
{
  // The only RB is on IR, with no bench RB - a real hole in every future
  // week, but only if the IR player is actually excluded rather than
  // force-started the way pickLineup would for *this* week.
  const roster = [
    { id: "q1", n: "QB1", p: "QB", t: "T1", status: "", pts: 20, posRank: 1 },
    { id: "r1", n: "RB1", p: "RB", t: "T1", status: "IR", pts: 15, posRank: 1 },
  ];
  const holes = app.upcomingHoles(roster, ["QB", "RB"], 5, {}, 2);
  check("an IR player is never counted as available in a future week",
        holes.map((h) => h.week), [6, 7]);
  check("the RB slot is a hole every week since the only RB is on IR",
        holes.every((h) => h.holes.includes("RB")), true);
}
{
  // The only RB is merely Questionable - a this-week-only call that says
  // nothing about 2 weeks from now, so it shouldn't disqualify them.
  const roster = [
    { id: "q1", n: "QB1", p: "QB", t: "T1", status: "", pts: 20, posRank: 1 },
    { id: "r1", n: "RB1", p: "RB", t: "T1", status: "Q", pts: 15, posRank: 1 },
  ];
  check("a questionable player still counts as available weeks out",
        app.upcomingHoles(roster, ["QB", "RB"], 5, {}, 2), []);
}
{
  // Both starters share a team and a bye week, but each has a backup on a
  // different team - no hole, yet still worth a heads up since half the
  // lineup turns over the same week.
  const roster = [
    { id: "q1", n: "QB1", p: "QB", t: "T1", status: "", pts: 20, posRank: 1 },
    { id: "q2", n: "QB2", p: "QB", t: "T2", status: "", pts: 10, posRank: 2 },
    { id: "r1", n: "RB1", p: "RB", t: "T1", status: "", pts: 15, posRank: 1 },
    { id: "r2", n: "RB2", p: "RB", t: "T3", status: "", pts: 9, posRank: 2 },
  ];
  const holes = app.upcomingHoles(roster, ["QB", "RB"], 5, { T1: new Set([9]) }, 4);
  check("2+ starters on bye is reported even with no hole",
        holes.map((h) => h.week), [9]);
  check("no hole, since the backups fill every slot", holes[0].holes, []);
  check("both bye'd starters are listed", holes[0].byes.map((p) => p.id).sort(), ["q1", "r1"]);
}
{
  const holes = app.upcomingHoles([], ["QB"], 1, {});
  check("default horizon (4) covers week+1..week+4", holes.map((h) => h.week), [2, 3, 4, 5]);
  check("an empty roster is a hole every one of those weeks",
        holes.every((h) => h.holes.includes("QB")), true);
}
{
  // No schedule reached at all (byes = {}) - falls back to the player
  // dump's own `b` field instead of silently reporting no upcoming byes.
  const roster = [
    { id: "q1", n: "QB1", p: "QB", t: "T1", status: "", pts: 20, posRank: 1, b: 8 },
  ];
  const holes = app.upcomingHoles(roster, ["QB"], 5, {}, 4);
  check("falls back to the player's own bye-week field when byes is empty",
        holes.map((h) => h.week), [8]);
  check("that week's QB slot is a hole via the b-field fallback",
        holes[0].holes, ["QB"]);
}
{
  // The schedule has an entry for this player's team (byes.T1 exists, even
  // though it's empty - the team simply has no upcoming bye per the live
  // schedule) while their stale `b` field still claims one. The schedule
  // must win: it's the whole reason byeWeeks() exists over trusting `b`.
  const roster = [
    { id: "q1", n: "QB1", p: "QB", t: "T1", status: "", pts: 20, posRank: 1, b: 8 },
  ];
  check("a live schedule saying a team plays overrides a stale b-field bye",
        app.upcomingHoles(roster, ["QB"], 5, { T1: new Set() }, 4), []);
}
check("a week with neither a hole nor 2+ byes is left out entirely",
      app.upcomingHoles(
        [{ id: "q1", n: "QB1", p: "QB", t: "T1", status: "", pts: 20, posRank: 1 }],
        ["QB"], 5, {}, 1),
      []);

/* --- recap: did the rankings help for a week that's over (Phase 7) ------ */
{
  const players = {
    q1: { n: "QB1", p: "QB", t: "AAA", i: "" },
    r1: { n: "RB1 projected RB1", p: "RB", t: "AAA", i: "" },
    r2: { n: "RB2 projected RB2, actually way better", p: "RB", t: "AAA", i: "" },
    w1: { n: "WR1 projected WR1", p: "WR", t: "AAA", i: "" },
    w2: { n: "WR2 projected WR2, actually better", p: "WR", t: "AAA", i: "" },
  };
  const projRanks = {
    q1: { posRank: 1, pts: 20 },
    r1: { posRank: 1, pts: 15 },
    r2: { posRank: 2, pts: 8 },
    w1: { posRank: 1, pts: 12 },
    w2: { posRank: 2, pts: 9 },
  };
  const slots = ["QB", "RB", "WR", "FLEX"];
  const entry = {
    points: 50,
    players: ["q1", "r1", "r2", "w1", "w2"],
    starters: ["q1", "r1", "w1", "w2"],   // what was literally set - recap() ignores this
    players_points: { q1: 18, r1: 5, r2: 22, w1: 10, w2: 14 },
  };
  const result = app.recap(entry, slots, players, projRanks);
  check("actual is the matchup entry's own points, untouched",
        result.actual, 50);
  check("ours: following that week's projected ranking (which liked the wrong RB/WR)",
        result.ours, 18 + 5 + 10 + 14);   // q1 + r1 + w1 + w2, per projected posRank
  check("best: perfect hindsight re-ranks each position by what actually happened",
        result.best, 18 + 22 + 14 + 10);  // q1 + r2 + w2 + w1
  check("best is never less than ours (hindsight can't do worse)",
        result.best >= result.ours, true);
}
check("a missing players_points entry counts as 0, not a crash",
      app.recap(
        { points: 10, players: ["x1"], players_points: {} },
        ["QB"],
        { x1: { n: "X", p: "QB", t: "AAA", i: "" } },
        { x1: { posRank: 1, pts: 20 } }),
      { actual: 10, ours: 0, best: 0 });
check("an empty roster recaps to all zeros but the actual score, not a crash",
      app.recap({ points: 30, players: [], players_points: {} }, ["QB"], {}, {}),
      { actual: 30, ours: 0, best: 0 });
check("a null entry is handled the same as an empty one",
      app.recap(null, ["QB"], {}, {}), { actual: 0, ours: 0, best: 0 });

/* --- dropCandidate: who to cut for a waiver add (Phase 8) --------------- */
{
  const starterQB = PL("s1", "Starter QB", "QB", 20);
  const best = { starters: [{ slot: "QB", player: starterQB }] };
  const bench1 = PL("b1", "Bench high", "RB", 9);
  const bench2 = PL("b2", "Bench low", "RB", 3);
  const roster = [starterQB, bench1, bench2];
  check("picks the lowest-pts bench player, not a starter",
        app.dropCandidate(roster, best, new Set()).id, "b2");
}
{
  const starterQB = PL("s1", "Starter QB", "QB", 20);
  const best = { starters: [{ slot: "QB", player: starterQB }] };
  const irPlayer = PL("ir1", "Stashed on IR", "RB", 0);
  const bench = PL("b1", "Bench", "RB", 5);
  const roster = [starterQB, irPlayer, bench];
  check("a reserved (IR/taxi) player is never suggested as the drop, even with the lowest pts",
        app.dropCandidate(roster, best, new Set(["ir1"])).id, "b1");
}
{
  const starterQB = PL("s1", "Starter QB", "QB", 20);
  const best = { starters: [{ slot: "QB", player: starterQB }] };
  const ranked = PL("r1", "Ranked bench", "RB", 4);
  const unranked = PL("u1", "Unranked bench", "RB", null);
  const roster = [starterQB, ranked, unranked];
  check("an unranked (no projection) bench player is preferred as the drop over a ranked one",
        app.dropCandidate(roster, best, new Set()).id, "u1");
}
check("nothing to drop when every roster player is starting",
      app.dropCandidate([PL("s1", "S", "QB", 20)], { starters: [{ slot: "QB", player: PL("s1", "S", "QB", 20) }] }, new Set()),
      null);
check("nothing to drop from an empty roster",
      app.dropCandidate([], { starters: [] }, new Set()), null);
check("a missing reserveIds set doesn't throw - treated as nothing reserved",
      app.dropCandidate([PL("b1", "B", "RB", 5)], { starters: [] }, undefined).id, "b1");

/* --- powerRanks: league strength by projected starters (Phase 9) ------- */
{
  const prPlayers = {
    a_qb: { n: "A QB", p: "QB", t: "X", i: "" },
    a_rb: { n: "A RB", p: "RB", t: "X", i: "" },
    b_qb: { n: "B QB", p: "QB", t: "Y", i: "" },
    b_rb: { n: "B RB", p: "RB", t: "Y", i: "" },
  };
  const prRanks = {
    a_qb: { posRank: 1, pts: 25 }, a_rb: { posRank: 1, pts: 15 },
    b_qb: { posRank: 2, pts: 10 }, b_rb: { posRank: 2, pts: 5 },
  };
  const slots = ["QB", "RB"];
  // Team A projects much stronger but has the worse record - power
  // rankings should still put them first, since it's ranked by strength
  // right now, not by what already happened.
  const rosters = [
    { roster_id: 1, players: ["a_qb", "a_rb"],
      settings: { wins: 2, losses: 5, ties: 0, fpts: 400, fpts_decimal: 50 } },
    { roster_id: 2, players: ["b_qb", "b_rb"],
      settings: { wins: 6, losses: 1, ties: 0, fpts: 300, fpts_decimal: 25 } },
  ];
  const ranked = app.powerRanks(rosters, prPlayers, prRanks, 5, slots);
  check("ranked by projected total, not record - the weaker-record team leads",
        ranked.map((r) => r.rosterId), [1, 2]);
  check("projected total sums the best lineup's starters", ranked[0].proj, 40);
  check("record comes through even though it's not the sort key",
        [ranked[1].wins, ranked[1].losses], [6, 1]);
  check("points-for combines fpts and fpts_decimal/100", ranked[0].pf, 400.5);
}
check("missing settings on a roster default every field to 0, not a crash",
      app.powerRanks(
        [{ roster_id: 9, players: [] }], {}, {}, 5, ["QB"])[0],
      { rosterId: 9, proj: 0, wins: 0, losses: 0, ties: 0, pf: 0 });
check("an empty rosters list is simply an empty ranking", app.powerRanks([], {}, {}, 5, ["QB"]), []);

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
