# sleeper-rankings

Enter a Sleeper username, pick a league, see this week's projected positional
ranks for your roster and the lineup they imply.

**→ [etanetan.github.io/sleeper-rankings](https://etanetan.github.io/sleeper-rankings)**

## Data sources

Two official APIs. Nothing is scraped.

| Source | Used for | Where |
| --- | --- | --- |
| **FantasyPros API** `consensus-rankings` | expert consensus ranks by position and scoring format | build, needs an API key |
| **Sleeper** `/v1/players/nfl` | names, positions, teams, injury status | build, at most once a day |
| **Sleeper** `/projections/nfl/...` | projected points, and fallback ranks | live in the browser, prebuilt as backup |
| **Sleeper** `/v1/user/...`, `/leagues`, `/rosters` | your leagues and rosters | live in the browser |

An earlier version scraped the FantasyPros website. That was replaced with
their official API: same data, authorized access. A test asserts the build
never requests a host outside those two APIs.

Sleeper asks callers to keep the ~5MB player dictionary to one pull per day, so
it's cached per calendar day via `actions/cache`.

### The API key

`FANTASYPROS_API_KEY` is read from the environment and must be stored as a
**repository secret**, never committed. This site is public: a key shipped to
the browser is a published key, which is why the FantasyPros call happens in
the build rather than on the page.

If the key is missing or rejected, the build still publishes - the page falls
back to ranking by projected points and shows a "Projection ranks" chip so the
difference is visible rather than silent.

## How the two are joined

FantasyPros ranks players by name; Sleeper rosters are lists of player IDs. The
build writes a normalized match key into `players.json` (lowercased, accents
folded, punctuation and generational suffixes stripped - so `De'Von Achane`,
`Amon-Ra St. Brown` and `Kenneth Walker III` line up), and defenses match on
team abbreviation with an alias map for the handful Sleeper and FantasyPros
spell differently (`JAX`/`JAC`, `WAS`/`WSH`, `LV`/`LVR`).

## Scoring

Each league's `scoring_settings.rec` selects the FantasyPros scoring variant:

| `rec` | Variant |
| --- | --- |
| `1.0` | PPR |
| `0.5` | HALF |
| `0` | STD |

QB, K and DST rankings don't vary by scoring and use one list.

Projected points are shown next to every rank, and those *are* computed from
the league's full `scoring_settings` - every stat line multiplied through the
league's actual values, including 6-point passing TDs and TE premium. So the
rank is expert consensus while the points column reflects your exact league.

### Known limits

Consensus rankings come in three buckets, so a league with unusual scoring
(TE premium, 6-point passing TDs) gets the closest standard variant. The
points column is exact; the rank is the nearest published list. Leagues with
TE premium show a chip as a reminder to nudge tight ends up.

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

1. **Add the API key.** Settings -> Secrets and variables -> Actions ->
   New repository secret, named `FANTASYPROS_API_KEY`.
2. **Activate the workflow.** Open `workflow.yml` -> pencil icon -> rename to
   `.github/workflows/build.yml` (typing the slashes moves it) -> Commit. It
   lives in the root because the token that created this repo lacked GitHub's
   `workflow` scope.
3. **Settings -> Pages -> Source: GitHub Actions.**
4. **Actions -> Build rankings -> Run workflow.**

The first run's `Probe data sources` step reports whether the key works, which
positions and scoring formats it can reach, and the exact response shape.
