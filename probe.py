#!/usr/bin/env python3
"""
Diagnostic probe for the Sleeper endpoints this project depends on.

Answers what a sandboxed session can't: the real shape of the projections
payload, whether it carries the stat components we score with, and whether
the endpoints send CORS headers (if they do, the browser can fetch
projections live and the prebuilt copy is only a fallback).

Prints findings and always exits 0 - this informs decisions, it isn't a test.
"""

import json
import sys

import requests

UA = {"User-Agent": "sleeper-rankings (github.com/etanetan/sleeper-rankings)"}
ORIGIN = {"Origin": "https://etanetan.github.io"}


def rule(t):
    print(f"\n{'=' * 62}\n{t}\n{'=' * 62}", flush=True)


def cors_of(r):
    h = {k.lower(): v for k, v in r.headers.items()}
    return h.get("access-control-allow-origin") or "(none)"


def main():
    try:
        st = requests.get("https://api.sleeper.app/v1/state/nfl", headers=UA, timeout=30).json()
        season, week = st.get("season", "2026"), st.get("week", 1)
    except Exception as e:
        print(f"could not read NFL state: {e}")
        season, week = "2026", 1

    rule(f"Projections  season={season} week={week}")
    url = (f"https://api.sleeper.com/projections/nfl/{season}/{week}?season_type=regular"
           f"&position[]=QB&position[]=RB&position[]=WR&position[]=TE"
           f"&position[]=K&position[]=DEF&order_by=pts_half_ppr")
    print(f"GET {url}\n")
    try:
        r = requests.get(url, headers={**UA, **ORIGIN}, timeout=45)
        print(f"HTTP {r.status_code}   CORS: {cors_of(r)}")
        if r.status_code == 200:
            rows = r.json()
            rows = rows if isinstance(rows, list) else list(rows.values())
            print(f"rows={len(rows)}")
            if rows:
                s = rows[0]
                print("\nrecord keys:", sorted(s.keys()))
                stats = s.get("stats") or {}
                print(f"\nstat keys ({len(stats)}):", sorted(stats)[:40])
                print("\nsample record:")
                print(json.dumps(s, indent=2)[:900])
                # These are what scoring multiplies against.
                comps = [k for k in stats if k.startswith(("rec", "rush", "pass", "fum", "def", "pts_allow"))]
                print(f"\nscoreable components: {sorted(comps)}")
                miss = [k for k in ("rec", "rec_yd", "rec_td", "rush_yd", "rush_td",
                                    "pass_yd", "pass_td") if k not in stats]
                print(f"expected components absent from this record: {miss}")
        else:
            print(r.text[:400])
    except Exception as e:
        print(f"failed: {e}")

    rule("CORS on every endpoint the browser calls")
    for u in (f"https://api.sleeper.app/v1/state/nfl",
              f"https://api.sleeper.app/v1/user/etanetan",
              url):
        try:
            r = requests.get(u, headers={**UA, **ORIGIN}, timeout=30)
            print(f"{r.status_code}  acao={cors_of(r):<18} {u[:80]}")
        except Exception as e:
            print(f"ERR  {u[:80]} -> {e}")

    print("\nprobe complete")
    sys.exit(0)


if __name__ == "__main__":
    main()
