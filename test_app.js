/* Offline tests for the client-side scoring, ranking and lineup logic. */
const app = require("./public/app.js");
const results = [];

function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}` +
    (ok ? "" : `\n        got ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`));
  results.push(ok);
}

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

/* --- roster assembly --------------------------------------------------- */
players.e = { n: "Hurt Guy", p: "WR", t: "EEE", i: "Questionable" };
const roster = app.buildRoster(["a", "b", "e", "nope"], players, pprRanks);
check("roster keeps known players", roster.length, 3);
check("rank attached", roster[0].posRank, 1);
check("injury normalized", roster[2].status, "Q");
check("unprojected player kept but unranked", roster[2].posRank, null);

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
