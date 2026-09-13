# sleeper-rankings

Weekly FantasyPros expert-consensus rankings for every Sleeper league I'm in,
rebuilt automatically and published to GitHub Pages.

**→ [etanetan.github.io/sleeper-rankings](https://etanetan.github.io/sleeper-rankings)**

## What it does

`build.py` pulls:

- **Rosters** from the [Sleeper API](https://docs.sleeper.com) — no auth needed,
  just the username.
- **Rankings** from [FantasyPros](https://www.fantasypros.com/nfl/rankings/qb.php),
  picking the variant that matches each league's scoring.

Scoring is read from each league's own `scoring_settings.rec` value, so a
full-PPR league and a half-PPR league get genuinely different ranking sets
rather than one list reused:

| `rec` | Format | FantasyPros page |
| --- | --- | --- |
| `1.0` | Full PPR | `ppr-rb.php`, `ppr-wr.php`, … |
| `0.5` | Half PPR | `half-point-ppr-rb.php`, … |
| `0` | Standard | `rb.php`, `wr.php`, … |

QB, K and DST have no scoring variants, so they use the same pages everywhere.

It then picks a suggested lineup per league, filling the most restrictive roster
slots first by positional rank and the flex slots by cross-position FLEX rank,
with injured and out players pushed down.

## Schedule

Runs Tue/Thu/Sat/Sun at ~9am ET, on every push to `main`, and on demand via
**Actions → Build rankings → Run workflow**.

## Changing the username

Edit `SLEEPER_USERNAME` in `.github/workflows/build.yml`, or run locally:

```bash
pip install -r requirements.txt
SLEEPER_USERNAME=someoneelse OUTPUT_PATH=site/index.html python build.py
open site/index.html
```
