/* Sleeper API calls, caching and the per-league view model - shared by the
 * page and the browser extension's content script.
 *
 * DOM-free like core.js: status goes through an `onStatus` callback instead
 * of touching the page, and the day-long player-list cache goes through a
 * storage adapter ({ getItem, setItem, removeItem }, each returning a
 * promise) so the same code runs against localStorage on the site and
 * chrome.storage.local in the extension. Requires core.js to be loaded first
 * for the pure functions (trimPlayers, rankPositions, pickLineup, ...) it
 * builds on - loaded as a plain script in the browser, so those are already
 * in scope as globals. */

const SLEEPER = "https://api.sleeper.app/v1";
const PROJ = "https://api.sleeper.com/projections/nfl";
const SCHEDULE = "https://api.sleeper.com/schedule/nfl/regular";

// Sleeper asks callers not to pull the player dump more than once a day.
const PLAYERS_KEY = "sleeperPlayers.v1";
const PLAYERS_MAX_AGE = 20 * 3600 * 1000;

async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} returned ${r.status}`);
  return r.json();
}

/* `storage`: an adapter with async getItem/setItem/removeItem, e.g. a thin
 * wrapper around localStorage (site) or chrome.storage.local (extension).
 * `onStatus`: optional callback(msg) for progress text; called with no
 * arguments in between to mean "nothing to say right now". */
function createLoader({ storage, onStatus } = {}) {
  const say = (msg) => { if (onStatus) onStatus(msg); };

  async function cachedWithTime(key, maxAge) {
    try {
      const raw = await storage.getItem(key);
      if (!raw) return null;
      const c = JSON.parse(raw);
      const age = Date.now() - (c.fetched || 0);
      return age >= 0 && age < maxAge ? c : null;
    } catch (e) {
      return null;   // private mode, quota, or corrupt entry
    }
  }

  async function putCache(key, value) {
    try {
      await storage.setItem(key, JSON.stringify({ fetched: Date.now(), value }));
    } catch (e) { /* over quota or private mode; not worth failing over */ }
  }

  async function loadPlayers(force) {
    if (!force) {
      const hit = await cachedWithTime(PLAYERS_KEY, PLAYERS_MAX_AGE);
      if (hit) return { players: hit.value, fetched: hit.fetched };
    }
    say("Fetching the player list from Sleeper (a few MB, once a day)…");
    const players = trimPlayers(await fetchJson(`${SLEEPER}/players/nfl`));
    await putCache(PLAYERS_KEY, players);
    return { players, fetched: Date.now() };
  }

  /* Drops the cached player dump so the next loadData() re-fetches it. */
  async function forgetPlayers() {
    try { await storage.removeItem(PLAYERS_KEY); } catch (e) { /* private mode */ }
  }

  async function loadProjections(season, week) {
    const url = `${PROJ}/${season}/${week}?season_type=regular` +
      `&position[]=QB&position[]=RB&position[]=WR&position[]=TE` +
      `&position[]=K&position[]=DEF&order_by=pts_half_ppr`;
    const rows = await fetchJson(url);
    const list = Array.isArray(rows) ? rows : Object.values(rows);
    const out = {};
    const statuses = {};
    for (const row of list) {
      const pid = String(row.player_id || "");
      const stats = row.stats || {};
      if (!pid) continue;
      const live = statusFromRow(row);
      if (live !== undefined) statuses[pid] = live;
      const kept = {};
      for (const k in stats) if (typeof stats[k] === "number" && stats[k]) kept[k] = stats[k];
      if (Object.keys(kept).length) out[pid] = kept;
    }
    return { projections: out, statuses };
  }

  /* Ranking a full player pool is the expensive part of a render, and leagues
   * with identical scoring produce identical ranks, so key a cache on the
   * settings themselves. */
  const _ranksCache = new Map();

  function ranksFor(data, settings) {
    const key = JSON.stringify(settings || {});
    if (_ranksCache.has(key)) return _ranksCache.get(key);

    const projRanks = rankPositions(data.projections, data.players, settings);
    const consensus = consensusRanks(data.rankings, data.players, settings);
    const ranks = {};
    for (const pid in projRanks) ranks[pid] = { ...projRanks[pid] };
    if (consensus) {
      for (const pid in consensus) ranks[pid] = { ...(ranks[pid] || {}), ...consensus[pid] };
      for (const pid in ranks) if (!(pid in consensus)) ranks[pid].posRank = null;
    }
    const result = { ranks, source: consensus ? "consensus" : "projection" };
    _ranksCache.set(key, result);
    return result;
  }

  function clearRanksCache() { _ranksCache.clear(); _prevRanksCache.clear(); }

  // Same idea, for last week's projections (recap()'s hindsight/what-the-
  // tool-picked comparison) - a separate cache since it's ranking a
  // different projections set under the same settings key, not a
  // second lookup into _ranksCache above. No consensus overlay: a build's
  // published rankings are for the live week, not a stale one.
  const _prevRanksCache = new Map();

  function prevRanksFor(data, settings) {
    if (!data.prevWeekProjections) return null;
    const key = JSON.stringify(settings || {});
    if (_prevRanksCache.has(key)) return _prevRanksCache.get(key);
    const ranks = rankPositions(data.prevWeekProjections, data.players, settings);
    _prevRanksCache.set(key, ranks);
    return ranks;
  }

  /* The season's shared data: the player list, this week's projections
   * (scored per-league later, by ranksFor), consensus rankings if a build
   * published them, and the schedule the lineup check uses to know who's
   * locked. Callers that need a season/week without the rest (a content
   * script probing which week it is) can read them off the result. */
  async function loadData() {
    say("Checking the NFL week…");
    const state = await fetchJson(`${SLEEPER}/state/nfl`);
    const season = state.season;
    // Sleeper's own dashboard uses league_season for a user's league list: in
    // the offseason, once leagues have renewed, it's ahead of `season` (which
    // stays on the just-finished year until the new one kicks off). Dynasty
    // leagues trade in the offseason, so using the wrong one would look up
    // last year's league ids. Projections and stats stay on `season`.
    const leagueSeason = state.league_season || state.season;
    const week = state.week || state.display_week || 1;

    const { players, fetched } = await loadPlayers();
    say("Loading projections…");
    const { projections, statuses } = await loadProjections(season, week);

    // Overlay any status the live projections call reported. Injury news moves
    // faster than anything else here and must not be served from a day-old
    // cache; where projections say nothing, the cached value stands.
    let liveStatuses = 0;
    for (const pid in statuses) {
      if (players[pid]) { players[pid].i = statuses[pid]; liveStatuses++; }
    }

    // Optional: if a build has published consensus rankings, prefer them.
    // Without one this 404s and we rank by projection instead.
    let rankings = null;
    try { rankings = await fetchJson("data/rankings.json"); } catch (e) { rankings = null; }

    // Who's locked in for the lineup check. Not fetching this shouldn't cost
    // the rest of the page - it just means nothing reads as locked yet.
    let schedule = null;
    try { schedule = await fetchJson(`${SCHEDULE}/${season}`); } catch (e) { schedule = null; }

    // Trending adds, used to tag waiver-upgrade suggestions. Not league
    // specific, so one call covers every league; a failure just means
    // suggestions go untagged.
    let trending = {};
    try {
      const rows = await fetchJson(`${SLEEPER}/players/nfl/trending/add?lookback_hours=24`);
      for (const row of rows || []) trending[row.player_id] = row.count;
    } catch (e) { trending = {}; }

    // Last week's projections, for the recap (core.js's recap()): how the
    // tool's picks would have done against what actually happened. Not
    // league specific - shared the same way this week's projections are,
    // each league scores them with its own settings later in
    // buildLeagueView. Skipped before week 2 (no prior week to recap).
    const prevWeek = week - 1;
    let prevWeekProjections = null;
    if (prevWeek >= 1) {
      try { ({ projections: prevWeekProjections } = await loadProjections(season, prevWeek)); }
      catch (e) { prevWeekProjections = null; }
    }

    return { season, leagueSeason, week, players, projections, rankings, schedule, trending,
             prevWeek, prevWeekProjections, playersFetched: fetched, liveStatuses };
  }

  async function fetchUser(username) {
    const user = await fetchJson(`${SLEEPER}/user/${encodeURIComponent(username)}`);
    return user && user.user_id ? user : null;
  }

  async function fetchLeagues(userId, season) {
    return fetchJson(`${SLEEPER}/user/${userId}/leagues/nfl/${season}`);
  }

  /* One league's full view model for `user`: their roster, ranked under this
   * league's own scoring, with the lineup check against what Sleeper
   * actually has set this week. Returns null when `user` doesn't own a
   * roster in this league. Shared by the site (one user, many leagues) and
   * the extension's content script (one league at a time, read off the
   * sleeper.com page it's injected into). */
  async function buildLeagueView(lg, user, data) {
    const rosters = await fetchJson(`${SLEEPER}/league/${lg.league_id}/rosters`);
    const mine = rosters.find(
      (r) => r.owner_id === user.user_id || (r.co_owners || []).includes(user.user_id));
    if (!mine) return null;

    const settings = lg.scoring_settings || {};
    const { ranks, source } = ranksFor(data, settings);
    const slots = (lg.roster_positions || []).filter((s) => !SKIP_SLOTS.has(s));
    const roster = buildRoster(mine.players, data.players, ranks, data.week);

    // Every roster's players, not just this user's - free for waiver upgrades
    // later, since the rosters call already fetched every roster.
    const rostered = new Set();
    for (const r of rosters) for (const pid of r.players || []) rostered.add(pid);

    // Team names (for the opponent's name below, and kept on the view for
    // the waiver drop/power-rankings displays), this week's matchups (for
    // the lineup check below and the opponent's) and last week's matchups
    // (for the recap further down) - three independent calls, so fired
    // together rather than one after another; each is still tolerated
    // failing on its own.
    const [usersResult, matchupsResult, prevMatchupsResult] = await Promise.allSettled([
      fetchJson(`${SLEEPER}/league/${lg.league_id}/users`),
      fetchJson(`${SLEEPER}/league/${lg.league_id}/matchups/${data.week}`),
      data.prevWeek >= 1
        ? fetchJson(`${SLEEPER}/league/${lg.league_id}/matchups/${data.prevWeek}`)
        : Promise.resolve(null),
    ]);

    let names = {};
    try {
      if (usersResult.status !== "fulfilled") throw usersResult.reason;
      const nameByUserId = {};
      (usersResult.value || []).forEach((u) => {
        nameByUserId[u.user_id] = (u.metadata && u.metadata.team_name) || u.display_name || "Team";
      });
      rosters.forEach((r) => { names[r.roster_id] = nameByUserId[r.owner_id] || `Team ${r.roster_id}`; });
    } catch (e) { names = {}; }

    // What Sleeper actually has set for this week, compared with the best
    // lineup this roster supports. A locked starter stays put; a locked
    // bench player is dropped from consideration entirely, so the result is
    // always a lineup that can still be set.
    let current = null;
    let check = null;
    let best = null;
    let locked = new Set();
    let checkedAt = null;
    let matchups = null;
    let mm = null;
    try {
      if (matchupsResult.status !== "fulfilled") throw matchupsResult.reason;
      matchups = matchupsResult.value;
      mm = (matchups || []).find((m) => m.roster_id === mine.roster_id);
      if (mm) {
        current = currentLineup(mm.starters, slots, roster);
        locked = lockedIds(roster, data.schedule, data.week);
        const startingIds = new Set(
          current.map((e) => e.player && e.player.id).filter(Boolean));
        const fixed = {};
        current.forEach((e, i) => { if (e.player && locked.has(e.player.id)) fixed[i] = e.player; });
        const pool = roster.filter((p) => !locked.has(p.id) || startingIds.has(p.id));
        best = pickLineup(pool, slots, fixed);
        check = lineupCheck(current, best.bySlot);
        checkedAt = Date.now();
      }
    } catch (e) {
      current = null; check = null; best = null; locked = new Set(); checkedAt = null;
      matchups = null; mm = null;
    }

    // This week's opponent: the other roster sharing `mm`'s matchup_id.
    // Separate try/catch from the block above - a bad opponent roster or
    // missing schedule shouldn't cost the user's own lineup check, which
    // matters more. `matchup_id` is null for a bye week (playoffs) or a
    // league that hasn't generated matchups yet, and there's simply no
    // "other entry" in a one-team matchup either way.
    let matchup = null;
    try {
      if (mm && mm.matchup_id != null) {
        const opp = (matchups || []).find(
          (m) => m.matchup_id === mm.matchup_id && m.roster_id !== mine.roster_id);
        const oppRosterRaw = opp && rosters.find((r) => r.roster_id === opp.roster_id);
        if (opp && oppRosterRaw) {
          const oppRoster = buildRoster(oppRosterRaw.players, data.players, ranks, data.week);
          const oppCurrent = currentLineup(opp.starters, slots, oppRoster);
          const oppHoles = oppCurrent.filter((e) => !e.player || unavailable(e.player));
          // Use the best lineup's total once the check flags a problem
          // with what's actually set - the number a person would react to
          // is "what I'd score if I fixed this", not the current shortfall.
          const myProj = check && !check.ok
            ? projectedTotal(best.bySlot) : projectedTotal(current);
          const myProjAsSet = projectedTotal(current);
          const oppProj = projectedTotal(oppCurrent);
          matchup = {
            oppName: names[opp.roster_id] || `Team ${opp.roster_id}`,
            mine: current, theirs: oppCurrent,
            myProj, myProjAsSet, oppProj,
            win: winProb(myProj, oppProj),
            myPts: mm.points || 0, oppPts: opp.points || 0,
            oppHoles,
          };
        }
      }
    } catch (e) { matchup = null; }

    // Free agents who'd beat your weakest starter at a slot they can fill,
    // tagged with how many leagues have added them in the last day. Uses the
    // same best lineup the check does when there is one, so "weakest
    // starter" means the same thing in both places.
    const pool = buildRoster(Object.keys(ranks), data.players, ranks, data.week);
    const waivers = waiverUpgrades(pool, rostered, best || pickLineup(roster, slots))
      .map((w) => ({ ...w, add: (data.trending && data.trending[w.id]) || 0 }));

    // Bye/injury holes over the next few weeks. Own try/catch, same as the
    // matchup block above: a missing/empty schedule is already handled by
    // byeWeeks() and upcomingHoles' own `b`-field fallback, but a schedule
    // response that parses as JSON yet has a malformed entry (a field
    // missing or the wrong type) would otherwise throw out of this whole
    // function and cost the entire league, not just this one card.
    let upcoming = [];
    try {
      upcoming = upcomingHoles(roster, slots, data.week, byeWeeks(data.schedule));
    } catch (e) { upcoming = []; }

    // Last week's recap: how the tool's picks would have done against
    // what actually happened (core.js's recap()), using the matchups
    // fetched in the Promise.allSettled batch above. Own try/catch, same
    // reasoning as the blocks above - a bad response shouldn't cost the
    // rest of the view. Skipped before week 2 (no prior week).
    let weekRecap = null;
    if (data.prevWeekProjections && data.prevWeek >= 1) {
      try {
        if (prevMatchupsResult.status !== "fulfilled") throw prevMatchupsResult.reason;
        const prevEntry = (prevMatchupsResult.value || []).find((m) => m.roster_id === mine.roster_id);
        if (prevEntry) {
          const prevRanks = prevRanksFor(data, settings);
          if (prevRanks) {
            weekRecap = { ...recap(prevEntry, slots, data.players, prevRanks), week: data.prevWeek };
          }
        }
      } catch (e) { weekRecap = null; }
    }

    return {
      name: lg.name, id: lg.league_id, week: data.week, slots,
      label: scoringLabel(settings),
      superflex: slots.includes("SUPER_FLEX"),
      trades: tradeWindow(lg, data.week),
      teRec: settings.bonus_rec_te || 0,
      roster, source, rostered, waivers, names, upcoming, recap: weekRecap,
      // Every ranked player in the league, not just this user's roster - the
      // extension's content script uses this to badge free agents on the
      // Players page and opponents' rosters, not only the user's own team.
      pool,
      current, check, best, locked, checkedAt, matchup,
      sleeperUrl: `https://sleeper.com/leagues/${lg.league_id}/team`,
    };
  }

  return {
    json: fetchJson, loadPlayers, forgetPlayers, loadProjections, loadData,
    ranksFor, prevRanksFor, clearRanksCache, fetchUser, fetchLeagues, buildLeagueView,
  };
}
