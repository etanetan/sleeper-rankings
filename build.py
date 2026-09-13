#!/usr/bin/env python3
"""
Fetch FantasyPros expert consensus rankings and a trimmed Sleeper player map,
and write them as JSON for the static site to consume.

The browser can call the Sleeper API directly (it sends CORS headers), but
FantasyPros does not allow cross-origin requests, so the rankings have to be
fetched server-side here and shipped alongside the page.

Runs in GitHub Actions, where outbound network access is unrestricted.
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
STATIC_DIR = os.environ.get("STATIC_DIR", "public")
CACHE_DIR = os.environ.get("CACHE_DIR", ".cache")

# Sleeper asks callers not to pull the ~5MB player dump more than once a day,
# so it is cached across runs while the rankings refresh as often as we like.
PLAYERS_MAX_AGE = 20 * 3600

SLEEPER = "https://api.sleeper.app/v1"
FP = "https://www.fantasypros.com/nfl/rankings"
UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/125.0 Safari/537.36"}

# Scoring variants FantasyPros publishes. QB/K/DST are identical across all
# three, so they are fetched once and shared.
FORMATS = ["std", "half", "ppr"]
SCORED_POS = ["RB", "WR", "TE", "FLEX"]
SHARED_POS = ["QB", "K", "DST"]

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


# --------------------------------------------------------------------------
# name matching
# --------------------------------------------------------------------------

SUFFIXES = {"jr", "sr", "ii", "iii", "iv", "v"}


def norm(name):
    """Normalize a player name so Sleeper and FantasyPros spellings agree."""
    name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    name = name.lower().replace(".", "").replace("'", "").replace("-", " ")
    parts = [p for p in re.split(r"\s+", name) if p and p not in SUFFIXES]
    return " ".join(parts)


# --------------------------------------------------------------------------
# FantasyPros
# --------------------------------------------------------------------------

def extract_object(text, start):
    """Return the balanced {...} JSON object beginning at or after `start`."""
    i = text.find("{", start)
    if i < 0:
        return None
    depth, in_str, esc = 0, False, False
    for j in range(i, len(text)):
        c = text[j]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
        else:
            if c == '"':
                in_str = True
            elif c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    return text[i:j + 1]
    return None


def parse_ecr(html, label):
    """
    Pull the rankings array out of a FantasyPros page.

    The data is embedded as `var ecrData = {...}`. That has moved before, so
    try the shapes we know and fail loudly with enough detail to fix it from
    the Actions log rather than silently returning nothing.
    """
    for marker in ("var ecrData", "window.ecrData", '"ecrData"'):
        idx = html.find(marker)
        if idx < 0:
            continue
        raw = extract_object(html, idx + len(marker))
        if not raw:
            continue
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as e:
            log(f"  [{label}] found {marker!r} but JSON failed: {e}")
            continue
        if data.get("players"):
            return data["players"]

    m = re.search(r'<script[^>]+id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.S)
    if m:
        try:
            nxt = json.loads(m.group(1))
        except json.JSONDecodeError:
            nxt = None
        if nxt:
            found = []

            def walk(node):
                if isinstance(node, dict):
                    if "players" in node and isinstance(node["players"], list):
                        found.append(node["players"])
                    for v in node.values():
                        walk(v)
                elif isinstance(node, list):
                    for v in node:
                        walk(v)

            walk(nxt)
            if found:
                log(f"  [{label}] recovered via __NEXT_DATA__")
                return max(found, key=len)

    log(f"  [{label}] NO RANKINGS PARSED. len(html)={len(html)} "
        f"has_ecrData={'ecrData' in html} has_table={'<table' in html}")
    log(f"  [{label}] head: {html[:300]!r}")
    return []


def slug(pos, fmt):
    """FantasyPros URL slug. QB/K/DST have no scoring variants."""
    if pos in SHARED_POS:
        return pos.lower()
    prefix = {"ppr": "ppr-", "half": "half-point-ppr-", "std": ""}[fmt]
    return f"{prefix}{pos.lower()}"


def fetch_pos(pos, fmt):
    """{key: {rank, posRank, team, opp, name}} for one position + format."""
    url = f"{FP}/{slug(pos, fmt)}.php"
    log(f"fetching {url}")
    players = parse_ecr(get(url).text, f"{pos}/{fmt}")

    out = {}
    for p in players:
        name = p.get("player_name") or ""
        team = (p.get("player_team_id") or "").upper()
        ppos = (p.get("player_position_id") or pos).upper()
        try:
            rank = int(float(p.get("rank_ecr") or 0))
        except (TypeError, ValueError):
            continue
        pos_rank = p.get("pos_rank") or ""
        # pos_rank arrives like "WR8"; keep just the number for display control.
        m = re.search(r"(\d+)", str(pos_rank))
        rec = {
            "rank": rank,
            "posRank": int(m.group(1)) if m else None,
            "team": team,
            "opp": (p.get("player_opponent") or "").strip(),
            "name": name,
        }
        key = team if (ppos == "DST" or pos == "DST") else norm(name)
        out[key] = rec
    log(f"  -> {len(out)} players")
    return out


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------

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

    log("fetching Sleeper player dictionary (~5MB)")
    db = get(f"{SLEEPER}/players/nfl").json()
    log(f"  -> {len(db)} entries")

    # Trim to fantasy-relevant players so the browser downloads ~1% of the dump.
    players = {}
    for pid, m in db.items():
        pos = (m.get("position") or "").upper()
        if pos not in FANTASY_POS:
            continue
        if pos == "DEF":
            name = f"{m.get('first_name', '')} {m.get('last_name', '')}".strip() or pid
            team = (m.get("team") or pid).upper()
            key = team
        else:
            name = m.get("full_name") or \
                f"{m.get('first_name', '')} {m.get('last_name', '')}".strip()
            team = (m.get("team") or "").upper()
            key = norm(name)
        players[pid] = {
            "n": name, "p": pos, "t": team, "k": key,
            "i": m.get("injury_status") or "", "b": m.get("bye_week"),
        }
    log(f"  -> {len(players)} fantasy-relevant players kept")

    os.makedirs(CACHE_DIR, exist_ok=True)
    with open(path, "w") as f:
        json.dump({"fetched": time.time(), "players": players}, f, separators=(",", ":"))
    log(f"cached player map to {path}")
    return players


def main():
    state = get(f"{SLEEPER}/state/nfl").json()
    season = state.get("season")
    week = state.get("week") or state.get("display_week") or 1
    season_type = state.get("season_type")
    log(f"season={season} week={week} type={season_type}")

    # The page calls Sleeper from the browser, so confirm CORS is actually open.
    probe = requests.get(f"{SLEEPER}/state/nfl", headers={**UA, "Origin":
                         "https://etanetan.github.io"}, timeout=30)
    acao = probe.headers.get("access-control-allow-origin")
    log(f"SLEEPER CORS access-control-allow-origin: {acao!r}")
    if not acao:
        log("WARNING: Sleeper did not return a CORS header; the browser fetch may fail")

    rankings = {"shared": {}, "formats": {}}
    for pos in SHARED_POS:
        rankings["shared"][pos] = fetch_pos(pos, "std")
    for fmt in FORMATS:
        rankings["formats"][fmt] = {pos: fetch_pos(pos, fmt) for pos in SCORED_POS}

    total = sum(len(v) for v in rankings["shared"].values()) + sum(
        len(t) for f in rankings["formats"].values() for t in f.values())
    log(f"\ntotal ranking rows: {total}")
    if total == 0:
        log("ERROR: no rankings parsed at all - the FantasyPros parser is broken")
        sys.exit(1)

    players = load_players()

    os.makedirs(f"{OUT_DIR}/data", exist_ok=True)
    if os.path.isdir(STATIC_DIR):
        for f in os.listdir(STATIC_DIR):
            shutil.copy2(os.path.join(STATIC_DIR, f), os.path.join(OUT_DIR, f))
        log(f"copied static files from {STATIC_DIR}/")

    meta = {
        "season": season, "week": week, "seasonType": season_type,
        "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "sleeperCors": bool(acao),
    }
    write(f"{OUT_DIR}/data/meta.json", meta)
    write(f"{OUT_DIR}/data/rankings.json", rankings)
    write(f"{OUT_DIR}/data/players.json", players)


def write(path, obj):
    with open(path, "w") as f:
        json.dump(obj, f, separators=(",", ":"))
    log(f"wrote {path} ({os.path.getsize(path) / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
