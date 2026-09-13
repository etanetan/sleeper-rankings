#!/usr/bin/env python3
"""
Publish FantasyPros consensus rankings alongside the static site.

This is the optional half of the project. The page works without it, ranking
by Sleeper projections; when data/rankings.json exists the page prefers it.

It exists as a build step for one reason: the FantasyPros API needs a key, the
site is public, and a key shipped to the browser is a published key. GitHub
secrets are only readable from an Actions runner, so the call happens here.

Everything else - players, projections, rosters - the page fetches itself.
"""

import json
import os
import re
import shutil
import sys
import time
import unicodedata

import requests

OUT_DIR = os.environ.get("OUTPUT_DIR", "site")
STATIC_DIR = os.environ.get("STATIC_DIR", ".")
STATIC_FILES = ("index.html", "app.js", "style.css")

SLEEPER = "https://api.sleeper.app/v1"
FP_API = "https://api.fantasypros.com/public/v2/json/nfl"
UA = {"User-Agent": "sleeper-rankings (github.com/etanetan/sleeper-rankings)"}

# Read from a repo secret, never committed.
FP_KEY = os.environ.get("FANTASYPROS_API_KEY", "").strip()

FP_SCORING = {"std": "STD", "half": "HALF", "ppr": "PPR"}
FP_SCORED_POS = ["RB", "WR", "TE", "FLEX"]
FP_SHARED_POS = ["QB", "K", "DST"]

SUFFIXES = {"jr", "sr", "ii", "iii", "iv", "v"}

log = lambda *a: print(*a, file=sys.stderr, flush=True)


def norm(name):
    """
    Normalize a player name for joining against Sleeper.

    Must stay identical to norm() in app.js - the join breaks silently if they
    drift, so a test runs both over the same names and compares.
    """
    name = unicodedata.normalize("NFKD", name or "").encode("ascii", "ignore").decode()
    name = name.lower().replace(".", "").replace("'", "").replace("-", " ")
    parts = [p for p in re.split(r"\s+", name) if p and p not in SUFFIXES]
    return " ".join(parts)


def fp_get(season, week, position, scoring):
    """One consensus-rankings call. Returns [] and logs rather than raising."""
    url = (f"{FP_API}/{season}/consensus-rankings"
           f"?position={position}&type=weekly&scoring={scoring}&week={week}")
    try:
        r = requests.get(url, headers={**UA, "x-api-key": FP_KEY}, timeout=45)
    except requests.RequestException as e:
        log(f"  [{position}/{scoring}] request failed: {e}")
        return []
    if r.status_code != 200:
        log(f"  [{position}/{scoring}] HTTP {r.status_code}: {r.text[:200]}")
        return []
    try:
        payload = r.json()
    except ValueError:
        log(f"  [{position}/{scoring}] non-JSON response: {r.text[:200]}")
        return []
    players = payload.get("players")
    if not players:
        log(f"  [{position}/{scoring}] no players key; got {sorted(payload)[:10]}")
        return []
    return players


def fp_table(season, week, position, scoring):
    """{key: {rank, posRank}} for one position and scoring format."""
    out = {}
    for p in fp_get(season, week, position, scoring):
        name = p.get("player_name") or ""
        team = (p.get("player_team_id") or "").upper()
        ppos = (p.get("player_position_id") or position).upper()
        try:
            rank = int(float(p.get("rank_ecr") or 0))
        except (TypeError, ValueError):
            continue
        m = re.search(r"(\d+)", str(p.get("pos_rank") or ""))
        key = team if ppos == "DST" else norm(name)
        if not key:
            continue
        out[key] = {"rank": rank, "posRank": int(m.group(1)) if m else None}
    log(f"  [{position}/{scoring}] {len(out)} ranked")
    return out


def main():
    if not FP_KEY:
        log("FANTASYPROS_API_KEY is not set.")
        log("Add it under Settings > Secrets and variables > Actions.")
        sys.exit(1)

    state = requests.get(f"{SLEEPER}/state/nfl", headers=UA, timeout=30).json()
    season = state.get("season")
    week = state.get("week") or state.get("display_week") or 1
    log(f"season={season} week={week}")

    shared = {pos: fp_table(season, week, pos, "STD") for pos in FP_SHARED_POS}
    formats = {fmt: {pos: fp_table(season, week, pos, code) for pos in FP_SCORED_POS}
               for fmt, code in FP_SCORING.items()}

    total = (sum(len(t) for t in shared.values())
             + sum(len(t) for f in formats.values() for t in f.values()))
    log(f"total ranking rows: {total}")
    if total == 0:
        log("ERROR: the key produced no rankings at all; refusing to publish")
        sys.exit(1)

    os.makedirs(f"{OUT_DIR}/data", exist_ok=True)
    for f in STATIC_FILES:
        src = os.path.join(STATIC_DIR, f)
        if not os.path.exists(src):
            log(f"ERROR: {src} is missing; the published site would have no page")
            sys.exit(1)
        shutil.copy2(src, os.path.join(OUT_DIR, f))
    log(f"copied {len(STATIC_FILES)} static files")

    path = f"{OUT_DIR}/data/rankings.json"
    with open(path, "w") as f:
        json.dump({"generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                   "season": season, "week": week,
                   "shared": shared, "formats": formats}, f, separators=(",", ":"))
    log(f"wrote {path} ({os.path.getsize(path) / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
