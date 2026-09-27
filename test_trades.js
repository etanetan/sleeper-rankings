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
check("never more than two per partner",
  Object.values(work.candidates.reduce((a, x) => (a[x.partner.roster_id] = (a[x.partner.roster_id] || 0) + 1, a), {}))
    .every((n) => n <= 2), true);
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

/* --- finalize: the research has to clear the numbers ------------------- */
const cid = work.candidates[0].id;
const good = {
  trades: [{
    candidate: cid, headline: "Turn WR depth into a starting RB", confidence: "high",
    summary: "Short version.",
    why: { give: ["Fourth WR rarely starts."], get: ["Bell-cow role."],
           you: ["RB2 goes from a 900 to a starter."], them: ["They start one real WR."] },
    risks: ["RB injury rates."],
    sources: [{ title: "News", url: "https://example.com/a" }],
  }],
};
const ok = T.finalize(work, good, new Date("2026-09-29T13:00:00Z"));
check("valid research passes", ok.errors, []);
check("numbers come from the candidates, not the research",
  ok.data.trades[0].value.giveAdj, work.candidates[0].value.giveAdj);
check("status ready", ok.data.status, "ready");
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
const fxFile = path.join(tmp, "fixtures.json");
fs.writeFileSync(fxFile, JSON.stringify(fixtures));
const env = { ...process.env, TRADES_FIXTURES: fxFile };
const run = (...a) => execFileSync(process.execPath, ["trades/engine.js", ...a],
  { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const out = JSON.parse(run("candidates", "--user", "etanetan", "--out", path.join(tmp, "work")));
check("cli: week read from Sleeper", out.week, 4);
check("cli: closed league skipped with reason", out.leagues.find((l) => l.league_id === "L2").open, false);
check("cli: open league has candidates", out.leagues.find((l) => l.league_id === "L1").candidates > 0, true);
const cliWork = JSON.parse(fs.readFileSync(path.join(tmp, "work", "L1.json"), "utf8"));
check("cli: partner named from team_name or display name",
  cliWork.candidates.every((x) => ["bee", "sea"].includes(x.partner.name)), true);
check("cli: records carried", cliWork.me.record, "2-1");

const dataDir = path.join(tmp, "data");
run("running", "--league", "L1", "--data", dataDir);
check("cli: running status", JSON.parse(fs.readFileSync(path.join(dataDir, "L1.json"))).status, "running");
const rFile = path.join(tmp, "research.json");
fs.writeFileSync(rFile, JSON.stringify({ trades: [{ ...good.trades[0], candidate: cliWork.candidates[0].id }] }));
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
