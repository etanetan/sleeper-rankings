/* Weekly Sleeper rankings - page UI.
 *
 * The ranking/lineup logic lives in core.js and the Sleeper API calls live in
 * data.js, both loaded as plain scripts before this one; their top-level
 * functions are used directly below with no import. Everything in this file
 * touches the DOM. */

if (typeof document !== "undefined") {
  const $ = (s) => document.querySelector(s);
  const el = (tag, cls, txt) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  };

  let DATA = null;
  let LEAGUES = [];

  const setStatus = (msg, isErr) => {
    const s = $("#status");
    s.textContent = msg || "";
    s.className = "status" + (isErr ? " err" : "");
    s.hidden = !msg;
  };

  // localStorage is synchronous; createLoader's storage adapter is async so
  // the same loader code also runs against chrome.storage.local in the
  // extension - wrap it in resolved promises here.
  const localStorageAdapter = {
    async getItem(key) { try { return localStorage.getItem(key); } catch (e) { return null; } },
    async setItem(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* private mode */ } },
    async removeItem(key) { try { localStorage.removeItem(key); } catch (e) { /* private mode */ } },
  };
  const loader = createLoader({ storage: localStorageAdapter, onStatus: setStatus });

  function ageText(hours) {
    return hours < 36 ? `${Math.round(hours)}h` : `${Math.round(hours / 24)} days`;
  }

  async function loadData() {
    if (DATA) return DATA;
    DATA = await loader.loadData();
    $("#week").textContent = `Week ${DATA.week}`;

    const injAge = (Date.now() - DATA.playersFetched) / 36e5;
    let rankSrc = "Ranks from Sleeper projections, scored by each league's settings. ";
    if (DATA.rankings && DATA.rankings.shared) {
      rankSrc = "Ranks from FantasyPros expert consensus";
      if (DATA.rankings.generated) {
        const rAge = (Date.now() - new Date(DATA.rankings.generated).getTime()) / 36e5;
        rankSrc += `, built ${rAge < 1.5 ? "under an hour" : ageText(rAge)} ago`;
      }
      rankSrc += ". ";
    }
    $("#gen").textContent = rankSrc +
      (DATA.liveStatuses
        ? `Injury statuses refreshed live.`
        : `Injury statuses from the player list, ` +
          `${injAge < 1 ? "under an hour" : `${Math.round(injAge)}h`} old.`);
    return DATA;
  }

  // A league id requested by an embedding page (extension side panel) before
  // that league had loaded yet; applied as soon as LEAGUES is ready.
  let PENDING_LEAGUE = null;

  function selectLeagueById(id) {
    const idx = LEAGUES.findIndex((lg) => String(lg.id) === String(id));
    if (idx === -1) { PENDING_LEAGUE = id; return; }
    PENDING_LEAGUE = null;
    const sel = $("#league");
    if (sel) sel.value = idx;
    render(idx);
  }

  async function go(username) {
    username = (username || "").trim().replace(/^@/, "");
    if (!username) return setStatus("Enter your Sleeper username.", true);

    $("#results").innerHTML = "";
    $("#picker").hidden = true;

    let data;
    try {
      data = await loadData();
    } catch (e) {
      return setStatus(`Couldn't reach Sleeper: ${e.message}`, true);
    }

    try {
      setStatus(`Looking up ${username}…`);
      const user = await loader.fetchUser(username);
      if (!user) return setStatus(`No Sleeper user named "${username}".`, true);

      const leagues = await loader.fetchLeagues(user.user_id, data.leagueSeason);
      if (!leagues.length) {
        return setStatus(`${username} has no NFL leagues for ${data.leagueSeason}.`, true);
      }

      setStatus(`Loading ${leagues.length} league${leagues.length > 1 ? "s" : ""}…`);

      // Fetch every league independently - one league failing shouldn't cost
      // you the other eleven.
      const settled = await Promise.allSettled(
        leagues.map((lg) => loader.buildLeagueView(lg, user, data)));

      LEAGUES = [];
      const failed = [];
      settled.forEach((r, i) => {
        if (r.status === "fulfilled") { if (r.value) LEAGUES.push(r.value); }
        else failed.push(leagues[i].name || leagues[i].league_id);
      });

      if (!LEAGUES.length) {
        return setStatus(failed.length
          ? `Couldn't load any leagues (${failed.join(", ")}).`
          : `Found leagues, but no roster owned by ${username}.`, true);
      }

      try { localStorage.setItem("sleeperUser", username); } catch (e) { /* private mode */ }
      setStatus(failed.length
        ? `Couldn't load ${failed.join(", ")} — showing the rest.` : "", failed.length > 0);
      renderPicker();
      renderStrip();
      render(0);
      if (PENDING_LEAGUE) selectLeagueById(PENDING_LEAGUE);
    } catch (e) {
      setStatus(`Sleeper request failed: ${e.message}`, true);
    }
  }

  /* A short suffix for the picker and the league strip: ✓ when Sleeper's
   * lineup already matches, otherwise how many changes are pending, or ⚠
   * when a starter needs attention (OUT/bye/empty) regardless of count -
   * plus this week's win chance, when there's a matchup to compute one from. */
  function checkSuffix(lg) {
    let suffix = "";
    if (lg.check) {
      if (lg.check.unavailable.length || lg.check.empty.length) suffix = "⚠";
      else if (lg.check.ok) suffix = "✓";
      else {
        const n = lg.check.changes.length;
        suffix = `${n} change${n === 1 ? "" : "s"}`;
      }
    }
    if (lg.matchup) {
      const winPct = Math.round(lg.matchup.win * 100);
      suffix = suffix ? `${suffix} · ${winPct}%` : `${winPct}%`;
    }
    return suffix;
  }

  function renderPicker() {
    const sel = $("#league");
    sel.innerHTML = "";
    LEAGUES.forEach((lg, i) => {
      const suffix = checkSuffix(lg);
      const o = el("option", null, `${lg.name} — ${lg.label}${suffix ? ` · ${suffix}` : ""}`);
      o.value = i;
      sel.appendChild(o);
    });
    $("#picker").hidden = LEAGUES.length < 2;
    sel.onchange = () => render(+sel.value);
  }

  function renderStrip() {
    const strip = $("#strip");
    if (!strip) return;
    strip.innerHTML = "";
    LEAGUES.forEach((lg, i) => {
      const suffix = checkSuffix(lg);
      const b = el("button", "ls-item", `${lg.name}${suffix ? ` ${suffix}` : ""}`);
      b.type = "button";
      b.dataset.idx = i;
      b.addEventListener("click", () => {
        const sel = $("#league");
        if (sel) sel.value = i;
        render(i);
      });
      strip.appendChild(b);
    });
    strip.hidden = LEAGUES.length === 0;
  }

  function updateStripActive(idx) {
    const strip = $("#strip");
    if (!strip) return;
    Array.from(strip.children).forEach((b, i) => b.classList.toggle("active", i === idx));
  }

  function playerRow(p, slot, flags) {
    flags = flags || {};
    const tr = el("tr", flags.chg ? "chg" : null);
    if (slot !== undefined) tr.appendChild(el("td", "slot", SLOT_LABEL[slot] || slot));
    const nameCell = el("td", "nm");
    nameCell.appendChild(document.createTextNode(p.n));
    if (flags.locked) {
      const lock = el("span", "lock", "🔒");
      lock.title = "Locked - this player's game has started";
      nameCell.appendChild(lock);
    }
    if (p.onBye) nameCell.appendChild(el("span", "out", "BYE"));
    if (p.status) {
      nameCell.appendChild(el("span", OUT_STATUSES.has(p.status) ? "out" : "q", p.status));
    }
    nameCell.appendChild(el("span", "meta", ` ${p.t || "FA"}`));
    tr.appendChild(nameCell);
    tr.appendChild(el("td", "pos", p.p === "DEF" ? "DST" : p.p));
    tr.appendChild(el("td", "pts", p.pts != null ? p.pts.toFixed(1) : "—"));
    const inactive = unavailable(p);
    const rk = el("td", "rk" + (inactive ? " inactive" : ""));
    if (p.posRank != null) {
      const b = el("b", null, `${p.p === "DEF" ? "DST" : p.p}${p.posRank}`);
      if (inactive) b.title = `Ranked ${p.p}${p.posRank}, but ${benchReason(p)} this week`;
      rk.appendChild(b);
    } else {
      rk.className = "rk meta";
      rk.textContent = "—";
    }
    tr.appendChild(rk);
    return tr;
  }

  function table(rows) {
    const wrap = el("div", "tbl-wrap");
    const t = el("table");
    rows.forEach((r) => t.appendChild(r));
    wrap.appendChild(t);
    return wrap;
  }

  function waiverRow(w) {
    const tr = el("tr");
    const nameCell = el("td", "nm");
    nameCell.appendChild(document.createTextNode(w.n));
    if (w.status) nameCell.appendChild(el("span", OUT_STATUSES.has(w.status) ? "out" : "q", w.status));
    nameCell.appendChild(el("span", "meta", ` ${w.t || "FA"} · over ${w.weakest.n}`));
    if (w.add) nameCell.appendChild(el("span", "meta", ` · ${num(w.add)} adds today`));
    tr.appendChild(nameCell);
    tr.appendChild(el("td", "pos", w.p === "DEF" ? "DST" : w.p));
    tr.appendChild(el("td", "pts", `+${w.gain.toFixed(1)}`));
    const rk = el("td", w.posRank != null ? "rk" : "rk meta");
    if (w.posRank != null) rk.appendChild(el("b", null, `${w.p === "DEF" ? "DST" : w.p}${w.posRank}`));
    else rk.textContent = "—";
    tr.appendChild(rk);
    return tr;
  }

  function fmtClock(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  function changeItem(c) {
    const li = el("li");
    const slotLabel = SLOT_LABEL[c.slot] || c.slot;
    if (c.in) {
      li.appendChild(document.createTextNode("Start "));
      li.appendChild(el("b", null, c.in.n));
      if (c.in.posRank != null) {
        li.appendChild(el("span", "meta", ` ${c.in.p === "DEF" ? "DST" : c.in.p}${c.in.posRank}`));
      }
    }
    if (c.out) {
      li.appendChild(document.createTextNode(c.in ? " over " : "Bench "));
      li.appendChild(el("b", null, c.out.n));
    }
    li.appendChild(document.createTextNode(` in ${slotLabel}`));
    return li;
  }

  /* One row of a matchup's starter column - a currentLineup-shaped entry
   * ({slot, player}), player possibly null for an empty slot. Reuses
   * playerRow for a real player so an opponent's OUT/bye starter gets the
   * same "out"/"q" tag and inactive rank styling the lineup tab already
   * uses - a hole should look like a hole, whichever side it's on. */
  function matchupRow(e) {
    if (e.player) return playerRow(e.player, e.slot);
    const tr = el("tr");
    tr.appendChild(el("td", "slot", SLOT_LABEL[e.slot] || e.slot));
    const nm = el("td", "nm");
    nm.appendChild(el("span", "out", "EMPTY"));
    tr.appendChild(nm);
    tr.appendChild(el("td", "pos"));
    tr.appendChild(el("td", "pts", "—"));
    tr.appendChild(el("td", "rk meta", "—"));
    return tr;
  }

  function matchupSide(label, entries) {
    const wrap = el("div", "deal-side");
    wrap.appendChild(el("h4", null, label));
    wrap.appendChild(table(entries.map(matchupRow)));
    return wrap;
  }

  /* This week's opponent: projected score, win chance, and both lineups
   * side by side (reusing the .deal/.deal-side layout the trade detail view
   * already uses, so it stacks on narrow screens for free). */
  function matchupPanel(lg) {
    const panel = el("div", "panel");
    const m = lg.matchup;
    if (!m) {
      panel.appendChild(el("p", "none",
        "No matchup found for this week yet - check back once the schedule's set."));
      return panel;
    }

    // Once either side has scored, that's more informative than a
    // projection frozen at kickoff; a real 0-0 is indistinguishable from
    // "hasn't started" for the seconds before the first snap, and that's
    // an acceptable tradeoff for not needing a separate "has it started"
    // signal from Sleeper.
    const started = m.myPts > 0 || m.oppPts > 0;
    const myShown = started ? m.myPts : m.myProj;
    const oppShown = started ? m.oppPts : m.oppProj;
    // Recomputed from whichever numbers are on screen, not read off m.win -
    // m.win is fixed at kickoff-time projections, so once live points take
    // over up above, using it here would risk contradicting them (a real
    // blowout paired with a stale "42% to win" from before the game).
    const winPct = Math.round(winProb(myShown, oppShown) * 100);

    const head = el("p", "mu-head");
    head.appendChild(el("b", null, "You"));
    head.appendChild(document.createTextNode(` ${myShown.toFixed(1)} – ${oppShown.toFixed(1)} `));
    head.appendChild(el("b", null, m.oppName));
    head.appendChild(el("span", "chip fmt", `${winPct}% to win`));
    panel.appendChild(head);

    if (!started && Math.abs(m.myProjAsSet - m.myProj) > 0.05) {
      panel.appendChild(el("p", "note",
        `${m.myProjAsSet.toFixed(1)} as your Sleeper lineup is set, ` +
        `${m.myProj.toFixed(1)} if you make the changes above.`));
    }

    const deal = el("div", "deal");
    deal.appendChild(matchupSide("You", m.mine));
    deal.appendChild(matchupSide(m.oppName, m.theirs));
    panel.appendChild(deal);

    if (m.oppHoles.length) {
      const who = m.oppHoles
        .map((e) => e.player ? `${e.player.n} (${benchReason(e.player)})` : `their ${SLOT_LABEL[e.slot] || e.slot} slot`)
        .join(", ");
      panel.appendChild(el("p", "note",
        `${m.oppName}'s lineup has a hole: ${who}.`));
    }

    return panel;
  }

  /* Above the starters table: what Sleeper has set vs. the best lineup this
   * roster supports, plus anything wrong with what's actually set. */
  function lineupBanner(lg) {
    if (!lg.check) return null;
    const box = el("div", "lineup-banner " + (lg.check.ok ? "ok" : "warn"));
    if (lg.check.ok) {
      box.appendChild(el("p", "lb-head", "✓ Your Sleeper lineup matches"));
    } else {
      const n = lg.check.changes.length;
      const gain = Math.round(lg.check.gain * 10) / 10;
      box.appendChild(el("p", "lb-head",
        `Make ${n} change${n === 1 ? "" : "s"} (${gain > 0 ? "+" : ""}${gain} pts)`));
      if (n) {
        const ul = el("ul", "lb-changes");
        lg.check.changes.forEach((c) => ul.appendChild(changeItem(c)));
        box.appendChild(ul);
      }
    }
    lg.check.unavailable.forEach((p) => {
      box.appendChild(el("p", "note warn lb-note",
        `${p.n} is in your lineup but ${benchReason(p) || "unavailable"} this week.`));
    });
    lg.check.empty.forEach((slot) => {
      box.appendChild(el("p", "note warn lb-note",
        `Your ${SLOT_LABEL[slot] || slot} slot is empty in Sleeper.`));
    });
    const foot = el("p", "lb-foot");
    const link = el("a", "lb-open", "Open in Sleeper ↗");
    link.href = lg.sleeperUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    foot.appendChild(link);
    if (lg.checkedAt) {
      foot.appendChild(el("span", "meta", ` · Sleeper lineup as of ${fmtClock(lg.checkedAt)}`));
    }
    box.appendChild(foot);
    return box;
  }

  // Which tab is showing, kept across league switches and re-renders so
  // changing leagues doesn't bounce you back to the lineup.
  let ACTIVE_TAB = "lineup";
  const TAB_NAMES = new Set(["lineup", "matchup", "positions", "waivers", "trades"]);
  try {
    const saved = localStorage.getItem("activeTab");
    if (TAB_NAMES.has(saved)) ACTIVE_TAB = saved;
  } catch (e) { /* private mode */ }

  function tabBar(panels) {
    const bar = el("div", "tabs");
    bar.setAttribute("role", "tablist");
    const buttons = [];

    const select = (name) => {
      ACTIVE_TAB = name;
      try { localStorage.setItem("activeTab", name); } catch (e) { /* private mode */ }
      buttons.forEach((b) => {
        const on = b.dataset.tab === name;
        b.setAttribute("aria-selected", String(on));
        b.tabIndex = on ? 0 : -1;
      });
      for (const key in panels) panels[key].hidden = key !== name;
    };

    const tabs = [["lineup", "Lineup"], ["matchup", "Matchup"], ["positions", "By position"],
                  ["waivers", "Waivers"], ["trades", "Trades"]];
    tabs.forEach(([name, label]) => {
      const b = el("button", "tab", label);
      b.type = "button";
      b.dataset.tab = name;
      b.setAttribute("role", "tab");
      b.addEventListener("click", () => select(name));
      buttons.push(b);
      bar.appendChild(b);
    });

    bar.addEventListener("keydown", (e) => {
      const i = buttons.findIndex((b) => b.dataset.tab === ACTIVE_TAB);
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        const next = buttons[(i + (e.key === "ArrowRight" ? 1 : buttons.length - 1)) % buttons.length];
        select(next.dataset.tab);
        next.focus();
      }
    });

    select(panels[ACTIVE_TAB] ? ACTIVE_TAB : "lineup");
    return bar;
  }

  function render(idx) {
    const lg = LEAGUES[idx];
    const out = $("#results");
    out.innerHTML = "";
    if (!lg) return;
    if (CURRENT && CURRENT !== lg) closeTradeQuietly();
    CURRENT = lg;
    updateStripActive(idx);

    const head = el("div", "lh");
    head.appendChild(el("h2", null, lg.name));
    head.appendChild(el("span", "chip fmt", lg.label));
    if (lg.superflex) head.appendChild(el("span", "chip", "Superflex"));
    if (lg.teRec) head.appendChild(el("span", "chip", `TE +${lg.teRec}`));
    out.appendChild(head);

    if (lg.source === "consensus") {
      const ranked = lg.roster.filter((p) => p.posRank != null).length;
      if (lg.roster.length && ranked < lg.roster.length * 0.6) {
        out.appendChild(el("p", "note warn",
          `Only ${ranked} of ${lg.roster.length} players have a consensus rank. ` +
          `The FantasyPros plan in use returns a truncated list, so players ` +
          `outside the top few at each position show no rank.`));
      }
    }

    // The best lineup this roster supports. Where a matchup was fetched, it's
    // the lock-aware one computed alongside the lineup check, so what's shown
    // here always matches what the banner is comparing against; otherwise
    // fall back to picking from the whole roster, same as before.
    const { starters } = lg.best || pickLineup(lg.roster, lg.slots);
    const startingIds = new Set(starters.map((s) => s.player.id));
    const bench = lg.roster.filter((p) => !startingIds.has(p.id));

    const changedIn = new Set();
    if (lg.check && !lg.check.ok) {
      lg.check.changes.forEach((c) => { if (c.in) changedIn.add(c.in.id); });
    }

    // --- lineup panel: start and sit, the week's actual decision -------
    const lineup = el("div", "panel");
    const banner = lineupBanner(lg);
    if (banner) lineup.appendChild(banner);
    if (starters.length) {
      const forced = starters.filter((s) => unavailable(s.player));
      if (forced.length) {
        const who = forced
          .map((s) => `${s.player.n} (${benchReason(s.player)})`).join(", ");
        lineup.appendChild(el("p", "note warn",
          `No healthy replacement for ${who}. ` +
          `${forced.length > 1 ? "They're" : "He's"} still listed below because ` +
          `the slot has to be filled — check waivers.`));
      }
      lineup.appendChild(table(starters.map((s) => playerRow(s.player, s.slot,
        { chg: changedIn.has(s.player.id), locked: lg.locked.has(s.player.id) }))));
    } else {
      lineup.appendChild(el("p", "none", "Couldn't build a lineup from this roster."));
    }

    if (bench.length) {
      lineup.appendChild(el("h3", null, "Sit"));
      const sidelined = bench.filter(
        (p) => unavailable(p) && p.posRank != null && p.posRank <= 36);
      if (sidelined.length) {
        const who = sidelined.map((p) => `${p.n} (${benchReason(p)})`).join(", ");
        lineup.appendChild(el("p", "note",
          `${who} ${sidelined.length > 1 ? "rank" : "ranks"} well but ` +
          `${sidelined.length > 1 ? "are" : "is"} not expected to play, so ` +
          `${sidelined.length > 1 ? "they were" : "he was"} left out of the lineup. ` +
          `Rankings reflect a healthy week.`));
      }
      bench.sort((a, b) => POS_ORDER.indexOf(a.p) - POS_ORDER.indexOf(b.p) || posKey(a) - posKey(b));
      lineup.appendChild(table(bench.map((p) => playerRow(p))));
    }

    // --- matchup panel: this week's opponent, projected score and holes -
    const matchup = matchupPanel(lg);

    // --- positions panel: the whole roster, ranked within each position
    const positions = el("div", "panel");
    for (const pos of POS_ORDER) {
      const grp = lg.roster.filter((p) => p.p === pos);
      if (!grp.length) continue;
      grp.sort((a, b) => posKey(a) - posKey(b));
      positions.appendChild(el("h4", null, pos === "DEF" ? "Defense" : pos));
      positions.appendChild(table(grp.map((p) => playerRow(p))));
    }

    // --- waivers panel: free agents who'd beat your weakest starter -----
    const waivers = el("div", "panel");
    if (lg.waivers && lg.waivers.length) {
      waivers.appendChild(el("p", "tr-intro",
        "Free agents who'd outscore your weakest starter at a position they can fill, by the gain."));
      waivers.appendChild(table(lg.waivers.map((w) => waiverRow(w))));
    } else {
      waivers.appendChild(el("p", "none", "No waiver upgrades found - your bench already covers your weak spots."));
    }

    // --- trades panel: filled in when the research file arrives
    const trades = el("div", "panel");
    TRADES_PANEL = trades;
    loadTrades(lg, trades);

    out.appendChild(tabBar({ lineup, matchup, positions, waivers, trades }));
    out.appendChild(lineup);
    out.appendChild(matchup);
    out.appendChild(positions);
    out.appendChild(waivers);
    out.appendChild(trades);
  }

  async function refresh() {
    setStatus("Refreshing player and injury data…");
    await loader.forgetPlayers();
    DATA = null;
    loader.clearRanksCache();
    _trades.clear();
    await go($("#username").value);
  }

  /* ------------------------------------------------------------ trades */

  // Trade research is written by a scheduled Claude routine to its own branch,
  // so a run never touches the site itself. raw.githubusercontent serves it
  // with open CORS and a five-minute cache.
  const TRADE_DATA =
    "https://raw.githubusercontent.com/etanetan/sleeper-rankings/refs/heads/claude/trade-data";
  const ROUTINES_URL = "https://claude.ai/code/routines";
  const ROUTINE_NAME = "Sleeper trade research";
  const _trades = new Map();   // league id -> { at, data }
  let CURRENT = null;
  let TRADES_PANEL = null;
  let OPEN_TRADE = null;
  {
    const m = /^#trade-([\w-]+)$/.exec(location.hash);
    if (m) { OPEN_TRADE = m[1]; ACTIVE_TAB = "trades"; }
  }

  async function fetchTrades(id, force) {
    const hit = _trades.get(id);
    if (!force && hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.data;
    const r = await fetch(`${TRADE_DATA}/${encodeURIComponent(id)}.json`, { cache: "no-store" });
    if (r.status === 404) {
      _trades.set(id, { at: Date.now(), data: null });
      return null;
    }
    if (!r.ok) throw new Error(`the research file returned ${r.status}`);
    const data = await r.json();
    _trades.set(id, { at: Date.now(), data });
    return data;
  }

  async function loadTrades(lg, panel, force) {
    panel.innerHTML = "";
    panel.appendChild(el("p", "none", "Loading trade ideas…"));
    let data;
    try {
      data = await fetchTrades(lg.id, force);
    } catch (e) {
      if (CURRENT !== lg) return;
      panel.innerHTML = "";
      panel.appendChild(el("p", "note warn", `Couldn't load trade research: ${e.message}.`));
      return;
    }
    if (CURRENT !== lg || TRADES_PANEL !== panel) return;   // switched leagues meanwhile
    drawTrades(lg, panel, data);
  }

  function drawTrades(lg, panel, data) {
    panel.innerHTML = "";
    const trade = OPEN_TRADE && data && (data.trades || []).find((t) => t.id === OPEN_TRADE);
    panel.appendChild(trade ? tradeDetail(lg, data, trade) : tradeList(lg, panel, data));
  }

  function redrawTrades() {
    if (!CURRENT || !TRADES_PANEL) return;
    const hit = _trades.get(CURRENT.id);
    if (hit) drawTrades(CURRENT, TRADES_PANEL, hit.data);
  }

  function openTrade(id) {
    OPEN_TRADE = id;
    try { history.pushState({ trade: id }, "", `#trade-${id}`); } catch (e) { /* sandboxed */ }
    redrawTrades();
    const tabs = document.querySelector(".tabs");
    if (tabs && tabs.getBoundingClientRect().top < 0) tabs.scrollIntoView({ block: "start" });
  }

  function closeTrade() {
    if (history.state && history.state.trade) { history.back(); return; }   // popstate redraws
    closeTradeQuietly();
    redrawTrades();
  }

  function closeTradeQuietly() {
    OPEN_TRADE = null;
    if (/^#trade-/.test(location.hash)) {
      try { history.replaceState(null, "", location.pathname + location.search); } catch (e) { /* sandboxed */ }
    }
  }

  window.addEventListener("popstate", (e) => {
    OPEN_TRADE = (e.state && e.state.trade) || null;
    redrawTrades();
  });

  function fmtWhen(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return "";
    const old = Date.now() - d.getTime() > 6 * 864e5;
    return d.toLocaleString([], old
      ? { month: "short", day: "numeric" }
      : { weekday: "short", hour: "numeric", minute: "2-digit" });
  }

  function readRequests() {
    try { return JSON.parse(localStorage.getItem("tradeRequests") || "{}") || {}; }
    catch (e) { return {}; }
  }

  function markRequested(id) {
    try {
      const m = readRequests();
      m[id] = Date.now();
      localStorage.setItem("tradeRequests", JSON.stringify(m));
    } catch (e) { /* private mode */ }
  }

  const posLabel = (p) => (p === "DEF" ? "DST" : p);
  const signed = (n) => `${n > 0 ? "+" : ""}${n}`;
  const num = (n) => Math.round(n || 0).toLocaleString();

  function verdictClass(v) {
    if (!v) return "chip";
    return "chip " + (Math.abs(v.diffPct) <= EVEN_PCT ? "fmt" : v.diffPct > 0 ? "good" : "warn");
  }

  // The market call behind each player in a deal. "hold" never reaches a
  // published trade; "avoid" does when a deal is worth it anyway, and says so.
  const TAGS = {
    sell_high: ["SELL HIGH", "sell"],
    buy_low: ["BUY LOW", "buy"],
    avoid: ["AT PEAK", "peak"],
  };

  function tagChip(p) {
    const t = TAGS[p.tag];
    if (!t) return null;
    const chip = el("span", `tag ${t[1]}`, t[0]);
    if (p.tagBy === "research") chip.title = "Confirmed by research";
    return chip;
  }

  /* The numbers behind the call: results against projection, market move,
   * and the usage that says whether it lasts. */
  function formLine(p) {
    const f = p.form;
    const bits = [];
    if (f && f.g) bits.push(`${f.ppg} pts/g vs ${f.proj} projected`);
    if (p.trendPct) {
      bits.push(`value ${p.trendPct > 0 ? "▲" : "▼"}${Math.abs(Math.round(p.trendPct * 100))}% in 30 days`);
    }
    if (f && f.snap != null) bits.push(`${f.snap}% snaps`);
    if (f && f.touches != null) bits.push(`${f.touches} touches/g`);
    else if (f && f.tgtShare != null) bits.push(`${f.tgtShare}% of targets`);
    return bits.join(" · ");
  }

  function tradeList(lg, panel, data) {
    const v = tradesView(data, Date.now(), readRequests()[lg.id]);
    const box = el("div");
    const bar = el("div", "tr-bar");
    bar.appendChild(el("span", "meta", v.generated
      ? `Researched ${fmtWhen(v.generated)} · week ${v.week}` + (v.reviewed ? " · double-checked" : "")
      : "No research for this league yet"));
    const btn = el("button", "ghost small", "Research new trades");
    btn.type = "button";
    if (!lg.trades.open) { btn.disabled = true; btn.title = lg.trades.reason; }
    bar.appendChild(btn);
    box.appendChild(bar);

    const reqSlot = el("div");
    box.appendChild(reqSlot);
    btn.addEventListener("click", () => requestResearch(lg, reqSlot));

    if (!lg.trades.open) {
      box.appendChild(el("p", "note warn", `${lg.trades.reason} No new trade ideas for this league.`));
    }

    if (v.running === "fresh") {
      const n = el("p", "note", `Researching new trades now (started ${fmtWhen(v.started)}). ` +
        `Check back in 15–30 minutes. `);
      const again = el("a", null, "Check again");
      again.href = "#";
      again.addEventListener("click", (e) => { e.preventDefault(); loadTrades(lg, panel, true); });
      n.appendChild(again);
      box.appendChild(n);
    } else if (v.running === "stale") {
      box.appendChild(el("p", "note warn", `The research run started ${fmtWhen(v.started)} ` +
        `never finished. Tap Research new trades to try again.`));
    } else if (v.requested) {
      box.appendChild(el("p", "note", `You asked for new research at ` +
        `${fmtWhen(new Date(v.requested).toISOString())}. It shows up here once the run starts.`));
    }
    if (v.error) {
      box.appendChild(el("p", "note warn", `The last run failed (${fmtWhen(v.error.at)}): ` +
        `${v.error.reason} Showing the trades from before.`));
    }

    if (v.trades.length) {
      box.appendChild(el("p", "tr-intro", "Sell high: your players scoring above expectations. " +
        "Buy low: theirs scoring below it while still getting the ball. " +
        "Your slumping players are never offered."));
    }
    if (v.reason) box.appendChild(el("p", "note", v.reason));
    if (v.empty && !v.reason && !data) {
      box.appendChild(el("p", "none", lg.trades.open
        ? "Trade ideas are researched every Tuesday. Want some now? Tap Research new trades."
        : "Nothing to show."));
    }
    v.trades.forEach((t) => box.appendChild(tradeCard(t, () => openTrade(t.id))));
    if (v.trades.length) box.appendChild(credit(data));
    return box;
  }

  function sideSummary(label, players) {
    const d = el("span", "tc-side");
    d.appendChild(el("span", "tc-label", label));
    players.forEach((p) => {
      const line = el("span", "tc-pl", p.n);
      line.appendChild(el("span", "meta", ` ${posLabel(p.p)}`));
      const chip = tagChip(p);
      if (chip) line.appendChild(chip);
      d.appendChild(line);
    });
    return d;
  }

  function tradeCard(t, onOpen) {
    const b = el("button", "tcard");
    b.type = "button";
    const top = el("span", "tc-top");
    top.appendChild(el("span", "tc-who", `with ${t.partner.name}`));
    if (t.partner.record) top.appendChild(el("span", "meta", t.partner.record));
    top.appendChild(el("span", verdictClass(t.value), t.value.verdict));
    b.appendChild(top);
    const deal = el("span", "tc-deal");
    deal.appendChild(sideSummary("Give", t.give));
    const arrow = el("span", "tc-arrow", "→");
    arrow.setAttribute("aria-hidden", "true");
    deal.appendChild(arrow);
    deal.appendChild(sideSummary("Get", t.get));
    b.appendChild(deal);
    b.appendChild(el("span", "tc-head", t.headline));
    const foot = el("span", "tc-foot");
    foot.appendChild(el("span", null, `Your lineup ${signed(t.you.gainPct)}%`));
    foot.appendChild(el("span", null, `Theirs ${signed(t.them.gainPct)}%`));
    foot.appendChild(el("span", "tc-more", "Why ›"));
    b.appendChild(foot);
    b.addEventListener("click", onOpen);
    return b;
  }

  function dealTable(label, players) {
    const wrap = el("div", "deal-side");
    wrap.appendChild(el("h4", null, label));
    const rows = players.map((p) => {
      const tr = el("tr");
      const nm = el("td", "nm", p.n);
      if (p.status) nm.appendChild(el("span", OUT_STATUSES.has(normStatus(p.status)) ? "out" : "q", normStatus(p.status)));
      else if (p.sidelined) nm.appendChild(el("span", "out", "IR"));
      nm.appendChild(el("span", "meta", ` ${posLabel(p.p)}${p.t ? " · " + p.t : ""}`));
      const chip = tagChip(p);
      if (chip) nm.appendChild(chip);
      const line = formLine(p);
      if (line) nm.appendChild(el("span", "form", line));
      tr.appendChild(nm);
      const v = el("td", "val", num(p.v));
      v.title = "FantasyCalc value";
      tr.appendChild(v);
      return tr;
    });
    wrap.appendChild(table(rows));
    return wrap;
  }

  function bullets(title, items) {
    const sec = el("section", "why");
    sec.appendChild(el("h3", null, title));
    const ul = el("ul");
    items.forEach((t) => ul.appendChild(el("li", null, t)));
    sec.appendChild(ul);
    return sec;
  }

  function credit(data) {
    const url = (data && data.values_source && data.values_source.url) || "https://fantasycalc.com";
    const p = el("p", "credit");
    p.appendChild(document.createTextNode("Trade values from "));
    const a = el("a", null, "FantasyCalc");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    p.appendChild(a);
    p.appendChild(document.createTextNode(", built from real trades in leagues like yours. " +
      "Research and reasoning by Claude."));
    return p;
  }

  /* One line comparing a pick's market price with what picks in the same
   * round have become in this league's own past drafts. */
  function pickCheck(pk, hist) {
    const r = hist && (hist.rounds || []).find((x) => x.round === pk.round);
    if (!r || r.median == null) return "";
    const rd = ORDINAL[pk.round] || `${pk.round}th`;
    const yrs = (hist.seasons || []).slice().sort();
    const span = yrs.length > 1 ? `${yrs[0]}–${yrs[yrs.length - 1]}` : yrs[0] || "past";
    const verdict = pk.v > r.median * 1.2 ? "the market pays more than they've been worth here"
      : pk.v < r.median * 0.8 ? "they've been worth more here than the market pays" : "about what the market pays";
    return `${pk.n} (${num(pk.v)}): ${rd}-round picks in this league's ${span} drafts are worth a median ` +
      `${num(r.median)} today, and ${r.busts}% are worth almost nothing: ${verdict}.`;
  }

  function tradeDetail(lg, data, t) {
    const box = el("div", "tdetail");
    const back = el("button", "ghost small back", "‹ All trades");
    back.type = "button";
    back.addEventListener("click", closeTrade);
    box.appendChild(back);

    box.appendChild(el("h2", "td-title", t.headline));
    const who = el("p", "td-who");
    who.appendChild(document.createTextNode(`with ${t.partner.name}` +
      `${t.partner.record ? ` (${t.partner.record})` : ""} `));
    who.appendChild(el("span", "chip", `${t.confidence} confidence`));
    box.appendChild(who);
    if (t.summary) box.appendChild(el("p", "td-sum", t.summary));

    const deal = el("div", "deal");
    deal.appendChild(dealTable("You give", t.give));
    deal.appendChild(dealTable("You get", t.get));
    box.appendChild(deal);

    const v = t.value;
    const pct = Math.round(Math.abs(v.diffPct) * 100);
    const check = el("p", "vcheck");
    check.appendChild(el("span", verdictClass(v), v.verdict));
    let txt = ` FantasyCalc: you give ${num(v.give)}, you get ${num(v.get)}`;
    if (t.give.length === 1 && t.get.length === 1) {
      txt += pct ? ` (${v.diffPct > 0 ? "+" : "−"}${pct}% for you).` : ". Dead even.";
    } else {
      // The verdict is on package-adjusted values, so say why raw totals that
      // differ still count as even (or by how much they don't).
      txt += ". Counting second pieces at a discount, ";
      txt += pct ? `${v.diffPct > 0 ? "you come" : "they come"} out ${pct}% ahead.` : "it's dead even.";
    }
    check.appendChild(document.createTextNode(txt));
    box.appendChild(check);

    const impact = el("p", "impact");
    impact.textContent = `Starting lineup value: yours ${signed(t.you.gainPct)}%, ` +
      `theirs ${signed(t.them.gainPct)}%.`;
    box.appendChild(impact);
    const ch = t.you.changes || {};
    const changes = [];
    if ((ch.in || []).length) {
      changes.push(`Starts for you: ${ch.in.map((c) => `${c.n} (${SLOT_LABEL[c.slot] || c.slot})`).join(", ")}`);
    }
    if ((ch.out || []).length) changes.push(`Leaves your lineup: ${ch.out.map((c) => c.n).join(", ")}`);
    if (t.you.drop) changes.push(`You'd drop ${t.you.drop.n} to make room.`);
    if (changes.length) {
      const ul = el("ul", "changes");
      changes.forEach((c) => ul.appendChild(el("li", null, c)));
      box.appendChild(ul);
    }

    // What picks in this deal have actually turned into in this league.
    for (const pk of t.give.concat(t.get).filter((p) => p.isPick)) {
      const line = pickCheck(pk, data && data.draft_history);
      if (line) box.appendChild(el("p", "note pickcheck", line));
    }

    const why = t.why || {};
    SECTIONS.forEach((k) => {
      const items = why[k] || [];
      if (k === "experts" && !items.length) return;
      box.appendChild(bullets(sectionHeading(k, t), items));
    });
    if ((t.risks || []).length) box.appendChild(bullets("Risks", t.risks));

    if ((t.sources || []).length) {
      const sec = el("section", "why sources");
      sec.appendChild(el("h3", null, "Sources"));
      const ul = el("ul");
      t.sources.forEach((s) => {
        if (!isHttps(s.url)) return;
        const li = el("li");
        const a = el("a", null, s.title || s.url);
        a.href = s.url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        li.appendChild(a);
        ul.appendChild(li);
      });
      sec.appendChild(ul);
      box.appendChild(sec);
    }

    const back2 = el("button", "ghost small back", "‹ All trades");
    back2.type = "button";
    back2.addEventListener("click", closeTrade);
    box.appendChild(back2);
    box.appendChild(credit(data));
    return box;
  }

  /* A static page can't start a Claude run by itself (the routine API
   * doesn't allow browser calls, and its token can't live in public code),
   * so hand the request to Claude: copy it, then open the routine. */
  function requestResearch(lg, slot) {
    const text = `Research new trades for my Sleeper league "${lg.name}" (league_id ${lg.id}).`;
    slot.innerHTML = "";
    const box = el("div", "note req");
    const msg = el("p", null, "Copying the request…");
    box.appendChild(msg);
    const steps = el("ol");
    [`Open Claude below and tap “${ROUTINE_NAME}”.`, "Tap Run now, paste, and run it.",
     "Come back in 15–30 minutes. New trades land here."]
      .forEach((s) => steps.appendChild(el("li", null, s)));
    box.appendChild(steps);
    const field = el("input", "req-text");
    field.readOnly = true;
    field.value = text;
    field.setAttribute("aria-label", "Research request");
    field.addEventListener("focus", () => field.select());
    box.appendChild(field);
    const go = el("a", "btn", "Open Claude ↗");
    go.href = ROUTINES_URL;
    go.target = "_blank";
    go.rel = "noopener noreferrer";
    box.appendChild(go);
    slot.appendChild(box);
    markRequested(lg.id);

    const done = (ok) => {
      msg.textContent = ok ? "✓ Request copied." : "Copy this request:";
      if (!ok) { field.focus(); field.select(); }
    };
    try {
      navigator.clipboard.writeText(text).then(() => done(true), () => done(false));
    } catch (e) {
      done(false);
    }
  }

  window.addEventListener("DOMContentLoaded", () => {
    const params = new URLSearchParams(location.search);
    // ?embed=1 is how the browser extension's side panel frames this page
    // next to sleeper.com: a compact layout, and a league picked by id
    // instead of typed in.
    const embed = params.get("embed") === "1";
    if (embed) document.body.classList.add("embed");

    $("#form").addEventListener("submit", (e) => {
      e.preventDefault();
      go($("#username").value);
    });
    $("#refresh").addEventListener("click", (e) => {
      e.preventDefault();
      refresh();
    });

    let saved = null;
    try { saved = localStorage.getItem("sleeperUser"); } catch (e) { /* private mode */ }
    const startUser = params.get("user") || saved;
    if (startUser) $("#username").value = startUser;
    if (startUser) go(startUser);

    const startLeague = params.get("league");
    if (embed && startLeague && /^\d+$/.test(startLeague)) selectLeagueById(startLeague);

    if (embed) {
      // The content script reports the sleeper.com tab's current league
      // whenever it navigates; the panel relays it here.
      window.addEventListener("message", (e) => {
        const msg = e.data;
        if (!msg || msg.type !== "sr-league") return;
        const id = String(msg.id || "");
        if (/^\d+$/.test(id)) selectLeagueById(id);
      });
    }
  });
}
