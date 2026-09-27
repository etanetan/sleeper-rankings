/* Trade research lifecycle - shared by the page and the routine.
 *
 * Owns the rules for what state a league's published research is in (still
 * running, stale, fresh enough to skip) and what the Trades tab should show
 * for it. Loaded the same way as app.js: a plain script in the browser, and
 * required for its `module.exports` in Node (by trades/engine.js).
 */

// A run is still active for this long after it starts; past that a scheduled
// run treats it as dead (free to redo) and the page tells the user to retry
// rather than to keep waiting.
const RUN_STALE_MS = 3 * 3600 * 1000;
// Sleeper asks for at most one full pull a day; research this recent is
// fresh enough that a scheduled run leaves it alone.
const FRESH_MS = 20 * 3600 * 1000;
// Ethan wants at least this many trades to choose from per league.
const MIN_TRADES = 5;

/* Mark a league as being researched, keeping whatever trades are already
 * published visible while the run works. */
function markRunning(prev, leagueId, now) {
  const next = { ...(prev || { version: 1, league_id: leagueId, trades: [] }) };
  next.status = "running";
  next.started = (now || new Date()).toISOString();
  delete next.error;
  return next;
}

/* Mark a run as failed: keep last time's trades on the page, and say why. */
function markFailed(prev, leagueId, reason, now) {
  const next = { ...(prev || { version: 1, league_id: leagueId, trades: [] }) };
  next.status = "ready";
  next.error = { at: (now || new Date()).toISOString(), reason: reason || "Research didn't finish." };
  delete next.started;
  return next;
}

/* The single "why fewer than five" field, however the research file spelled
 * it (`short_reason`, or the older `none_reason`), and only while it still
 * applies: a reason survives even at zero trades, but stops applying once
 * there are enough trades that no excuse is needed. */
function reasonFor(research, count) {
  const reason = (research && (research.short_reason || research.none_reason)) || null;
  return reason && count < MIN_TRADES ? reason : null;
}

/* What the Trades tab should show for one league's published research file.
 * Pure: the page's DOM code renders this, nothing more. `requestedAt` is the
 * time (ms) the user last tapped "Research new trades", if any. */
function tradesView(file, now, requestedAt) {
  const t = now == null ? Date.now() : +now;
  const trades = (file && file.trades) || [];
  let running = null;
  if (file && file.status === "running" && file.started) {
    running = t - Date.parse(file.started) < RUN_STALE_MS ? "fresh" : "stale";
  }
  let requested = null;
  if (!running && requestedAt) {
    const done = file && file.generated ? Date.parse(file.generated) : 0;
    if (requestedAt > done && t - requestedAt < RUN_STALE_MS) requested = requestedAt;
  }
  return {
    generated: (file && file.generated) || null,
    week: (file && file.week) || null,
    reviewed: !!(file && file.review && file.review.checked),
    running,
    started: (file && file.started) || null,
    requested,
    error: (file && file.error) || null,
    reason: reasonFor(file, trades.length),
    trades,
    empty: trades.length === 0,
  };
}

/* Which league a scheduled run should research: the open league whose
 * published research is oldest, skipping any another run is working on.
 * Runs are spread through the day so each fits a usage window; once every
 * league is fresh there's nothing to do. */
function pickNext(open, files, now) {
  const t = now.getTime();
  let best = null;
  for (const lg of open) {
    const f = files[lg.league_id] || {};
    if (f.status === "running" && f.started && t - Date.parse(f.started) < RUN_STALE_MS) continue;
    const age = f.generated ? t - Date.parse(f.generated) : Infinity;
    if (age < FRESH_MS) continue;
    if (!best || age > best.age) best = { league_id: lg.league_id, name: lg.name, age };
  }
  return best;
}

if (typeof module !== "undefined") {
  module.exports = { RUN_STALE_MS, FRESH_MS, MIN_TRADES, markRunning, markFailed, reasonFor, tradesView, pickNext };
}
