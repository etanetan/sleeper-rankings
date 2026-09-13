# sleeper-rankings

Enter a Sleeper username, pick a league, see this week's positional ranks for
your roster and the lineup they imply.

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

## FantasyPros consensus rankings

`build.py` fetches expert consensus ranks from the official FantasyPros API and
publishes them to `data/rankings.json`. The page prefers that file when it
exists and falls back to projection ranks when it doesn't, so turning this on
or off changes nothing else.

It runs as a build step for one unavoidable reason: the API needs a key, this
site is public, and a key shipped to the browser is a published key. GitHub
secrets are only readable from an Actions runner, so the call happens there.

### Enabling it

1. **Settings → Secrets and variables → Actions → New repository secret**,
   named `FANTASYPROS_API_KEY`.
2. Move `workflow.yml` to `.github/workflows/build.yml`.
3. **Settings → Pages → Source: GitHub Actions.**

The first run's `Probe data sources` step reports whether the key works and
what the API returns, without printing the key.

### Keeping the two normalizers in step

FantasyPros ranks by player name, Sleeper rosters are player IDs, so the join
runs through a normalized name - in Python in `build.py`, in JavaScript in
`app.js`. If those drift the join fails silently and players just look
unranked, so `test_norm_parity.py` runs both over the same names and compares.

## Tests

```bash
node test_app.js      # 84 assertions: name matching, scoring, ranking, lineups
python3 test_build.py # 23 assertions: the optional build, hosts, secret hygiene
```
