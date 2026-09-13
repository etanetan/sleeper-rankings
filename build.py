#!/usr/bin/env python3
"""
Build a static rankings page for every Sleeper league a user is in.

Pulls rosters from the Sleeper API and expert consensus rankings (ECR) from
FantasyPros, picking the ranking variant that matches each league's scoring
(full PPR / half PPR / standard), then writes a single self-contained index.html.

Runs in GitHub Actions, where outbound network access is unrestricted.
"""

import json
import os
import re
import sys
import time
import unicodedata
from html import escape

import requests

USERNAME = os.environ.get("SLEEPER_USERNAME", "etanetan")
OUT = os.environ.get("OUTPUT_PATH", "site/index.html")

SLEEPER = "https://api.sleeper.app/v1"
FP = "https://www.fantasypros.com/nfl/rankings"
UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/125.0 Safari/537.36"}

# Positions we rank. FLEX is fetched separately as a cross-position yardstick.
POSITIONS = ["QB", "RB", "WR", "TE", "K", "DST"]

SLOT_ELIGIBLE = {
    "QB": {"QB"},
    "RB": {"RB"},
    "WR": {"WR"},
    "TE": {"TE"},
    "K": {"K"},
    "DEF": {"DEF"},
    "FLEX": {"RB", "WR", "TE"},
    "WRRB_FLEX": {"RB", "WR"},
    "WRRB-FLEX": {"RB", "WR"},
    "REC_FLEX": {"WR", "TE"},
    "SUPER_FLEX": {"QB", "RB", "WR", "TE"},
}
SKIP_SLOTS = {"BN", "IR", "TAXI"}

# Sleeper -> FantasyPros team abbreviation differences.
TEAM_ALIAS = {"JAX": "JAC", "WAS": "WSH", "LV": "LVR", "LAR": "LAR", "LAC": "LAC"}

log = lambda *a: print(*a, file=sys.stderr, flush=True)


# --------------------------------------------------------------------------
# fetching
# --------------------------------------------------------------------------

def get(url, tries=4, **kw):
    """GET with backoff. Network hiccups in CI shouldn't fail the whole build."""
    last = None
    for n in range(tries):
        try:
            r = requests.get(url, headers=UA, timeout=45, **kw)
            if r.status_code == 200:
                return r
            last = f"HTTP {r.status_code}"
            log(f"  {url} -> {last} (attempt {n + 1}/{tries})")
        except requests.RequestException as e:
            last = str(e)
            log(f"  {url} -> {last} (attempt {n + 1}/{tries})")
        time.sleep(2 ** n)
    raise RuntimeError(f"failed to fetch {url}: {last}")


def get_json(url):
    return get(url).json()


# --------------------------------------------------------------------------
# FantasyPros scraping
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

    The page embeds its data as `var ecrData = {...}`. That has moved around
    over the years, so try a few known shapes and fail loudly with enough
    detail to fix it from the Actions log rather than silently returning [].
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
        players = data.get("players")
        if players:
            return players

    # Fallback: a Next.js style embedded payload.
    m = re.search(r'<script[^>]+id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.S)
    if m:
        try:
            blob = json.dumps(json.loads(m.group(1)))
            i = blob.find('"players"')
            if i > 0:
                log(f"  [{label}] __NEXT_DATA__ present; players key found but shape unknown")
        except json.JSONDecodeError:
            pass

    log(f"  [{label}] NO RANKINGS PARSED. len(html)={len(html)} "
        f"has_ecrData={'ecrData' in html} has_table={'<table' in html}")
    log(f"  [{label}] head: {html[:300]!r}")
    return []


def fp_slug(pos, fmt):
    """FantasyPros URL slug. QB/K/DST have no scoring variants."""
    if pos in ("QB", "K", "DST"):
        return pos.lower()
    prefix = {"ppr": "ppr-", "half": "half-point-ppr-", "std": ""}[fmt]
    return f"{prefix}{pos.lower()}"


_rank_cache = {}


def rankings(pos, fmt):
    """{normalized_key: {rank, pos_rank, team, opp, name}} for one position+format."""
    key = (pos, fmt)
    if key in _rank_cache:
        return _rank_cache[key]

    url = f"{FP}/{fp_slug(pos, fmt)}.php"
    log(f"fetching {url}")
    players = parse_ecr(get(url).text, f"{pos}/{fmt}")
    log(f"  -> {len(players)} players")

    out = {}
    for p in players:
        name = p.get("player_name") or ""
        team = (p.get("player_team_id") or "").upper()
        ppos = (p.get("player_position_id") or pos).upper()
        try:
            rank = int(float(p.get("rank_ecr") or 0))
        except (TypeError, ValueError):
            rank = 0
        rec = {
            "rank": rank,
            "pos_rank": p.get("pos_rank") or "",
            "team": team,
            "opp": p.get("player_opponent") or "",
            "name": name,
            "tier": p.get("tier"),
        }
        if ppos == "DST" or pos == "DST":
            out[f"DEF:{team}"] = rec
        else:
            out[f"{ppos}:{norm(name)}"] = rec
    _rank_cache[key] = out
    return out


# --------------------------------------------------------------------------
# matching
# --------------------------------------------------------------------------

SUFFIXES = {"jr", "sr", "ii", "iii", "iv", "v"}


def norm(name):
    name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    name = name.lower().replace(".", "").replace("'", "").replace("-", " ")
    parts = [p for p in re.split(r"\s+", name) if p and p not in SUFFIXES]
    return " ".join(parts)


def lookup(table, player):
    """Find a Sleeper player in a FantasyPros table."""
    pos = player["pos"]
    if pos == "DEF":
        team = player.get("team") or ""
        for t in (team, TEAM_ALIAS.get(team, team)):
            if f"DEF:{t}" in table:
                return table[f"DEF:{t}"]
        return None
    return table.get(f"{pos}:{norm(player['name'])}")


# --------------------------------------------------------------------------
# Sleeper
# --------------------------------------------------------------------------

def scoring_format(league):
    """full PPR / half PPR / standard, from the league's own scoring settings."""
    rec = (league.get("scoring_settings") or {}).get("rec", 0) or 0
    if rec >= 0.75:
        return "ppr"
    if rec >= 0.25:
        return "half"
    return "std"


FMT_LABEL = {"ppr": "Full PPR", "half": "Half PPR", "std": "Standard"}


def build():
    state = get_json(f"{SLEEPER}/state/nfl")
    season = state.get("season")
    week = state.get("week") or state.get("display_week") or 1
    log(f"season={season} week={week}")

    user = get_json(f"{SLEEPER}/user/{USERNAME}")
    uid = user["user_id"]
    log(f"user {USERNAME} -> {uid}")

    leagues = get_json(f"{SLEEPER}/user/{uid}/leagues/nfl/{season}")
    log(f"{len(leagues)} leagues")
    if not leagues:
        log("WARNING: no leagues returned for this season")

    log("fetching player dictionary (~5MB)")
    players_db = get_json(f"{SLEEPER}/players/nfl")
    log(f"  -> {len(players_db)} players")

    results = []
    for lg in leagues:
        fmt = scoring_format(lg)
        slots = [s for s in (lg.get("roster_positions") or []) if s not in SKIP_SLOTS]
        superflex = "SUPER_FLEX" in slots
        log(f"\nleague {lg['name']!r} fmt={fmt} superflex={superflex}")

        rosters = get_json(f"{SLEEPER}/league/{lg['league_id']}/rosters")
        mine = next((r for r in rosters if r.get("owner_id") == uid), None)
        if not mine:
            log("  no roster found for user, skipping")
            continue

        flex_table = rankings("FLEX", fmt)
        # Superflex ranks QBs and flex bodies on one scale; positional ranks
        # from separate lists are not comparable across those positions.
        sf_table = rankings("SUPERFLEX", fmt) if superflex else {}
        roster = []
        for pid in (mine.get("players") or []):
            meta = players_db.get(pid)
            if not meta:
                log(f"  unknown player id {pid}")
                continue
            pos = (meta.get("position") or "").upper()
            if pos == "DEF":
                name = f"{meta.get('first_name', '')} {meta.get('last_name', '')}".strip() or pid
                team = (meta.get("team") or pid).upper()
            else:
                name = meta.get("full_name") or \
                    f"{meta.get('first_name', '')} {meta.get('last_name', '')}".strip()
                team = (meta.get("team") or "FA").upper()

            p = {
                "id": pid, "name": name, "pos": pos, "team": team,
                "status": meta.get("injury_status") or "",
                "bye": meta.get("bye_week"),
            }

            table = rankings(pos, fmt) if pos in ("QB", "RB", "WR", "TE", "K") else \
                rankings("DST", fmt) if pos == "DEF" else {}
            hit = lookup(table, p)
            if hit:
                p["rank"] = hit["rank"]
                p["pos_rank"] = hit["pos_rank"]
                p["opp"] = hit["opp"]
            else:
                p["rank"] = None
                p["pos_rank"] = ""
                p["opp"] = ""
                if pos in ("QB", "RB", "WR", "TE", "K", "DEF"):
                    log(f"  UNMATCHED {pos} {name} ({team})")

            fhit = lookup(flex_table, p) if pos in ("RB", "WR", "TE") else None
            p["flex_rank"] = fhit["rank"] if fhit else None
            shit = lookup(sf_table, p) if sf_table else None
            p["sf_rank"] = shit["rank"] if shit else None
            roster.append(p)

        results.append({
            "name": lg.get("name"), "id": lg["league_id"], "fmt": fmt,
            "superflex": superflex, "slots": slots, "roster": roster,
            "lineup": pick_lineup(roster, slots),
        })

    return {"season": season, "week": week, "user": USERNAME, "leagues": results}


def pick_lineup(roster, slots):
    """
    Greedy optimal-ish lineup: fill the most restrictive slots first, taking the
    best available by positional rank, then fill flex slots by cross-position
    FLEX rank. Injured/out players sink to the bottom.
    """
    def penalty(p):
        return 500 if (p.get("status") or "").upper() in ("OUT", "IR", "DOUB", "SUSP") else 0

    def pos_key(p):
        r = p.get("rank")
        return (0, (r if r else 9999) + penalty(p))

    def flex_key(p):
        r = p.get("flex_rank") or p.get("rank")
        return (0, (r if r else 9999) + penalty(p))

    def sf_key(p):
        """Superflex: one scale spanning QB and flex. Falls back to QBs-first."""
        if p.get("sf_rank"):
            return (0, p["sf_rank"] + penalty(p))
        if p["pos"] == "QB":
            return (0, (p.get("rank") or 9999) + penalty(p))
        return (1, (p.get("flex_rank") or p.get("rank") or 9999) + penalty(p))

    avail = list(roster)
    order = sorted(range(len(slots)), key=lambda i: len(SLOT_ELIGIBLE.get(slots[i], set())))
    picked = {}
    for i in order:
        slot = slots[i]
        elig = SLOT_ELIGIBLE.get(slot)
        if not elig:
            continue
        if slot == "SUPER_FLEX":
            key = sf_key
        elif len(elig) > 1:
            key = flex_key
        else:
            key = pos_key
        pool = [p for p in avail if p["pos"] in elig]
        if not pool:
            continue
        best = min(pool, key=key)
        picked[i] = best
        avail.remove(best)

    starters = [(slots[i], picked[i]) for i in range(len(slots)) if i in picked]
    return {"starters": starters, "bench": avail}


# --------------------------------------------------------------------------
# rendering
# --------------------------------------------------------------------------

CSS = """
:root{--bg:#f7f7f5;--card:#fff;--ink:#1a1a17;--dim:#6b6b63;--line:#e3e3dd;
--accent:#b45309;--good:#15803d;--bad:#b91c1c;--chip:#efefe9}
@media(prefers-color-scheme:dark){:root{--bg:#16161a;--card:#1e1e24;--ink:#ececf0;
--dim:#9a9aa5;--line:#2e2e38;--accent:#f59e0b;--good:#4ade80;--bad:#f87171;--chip:#2a2a33}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
padding:24px 16px 64px}
.wrap{max-width:880px;margin:0 auto}
h1{font-size:22px;margin:0 0 4px}
.sub{color:var(--dim);font-size:13px;margin-bottom:28px}
.league{background:var(--card);border:1px solid var(--line);border-radius:12px;
padding:18px;margin-bottom:22px}
.lh{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px;margin-bottom:14px}
.lh h2{font-size:17px;margin:0}
.chip{background:var(--chip);color:var(--dim);border-radius:999px;
padding:2px 9px;font-size:11px;font-weight:600;letter-spacing:.03em;text-transform:uppercase}
.chip.fmt{color:var(--accent)}
h3{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);
margin:18px 0 6px;font-weight:600}
table{width:100%;border-collapse:collapse;font-size:14px}
td,th{padding:6px 8px;text-align:left;border-bottom:1px solid var(--line)}
th{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--dim);font-weight:600}
tr:last-child td{border-bottom:none}
.slot{font-weight:700;color:var(--dim);font-size:12px;width:52px}
.pos{color:var(--dim);font-size:12px;width:38px}
.rk{text-align:right;font-variant-numeric:tabular-nums;width:62px}
.rk b{color:var(--accent)}
.nm{font-weight:500}
.meta{color:var(--dim);font-size:12px;font-weight:400}
.out{color:var(--bad);font-size:11px;font-weight:700;margin-left:4px}
.q{color:var(--accent);font-size:11px;font-weight:700;margin-left:4px}
.none{color:var(--dim);font-size:13px;font-style:italic}
.tbl-wrap{overflow-x:auto}
footer{color:var(--dim);font-size:12px;text-align:center;margin-top:36px}
a{color:var(--accent)}
"""

INJ = {"OUT": "OUT", "IR": "IR", "DOUB": "D", "QUES": "Q", "SUSP": "SUS", "PUP": "PUP"}


def badge(p):
    s = (p.get("status") or "").upper()
    if not s:
        return ""
    cls = "out" if s in ("OUT", "IR", "DOUB", "SUSP", "PUP") else "q"
    return f'<span class="{cls}">{escape(INJ.get(s, s))}</span>'


def rank_cell(p):
    if not p.get("rank"):
        return '<td class="rk meta">—</td>'
    pr = escape(str(p.get("pos_rank") or ""))
    return f'<td class="rk"><b>{pr or p["rank"]}</b></td>'


def player_row(p, slot=None):
    opp = f' <span class="meta">{escape(p["opp"])}</span>' if p.get("opp") else ""
    team = escape(p.get("team") or "")
    cells = []
    if slot is not None:
        cells.append(f'<td class="slot">{escape(slot)}</td>')
    cells.append(f'<td class="nm">{escape(p["name"])}{badge(p)}'
                 f'<span class="meta"> · {team}</span>{opp}</td>')
    cells.append(f'<td class="pos">{escape(p["pos"])}</td>')
    cells.append(rank_cell(p))
    return "<tr>" + "".join(cells) + "</tr>"


def render(data):
    parts = [f"<h1>Week {data['week']} · {escape(str(data['user']))}</h1>"]
    parts.append('<div class="sub">Expert consensus rankings from FantasyPros, '
                 'matched to each league\'s scoring. Numbers are positional rank '
                 '(e.g. WR8). Updated '
                 f'{time.strftime("%a %b %-d, %-I:%M %p UTC", time.gmtime())}.</div>')

    if not data["leagues"]:
        parts.append('<p class="none">No leagues found for this season.</p>')

    for lg in data["leagues"]:
        parts.append('<div class="league">')
        parts.append('<div class="lh">')
        parts.append(f'<h2>{escape(lg["name"] or "League")}</h2>')
        parts.append(f'<span class="chip fmt">{FMT_LABEL[lg["fmt"]]}</span>')
        if lg["superflex"]:
            parts.append('<span class="chip">Superflex</span>')
        parts.append("</div>")

        lineup = lg["lineup"]
        parts.append("<h3>Start</h3>")
        if lineup["starters"]:
            parts.append('<div class="tbl-wrap"><table>')
            for slot, p in lineup["starters"]:
                parts.append(player_row(p, slot))
            parts.append("</table></div>")
        else:
            parts.append('<p class="none">Couldn\'t determine a lineup.</p>')

        if lineup["bench"]:
            parts.append("<h3>Bench</h3>")
            parts.append('<div class="tbl-wrap"><table>')
            for p in sorted(lineup["bench"], key=lambda x: (x["pos"], x["rank"] or 9999)):
                parts.append(player_row(p))
            parts.append("</table></div>")

        parts.append("<h3>All players by position</h3>")
        parts.append('<div class="tbl-wrap"><table>')
        for pos in POSITIONS + ["DEF"]:
            grp = [p for p in lg["roster"] if p["pos"] == (pos if pos != "DST" else "DEF")]
            if pos == "DST":
                continue
            if not grp:
                continue
            for p in sorted(grp, key=lambda x: x["rank"] or 9999):
                parts.append(player_row(p))
        parts.append("</table></div>")
        parts.append("</div>")

    parts.append('<footer>Built automatically · '
                 '<a href="https://www.fantasypros.com/nfl/rankings/qb.php">FantasyPros</a> · '
                 '<a href="https://sleeper.com">Sleeper</a></footer>')

    return (f"<title>Week {data['week']} Rankings</title>"
            f"<meta name=viewport content='width=device-width,initial-scale=1'>"
            f"<style>{CSS}</style>"
            f'<div class="wrap">{"".join(parts)}</div>')


def main():
    data = build()
    html = render(data)
    os.makedirs(os.path.dirname(OUT) or ".", exist_ok=True)
    with open(OUT, "w") as f:
        f.write(html)
    log(f"\nwrote {OUT} ({len(html)} bytes)")

    matched = sum(1 for lg in data["leagues"] for p in lg["roster"] if p.get("rank"))
    total = sum(len(lg["roster"]) for lg in data["leagues"])
    log(f"matched {matched}/{total} players to rankings")
    if total and matched == 0:
        log("ERROR: nothing matched — the FantasyPros parser is probably broken")
        sys.exit(1)


if __name__ == "__main__":
    main()
