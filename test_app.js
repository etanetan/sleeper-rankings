/* Offline tests for the client-side scoring, ranking and lineup logic. */
const app = require("./app.js");
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

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
