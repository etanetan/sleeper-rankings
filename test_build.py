#!/usr/bin/env python3
"""Offline tests for the logic that doesn't need network access."""
import sys
import build


def check(label, got, want):
    ok = got == want
    print(f"{'PASS' if ok else 'FAIL'}  {label}" + ("" if ok else f"\n        got {got!r}\n       want {want!r}"))
    return ok

results = []

# --- name normalization -------------------------------------------------
results.append(check("suffix stripped", build.norm("Marvin Harrison Jr."), "marvin harrison"))
results.append(check("apostrophe", build.norm("De'Von Achane"), "devon achane"))
results.append(check("hyphen", build.norm("Amon-Ra St. Brown"), "amon ra st brown"))
results.append(check("roman numeral", build.norm("Michael Pittman II"), "michael pittman"))
results.append(check("accents", build.norm("Equanimeous St. Brown"), "equanimeous st brown"))
results.append(check("case/space", build.norm("  JOSH   ALLEN "), "josh allen"))

# --- scoring detection --------------------------------------------------
results.append(check("full ppr", build.scoring_format({"scoring_settings": {"rec": 1.0}}), "ppr"))
results.append(check("half ppr", build.scoring_format({"scoring_settings": {"rec": 0.5}}), "half"))
results.append(check("standard", build.scoring_format({"scoring_settings": {"rec": 0}}), "std"))
results.append(check("missing rec", build.scoring_format({"scoring_settings": {}}), "std"))
results.append(check("no settings", build.scoring_format({}), "std"))

# --- FantasyPros slugs --------------------------------------------------
results.append(check("half rb slug", build.fp_slug("RB", "half"), "half-point-ppr-rb"))
results.append(check("ppr wr slug", build.fp_slug("WR", "ppr"), "ppr-wr"))
results.append(check("std te slug", build.fp_slug("TE", "std"), "te"))
results.append(check("qb ignores fmt", build.fp_slug("QB", "ppr"), "qb"))
results.append(check("dst ignores fmt", build.fp_slug("DST", "half"), "dst"))
results.append(check("flex half", build.fp_slug("FLEX", "half"), "half-point-ppr-flex"))

# --- balanced brace extraction -----------------------------------------
results.append(check("nested braces",
    build.extract_object('var x = {"a":{"b":1},"c":"}"};', 8), '{"a":{"b":1},"c":"}"}'))
results.append(check("escaped quote",
    build.extract_object(r'{"a":"say \"hi\""}', 0), r'{"a":"say \"hi\""}'))

# --- lineup construction ------------------------------------------------
def P(name, pos, rank, flex=None, status="", sf=None):
    return {"name": name, "pos": pos, "rank": rank, "flex_rank": flex, "sf_rank": sf,
            "team": "XXX", "status": status, "pos_rank": f"{pos}{rank}", "opp": ""}

roster = [
    P("Elite QB", "QB", 1), P("Backup QB", "QB", 20),
    P("RB1", "RB", 2, flex=3), P("RB2", "RB", 9, flex=14), P("RB3", "RB", 30, flex=60),
    P("WR1", "WR", 1, flex=1), P("WR2", "WR", 12, flex=18), P("WR3", "WR", 25, flex=40),
    P("TE1", "TE", 4, flex=22),
    P("K1", "K", 5), P("DEF1", "DEF", 6),
]
slots = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DEF", "BN", "BN"]
slots = [s for s in slots if s not in build.SKIP_SLOTS]
lu = build.pick_lineup(roster, slots)
names = [(s, p["name"]) for s, p in lu["starters"]]
results.append(check("starter count", len(names), 9))
results.append(check("best QB starts", dict(n for n in [names[0]])["QB"], "Elite QB"))
started = {p["name"] for _, p in lu["starters"]}
results.append(check("RB1+RB2 start", {"RB1", "RB2"} <= started, True))
results.append(check("WR1+WR2 start", {"WR1", "WR2"} <= started, True))
results.append(check("flex takes best flex rank (RB3 f60 vs WR3 f40 vs TE1 f22->TE slot)",
                     "WR3" in started, True))
results.append(check("bench holds the rest", sorted(p["name"] for p in lu["bench"]),
                     ["Backup QB", "RB3"]))

# injured player demoted
roster2 = [P("Hurt Stud", "RB", 1, flex=1, status="OUT"), P("Healthy", "RB", 15, flex=25),
           P("Also Healthy", "RB", 40, flex=70)]
lu2 = build.pick_lineup(roster2, ["RB"])
results.append(check("OUT player benched", lu2["starters"][0][1]["name"], "Healthy"))

# superflex should start the second QB
slots3 = ["QB", "SUPER_FLEX", "RB", "WR"]
lu3 = build.pick_lineup(roster, slots3)
sf = dict((s, p["name"]) for s, p in lu3["starters"])
results.append(check("superflex prefers QB2 over flex bodies (no sf data)", sf.get("SUPER_FLEX"), "Backup QB"))

# with real superflex ranks, the list decides rather than the fallback
sfr = [P("QB A", "QB", 1, sf=2), P("QB B", "QB", 22, sf=45),
       P("Stud WR", "WR", 1, flex=1, sf=8), P("Spare WR", "WR", 18, flex=30, sf=20)]
lu5 = build.pick_lineup(sfr, ["QB", "SUPER_FLEX", "WR"])
sf5 = dict((s, p["name"]) for s, p in lu5["starters"])
results.append(check("sf QB1 takes QB slot", sf5.get("QB"), "QB A"))
results.append(check("sf slot obeys the superflex list (WR sf20 over QB sf45)",
                     sf5.get("SUPER_FLEX"), "Spare WR"))
results.append(check("dedicated WR slot keeps the stud", sf5.get("WR"), "Stud WR"))

# a dedicated slot is filled before flex, so a lone eligible player is not stolen
lu6 = build.pick_lineup([P("Only TE", "TE", 30, flex=55), P("Good RB", "RB", 5, flex=6)],
                        ["TE", "FLEX"])
sf6 = dict((s, p["name"]) for s, p in lu6["starters"])
results.append(check("lone TE not stolen by flex", sf6.get("TE"), "Only TE"))
results.append(check("flex takes the RB", sf6.get("FLEX"), "Good RB"))

# unranked players sink below ranked ones
roster4 = [P("Unranked", "WR", None, flex=None), P("Ranked", "WR", 50, flex=80)]
lu4 = build.pick_lineup(roster4, ["WR"])
results.append(check("ranked beats unranked", lu4["starters"][0][1]["name"], "Ranked"))

# --- rendering ----------------------------------------------------------
data = {"season": "2026", "week": 2, "user": "etanetan", "leagues": [
    {"name": "Test <script>League</script>", "id": "1", "fmt": "half", "superflex": False,
     "slots": slots, "roster": roster, "lineup": lu}]}
html = build.render(data)
results.append(check("html non-empty", len(html) > 2000, True))
results.append(check("escapes league name", "<script>League" in html, False))
results.append(check("shows format label", "Half PPR" in html, True))
results.append(check("has viewport", "viewport" in html, True))
results.append(check("week in title", "Week 2" in html, True))

# empty-league page still renders
empty = build.render({"season": "2026", "week": 1, "user": "x", "leagues": []})
results.append(check("empty renders", "No leagues found" in empty, True))

print(f"\n{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) else 1)
