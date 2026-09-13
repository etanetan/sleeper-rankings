# sleeper-rankings

Enter a Sleeper username, pick a league, see this week's FantasyPros expert
consensus ranks for your roster and the lineup those ranks imply.

**→ [etanetan.github.io/sleeper-rankings](https://etanetan.github.io/sleeper-rankings)**

## How it works

The work is split because of one constraint: **FantasyPros doesn't send CORS
headers, so a browser can't fetch it.** Sleeper does, so the browser can.

| | Where | What |
| --- | --- | --- |
| **Build** | GitHub Actions, on a schedule | Scrapes FantasyPros into `data/rankings.json`, trims the 5MB Sleeper player dump to `data/players.json` |
| **Runtime** | Your browser, when you visit | Looks up your username, leagues and rosters from Sleeper live, joins them against that JSON |

So rankings are as fresh as the last Actions run; rosters are always current.

## Scoring

Each league's format is read from its own `scoring_settings.rec` and mapped to
the matching FantasyPros page. All three are supported:

| `rec` | Format | Pages used |
| --- | --- | --- |
| `1.0` | Full PPR | `ppr-rb.php`, `ppr-wr.php`, `ppr-te.php`, `ppr-flex.php` |
| `0.5` | Half PPR | `half-point-ppr-rb.php`, … |
| `0` | Standard | `rb.php`, `wr.php`, … |

QB, K and DST have no scoring variants and use the same pages in every league.

What's **not** reflected: TE premium, 6-point passing TDs, and other custom
scoring. FantasyPros doesn't publish consensus ranks for those, so a league
with them is shown against the closest standard variant. A TE-premium league
gets a chip in the header as a reminder to nudge tight ends up yourself.

## Lineup logic

Slots are filled most-restrictive-first, so a flex slot can't steal the only
player eligible for a dedicated one. Dedicated slots rank by positional rank,
flex slots by cross-position FLEX rank. `SUPER_FLEX` takes a QB whenever one is
available. Doubtful, out, IR, PUP and suspended players sink to the bottom;
questionable players still start.

## Tests

```bash
python3 test_build.py   # name matching, URL slugs, ecrData parsing
node test_app.js        # scoring detection, lineup construction, roster joins
```

Both run in CI before the site is built. The FantasyPros fetch itself can't be
unit tested, so it logs loudly and the build fails rather than publishing an
empty page.

## Setup

The Actions workflow lives at `workflow.yml` in the repo root because the token
that created this repo lacked GitHub's `workflow` scope. To activate:

1. Open `workflow.yml` → pencil icon → rename to `.github/workflows/build.yml`
   (typing the slashes moves it) → Commit.
2. **Settings → Pages → Source: GitHub Actions.**
3. **Actions → Build rankings → Run workflow.**
