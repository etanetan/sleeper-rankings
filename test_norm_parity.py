#!/usr/bin/env python3
"""
The FantasyPros join matches players by normalized name. build.py normalizes in
Python, app.js in JavaScript. If those two ever disagree the join fails
silently - players just show as unranked - so compare them directly.
"""
import json
import subprocess
import sys

import build

NAMES = [
    "Josh Allen", "Ja'Marr Chase", "Amon-Ra St. Brown", "Marvin Harrison Jr.",
    "Kenneth Walker III", "De'Von Achane", "D'Andre Swift", "T.J. Hockenson",
    "A.J. Brown", "DK Metcalf", "Michael Pittman Jr.", "Brian Robinson Jr.",
    "Chig Okonkwo", "Equanimeous St. Brown", "JuJu Smith-Schuster",
    "Jaxon Smith-Njigba", "Marquise Brown", "Odell Beckham Jr.",
    "Travis Etienne Jr.", "Kyle Pitts Sr.", "Deebo Samuel Sr.",
    "Gabe Davis", "Tank Dell", "Josh Palmer", "Cedrick Wilson Jr.",
    "José Peña", "Renfrow", "  SPACED   OUT  NAME ", "", "X Æ A-12",
    "Patrick Mahomes II", "Robert Griffin III", "Ronald Jones II",
    "Nathaniel Dell", "Pierre Strong Jr.", "Irv Smith Jr.",
]

js = """
const app = require("./app.js");
const names = JSON.parse(process.argv[1]);
console.log(JSON.stringify(names.map(app.norm)));
"""
out = subprocess.run(["node", "-e", js, json.dumps(NAMES)],
                     capture_output=True, text=True, cwd=".")
if out.returncode != 0:
    print("FAIL  could not run the JS normalizer")
    print(out.stderr)
    sys.exit(1)

js_results = json.loads(out.stdout)
py_results = [build.norm(n) for n in NAMES]

bad = 0
for name, p, j in zip(NAMES, py_results, js_results):
    if p != j:
        bad += 1
        print(f"FAIL  {name!r}\n        python -> {p!r}\n        js     -> {j!r}")

print(f"\n{len(NAMES) - bad}/{len(NAMES)} names normalize identically in both languages")
sys.exit(0 if bad == 0 else 1)
