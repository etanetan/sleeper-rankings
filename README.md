# sleeper-rankings

Enter a Sleeper username, pick a league, see this week's projected positional
ranks for your roster and the lineup they imply.

**→ [etanetan.github.io/sleeper-rankings](https://etanetan.github.io/sleeper-rankings)**

## Data sources

Everything comes from **Sleeper's own public API**. Nothing is scraped.

| Endpoint | Used for | Where |
| --- | --- | --- |
| `/v1/state/nfl` | current season and week | build |
| `/v1/players/nfl` | player names, positions, teams, injury status | build, at most once a day |
| `/projections/nfl/{season}/{week}` | projected stat lines | live in the browser, prebuilt as fallback |
| `/v1/user/{name}`, `/v1/user/{id}/leagues`, `/v1/league/{id}/rosters` | your leagues and rosters | live in the browser |

An earlier version of this project scraped FantasyPros' consensus rankings.
That was removed: their rankings are a commercial product, we have no
permission to automate against them, and Sleeper publishes everything needed
anyway. Nothing here requests a host other than Sleeper, and a test asserts it.

Sleeper asks callers to keep the ~5MB player dictionary to one pull per day, so
it's cached per calendar day via `actions/cache` and the build reuses it.

## Scoring

Ranks are **computed per league from its own `scoring_settings`**, not picked
from a generic PPR/half/standard list. Each projected stat line is multiplied
through the league's actual scoring values, so the same player can be WR2 in
one of your leagues and WR6 in another, and that difference is real.

This handles what a generic ranking list can't:

- Full, half, quarter or any other per-reception value
- 4-point vs 6-point passing touchdowns
- TE premium (`bonus_rec_te`), applied per reception for tight ends only
- Custom yardage, turnover and defensive values

Positional rank is that player's place among **everyone** at the position under
those settings, so QB1 means the best projected quarterback in the league's
scoring, not just the best on your roster.

### Known limits

Defensive scoring is approximate: Sleeper projects `pts_allow` as a single
number while leagues score it in tiers, so DST ranks are rougher than the rest.
Projections are also projections - they're a model, not expert consensus.

## Lineup logic

Slots fill most-restrictive-first, so a flex slot can't take the only player
eligible for a dedicated one. Dedicated slots rank by positional rank; flex
slots compare projected points directly, which is valid because every player is
scored by the same league settings. `SUPER_FLEX` takes a QB whenever one is
available. Out, doubtful, IR, PUP and suspended players sink to the bottom;
questionable players still start.

## Freshness

The page tries to fetch projections live from Sleeper on every visit, so injury
news is reflected immediately. If that request fails it falls back to the
prebuilt copy and says how old it is, warning above the results past 36 hours.

Builds run daily at ~9am ET, hourly on Sunday 8am-1pm ET, on demand, and on
push.

## Tests

```bash
python3 test_build.py   # caching, projection parsing, no-scraping assertions
node test_app.js        # scoring, per-league ranking, lineup construction
python3 probe.py        # optional: reports live endpoint shape and CORS
```

Both suites run in CI before the site is built.

## Setup

The Actions workflow lives at `workflow.yml` in the repo root because the token
that created this repo lacked GitHub's `workflow` scope. To activate:

1. Open `workflow.yml` -> pencil icon -> rename to `.github/workflows/build.yml`
   (typing the slashes moves it) -> Commit.
2. **Settings -> Pages -> Source: GitHub Actions.**
3. **Actions -> Build rankings -> Run workflow.**
