# Roadmap: next features

A hand-off plan. Each numbered task below is written to be implemented on its
own, in a fresh session, by an agent that has read `CLAUDE.md` and nothing
else from earlier conversations. Do them in order unless the owner says
otherwise: later tasks reuse pieces from earlier ones (icons from 1, the
opponent/users fetch from 4, the storage adapter from 3).

To hand one off: start a new session and say *"Implement task N from
docs/ROADMAP.md."* One task per session keeps context small.

## Rules for every task

- Read `CLAUDE.md` first. It's the source of truth for commands, deploy and
  architecture; this file doesn't repeat it.
- Pure logic goes in `core.js` (DOM-free, added to `module.exports`), API
  calls and view-model fields in `data.js`, rendering in `app.js`. Anything
  extension-only goes in `extension/`.
- After changing `core.js`/`data.js`: `node extension/sync.js`. After changing
  `core.js`/`data.js`/`app.js`/`style.css`: bump its `?v=N` in `index.html`.
- Every new pure function gets `check(...)` cases in `test_app.js` (or
  `test_extension.js` for extension helpers). Run all five test commands from
  `CLAUDE.md` before committing; all must pass.
- Serve locally (`python3 -m http.server 8765`) and load the page with a real
  username (`etanetan`) to check the new UI renders without console errors.
  Use Playwright + the preinstalled Chromium if you want a screenshot.
- Commit straight to `main`, then `git push origin main main:gh-pages`. No PR.
  One commit per task (or per part, where a task has parts).
- **Sleeper's own DOM (sleeper.com) can't be seen from the cloud session** -
  it's behind the owner's login. Anything that depends on sleeper.com markup
  (selectors, URL paths like `/matchup`) is a guess until the owner checks it.
  Say so in the final message and list exactly what they should look at.
- Never add anything that *writes* to Sleeper (setting lineups, claiming
  players). Read-only is a deliberate decision (Sleeper ToS).
- Sleeper API endpoints below are from the public docs
  (https://docs.sleeper.com). If a response shape differs from what's
  described here, trust the real response - `curl` it first.

---

## 1. Firefox: a signed, permanent, auto-updating install

**Why.** Firefox only keeps an unsigned extension until the browser restarts
("Load Temporary Add-on"). Release Firefox refuses unsigned extensions
permanently. Mozilla signs extensions for free through addons.mozilla.org
(AMO) with an **unlisted** channel: signed, installable forever, not
published in the store, automated review (usually minutes). With an
`update_url`, Firefox then updates it on its own.

Chrome needs nothing here: "Load unpacked" already survives restarts.

Note what actually needs a new signed version: only changes under
`extension/` (content script, manifest, bg). The side panel is an iframe of
the live site, so site features reach Firefox without re-signing.

### 1a. Manifest and icons (agent)

1. Add icons. There are none today, so the toolbar shows a generic puzzle
   piece. Write `tools/make_icons.py` (stdlib only - no Pillow; write PNGs
   with `zlib` + `struct`) that draws a simple mark (e.g. an amber `#d97706`
   rounded square with three white ascending bars, like a bar chart) and
   writes:
   - `extension/icons/icon-{16,32,48,128}.png`
   - `icons/icon-{180,192,512}.png` at the repo root (used by task 2's PWA)
   Commit the PNGs and the script.
2. `extension/manifest.json`:
   - `"version": "1.1.0"`
   - `"icons"` and `"action.default_icon"` pointing at the extension icons.
   - Under `browser_specific_settings.gecko` add:
     ```json
     "strict_min_version": "140.0",
     "update_url": "https://etanetan.github.io/sleeper-rankings/extension/updates.json",
     "data_collection_permissions": { "required": ["none"] }
     ```
     `data_collection_permissions` is mandatory for new AMO submissions
     since Nov 2025 and needs Firefox 140+. `"none"` is accurate: the
     extension sends nothing to the developer; it only fetches public
     Sleeper data the user asked for. (If AMO's validator rejects it, report
     the message to the owner rather than picking a category yourself.)
3. `test_extension.js`: add checks that every icon path in the manifest
   exists, `strict_min_version` is present, `update_url` is https on
   `etanetan.github.io`, and `data_collection_permissions.required` is a
   non-empty array. If `extension/updates.json` exists, check its addon id
   equals the gecko id and every `update_link` is https under
   `https://etanetan.github.io/sleeper-rankings/extension/dist/`.
4. Lint: `npx --yes web-ext@8 lint --source-dir extension --self-hosted`. The
   `--self-hosted` flag matters: without it, `lint` assumes AMO-listed
   distribution and hard-errors on `update_url` (`MANIFEST_UPDATE_URL`,
   "not allowed for Mozilla-hosted add-ons") even though it's exactly right
   for a self-distributed/unlisted extension - `--self-hosted` turns that
   off. Fix any other errors. Expected, acceptable warnings: `sidePanel`
   permission unknown to Firefox, `background.service_worker` ignored by
   Firefox (the manifest carries both on purpose - see `bg.js`), and the two
   `sidePanel.setPanelBehavior is not supported` notices from `bg.js` (same
   cause - it's feature-detected there and is dead code on Firefox).
   Mention any others to the owner. `web-ext sign` (task 1b) validates
   against AMO's real API instead of this local ruleset and has no
   `--self-hosted` equivalent - it accepts `update_url` for an unlisted
   submission without it.

### 1b. Release script (agent)

`extension/release.js` (Node, no dependencies), run as
`node extension/release.js`:

1. Refuse to run unless `WEB_EXT_API_KEY` and `WEB_EXT_API_SECRET` are set
   (print where to get them: https://addons.mozilla.org/developers/addon/api/key/).
2. Refuse if `extension/dist/` already has an xpi for the manifest's version
   (AMO rejects re-signing a version; the fix is bumping `version`).
3. Run `node extension/sync.js`, then
   `npx --yes web-ext@8 sign --channel=unlisted --source-dir extension
   --artifacts-dir extension/dist --ignore-files release.js sync.js dist
   updates.json` (web-ext reads the key/secret from the env vars).
4. Rename the produced xpi to `sleeper-rankings-<version>.xpi` and write
   `extension/updates.json`:
   ```json
   { "addons": { "sleeper-rankings@etanetan.github.io": { "updates": [
     { "version": "1.1.0",
       "update_link": "https://etanetan.github.io/sleeper-rankings/extension/dist/sleeper-rankings-1.1.0.xpi" }
   ] } } }
   ```
   Append to the `updates` list; don't drop older entries.
5. Print the next steps: commit `extension/dist/` + `updates.json`, push
   `main` and `gh-pages`, open the xpi URL in Firefox.

Also add a "Releasing the Firefox build" section to `CLAUDE.md` under
Deploying: bump `manifest.json` version → `node extension/release.js` →
commit → push both branches. Firefox checks `update_url` about once a day
(`about:addons` → gear → "Check for Updates" to force it).

Do **not** run the signing step in the cloud session - it needs the owner's
AMO keys, which should never be pasted into chat or committed.

### 1c. Owner's steps (tell the owner these; the agent can't do them)

1. Sign in at https://addons.mozilla.org (free Firefox account) and create
   API credentials at https://addons.mozilla.org/developers/addon/api/key/.
2. On your own machine, in the repo:
   ```bash
   git pull
   export WEB_EXT_API_KEY='user:...'   WEB_EXT_API_SECRET='...'
   node extension/release.js
   git add extension/dist extension/updates.json && git commit -m "Sign Firefox 1.1.0"
   git push origin main main:gh-pages
   ```
3. Remove the temporary add-on in `about:debugging`, then open
   `https://etanetan.github.io/sleeper-rankings/extension/dist/sleeper-rankings-1.1.0.xpi`
   in Firefox → Install. It now survives restarts and auto-updates.

---

## 2. Installable site (PWA)

**Why.** "Add to Home Screen" on a phone gives an app icon that opens the
site full-screen - most lineup checks happen on a phone on Sunday morning.

1. `manifest.webmanifest` at the repo root: `name` "Weekly Sleeper
   Rankings", `short_name` "Rankings", `start_url` "./", `scope` "./",
   `display` "standalone", `background_color`/`theme_color` matching
   `style.css`'s page background, icons 192 and 512 from task 1
   (`icons/icon-192.png`, `icons/icon-512.png`, `"purpose": "any"`).
2. `index.html` `<head>`: `<link rel="manifest" href="manifest.webmanifest">`,
   `<link rel="apple-touch-icon" href="icons/icon-180.png">`,
   `<meta name="theme-color" content="...">`,
   `<meta name="apple-mobile-web-app-capable" content="yes">`.
3. **No service worker.** Chrome no longer requires one to install, and a
   caching worker would fight the `?v=N` cache-busting and serve stale
   injury data. Leave a one-line comment saying so.
4. `test_build.py`: manifest parses as JSON, every icon it lists exists,
   `index.html` links it.

---

## 3. Extension polish: tooltips, live refresh, robust rows, debug dump

All in `extension/content.js` / `content.css` / `test_extension.js`.

### 3a. Badge tooltips
Set `badge.title` to e.g. `"WR8 · 14.2 proj pts · Questionable"` (status only
when set; use core's `INJ_ABBR`/status text if a readable form exists, else
the raw status) and, for colored badges, why: `Start` / `Bench → start` /
`Start → bench` / `Out`. Put the string-building in a pure exported
`badgeTitle(meta, cls)` and test it.

### 3b. Refresh after the user edits their lineup
Today the pill and badge colors only compute on navigation, so after
swapping players on Sleeper they're stale. Re-run `loadContext(LEAGUE_ID)`
(which must first clear `data-sr` and existing `.sr-badge` elements so
badges are redrawn with new colors) when:
- the tab becomes visible again (`visibilitychange`), and
- after DOM mutations settle, but at most once per 30 s (keep the existing
  400 ms sweep debounce separate - sweeps are cheap, reloads hit the API).
`loadData()` is cached (player dump) so a reload is ~2 API calls.

### 3c. Selector-free row detection
The Team page row (`.team-roster-item`) is confirmed; the Players page and
matchup page rows are guesses. Make rows findable without class names:
starting from each player avatar (`SELECTORS.ariaAvatar`/`imgAvatar`), walk
up ancestors until reaching an element whose parent has ≥3 element children
that each contain an avatar - that element is the row. Implement the walk as
a pure exported function over plain objects
(`rowFor(el, hasAvatar)` using only `.parentElement` / `.children`) so
`test_extension.js` can test it with hand-built fake nodes. Use it as the
fallback when `SELECTORS.row` matches nothing containing that avatar. Cap the
walk at ~8 levels.

### 3d. Debug dump for pages we can't see
Alt+click on `#sr-pill` copies a short text outline to the clipboard: the
URL path, how many rows matched `SELECTORS.row` vs `rowFor`, and for the
first 3 rows the tag/class chain from row down to the name element plus
whether a player id was found. The owner pastes it into a session so
selectors can be fixed without guessing. Tell the owner about the shortcut.

Bump the manifest `version` (patch) - Firefox needs a new signed build (task 1b).

---

## 4. Matchup: projected score and win chance

**Why.** "Am I winning this week, and does my opponent have a hole?" is the
most-asked question after "who do I start".

### 4a. core.js
- `projectedTotal(entries)` - sum of `player.pts` over a `currentLineup`-shaped
  array (null players and null pts count 0). `lineupCheck` already does this
  inline; reuse it there.
- `winProb(mine, theirs)` - normal approximation: each team's σ = 0.2 ×
  its projection (minimum 10), combined σ = √(σa²+σb²), return Φ((mine −
  theirs)/σ). Implement Φ with an erf approximation (Abramowitz-Stegun
  7.1.26). Tests: equal → 0.5; `winProb(a,b)+winProb(b,a)` ≈ 1; bigger lead
  → higher; both 0 → 0.5.

### 4b. data.js (`buildLeagueView`)
- The week's matchups are already fetched. The opponent is the other entry
  with the same `matchup_id` (null `matchup_id` or no other entry → no
  opponent, e.g. a playoff bye).
- Opponent roster: `rosters.find(r => r.roster_id === opp.roster_id)`;
  build it with `buildRoster`, their set lineup with `currentLineup(opp.starters, slots, oppRoster)`.
- Names: fetch `${SLEEPER}/league/<id>/users` once per league (tolerate
  failure); team name is `metadata.team_name || display_name`. Keep a
  `names` map `{roster_id: name}` on the view - task 8 reuses it.
- Add to the view:
  ```js
  matchup: { oppName, mine: current, theirs: oppCurrent,
             myProj, oppProj, win,               // win = winProb(myProj, oppProj)
             myPts: mm.points, oppPts: opp.points,// live actual points, 0 before kickoff
             oppHoles }                           // opp starters unavailable()/onBye/empty
  ```
  or `matchup: null`. `myProj` should use the **best** lineup's total if the
  check isn't ok, and show both ("118.4 as set, 124.0 with changes").

### 4c. Site
New "Matchup" tab (add to `TAB_NAMES` and `tabBar`): header line
`You 118.4 – 104.2 Opp · 71% to win`, then two columns of starters by slot
(stack on narrow screens), opponent holes highlighted with the existing
out/bye styling, and live points once games start. Also show `71%` in the
league strip entry next to the lineup-check suffix.

### 4d. Extension
On `sleeper.com/leagues/<id>/matchup` (unverified path - match any path
containing `/matchup`), the pill shows `Proj 118–104 · 71%` instead of the
lineup-check text. Badges on the opponent's rows already work if 3c finds the
rows (opponent players are in `view.pool`). Flag both for the owner to check.

---

## 5. Coming up: bye and injury holes in the next 4 weeks

**Why.** Finding out on Saturday that you have no TE on bye week is avoidable;
this gives a few weeks' notice to grab a replacement.

- core.js `byeWeeks(schedule)` → `{ team: Set(weeks) }`: for every week that
  has games, any team that appears in some week but not this one is on bye.
  Prefer this over the player dump's `b` field (sometimes null in-season);
  fall back to `b` when there's no schedule.
- core.js `upcomingHoles(roster, slots, week, byes, horizon = 4)` → for each
  week `w` in `week+1 … week+horizon`: available players are those not on
  bye in `w` and not long-term out (`IR`, `PUP`, `SUS`, `NA` - *not* Q/D/OUT,
  which are this-week statuses). Run `pickLineup(available, slots)`; any
  slot left empty is a hole. Also list this week's best-lineup starters who
  are on bye in `w`. Return only weeks with a hole or ≥2 starters on bye:
  `[{ week, holes: ["TE"], byes: [player, …] }]`. Check how `pickLineup`
  represents an unfillable slot before relying on it. Tests: a roster with
  one TE on bye in week 7 → `{week:7, holes:["TE"]}`; IR player excluded;
  Q player still counts.
- data.js: `upcoming` on the view.
- Site: a compact "Coming up" card at the bottom of the Lineup tab ("Wk 7:
  no TE (Kittle on bye) · Wk 9: 3 starters on bye"); hidden when empty. In
  the Waivers tab, mark a waiver suggestion that fills an upcoming hole
  ("fills Wk 7 TE").

---

## 6. Game-day alerts and a toolbar count (extension)

**Why.** The single most valuable thing the extension can do without the
user opening anything: tell them a starter was ruled OUT before kickoff.

1. Move the chrome.storage adapter out of `content.js` into
   `extension/storage.js` (loaded before `content.js` in the manifest's
   content script list) so the background can use it too.
2. Pure `extension/alerts.js`, exported for Node: `alertsFor(view)` →
   `[{ key, title, message, url }]` for each starter in `view.current` who is
   `unavailable()`, on bye, or an empty slot, and **not** in `view.locked`.
   `key` = `${leagueId}:${week}:${playerId || "slot"+i}:${status}` so a new
   status (Q → OUT) alerts again but a repeat doesn't. Test it.
3. Background: Firefox `background.scripts: ["lib/core.js", "lib/data.js",
   "storage.js", "alerts.js", "bg.js"]`; Chrome's service worker stays
   `bg.js` and does `if (typeof importScripts === "function")
   importScripts("lib/core.js", "lib/data.js", "storage.js", "alerts.js")`.
   `chrome.alarms.create("sr-check", { periodInMinutes: 30 })` on install and
   startup; on alarm: read `sleeperUser` and `sleeperAlerts` (default true),
   run the loader for every league (`fetchLeagues` + `buildLeagueView`),
   notify for alert keys not already in `chrome.storage.local`'s
   `sr-alerted` (prune keys from past weeks), and set the toolbar badge:
   `action.setBadgeText` = number of leagues whose `check` isn't ok (empty
   when 0), amber background. Notification click opens that league's
   `sleeperUrl` (keep a notificationId → url map in storage;
   `tabs.create` needs no extra permission).
4. Manifest: add `"alarms"`, `"notifications"` permissions; bump version.
5. Options page (`options.html`/`options.js`, `options_ui` in manifest):
   Sleeper username (same `sleeperUser` sync key the panel uses) and an
   "Alert me when a starter is ruled out" checkbox (`sleeperAlerts`).
6. Test locally by loading unpacked in Chromium via Playwright if practical;
   otherwise say it's untested live and give the owner a checklist (set a
   known-OUT player as a starter in a test league, wait for the alarm or
   trigger it from the service worker console with
   `chrome.alarms.create("sr-check", {when: Date.now()+1000})`).

---

## 7. Last week's recap: did the rankings help?

**Why.** Trust. Showing "our lineup would have scored +6" (or honestly −3)
tells the owner whether to follow the tool.

Key fact: a past week's matchups (`/league/<id>/matchups/<w>`) include
`players` (the roster that week), `starters`, `points`, and
`players_points` (each player's actual points under this league's scoring,
computed by Sleeper). So no stats endpoint is needed.

- data.js: for `w = week − 1` (skip if < 1), fetch that week's projections
  (`loadProjections(season, w)`, shared across leagues) and the league's
  matchups for `w`. Score projections with the league settings
  (`rankPositions` as `ranksFor` does, but for that week's projections).
- core.js `recap(entry, slots, players, projRanks)` →
  `{ actual, ours, best }`:
  - `actual` = `entry.points`
  - `ours` = sum of `players_points` over `pickLineup(<that week's roster
    scored by that week's projections>, slots)` starters
  - `best` = same, but pick with `pts` replaced by `players_points`
    (perfect hindsight)
  Tests with a small hand-built entry.
- Site: one line at the top of the Lineup tab: "Week 3: you scored 112.4 ·
  our lineup 118.0 (+5.6) · best possible 131.2".
- Part B (separate commit): season totals across weeks 1…week−1. Completed
  weeks never change, so cache each `{league, week}` recap in storage
  forever; only the newest week costs API calls.

Limitation to note in a comment: injury statuses from that week aren't
available, so "ours" relies on projections already being ~0 for players who
were ruled out.

---

## 8. Waivers: who to drop, and the next 3 weeks

- **Add/drop pairing.** For each suggestion, name a drop: the bench player
  (not in the best lineup's starters, not in `roster.reserve`/`taxi` from
  the raw roster) with the lowest `pts`. Show "Add X · drop Y". Pure helper
  `dropCandidate(roster, best, reserveIds)` in core.js with tests.
- **3-week outlook.** In `loadData`, also fetch projections for `week+1` and
  `week+2` (failure-tolerant, shared across leagues). Per league, score them
  and give each waiver suggestion and each starter a `next3` average. Tag a
  suggestion "streamer" when it beats the weakest starter this week but not
  over 3 weeks, "hold" when it beats them over 3 weeks too. Keep sort order
  by this week's gain.

---

## 9. League power rankings

**Why.** Context for trades and for how scary next week's opponent is.

- Every roster is already fetched in `buildLeagueView`. For each: build it,
  `pickLineup`, total the starters' `pts`. Rank teams by that, alongside
  record (`roster.settings.wins/losses/ties`) and points for
  (`settings.fpts` + `fpts_decimal/100`). Names from task 4's `names` map.
- New "League" tab: rank, team, projected starters total, record, PF; the
  owner's row highlighted; the current opponent marked.
- Pure helper `powerRanks(rosters, players, ranks, week, slots)` in core.js,
  tested.

---

## Considered, not planned

- **One-click "apply lineup".** Would mean calling Sleeper's private write
  API. Declined: against Sleeper's ToS; the project stays read-only.
- **Trade-value overlay on sleeper.com's trade screen.** Needs FantasyCalc
  from the browser (CORS unknown) and Sleeper's trade-builder DOM (unseen).
  Revisit after 3d's debug dump makes unseen pages cheap to map.
- **Draft-board badges.** Drafts live under `sleeper.com/draft/...`, outside
  the content script's match. Worth doing before next August's drafts.
- **Chrome Web Store listing.** $5 one-time; unpacked already persists in
  Chrome, so only worth it to share the extension with friends.
