/* Offline tests for the client-side ranking and lineup logic. */
const app = require("./public/app.js");
const results = [];

function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}` +
    (ok ? "" : `\n        got ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`));
  results.push(ok);
}

/* --- scoring detection ------------------------------------------------ */
check("full ppr", app.scoringFormat({ scoring_settings: { rec: 1 } }), "ppr");
check("half ppr", app.scoringFormat({ scoring_settings: { rec: 0.5 } }), "half");
check("standard", app.scoringFormat({ scoring_settings: { rec: 0 } }), "std");
check("missing rec key", app.scoringFormat({ scoring_settings: {} }), "std");
check("no settings at all", app.scoringFormat({}), "std");
check("odd ppr value rounds to half", app.scoringFormat({ scoring_settings: { rec: 0.6 } }), "half");

/* --- lineup ----------------------------------------------------------- */
const P = (n, p, posRank, flexRank = null, status = "") =>
  ({ n, p, posRank, flexRank, status, t: "XXX" });

const names = (lu) => Object.fromEntries(lu.starters.map((s) => [s.slot, s.player.n]));

const roster = [
  P("Elite QB", "QB", 1), P("QB2", "QB", 20),
  P("RB1", "RB", 2, 3), P("RB2", "RB", 9, 14), P("RB3", "RB", 30, 60),
  P("WR1", "WR", 1, 1), P("WR2", "WR", 12, 18), P("WR3", "WR", 25, 40),
  P("TE1", "TE", 4, 22), P("K1", "K", 5), P("DST1", "DEF", 6),
];
const slots = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DEF"];
const lu = app.pickLineup(roster, slots);
check("starter count", lu.starters.length, 9);
check("best QB starts", names(lu).QB, "Elite QB");
check("flex takes best flex rank", names(lu).FLEX, "WR3");
check("bench is the remainder", lu.bench.map((p) => p.n).sort(), ["QB2", "RB3"]);

/* superflex: a QB gets the slot whenever one is available */
const sf = app.pickLineup(roster, ["QB", "SUPER_FLEX", "RB", "WR"]);
check("superflex starts the second QB", names(sf).SUPER_FLEX, "QB2");
check("superflex leaves QB1 in the QB slot", names(sf).QB, "Elite QB");

/* superflex with no spare QB falls back to a flex body */
const noQb = app.pickLineup(
  [P("Only QB", "QB", 3), P("RB A", "RB", 5, 7), P("WR A", "WR", 4, 5)],
  ["QB", "SUPER_FLEX"]);
check("superflex without a spare QB uses best flex", names(noQb).SUPER_FLEX, "WR A");

/* injuries */
const hurt = app.pickLineup(
  [P("Hurt Stud", "RB", 1, 1, "OUT"), P("Healthy", "RB", 15, 25)], ["RB"]);
check("OUT player benched", names(hurt).RB, "Healthy");
const ques = app.pickLineup(
  [P("Questionable Stud", "RB", 1, 1, "Q"), P("Healthy", "RB", 15, 25)], ["RB"]);
check("questionable player still starts", names(ques).RB, "Questionable Stud");
const doubt = app.pickLineup(
  [P("Doubtful Stud", "RB", 1, 1, "D"), P("Healthy", "RB", 15, 25)], ["RB"]);
check("doubtful player benched", names(doubt).RB, "Healthy");

/* --- injury status normalization ------------------------------------- */
check("Questionable -> Q", app.normStatus("Questionable"), "Q");
check("Doubtful -> D", app.normStatus("Doubtful"), "D");
check("Out -> OUT", app.normStatus("Out"), "OUT");
check("IR stays IR", app.normStatus("IR"), "IR");
check("Sus -> SUS", app.normStatus("Sus"), "SUS");
check("empty stays empty", app.normStatus(""), "");
check("null safe", app.normStatus(null), "");
check("unknown truncated", app.normStatus("Whatever"), "WHA");
check("Doubtful counts as out", app.OUT_STATUSES.has(app.normStatus("Doubtful")), true);
check("Questionable does not", app.OUT_STATUSES.has(app.normStatus("Questionable")), false);

/* restrictive slots fill first so a lone eligible player isn't stolen */
const lone = app.pickLineup(
  [P("Only TE", "TE", 30, 55), P("Good RB", "RB", 5, 6)], ["TE", "FLEX"]);
check("lone TE keeps the TE slot", names(lone).TE, "Only TE");
check("flex takes the RB", names(lone).FLEX, "Good RB");

/* unranked players sink below ranked ones */
const unranked = app.pickLineup([P("Unranked", "WR", null), P("Ranked", "WR", 50, 80)], ["WR"]);
check("ranked beats unranked", names(unranked).WR, "Ranked");

/* empty roster doesn't explode */
check("empty roster", app.pickLineup([], ["QB", "RB"]).starters.length, 0);
check("more slots than players", app.pickLineup([P("A", "QB", 1)], ["QB", "RB", "WR"]).starters.length, 1);

/* --- joining rosters to rankings -------------------------------------- */
const data = {
  players: {
    "1": { n: "Josh Allen", p: "QB", t: "BUF", k: "josh allen", i: "" },
    "2": { n: "Bijan Robinson", p: "RB", t: "ATL", k: "bijan robinson", i: "" },
    "JAX": { n: "Jacksonville Jaguars", p: "DEF", t: "JAX", k: "JAX", i: "" },
    "9": { n: "Nobody", p: "WR", t: "FA", k: "nobody", i: "" },
  },
  rankings: {
    shared: {
      QB: { "josh allen": { rank: 1, posRank: 1, opp: "vs NYJ" } },
      K: {},
      DST: { JAC: { rank: 7, posRank: 7, opp: "at HOU" } },
    },
    formats: {
      half: {
        RB: { "bijan robinson": { rank: 2, posRank: 2, opp: "at CAR" } },
        FLEX: { "bijan robinson": { rank: 3, posRank: 3, opp: "at CAR" } },
        WR: {}, TE: {},
      },
    },
  },
};
const built = app.buildRoster(["1", "2", "JAX", "9"], data, "half");
check("joins QB rank", built[0].posRank, 1);
check("joins QB opponent", built[0].opp, "vs NYJ");
check("joins format-specific RB rank", built[1].posRank, 2);
check("joins flex rank separately", built[1].flexRank, 3);
check("DEF matches through team alias JAX->JAC", built[2].posRank, 7);
check("unmatched player is unranked, not dropped", built[3].posRank, null);
check("roster keeps every player", built.length, 4);
check("unknown id skipped", app.buildRoster(["nope"], data, "half").length, 0);

data.players["8"] = { n: "Hurt Guy", p: "WR", t: "KC", k: "hurt guy", i: "Questionable" };
check("buildRoster normalizes injury text", app.buildRoster(["8"], data, "half")[0].status, "Q");

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
