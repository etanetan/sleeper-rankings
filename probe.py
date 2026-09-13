#!/usr/bin/env python3
"""
Diagnostic probe. Answers questions this container's network policy can't:

  1. What does FantasyPros' robots.txt actually permit?
  2. Does Sleeper publish projections we could use instead of scraping?
  3. Do those endpoints send CORS headers (i.e. could the browser call them
     directly, removing the need for a build step)?
  4. Does the projections payload carry injury status, so we stop depending
     on the 5MB player dump for it?

Prints findings and always exits 0 - this informs decisions, it isn't a test.
"""

import json
import sys

import requests

UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/125.0 Safari/537.36"}
ORIGIN = {"Origin": "https://etanetan.github.io"}


def rule(t):
    print(f"\n{'=' * 62}\n{t}\n{'=' * 62}", flush=True)


def cors_of(r):
    h = {k.lower(): v for k, v in r.headers.items()}
    return h.get("access-control-allow-origin") or "(none)"


def probe_robots():
    rule("1. FantasyPros robots.txt")
    try:
        r = requests.get("https://www.fantasypros.com/robots.txt",
                         headers=UA, timeout=30)
        print(f"HTTP {r.status_code}\n")
        body = r.text
        print(body[:3000])
        if len(body) > 3000:
            print(f"... ({len(body)} bytes total)")
        # Call out anything that covers the paths we use.
        print("\n-- lines mentioning /nfl/rankings --")
        for line in body.splitlines():
            if "rankings" in line.lower() or line.lower().startswith("crawl-delay"):
                print(f"  {line}")
    except Exception as e:
        print(f"failed: {e}")


def probe_sleeper_projections(season, week):
    rule(f"2. Sleeper projections  season={season} week={week}")
    base = "https://api.sleeper.com/projections/nfl"
    url = (f"{base}/{season}/{week}?season_type=regular"
           f"&position[]=QB&position[]=RB&position[]=WR&position[]=TE"
           f"&position[]=K&position[]=DEF&order_by=pts_half_ppr")
    print(f"GET {url}\n")
    try:
        r = requests.get(url, headers={**UA, **ORIGIN}, timeout=45)
        print(f"HTTP {r.status_code}")
        print(f"CORS access-control-allow-origin: {cors_of(r)}")
        if r.status_code != 200:
            print(r.text[:500])
            return
        data = r.json()
        print(f"type={type(data).__name__} count={len(data)}")
        rows = data if isinstance(data, list) else list(data.values())
        if not rows:
            print("empty payload")
            return
        s = rows[0]
        print("\n-- first record, keys --")
        print(sorted(s.keys()))
        print("\n-- first record, abridged --")
        print(json.dumps({k: s[k] for k in list(s)[:12]}, indent=2)[:1200])

        stats = s.get("stats") or {}
        print(f"\n-- stats keys ({len(stats)}) --")
        print(sorted(stats.keys())[:40])
        for k in ("pts_std", "pts_half_ppr", "pts_ppr"):
            print(f"  {k}: {stats.get(k)}")

        # Raw stat lines would let us score with each league's own settings
        # instead of bucketing into std/half/ppr.
        raw = [k for k in stats if k.startswith(("rec", "rush", "pass"))]
        print(f"\nraw stat components present: {sorted(raw)[:20]}")

        # Injury status here would end the dependency on the 5MB dump for it.
        for key in ("injury_status", "status", "player"):
            if key in s:
                print(f"\n'{key}' present: {json.dumps(s[key])[:300]}")
    except Exception as e:
        print(f"failed: {e}")


def probe_cors():
    rule("3. CORS on the endpoints the browser already calls")
    for url in ("https://api.sleeper.app/v1/state/nfl",
                "https://api.sleeper.app/v1/user/etanetan",
                "https://api.sleeper.com/projections/nfl/2026/1?season_type=regular&position[]=QB"):
        try:
            r = requests.get(url, headers={**UA, **ORIGIN}, timeout=30)
            print(f"{r.status_code}  acao={cors_of(r):<20}  {url}")
        except Exception as e:
            print(f"ERR  {url} -> {e}")


def probe_fp_api():
    rule("4. Does FantasyPros offer an official API?")
    for url in ("https://api.fantasypros.com/v2/json/nfl/2026/consensus-rankings",
                "https://www.fantasypros.com/about/legal/"):
        try:
            r = requests.get(url, headers=UA, timeout=30)
            print(f"\n{r.status_code}  {url}")
            if "legal" in url and r.status_code == 200:
                import re
                txt = re.sub(r"<[^>]+>", " ", r.text)
                txt = re.sub(r"\s+", " ", txt)
                for term in ("scrap", "automated", "robot", "crawl", "data mining", "spider"):
                    for m in re.finditer(term, txt, re.I):
                        print(f"  …{txt[max(0, m.start() - 180):m.start() + 180]}…")
                        break
            else:
                print(f"  {r.text[:300]}")
        except Exception as e:
            print(f"  failed: {e}")


if __name__ == "__main__":
    try:
        st = requests.get("https://api.sleeper.app/v1/state/nfl", headers=UA, timeout=30).json()
        season, week = st.get("season", "2026"), st.get("week", 1)
    except Exception:
        season, week = "2026", 1
    probe_robots()
    probe_sleeper_projections(season, week)
    probe_cors()
    probe_fp_api()
    print("\nprobe complete")
    sys.exit(0)
