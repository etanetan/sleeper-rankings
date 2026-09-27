# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A static site (GitHub Pages, https://etanetan.github.io/sleeper-rankings) that shows a Sleeper user's weekly positional ranks, best lineup, and researched trade ideas per league. There is no build step, no server and no API key: the browser calls Sleeper directly. Trade ideas are produced separately by a scheduled Claude routine and read by the page as static JSON.

## Commands

```bash
node test_app.js            # site logic: scoring, ranks, lineups, injuries, trade windows
node test_trades.js         # trade engine: form/tags, fairness, search, picks, finalize gate, CLI (uses fixtures)
python3 test_build.py       # asset versioning, allowed hosts, secret hygiene, optional build.py
python3 test_norm_parity.py # build.py and app.js name normalizers must agree
python3 -m http.server 8765 # serve the site locally at http://localhost:8765
```

Tests are flat scripts of `check(label, got, want)` calls, not a framework; there is no single-test runner, so comment out or grep for the check you care about. `test_trades.js` runs the engine CLI against canned responses via `TRADES_FIXTURES` (a JSON map of URL → response) and pins the clock with `TRADES_NOW`.

Trade engine (needs network to api.sleeper.app, api.sleeper.com, api.fantasycalc.com; it re-execs itself with `NODE_USE_ENV_PROXY=1` when `HTTPS_PROXY` is set):

```bash
node trades/engine.js candidates --user etanetan --league <id> --out trades/work [--targets <file>]
node trades/engine.js brief      --league <id> --work trades/work     # compact text view of a work file
node trades/engine.js next       --user etanetan --data <dir>         # which league a scheduled run should do
node trades/engine.js running|failed|finalize --league <id> --data <dir> ...
```

## Deploying

- Pages serves the `gh-pages` branch, a mirror of `main`: push both with `git push origin main main:gh-pages`.
- Whenever `app.js` or `style.css` change, bump the `?v=N` on their tags in `index.html` (browsers otherwise keep serving the old file; `test_build.py` checks the versioning exists).
- No GitHub Actions: the session credential can't push `.github/workflows/`, and the owner doesn't want them.

## Architecture

**`app.js` is two things.** The top half is pure logic (`norm`, `scorePlayer`, `rankPositions`, `pickLineup`, `tradeWindow`, …) exported via `module.exports` for Node; the UI lives inside `if (typeof document !== "undefined")`. `trades/engine.js` requires `app.js` for shared definitions (`SLOT_ELIGIBLE`, `tradeWindow`, `normStatus`, `scorePlayer`), so changes there affect both the page and the engine.

**Ranks** come from Sleeper projections scored with each league's own `scoring_settings` (including TE premium), ranked within position. The ~5MB Sleeper player dump is cached in `localStorage` for 20h (Sleeper asks for at most one pull a day); injury statuses are refreshed live from the projections call. `build.py` (FantasyPros consensus) is kept but unused: the free API tier returns only 10 players per position.

**Trades pipeline** (three branches matter):
- `main` / `gh-pages`: code.
- `claude/trade-data`: orphan branch holding only `<league_id>.json` research files. The page fetches them from `raw.githubusercontent.com/etanetan/sleeper-rankings/refs/heads/claude/trade-data/`, so a research run never touches the site. Never push code there; `trades/work/` is gitignored scratch.

The flow per league: `engine.js candidates` (numbers) → Claude researches and writes `targets.json` (buy/sell/hold calls) → `candidates --targets` again → Claude writes `research.json` → reviewer subagent → `engine.js finalize` → push to `claude/trade-data`. The routine's instructions live in `.claude/skills/trade-research/SKILL.md`; that file, not the routine prompt, is the source of truth for the research process.

**Engine concepts worth knowing before editing `trades/engine.js`:**
- Values are FantasyCalc, scaled per league (`fcParams`: redraft/dynasty, 1QB vs superflex, team count, PPR snapped to 0/0.5/1). Keeper leagues use redraft values.
- Fairness is package-adjusted (`PACKAGE_WEIGHTS` discount extra pieces) and the gap is measured against the best single piece, so equal padding can't make a lopsided deal "fair". `FAIR_PCT` is shared by search and `finalize`.
- Market tags from `form` (points vs past projections, snap/target share, touches) and 30-day value trend: your players `sell_high` / `hold`, others' `buy_low` / `avoid`. `hold` players are never offered, and `finalize` refuses a trade that gives one.
- Players on IR/PUP/suspended keep trade value but never start; injury flags travel with the player in `swap()`.
- Draft picks exist only in dynasty leagues: owners come from `traded_picks`, next year's picks are priced by projected slot (roster strength thirds). Draft history uses each season's *first-created* complete draft with ≤5 rounds (some leagues run a second, weaker draft; startup drafts are skipped).
- `finalize` is the gate: numbers always come from the work file, never from the research; it enforces ≥5 trades (or a `short_reason`), ≤8, required `why` sections including `experts`, https sources, and second-person wording.

**The routine** ("Sleeper trade research", `trig_015CNtre9vMEu6wKa8ae2yuV`) fires Tuesdays at 8:54/13:54/18:54/23:54 ET, one league per run (`next` picks the stalest), because the owner is on Claude Pro and a four-league run exhausted a 5-hour usage window. Keep research token-light: read `brief`, not the work JSON. The page's "Research new trades" button can't call the routine API (no browser CORS, and the token can't ship in public code); it copies a request and opens claude.ai/code/routines.
