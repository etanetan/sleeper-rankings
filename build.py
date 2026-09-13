#!/usr/bin/env python3
"""
Prepare the data the page can't fetch for itself.

Only Sleeper's public API is used. No scraping: FantasyPros' rankings are
their commercial product and we have no permission to automate against them.

Sleeper asks callers to pull the ~5MB player dictionary no more than once a
day, which is the one thing that genuinely needs a build step - rosters come
back as bare player IDs and that file is the only way to name them. Weekly
projections are prebuilt too, as a fallback for browsers that can't reach the
projections host directly.
"""

import json
import os
import shutil
import sys
import time

import requests

OUT_DIR = os.environ.get("OUTPUT_DIR", "site")
STATIC_DIR = os.environ.get("STATIC_DIR", "public")
CACHE_DIR = os.environ.get("CACHE_DIR", ".cache")

SLEEPER = "https://api.sleeper.app/v1"
PROJ = "https://api.sleeper.com/projections/nfl"
UA = {"User-Agent": "sleeper-rankings (github.com/etanetan/sleeper-rankings)"}

# Sleeper's own guidance for the player dump.
PLAYERS_MAX_AGE = 20 * 3600
FANTASY_POS = {"QB", "RB", "WR", "TE", "K", "DEF"}

log = lambda *a: print(*a, file=sys.stderr, flush=True)


def get(url, tries=4):
    last = None
    for n in range(tries):
        try:
            r = requests.get(url, headers=UA, timeout=45)
            if r.status_code == 200:
                return r
            last = f"HTTP {r.status_code}"
        except requests.RequestException as e:
            last = str(e)
        log(f"  {url} -> {last} (attempt {n + 1}/{tries})")
        time.sleep(2 ** n)
    raise RuntimeError(f"failed to fetch {url}: {last}")


def load_players():
    """
    The trimmed Sleeper player map, from cache when it is recent enough.

    The age is stored in the file rather than read from its mtime, because a
    cache restored by CI does not necessarily preserve timestamps.
    """
    path = os.path.join(CACHE_DIR, "players.json")
    if os.path.exists(path):
        try:
            with open(path) as f:
                cached = json.load(f)
            age = time.time() - cached.get("fetched", 0)
            if 0 <= age < PLAYERS_MAX_AGE and cached.get("players"):
                log(f"reusing cached player map ({age / 3600:.1f}h old, "
                    f"{len(cached['players'])} players)")
                return cached["players"]
            log(f"cached player map is {age / 3600:.1f}h old, refetching")
        except (json.JSONDecodeError, OSError) as e:
            log(f"cached player map unusable ({e}), refetching")

    log("fetching Sleeper player dictionary (~5MB, at most once a day)")
    db = get(f"{SLEEPER}/players/nfl").json()
    log(f"  -> {len(db)} entries")

    players = {}
    for pid, m in db.items():
        pos = (m.get("position") or "").upper()
        if pos not in FANTASY_POS:
            continue
        if pos == "DEF":
            name = f"{m.get('first_name', '')} {m.get('last_name', '')}".strip() or pid
            team = (m.get("team") or pid).upper()
        else:
            name = m.get("full_name") or \
                f"{m.get('first_name', '')} {m.get('last_name', '')}".strip()
            team = (m.get("team") or "").upper()
        players[pid] = {
            "n": name, "p": pos, "t": team,
            "i": m.get("injury_status") or "", "b": m.get("bye_week"),
        }
    log(f"  -> {len(players)} fantasy-relevant players kept")

    os.makedirs(CACHE_DIR, exist_ok=True)
    with open(path, "w") as f:
        json.dump({"fetched": time.time(), "players": players}, f, separators=(",", ":"))
    return players


def fetch_projections(season, week):
    """
    Weekly projected stat lines, keyed by player id.

    The raw components are kept rather than Sleeper's precomputed pts_* values
    so the page can score each league by its own settings.
    """
    url = (f"{PROJ}/{season}/{week}?season_type=regular"
           f"&position[]=QB&position[]=RB&position[]=WR&position[]=TE"
           f"&position[]=K&position[]=DEF&order_by=pts_half_ppr")
    log(f"fetching projections: {url}")
    rows = get(url).json()
    if isinstance(rows, dict):
        rows = list(rows.values())
    log(f"  -> {len(rows)} projection rows")

    out = {}
    for row in rows:
        pid = str(row.get("player_id") or "")
        stats = row.get("stats") or {}
        if not pid or not stats:
            continue
        # Drop zero values; most players project zero in most categories and
        # the payload shrinks a lot without them. A player left with nothing
        # isn't projected to do anything, so drop the row entirely rather than
        # rank a crowd of scoreless players against each other.
        kept = {k: v for k, v in stats.items() if isinstance(v, (int, float)) and v}
        if not kept:
            continue
        out[pid] = kept
    log(f"  -> {len(out)} players with a projection")
    return out


def write(path, obj):
    with open(path, "w") as f:
        json.dump(obj, f, separators=(",", ":"))
    log(f"wrote {path} ({os.path.getsize(path) / 1024:.0f} KB)")


def main():
    state = get(f"{SLEEPER}/state/nfl").json()
    season = state.get("season")
    week = state.get("week") or state.get("display_week") or 1
    log(f"season={season} week={week} type={state.get('season_type')}")

    players = load_players()
    projections = fetch_projections(season, week)
    if not projections:
        log("ERROR: no projections returned; refusing to publish an empty site")
        sys.exit(1)

    os.makedirs(f"{OUT_DIR}/data", exist_ok=True)
    if os.path.isdir(STATIC_DIR):
        for f in os.listdir(STATIC_DIR):
            shutil.copy2(os.path.join(STATIC_DIR, f), os.path.join(OUT_DIR, f))
        log(f"copied static files from {STATIC_DIR}/")

    write(f"{OUT_DIR}/data/meta.json", {
        "season": season, "week": week, "seasonType": state.get("season_type"),
        "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    })
    write(f"{OUT_DIR}/data/players.json", players)
    write(f"{OUT_DIR}/data/projections.json", projections)


if __name__ == "__main__":
    main()
