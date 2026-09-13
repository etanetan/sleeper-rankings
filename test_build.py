#!/usr/bin/env python3
"""Offline tests for the Python build step (everything but the network)."""
import json
import os
import sys
import tempfile
import time

import build

results = []


def check(label, got, want):
    ok = got == want
    print(f"{'PASS' if ok else 'FAIL'}  {label}" +
          ("" if ok else f"\n        got {got!r}\n       want {want!r}"))
    results.append(ok)


# --- player map caching -------------------------------------------------
# Sleeper asks for at most one pull of the ~5MB dump per day, so the cache is
# the mechanism that keeps us inside their guidance. Verify it actually holds.
tmp = tempfile.mkdtemp()
build.CACHE_DIR = tmp
path = os.path.join(tmp, "players.json")


def no_network(*a, **k):
    raise AssertionError("hit the network when the cache should have been used")


def refetches(label):
    """load_players should try the network; no_network proves it did."""
    try:
        build.load_players()
        check(label, "used cache", "refetched")
    except AssertionError:
        check(label, "refetched", "refetched")


real_get, build.get = build.get, no_network

with open(path, "w") as f:
    json.dump({"fetched": time.time(), "players": {"1": {"n": "Cached"}}}, f)
check("fresh cache reused without fetching", build.load_players(), {"1": {"n": "Cached"}})

with open(path, "w") as f:
    json.dump({"fetched": time.time() - 19 * 3600, "players": {"1": {"n": "Ok"}}}, f)
check("19h cache still reused", build.load_players(), {"1": {"n": "Ok"}})

with open(path, "w") as f:
    json.dump({"fetched": time.time() - 30 * 3600, "players": {"1": {"n": "Old"}}}, f)
refetches("stale cache refetches")

with open(path, "w") as f:
    f.write("{not json")
refetches("corrupt cache refetches")

with open(path, "w") as f:
    json.dump({"fetched": time.time() + 9999, "players": {"1": {"n": "Future"}}}, f)
refetches("future-dated cache refetches")

with open(path, "w") as f:
    json.dump({"fetched": time.time(), "players": {}}, f)
refetches("empty cache refetches")

os.remove(path)
refetches("missing cache refetches")
build.get = real_get


# --- projection parsing -------------------------------------------------
class FakeResponse:
    def __init__(self, payload):
        self._p = payload

    def json(self):
        return self._p


sample = [
    {"player_id": "4046", "stats": {"pts_ppr": 18.4, "rec": 6.1, "rec_yd": 74.2, "rec_td": 0.4}},
    {"player_id": "1234", "stats": {"pass_yd": 268.0, "pass_td": 1.8, "pass_int": 0.7}},
    {"player_id": "9999", "stats": {}},                     # no projection
    {"stats": {"rec": 4}},                                   # no player id
    {"player_id": "5555", "stats": {"rec": 0, "rec_yd": 0}},  # all zeros
]
build.get = lambda url, tries=4: FakeResponse(sample)
proj = build.fetch_projections("2026", 2)
check("keeps players with a projection", sorted(proj.keys()), ["1234", "4046"])
check("keeps raw stat components", proj["4046"]["rec"], 6.1)
check("drops zero-valued stats", "5555" in proj, False)
check("skips rows without a player id", len(proj), 2)

# a dict payload (rather than a list) is handled too
build.get = lambda url, tries=4: FakeResponse({"a": sample[0]})
check("dict payload accepted", list(build.fetch_projections("2026", 2)), ["4046"])
build.get = real_get

# --- no scraping -------------------------------------------------------
source = open("build.py").read()
# The word appears in a comment explaining why we don't scrape it; what
# matters is that no request is ever addressed to the host.
check("never requests fantasypros.com", "fantasypros.com" in source.lower(), False)
check("no http url outside sleeper",
      [u for u in __import__("re").findall(r'https?://[a-z0-9.\-]+', source)
       if "sleeper" not in u], [])

print(f"\n{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) else 1)
