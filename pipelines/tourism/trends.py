#!/usr/bin/env python3
"""Measure Google search interest in Colorado destinations and write the app's tourism data.

    attractions.json ──> Google Trends (US searchers, last 12 months) ──> public/data/states/CO/tourism.json

Google Trends only compares up to 5 terms at a time, each scaled 0-100 against the busiest week in that
comparison. To put ~90 destinations on one scale:

  pass 1  every attraction is compared against one anchor (Garden of the Gods) for a rough size;
  pass 2  attractions are sorted by that size and compared in groups of 4 similar-sized ones, each group
          anchored to the smallest member of the group before it, so small destinations aren't rounded to 0
          next to big ones. Scores chain back to the first anchor.

The result is relative: 100 is the most-searched attraction, 10 means a tenth of its search volume.

Usage:
    python3 pipelines/tourism/trends.py            fetch (cached for 30 days) and write tourism.json
    python3 pipelines/tourism/trends.py --refresh  ignore the cache
    python3 pipelines/tourism/trends.py --offline  rebuild tourism.json from the cache only
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import http.cookiejar
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Dict, List

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
OUT = ROOT / "public" / "data" / "states" / "CO" / "tourism.json"
CACHE = HERE / "cache"

GEO = "US"
TIMEFRAME = "today 12-m"
ANCHOR = "garden-of-the-gods"
GROUP = 4  # plus one anchor = Google's limit of 5 terms
PAUSE_S = 4.0  # between requests; Google rate-limits bursts
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


class Trends:
    def __init__(self, refresh: bool, offline: bool, cache_days: int):
        self.refresh, self.offline, self.cache_days = refresh, offline, cache_days
        self.requests = 0
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        self.opener.addheaders = [("User-Agent", "Mozilla/5.0 (home-hunter tourism pipeline)"), ("Accept-Language", "en-US")]
        self.warmed = False

    def _get(self, url: str) -> dict:
        for attempt in range(6):
            time.sleep(PAUSE_S * (1 if attempt == 0 else 8 * attempt))
            try:
                if not self.warmed:
                    self.opener.open("https://trends.google.com/trends/?geo=US", timeout=30).read()  # sets the NID cookie
                    self.warmed = True
                self.requests += 1
                text = self.opener.open(url, timeout=30).read().decode()
                return json.loads(text[text.index("{"):])  # strip the )]}' guard
            except urllib.error.HTTPError as e:
                if e.code != 429:
                    raise
                print(f"  rate-limited, waiting ({attempt + 1}/6)", file=sys.stderr)
        raise SystemExit("Google Trends kept rate-limiting. Try again later; finished batches are cached.")

    def compare(self, terms: List[str]) -> Dict[str, List[tuple]]:
        """Weekly interest for up to 5 terms on a shared 0-100 scale: {term: [(unix_time, value), ...]}."""
        req = {"comparisonItem": [{"keyword": t, "geo": GEO, "time": TIMEFRAME} for t in terms], "category": 0, "property": ""}
        key = hashlib.sha1(json.dumps(req, sort_keys=True).encode()).hexdigest()[:16]
        path = CACHE / f"{key}.json"
        if path.exists() and not self.refresh:
            cached = json.loads(path.read_text())
            age = (dt.datetime.now(dt.timezone.utc) - dt.datetime.fromisoformat(cached["fetchedAt"])).days
            if age <= self.cache_days or self.offline:
                return {t: [tuple(p) for p in s] for t, s in cached["series"].items()}
        if self.offline:
            raise SystemExit(f"--offline: no cached comparison for {terms}")
        q = urllib.parse.quote
        explore = self._get(f"https://trends.google.com/trends/api/explore?hl=en-US&tz=0&req={q(json.dumps(req))}")
        widget = next(w for w in explore["widgets"] if w["id"] == "TIMESERIES")
        data = self._get("https://trends.google.com/trends/api/widgetdata/multiline?hl=en-US&tz=0"
                         f"&req={q(json.dumps(widget['request']))}&token={widget['token']}")
        points = [p for p in data["default"]["timelineData"] if not p.get("isPartial")]
        series = {t: [(int(p["time"]), p["value"][i]) for p in points] for i, t in enumerate(terms)}
        CACHE.mkdir(exist_ok=True)
        path.write_text(json.dumps({"fetchedAt": dt.datetime.now(dt.timezone.utc).isoformat(), "request": req, "series": series}))
        return series


def mean(series: List[tuple]) -> float:
    return sum(v for _, v in series) / len(series) if series else 0.0


def peak_month(series: List[tuple]) -> str | None:
    by_month: Dict[int, List[int]] = {}
    for t, v in series:
        by_month.setdefault(dt.datetime.fromtimestamp(t, dt.timezone.utc).month, []).append(v)
    if not by_month or not any(any(v) for v in by_month.values()):
        return None
    return MONTHS[max(by_month, key=lambda m: sum(by_month[m]) / len(by_month[m])) - 1]


def chunks(xs: list, n: int) -> List[list]:
    return [xs[i:i + n] for i in range(0, len(xs), n)]


def main(argv: List[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--refresh", action="store_true", help="ignore cached Trends responses")
    ap.add_argument("--offline", action="store_true", help="use cached responses only, however old")
    ap.add_argument("--cache-days", type=int, default=30)
    args = ap.parse_args(argv)

    src = json.loads((HERE / "attractions.json").read_text())
    attractions = src["attractions"]
    term = {a["id"]: a["topic"] or a["query"] for a in attractions}
    by_term = {v: k for k, v in term.items()}
    if len(by_term) != len(term):
        raise SystemExit("Two attractions use the same Trends term")
    trends = Trends(args.refresh, args.offline, args.cache_days)

    # Pass 1: everything against the anchor.
    rough: Dict[str, float] = {ANCHOR: 1.0}
    others = [a["id"] for a in attractions if a["id"] != ANCHOR]
    for i, group in enumerate(chunks(others, GROUP), start=1):
        print(f"pass 1, batch {i}: {', '.join(group)}")
        s = trends.compare([term[ANCHOR]] + [term[g] for g in group])
        base = mean(s[term[ANCHOR]])
        for g in group:
            rough[g] = mean(s[term[g]]) / base

    # Pass 2: similar-sized groups, chained from the biggest down.
    order = sorted(rough, key=lambda k: -rough[k])
    score: Dict[str, float] = {}
    season: Dict[str, str | None] = {}
    anchor, anchor_score = ANCHOR, 1.0
    for i, group in enumerate(chunks([k for k in order if k != ANCHOR], GROUP), start=1):
        print(f"pass 2, batch {i}: {', '.join(group)} (anchor {anchor})")
        s = trends.compare([term[anchor]] + [term[g] for g in group])
        base = mean(s[term[anchor]])
        for g in group:
            score[g] = mean(s[term[g]]) / base * anchor_score if base else rough[g]
            season[g] = peak_month(s[term[g]])
        if anchor == ANCHOR:
            season[ANCHOR] = peak_month(s[term[ANCHOR]])
        # The next group is anchored to this group's smallest member that has data.
        nonzero = [g for g in group if score[g] > 0]
        if nonzero:
            anchor = min(nonzero, key=lambda g: score[g])
            anchor_score = score[anchor]
    score[ANCHOR] = 1.0

    top = max(score.values())
    records = []
    for a in attractions:
        records.append({
            "id": a["id"], "name": a["name"], "category": a["category"], "lat": a["lat"], "lng": a["lng"],
            "interest": round(100 * score[a["id"]] / top, 2),
            "peakMonth": season.get(a["id"]),
            "trendsTerm": a.get("topicTitle") or f'"{a["query"]}"',
            "stays": a["stays"],
        })
    records.sort(key=lambda r: -r["interest"])
    OUT.write_text(json.dumps({
        "datasetVersion": f"co-tourism-{dt.date.today():%Y-%m}",
        "builtAt": dt.date.today().isoformat(),
        "source": {
            "name": "Google Trends",
            "url": "https://trends.google.com/trends/explore?geo=US",
            "geo": GEO,
            "timeframe": "last 12 months",
            "note": "Relative search interest from US searchers, chained across comparisons; 100 = the most-searched destination here.",
        },
        "staysNote": "Where visitors stay is an editorial estimate per destination (pipelines/tourism/attractions.json), not measured.",
        "bases": src["bases"],
        "attractions": records,
    }, indent=1, ensure_ascii=False) + "\n")
    print(f"Wrote {OUT.relative_to(ROOT)}: {len(records)} attractions, {trends.requests} Trends requests")
    for r in records[:12]:
        print(f"  {r['interest']:6.1f}  {r['name']}  (peak {r['peakMonth']})")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
