/* Offline tests for the trade research lifecycle: the Trades tab view, the
 * running/failed transforms, and the "why fewer than five" reason. */
const R = require("./research.js");
const results = [];

function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}` +
    (ok ? "" : `\n        got ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`));
  results.push(ok);
}

const now = new Date("2026-09-30T12:00:00Z").getTime();
const hoursAgo = (h) => new Date(now - h * 3600e3).toISOString();

/* --- reasonFor ---------------------------------------------------------- */
check("no research, no reason", R.reasonFor(null, 0), null);
check("short_reason at zero trades", R.reasonFor({ short_reason: "Nothing fair this week." }, 0),
  "Nothing fair this week.");
check("none_reason accepted as an alias", R.reasonFor({ none_reason: "Old-file spelling." }, 0),
  "Old-file spelling.");
check("short_reason wins over none_reason", R.reasonFor({ short_reason: "New.", none_reason: "Old." }, 2), "New.");
check("no reason given, none published", R.reasonFor({ trades: [] }, 0), null);
check("a reason stops applying once there are enough trades",
  R.reasonFor({ short_reason: "Shouldn't show." }, R.MIN_TRADES), null);
check("a reason still applies just under the bar",
  R.reasonFor({ short_reason: "Still short." }, R.MIN_TRADES - 1), "Still short.");

/* --- tradesView: every state, on a pinned clock ------------------------- */
check("no file at all", R.tradesView(null, now, null),
  { generated: null, week: null, reviewed: false, running: null, started: null,
    requested: null, error: null, reason: null, trades: [], empty: true });

const ready = { generated: hoursAgo(2), week: 4, review: { checked: true }, trades: [{ id: "t1" }] };
check("ready with trades", R.tradesView(ready, now, null),
  { generated: ready.generated, week: 4, reviewed: true, running: null, started: null,
    requested: null, error: null, reason: null, trades: [{ id: "t1" }], empty: false });

const running = { status: "running", started: hoursAgo(1), trades: [{ id: "old" }] };
check("running, started under 3h ago is fresh", R.tradesView(running, now, null).running, "fresh");
check("a fresh run still shows last week's trades", R.tradesView(running, now, null).trades, [{ id: "old" }]);

const dead = { status: "running", started: hoursAgo(5), trades: [] };
check("running, started over 3h ago is stale", R.tradesView(dead, now, null).running, "stale");

const failed = { status: "ready", error: { at: hoursAgo(1), reason: "Sleeper was down." }, trades: [{ id: "t1" }] };
check("a failed run surfaces its error", R.tradesView(failed, now, null).error, failed.error);

check("a request just after the last run shows up",
  R.tradesView(ready, now, Date.parse(ready.generated) + 3600e3).requested, Date.parse(ready.generated) + 3600e3);
check("a request from before the last run doesn't",
  R.tradesView(ready, now, Date.parse(ready.generated) - 3600e3).requested, null);
const oldReady = { generated: hoursAgo(10), week: 4, trades: [{ id: "t1" }] };
check("a request is dropped once it's stale (over 3h)",
  R.tradesView(oldReady, now, now - 4 * 3600e3).requested, null);
check("a request is suppressed while a run is actually going",
  R.tradesView(running, now, now - 1000).requested, null);

/* --- the zero-trades + short_reason case (the bug this fixes) ---------- */
const empty = { generated: hoursAgo(1), week: 4, short_reason: "No fair trades this week.", trades: [] };
check("zero trades still carries the reason", R.tradesView(empty, now, null).reason, "No fair trades this week.");
check("zero trades is empty", R.tradesView(empty, now, null).empty, true);

/* --- old-file compatibility --------------------------------------------- */
const old = { generated: hoursAgo(1), week: 4, none_reason: "Old format, no status field.", trades: [] };
check("old none_reason files still show a reason", R.tradesView(old, now, null).reason,
  "Old format, no status field.");
check("a file with no status field is never 'running'", R.tradesView(old, now, null).running, null);

/* --- markRunning / markFailed ------------------------------------------- */
const prevReady = { version: 1, league_id: "L1", generated: hoursAgo(30), trades: [{ id: "t1" }, { id: "t2" }] };

const running1 = R.markRunning(prevReady, "L1", new Date(now));
check("markRunning sets status and started", [running1.status, running1.started],
  ["running", new Date(now).toISOString()]);
check("markRunning keeps last week's trades", running1.trades, prevReady.trades);
check("markRunning clears any stale error", R.markRunning({ ...prevReady, error: { reason: "old" } }, "L1",
  new Date(now)).error, undefined);

check("markRunning with no prior file starts one", R.markRunning(null, "L2", new Date(now)),
  { version: 1, league_id: "L2", trades: [], status: "running", started: new Date(now).toISOString() });

const failed1 = R.markFailed(prevReady, "L1", "Sleeper was down.", new Date(now));
check("markFailed sets status ready and the error", [failed1.status, failed1.error],
  ["ready", { at: new Date(now).toISOString(), reason: "Sleeper was down." }]);
check("markFailed keeps last week's trades", failed1.trades, prevReady.trades);
check("markFailed clears started", failed1.started, undefined);
check("markFailed with no reason has a default", R.markFailed(null, "L1", null, new Date(now)).error.reason,
  "Research didn't finish.");

const failures = results.filter((x) => !x).length;
console.log(`\n${results.length - failures}/${results.length} passed`);
process.exit(failures ? 1 : 0);
