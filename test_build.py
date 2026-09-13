#!/usr/bin/env python3
"""Offline tests for the optional FantasyPros build step."""
import os
import re
import sys

import build

results = []


def check(label, got, want):
    ok = got == want
    print(f"{'PASS' if ok else 'FAIL'}  {label}" +
          ("" if ok else f"\n        got {got!r}\n       want {want!r}"))
    results.append(ok)


# --- name normalization (parity with app.js covered by test_norm_parity.py)
check("suffix stripped", build.norm("Marvin Harrison Jr."), "marvin harrison")
check("apostrophe", build.norm("De'Von Achane"), "devon achane")
check("hyphen", build.norm("Amon-Ra St. Brown"), "amon ra st brown")
check("roman numeral", build.norm("Kenneth Walker III"), "kenneth walker")
check("accents folded", build.norm("José Peña"), "jose pena")
check("empty safe", build.norm(""), "")
check("none safe", build.norm(None), "")


# --- parsing a consensus-rankings payload -------------------------------
class Fake:
    def __init__(self, payload, status=200):
        self._p, self.status_code, self.text = payload, status, "body"

    def json(self):
        if self._p is None:
            raise ValueError("not json")
        return self._p


sample = {"players": [
    {"player_name": "Josh Allen", "player_team_id": "BUF",
     "player_position_id": "QB", "rank_ecr": "1", "pos_rank": "QB1"},
    {"player_name": "Jalen Hurts", "player_team_id": "PHI",
     "player_position_id": "QB", "rank_ecr": 2.0, "pos_rank": "QB2"},
    {"player_name": "Broken", "player_team_id": "NYJ",
     "player_position_id": "QB", "rank_ecr": "not a number"},
    {"player_name": "", "player_team_id": "", "player_position_id": "QB",
     "rank_ecr": "9"},
]}
build.requests.get = lambda *a, **k: Fake(sample)
t = build.fp_table("2026", 2, "QB", "STD")
check("players keyed by normalized name", sorted(t), ["jalen hurts", "josh allen"])
check("integer rank parsed", t["josh allen"]["rank"], 1)
check("float rank parsed", t["jalen hurts"]["rank"], 2)
check("pos_rank digits extracted", t["josh allen"]["posRank"], 1)
check("unparseable rank skipped", "broken" in t, False)
check("nameless row skipped", len(t), 2)

dst = {"players": [{"player_name": "Jacksonville Jaguars", "player_team_id": "JAC",
                    "player_position_id": "DST", "rank_ecr": "140", "pos_rank": "DST7"}]}
build.requests.get = lambda *a, **k: Fake(dst)
check("defenses keyed by team", sorted(build.fp_table("2026", 2, "DST", "STD")), ["JAC"])

build.requests.get = lambda *a, **k: Fake({"error": "nope"})
check("payload without players is empty", build.fp_table("2026", 2, "QB", "STD"), {})
build.requests.get = lambda *a, **k: Fake(None)
check("non-JSON response is empty", build.fp_table("2026", 2, "QB", "STD"), {})
build.requests.get = lambda *a, **k: Fake({}, status=403)
check("rejected key is empty, not a crash", build.fp_table("2026", 2, "QB", "STD"), {})


def raises(*a, **k):
    raise build.requests.RequestException("network down")


build.requests.get = raises
check("network error is empty, not a crash", build.fp_table("2026", 2, "QB", "STD"), {})

# --- what the build publishes -------------------------------------------
check("static files include the page", "index.html" in build.STATIC_FILES, True)
check("static files include the script", "app.js" in build.STATIC_FILES, True)
check("static files include the stylesheet", "style.css" in build.STATIC_FILES, True)
for f in build.STATIC_FILES:
    check(f"{f} exists to be copied", os.path.exists(f), True)

# --- hosts and secrets --------------------------------------------------
source = open("build.py").read()
hosts = {re.sub(r"^https?://", "", u) for u in re.findall(r'https?://[a-z0-9.\-]+', source)}
check("only official API hosts contacted", sorted(hosts),
      ["api.fantasypros.com", "api.sleeper.app"])
check("never requests the fantasypros website", "www.fantasypros.com" in source, False)
check("api key read from the environment", 'os.environ.get("FANTASYPROS_API_KEY"' in source, True)

for f in ("build.py", "probe.py", "app.js", "index.html", "workflow.yml"):
    body = open(f).read()
    leak = re.search(r'(?i)api[_-]?key["\s:=]+["\x27][A-Za-z0-9]{20,}', body)
    check(f"no literal key in {f}", bool(leak), False)

client = open("app.js").read()
check("client never names the key variable", "FANTASYPROS_API_KEY" in client, False)
check("client never requests a fantasypros host",
      bool(re.search(r"https?://[a-z0-9.\-]*fantasypros", client, re.I)), False)
check("client only calls sleeper hosts",
      sorted({re.sub(r"^https?://", "", u)
              for u in re.findall(r'https?://[a-z0-9.\-]+', client)}),
      ["api.sleeper.app", "api.sleeper.com"])

print(f"\n{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) else 1)
