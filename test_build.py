#!/usr/bin/env python3
"""Offline tests for the Python build step (everything but the network)."""
import sys
import build

results = []


def check(label, got, want):
    ok = got == want
    print(f"{'PASS' if ok else 'FAIL'}  {label}" +
          ("" if ok else f"\n        got {got!r}\n       want {want!r}"))
    results.append(ok)


# --- name normalization -------------------------------------------------
check("suffix stripped", build.norm("Marvin Harrison Jr."), "marvin harrison")
check("apostrophe", build.norm("De'Von Achane"), "devon achane")
check("hyphen", build.norm("Amon-Ra St. Brown"), "amon ra st brown")
check("roman numeral", build.norm("Michael Pittman II"), "michael pittman")
check("accents folded", build.norm("Equanimeous St. Brown"), "equanimeous st brown")
check("case and spacing", build.norm("  JOSH   ALLEN "), "josh allen")
check("sleeper vs fp agree",
      build.norm("Kenneth Walker III") == build.norm("Kenneth Walker"), True)

# --- FantasyPros URL slugs ---------------------------------------------
check("half ppr rb", build.slug("RB", "half"), "half-point-ppr-rb")
check("full ppr wr", build.slug("WR", "ppr"), "ppr-wr")
check("standard te", build.slug("TE", "std"), "te")
check("qb has no variant", build.slug("QB", "ppr"), "qb")
check("dst has no variant", build.slug("DST", "half"), "dst")
check("k has no variant", build.slug("K", "ppr"), "k")
check("half flex", build.slug("FLEX", "half"), "half-point-ppr-flex")
check("ppr flex", build.slug("FLEX", "ppr"), "ppr-flex")

# --- balanced brace extraction -----------------------------------------
check("nested objects",
      build.extract_object('var x = {"a":{"b":1},"c":2};', 8), '{"a":{"b":1},"c":2}')
check("brace inside string",
      build.extract_object('var x = {"a":"}"};', 8), '{"a":"}"}')
check("escaped quote",
      build.extract_object(r'{"a":"say \"hi\""}', 0), r'{"a":"say \"hi\""}')
check("no object found", build.extract_object("nothing here", 0), None)

# --- ecrData parsing ----------------------------------------------------
page = ('<html><script>var ecrData = {"players":[{"player_name":"Josh Allen",'
        '"player_team_id":"BUF","player_position_id":"QB","rank_ecr":"1",'
        '"pos_rank":"QB1","player_opponent":"vs NYJ"}]};</script></html>')
got = build.parse_ecr(page, "test")
check("parses one player", len(got), 1)
check("keeps the name", got[0]["player_name"], "Josh Allen")

check("window.ecrData variant",
      len(build.parse_ecr('<script>window.ecrData = {"players":[{"player_name":"X"}]}</script>',
                          "t")), 1)
check("no data returns empty", build.parse_ecr("<html>nope</html>", "t"), [])

# --- player map caching -------------------------------------------------
import json as _json, os as _os, tempfile, time as _time

tmp = tempfile.mkdtemp()
build.CACHE_DIR = tmp
path = _os.path.join(tmp, "players.json")


def no_network(*a, **k):
    raise AssertionError("load_players hit the network when it should have used cache")


# a fresh cache is reused without fetching
with open(path, "w") as f:
    _json.dump({"fetched": _time.time(), "players": {"1": {"n": "Cached Guy"}}}, f)
real_get, build.get = build.get, no_network
check("fresh cache reused", build.load_players(), {"1": {"n": "Cached Guy"}})

# a stale cache is not reused
with open(path, "w") as f:
    _json.dump({"fetched": _time.time() - 30 * 3600, "players": {"1": {"n": "Old"}}}, f)
try:
    build.load_players()
    check("stale cache refetches", "no fetch", "fetch attempted")
except AssertionError:
    check("stale cache refetches", "fetch attempted", "fetch attempted")

# a corrupt cache is not fatal
with open(path, "w") as f:
    f.write("{not json")
try:
    build.load_players()
    check("corrupt cache refetches", "no fetch", "fetch attempted")
except AssertionError:
    check("corrupt cache refetches", "fetch attempted", "fetch attempted")

# a cache written in the future (clock skew) is not trusted
with open(path, "w") as f:
    _json.dump({"fetched": _time.time() + 9999, "players": {"1": {"n": "Future"}}}, f)
try:
    build.load_players()
    check("future-dated cache refetches", "no fetch", "fetch attempted")
except AssertionError:
    check("future-dated cache refetches", "fetch attempted", "fetch attempted")

build.get = real_get

print(f"\n{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) else 1)
