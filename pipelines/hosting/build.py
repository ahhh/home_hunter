#!/usr/bin/env python3
"""Build the county hosting pages and the app's hosting data from counties.json.

    counties.json ──────────┬─> wiki/counties/<county>.md   one page per county, every claim cited
    ../incentives/*.json ───┤   wiki/counties/README.md     matrix of all 64 counties
                            ├─> wiki/18-incentive-zones.md  tax-credit zones, statewide
                            └─> public/data/states/CO/hosting.json   short summaries for the county panel

Usage:
    python3 pipelines/hosting/build.py           write the files
    python3 pipelines/hosting/build.py --check   exit 1 if any output is out of date (used in CI)
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Dict, List

import incentives

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
STATE_DIR = ROOT / "public" / "data" / "states" / "CO"
WIKI_DIR = ROOT / "wiki" / "counties"
WIKI_BASE = "https://github.com/ahhh/home_hunter/blob/main/wiki/"

# Counties with no building department, per the Division of Housing (checked 2026-09-29).
NO_BUILDING_DEPT = {
    "Baca", "Cheyenne", "Costilla", "Crowley", "Custer", "Delta", "Dolores", "Kit Carson", "Mineral",
    "Montezuma", "Phillips", "Prowers", "Saguache", "Sedgwick", "Washington", "Yuma",
}
DOH_SOURCE = {
    "title": "Division of Housing: jurisdictions without building departments",
    "url": "https://doh.colorado.gov/jurisdictions-without-building-departments-tiny-homes",
    "kind": "primary",
    "read": True,
}
CITY_COUNTIES = {"Denver", "Broomfield"}

SIGNALS = {
    "Pathway": "Explicit small-scale private-land camping permit",
    "Campground": "Paid camping handled as a campground/RV park or special use",
    "Restrictive": "A rule found limits paid camping, RV occupancy or camping-unit rentals",
    "Paused": "Moratorium on campground-type applications reported",
    "Unclear": "No specific camping provision found yet",
}
EVIDENCE = {
    "verified": "Verified: every sourced claim was read in a primary source",
    "partial": "Partly verified: some claims read in primary sources; the rest need confirmation",
    "unverified": "Needs confirmation: from official pages and search summaries; code text not read",
}
TOPICS = [
    ("private", "Private (non-commercial) camping"),
    ("commercial", "Paid camping / campground pathway"),
]


def slug(name: str) -> str:
    return name.lower().replace(" ", "-")


def claim_status(ids: List[str], sources: Dict[str, dict]) -> str:
    """verified = only read primary sources; reported = sourced but not all verified; lead = no source."""
    if not ids:
        return "lead"
    if all(sources[i]["kind"] == "primary" and sources[i].get("read") for i in ids):
        return "verified"
    return "reported"


def all_claims(c: dict) -> List[list]:
    claims = [cl for key, _ in TOPICS for cl in c[key]]
    claims += [c[k] for k in ("rv", "str", "water") if c.get(k)]
    return claims


def evidence(c: dict) -> str:
    statuses = [claim_status(ids, c["sources"]) for _, ids in all_claims(c) if ids]
    if statuses and all(s == "verified" for s in statuses):
        return "verified"
    if "verified" in statuses:
        return "partial"
    return "unverified"


def validate(counties: Dict[str, dict], names: List[str]) -> None:
    missing = set(names) - set(counties)
    extra = set(counties) - set(names)
    if missing or extra:
        sys.exit(f"counties.json doesn't match areas.json. Missing: {sorted(missing)}. Unknown: {sorted(extra)}")
    for name, c in counties.items():
        if c["signal"] not in SIGNALS:
            sys.exit(f"{name}: unknown signal {c['signal']!r}")
        for text, ids in all_claims(c):
            for i in ids:
                if i not in c["sources"]:
                    sys.exit(f"{name}: claim cites unknown source {i!r}: {text[:60]}")
        for i, s in c["sources"].items():
            if s["kind"] not in ("primary", "secondary"):
                sys.exit(f"{name}: source {i} has kind {s['kind']!r}")
        if not any(s["kind"] == "primary" for s in c["sources"].values()):
            sys.exit(f"{name}: needs at least one primary source")


def render_county(name: str, area: dict, profile: dict, c: dict, checked: str, next_review: str, incentive_section: str) -> str:
    sources = dict(c["sources"])
    if name in NO_BUILDING_DEPT:
        sources["doh"] = DOH_SOURCE
    numbers = {sid: n for n, sid in enumerate(sources, start=1)}

    def cite(ids: List[str]) -> str:
        if not ids:
            return " — *lead only, no source yet*"
        refs = ", ".join(f"[[{numbers[i]}]]({sources[i]['url']})" for i in ids)
        tag = {"verified": "verified", "reported": "needs confirmation"}[claim_status(ids, sources)]
        return f" — {refs} *({tag})*"

    def bullets(claims: List[list]) -> str:
        return "\n".join(f"- {text}{cite(ids)}" for text, ids in claims)

    muni = ("No. City and county are the same government, so the municipal code *is* the county code."
            if name in CITY_COUNTIES else
            "**Yes.** If the parcel is inside a city or town, that municipality's zoning applies instead of the county's. Check the assessor record for the tax district.")
    rv_line = bullets([c["rv"]]) if c.get("rv") else (
        "- Not confirmed. Most Colorado counties treat RVs as temporary/recreational, not dwellings. "
        "See [Structures, Tiny Homes & RVs](../09-structures-tiny-homes-rvs.md).")
    building = (f"- **No building department.** DOH inspects foundations for manufactured, tiny and factory-built homes. "
                f"State electrical and plumbing permits still apply.{cite(['doh'])}"
                if name in NO_BUILDING_DEPT else
                "- County building department (or the town's inside town limits). Confirm the adopted code edition, "
                "and the wildfire resiliency code if the parcel is in the WUI.")
    str_line = bullets([c["str"]]) if c.get("str") else (
        "- Not researched. If you offer a cabin, yurt or other structure, check for an STR/vacation-rental permit.")
    water_section = f"\n## Water\n\n{bullets([c['water']])}\n" if c.get("water") else ""

    src_lines = []
    for sid, s in sources.items():
        kind = "primary" if s["kind"] == "primary" else "**secondary**"
        read = "read" if s.get("read") else "not read in full"
        section = f", {s['section']}" if s.get("section") else ""
        src_lines.append(f"{numbers[sid]}. [{s['title']}]({s['url']}) — {kind}, {read}{section}")

    return f"""<!-- Generated by pipelines/hosting/build.py from pipelines/hosting/counties.json. Edit the JSON, not this file. -->
# {name} County

> {c['summary']}

| Field | Value |
|---|---|
| FIPS | {area['fips']} |
| County seat | {profile.get('countySeat', '')} |
| Region | {profile.get('region', '')} |
| Hipcamp signal | **{c['signal']}**: {SIGNALS[c['signal']]} |
| Municipality check required? | {muni} |
| Evidence | {EVIDENCE[evidence(c)]} |
| Date checked | {checked} |
| Next review | {next_review} |

## Planning & zoning

- Department: <{c['planning']}>

## {TOPICS[0][1]}

{bullets(c['private'])}

## {TOPICS[1][1]}

{bullets(c['commercial'])}

> County "camping on your own land" rules usually cover **non-commercial** use by the owner and their guests.
> A paid Hipcamp booking is often a campground or commercial use instead. Ask Planning in writing:
> *"How do you classify paid overnight camping booked through an online platform on this parcel?"*

## RVs, tiny homes & structures

{rv_line}
{building}
{water_section}
## Short-term rental / lodging rules

{str_line}
- Lodging taxes: Hipcamp collects state, county lodging and local marketing district taxes. Check for a **home-rule city** tax if the parcel is inside a municipality. See [Taxes](../10-taxes-and-licensing.md).

## Health, fire & other authorities

- Septic (OWTS), privies, water systems: the county's local public health agency. Find it at [CDPHE: find your local public health agency](https://cdphe.colorado.gov/public-information/find-your-local-public-health-agency).
- Fire bans: the Board of County Commissioners by ordinance, enforced by the Sheriff ([C.R.S. 30-15-401](https://law.justia.com/codes/colorado/title-30/county-powers-and-functions/general/article-15/part-4/section-30-15-401/)). A fire protection district may add restrictions.
- Wells: a Colorado Division of Water Resources permit, with uses limited to what the permit lists. See [Water & Wells](../07-water-and-wells.md).

## Notes for a Hipcamp host

{c['notes'] or '—'}

{incentive_section}
## Sources

{chr(10).join(src_lines)}

"Verified" means the cited text was read in the government's own document on the date checked. "Needs confirmation"
means the claim came from an official page or a search summary, or from a secondary source, and the text wasn't read
in full. **Primary** sources are the county's or state's own documents. **Secondary** sources are news or third-party summaries.
"""


def render_matrix(rows: List[tuple]) -> str:
    lines = [
        "<!-- Generated by pipelines/hosting/build.py from pipelines/hosting/counties.json. Edit the JSON, not this file. -->",
        "# Colorado County Matrix",
        "",
        "One standard page for each of Colorado's 64 counties. Every claim on a county page links to its source,",
        "and each source is labeled **primary** (the government's own document) or **secondary**. Claims we read in",
        "the primary text are marked *verified*. The rest are marked *needs confirmation*.",
        "Start with [how to use the wiki](../README.md).",
        "",
        "Home Hunter's county panel shows the one-line summary and signal from these pages.",
        "",
        "## Hipcamp signal legend",
        "",
        "| Signal | Meaning |",
        "|---|---|",
        *[f"| **{k}** | {v} |" for k, v in SIGNALS.items()],
        "",
        "The signal only says what research found so far. **Unclear** doesn't mean allowed.",
        "",
        "## All counties",
        "",
        "| County | Region | Hipcamp signal | Evidence | Summary |",
        "|---|---|---|---|---|",
    ]
    ev_short = {"verified": "Verified", "partial": "Partly verified", "unverified": "Needs confirmation"}
    for name, region, c in rows:
        lines.append(f"| [{name}]({slug(name)}.md) | {region} | {c['signal']} | {ev_short[evidence(c)]} | {c['summary']} |")
    lines += [
        "",
        "## Editing",
        "",
        "County pages are generated. Change `pipelines/hosting/counties.json`, then run",
        "`python3 pipelines/hosting/build.py`. CI fails if the pages or `public/data/states/CO/hosting.json` are out of date.",
        "",
        "Each claim is `[text, [source ids]]`. Each source has `title`, `url`, `kind` (`primary` or `secondary`), `read`",
        "(true only after you've read the cited text yourself) and an optional `section`. A county must have at least one",
        "primary source.",
    ]
    return "\n".join(lines) + "\n"


def build() -> Dict[Path, str]:
    data = json.loads((HERE / "counties.json").read_text())
    areas = json.loads((STATE_DIR / "areas.json").read_text())["areas"]
    profiles = {p["areaId"]: p for p in json.loads((STATE_DIR / "profiles.json").read_text())["profiles"]}
    counties = data["counties"]
    names = [a["name"].removesuffix(" County") for a in areas]
    validate(counties, names)

    programs, zones = incentives.load()
    if set(zones) != set(names):
        sys.exit("pipelines/incentives/zones.json doesn't match areas.json. Run: node pipelines/incentives/build.mjs")

    out: Dict[Path, str] = {}
    rows, records = [], []
    for area in areas:
        name = area["name"].removesuffix(" County")
        c, profile = counties[name], profiles.get(area["id"], {})
        section = incentives.render_section(name, programs, zones[name])
        out[WIKI_DIR / f"{slug(name)}.md"] = render_county(name, area, profile, c, data["checkedAt"], data["nextReview"], section)
        rows.append((name, profile.get("region", ""), c))
        primary = [s for s in c["sources"].values() if s["kind"] == "primary"]
        primary.sort(key=lambda s: not s.get("read"))  # sources we actually read first
        records.append({
            "areaId": area["id"],
            "signal": c["signal"],
            "summary": c["summary"],
            "evidence": evidence(c),
            "noBuildingDept": name in NO_BUILDING_DEPT,
            "wikiPath": f"counties/{slug(name)}.md",
            "sources": [
                {k: s[k] for k in ("title", "url", "section") if s.get(k)} | {"read": bool(s.get("read"))}
                for s in primary[:3]
            ],
            "incentives": incentives.panel_record(zones[name]),
        })
    out[WIKI_DIR / "README.md"] = render_matrix(rows)
    out[WIKI_DIR.parent / "18-incentive-zones.md"] = incentives.render_statewide(
        programs, zones, [(name, region, slug(name)) for name, region, _ in rows])
    out[STATE_DIR / "hosting.json"] = json.dumps({
        "datasetVersion": f"co-hosting-{data['checkedAt'][:7]}",
        "checkedAt": data["checkedAt"],
        "nextReview": data["nextReview"],
        "wikiBase": WIKI_BASE,
        "incentivesCheckedAt": programs["checkedAt"],
        "records": records,
    }, indent=2) + "\n"
    return out


def main(argv: List[str]) -> int:
    out = build()
    if "--check" in argv:
        stale = [p for p, text in out.items() if not p.exists() or p.read_text() != text]
        for p in stale:
            print(f"out of date: {p.relative_to(ROOT)}")
        if stale:
            print("Run: python3 pipelines/hosting/build.py")
        return 1 if stale else 0
    for p, text in out.items():
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)
    print(f"Wrote {len(out)} files")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
