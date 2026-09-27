# sleeper-rankings

Enter a Sleeper username, pick a league, see this week's positional ranks for
your roster, the lineup they imply, and researched trade ideas.

**→ [etanetan.github.io/sleeper-rankings](https://etanetan.github.io/sleeper-rankings)**

## No build, no server, no key

The site is three static files. Your browser does all the work: it asks Sleeper
for the current week, your leagues, your rosters and this week's projections,
and ranks everything locally. Nothing is stored anywhere but your own device.

That means **GitHub Actions is not required** and nothing needs to run on a
schedule. Publish the files and it works.

### Turning it on

**Settings → Pages → Source: Deploy from a branch → `main` → `/ (root)` → Save.**

That's it. No secrets, no workflow, no build step.

## How ranks are computed

Sleeper publishes projected stat lines. Each one is multiplied through the
league's own `scoring_settings`, then players are ranked within their position.
Because the scoring is the league's actual configuration rather than a preset,
this handles what a generic ranking list can't:

- Any per-reception value: full, half, quarter PPR
- 4-point vs 6-point passing touchdowns
- TE premium (`bonus_rec_te`), applied per reception to tight ends only
- Custom yardage, turnover and defensive values

The same player can be WR2 in one of your leagues and WR6 in another, and that
difference is real. The points column next to each rank is that player's
projection under that league's exact rules.

### Lineup logic

Slots fill most-restrictive-first, so a flex slot can't take the only player
eligible for a dedicated one. Dedicated slots rank by positional rank; flex
slots compare projected points, which is valid because every player on the page
is scored by the same settings. `SUPER_FLEX` takes a QB whenever one is
available.

Players who won't take the field sink to the bottom: out, doubtful, IR, PUP,
suspended, and anyone on bye that week. Questionable players still start. When
a well-ranked player is held out, the page names him and says why, because a
WR6 sitting on the bench otherwise looks like a bug.

Slots still have to be filled, so if the healthy players at a position run out,
an unavailable one is started anyway. That case is called out separately - it
means the roster is short, not that the pick is good.

### Known limits

Kicker and defense scoring are approximate. Sleeper projects a single `fgm` and
`pts_allow` figure while leagues score those in distance and points-allowed
tiers, so K and DST ranks are rougher than the skill positions. Everything else
is scored exactly.

### Caching

Sleeper's player dictionary is ~5MB and is the only way to turn roster player
IDs into names. Sleeper asks callers not to pull it more than once a day, so the
page trims it to the fantasy positions and keeps it in `localStorage` for 20
hours. Everything else is fetched fresh on each visit.

## Trades tab

Every Tuesday a Claude routine researches trades for each league where trading
is open, and the Trades tab shows at least five per league: who to give, who to
get, and tapping a trade shows why, with sources.

**How trades are chosen: like a market.** A trade that's fair by market value
is one the other manager will accept; the edge is knowing the market has a
player mispriced.

- **Sell high:** your players scoring well above their projections, or whose
  market value just jumped, when their role doesn't support it.
- **Buy low:** other teams' players scoring below projection, or whose value
  just dropped, while they're still getting the snaps and targets.
- **Never sell low:** your slumping players are never offered.
- **Don't buy high:** other teams' players on a heater rank lower.

**How a run works**

1. `trades/engine.js candidates` pulls rosters from Sleeper, this season's
   stats and past projections (scored with each league's settings) for points
   per game against projection, snap share, target share and touches, and
   market values and 30-day trends from FantasyCalc, scaled to the league.
   It tags every player (sell high, hold, buy low, avoid), then searches every
   1-for-1 up to 2-for-2 with every other team and keeps trades that are
   **fair** (within 10% after discounting the extra piece in uneven deals)
   and either carry an angle or clearly help both lineups.
2. Claude researches the market first — the week's buy-low / sell-high
   columns and trade value charts, usage reports, injuries — confirms or
   overrides the tags, and re-runs the search with those calls. Then it
   researches each trade and writes the reasons.
3. `trades/engine.js finalize` merges the research back in. Numbers come from
   the engine, never the write-up. It refuses anything outside FantasyCalc's
   ±10%, fewer than five trades without a stated reason, and any trade that
   sells one of your slumping players.
4. The result is pushed to the `claude/trade-data` branch as
   `<league_id>.json`. The page reads it from raw.githubusercontent.com, so a
   run never touches the site.

The instructions Claude follows are in
[`.claude/skills/trade-research/SKILL.md`](.claude/skills/trade-research/SKILL.md).

**On demand.** *Research new trades* copies a request naming the league and
opens Claude's routines page; tap **Run now** on *Sleeper trade research* and
paste it. A static page can't start the run itself: the routine API doesn't
accept browser calls, and its token can't be shipped in public code.

**Network.** The routine needs to reach `api.sleeper.app`, `api.sleeper.com`
and `api.fantasycalc.com` (plus news sites for the research), so its cloud
environment needs network access beyond the default **Trusted** list.

### Why FantasyCalc validates the trades

| Calculator | Values come from | Redraft in season | Adjusts for format | Machine access |
|---|---|---|---|---|
| **FantasyCalc** | Millions of real trades in real leagues | Yes, daily | Redraft/dynasty, 1QB/SF, PPR, team count | Documented API, keyed by Sleeper ID |
| KeepTradeCut | Crowd "keep/trade/cut" votes | Yes (dynasty first) | 1QB/SF, TEP | None; terms forbid scraping |
| FantasyPros | Expert consensus + weekly trade value chart | Yes | Scoring | API free tier caps at 10 players per position |
| Draft Sharks | Their own projections | Yes | Custom scoring | None; full values paywalled |
| PFN, RotoTrade, Fantasy Draft Pros | In-house analyst or model values | Yes | Varies | None |
| CBS / Yahoo weekly charts | One analyst's weekly article | Yes | PPR / non-PPR | Articles only |

FantasyCalc is the only one that is market-based, scaled to each league, and
usable without breaking anyone's terms. Its terms ask for non-commercial use,
at most daily fetches and a visible link, which the Trades tab carries. The
expert charts are still used, as research inputs rather than as the scale.

## FantasyPros consensus rankings (tried, not in use)

**Currently disabled.** The plan available to this project returns only the top
10 players per position (`"public_api_limited": true`), which isn't enough to
rank a full roster - most players would show no rank at all. Sleeper's
projections cover every player, so the site uses those.

The code below still works and is kept for if that ever changes. To turn it
back on, restore the workflow and follow the steps in this section.

### How it worked

`build.py` fetches expert consensus ranks from the official FantasyPros API and
publishes them to `data/rankings.json`. The page prefers that file when it
exists and falls back to projection ranks when it doesn't, so turning this on
or off changes nothing else.

It runs as a build step for one unavoidable reason: the API needs a key, this
site is public, and a key shipped to the browser is a published key. GitHub
secrets are only readable from an Actions runner, so the call happens there.

### Re-enabling it

1. Store the key as a repository secret named `FANTASYPROS_API_KEY`.
2. Restore a workflow at `.github/workflows/build.yml` that runs `build.py`
   with that secret and publishes `site/`.
3. **Settings → Pages → Source: GitHub Actions.**

The `Probe data sources` step reports whether the key works and whether the
plan caps the list, without printing the key.

Notes from the one real run: the position is spelled `FLX`, not `FLEX` (and
`OP` for superflex), and the free tier rate-limits hard enough that calls need
pacing and retries.

### Keeping the two normalizers in step

FantasyPros ranks by player name, Sleeper rosters are player IDs, so the join
runs through a normalized name - in Python in `build.py`, in JavaScript in
`app.js`. If those drift the join fails silently and players just look
unranked, so `test_norm_parity.py` runs both over the same names and compares.

## Tests

```bash
node test_app.js      # name matching, scoring, ranking, lineups
node test_trades.js   # trade windows, fairness, candidate search, finalize gate
python3 test_build.py # the optional build, hosts, secret hygiene
```
