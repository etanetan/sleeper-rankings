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
available. Out, doubtful, IR, PUP and suspended players sink to the bottom;
questionable players still start.

### Caching

Sleeper's player dictionary is ~5MB and is the only way to turn roster player
IDs into names. Sleeper asks callers not to pull it more than once a day, so the
page trims it to the fantasy positions and keeps it in `localStorage` for 20
hours. Everything else is fetched fresh on each visit.

## Optional: FantasyPros consensus rankings

`build.py` and `workflow.yml` are **optional extras**, not part of the site.
They fetch expert consensus ranks from the official FantasyPros API and publish
them to `data/rankings.json`; the page picks that file up automatically if it
exists and falls back to projections if it doesn't.

This needs GitHub Actions, for an unavoidable reason: the FantasyPros API needs
a key, this site is public, and a key shipped to the browser is a published key.
Secrets only exist inside Actions runners - a static page has no way to read
one. So the choice is a build step, or no consensus rankings.

To enable it: store the key as a repository secret named
`FANTASYPROS_API_KEY`, move `workflow.yml` to `.github/workflows/build.yml`,
and switch Pages to "GitHub Actions" as its source.

## Tests

```bash
node test_app.js      # 84 assertions: name matching, scoring, ranking, lineups
python3 test_build.py # 23 assertions: the optional build, hosts, secret hygiene
```
