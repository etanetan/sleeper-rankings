#!/usr/bin/env python3
"""
Diagnostic probe. Validates the FantasyPros key and reports what both APIs
actually return, from a runner that can reach them.

Never prints the key. Always exits 0 - this informs decisions, it isn't a test.
"""

import json
import os
import sys

import requests

UA = {"User-Agent": "sleeper-rankings (github.com/etanetan/sleeper-rankings)"}
ORIGIN = {"Origin": "https://etanetan.github.io"}
FP_API = "https://api.fantasypros.com/public/v2/json/nfl"
KEY = os.environ.get("FANTASYPROS_API_KEY", "").strip()


def rule(t):
    print(f"\n{'=' * 64}\n{t}\n{'=' * 64}", flush=True)


def cors_of(r):
    h = {k.lower(): v for k, v in r.headers.items()}
    return h.get("access-control-allow-origin") or "(none)"


def probe_fantasypros(season, week):
    rule("FantasyPros consensus-rankings")
    if not KEY:
        print("FANTASYPROS_API_KEY is not set in this environment.")
        print("Add it under Settings > Secrets and variables > Actions.")
        return
    print(f"key present: {len(KEY)} chars, ending {KEY[-4:]}")

    # One known-good call first, reported in full.
    url = f"{FP_API}/{season}/consensus-rankings?position=QB&type=weekly&scoring=STD&week={week}"
    print(f"\nGET {url}")
    try:
        r = requests.get(url, headers={**UA, "x-api-key": KEY}, timeout=45)
    except Exception as e:
        print(f"request failed: {e}")
        return
    print(f"HTTP {r.status_code}")
    if r.status_code != 200:
        print(f"body: {r.text[:600]}")
        if r.status_code in (401, 403):
            print("\n-> the key was rejected, or lacks access to this endpoint")
        return

    try:
        payload = r.json()
    except ValueError:
        print(f"non-JSON body: {r.text[:400]}")
        return

    print(f"top-level keys: {sorted(payload)}")
    players = payload.get("players") or []
    print(f"players: {len(players)}")
    if players:
        print("\nfirst record:")
        print(json.dumps(players[0], indent=2)[:900])
        print(f"\nrecord keys: {sorted(players[0])}")
        for f in ("player_name", "player_team_id", "player_position_id",
                  "rank_ecr", "pos_rank", "tier"):
            print(f"  {f}: {players[0].get(f)!r}")

    # Deliberately does NOT sweep every position/scoring combination. Doing
    # that burned the rate limit before the build could run.
    print(f"\npublic_api_limited: {payload.get('public_api_limited')!r}  "
          f"count={payload.get('count')!r}  limit={payload.get('limit')!r}  "
          f"returned={len(players)}")
    print("If returned is much smaller than count, the plan caps the list and "
          "only the top few players per position are ranked.")


def probe_sleeper(season, week):
    rule("Sleeper endpoints and CORS")
    proj = (f"https://api.sleeper.com/projections/nfl/{season}/{week}?season_type=regular"
            f"&position[]=QB&position[]=RB&position[]=WR&position[]=TE"
            f"&position[]=K&position[]=DEF&order_by=pts_half_ppr")
    for u in ("https://api.sleeper.app/v1/state/nfl",
              "https://api.sleeper.app/v1/user/etanetan", proj):
        try:
            r = requests.get(u, headers={**UA, **ORIGIN}, timeout=45)
            extra = ""
            if "projections" in u and r.status_code == 200:
                rows = r.json()
                rows = rows if isinstance(rows, list) else list(rows.values())
                extra = f"  rows={len(rows)}"
                if rows:
                    extra += f"  stat keys={sorted((rows[0].get('stats') or {}))[:12]}"
            print(f"{r.status_code}  acao={cors_of(r):<16} {u[:70]}{extra}")
        except Exception as e:
            print(f"ERR  {u[:70]} -> {e}")


if __name__ == "__main__":
    try:
        st = requests.get("https://api.sleeper.app/v1/state/nfl", headers=UA, timeout=30).json()
        season, week = st.get("season", "2026"), st.get("week", 1)
    except Exception as e:
        print(f"could not read NFL state: {e}")
        season, week = "2026", 1
    print(f"season={season} week={week}")
    probe_fantasypros(season, week)
    probe_sleeper(season, week)
    print("\nprobe complete")
    sys.exit(0)
