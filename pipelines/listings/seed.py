#!/usr/bin/env python3
"""Build a Home Hunter data bundle (seed file) of current listings to drop onto the app.

Listings come from the RentCast API (active MLS listings; needs RENTCAST_API_KEY in the
environment or .env) and from Redfin "Download All" CSVs saved in pipelines/listings/inbox/.
The result is a file on this computer: drag it onto the Home Hunter page or choose it under
Import. Nothing is uploaded or published.
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, Iterable, List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))
from rentcast import DEFAULT_MAX_CALLS, FREE_PLAN_MONTHLY, MAX_RADIUS_MILES, Budget, Cache, Client, Query  # noqa: E402

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]

# ---------------------------------------------------------------- shared rules
# These mirror src/sources/sources.ts and src/listings/collection.ts so the site and the
# script agree on ids, URLs and categories.

LAND = re.compile(r"\b(vacant land|land|lots?(/land)?|farm ?/ ?ranch land|acreage)\b", re.I)
IMPROVED = re.compile(
    r"\b(single family|residential|condo|co-op|townhouse|townhome|multi-family|duplex|triplex|"
    r"mobile|manufactured|cabin|house)\b",
    re.I,
)


def classify(raw: Optional[str], square_feet: Optional[float] = None, bedrooms: Optional[float] = None) -> str:
    """Explicit provider labels win; the only fallback is living area/bedrooms -> improved."""
    if raw:
        if LAND.search(raw):
            return "vacant_land"
        if IMPROVED.search(raw):
            return "improved"
    if (square_feet or 0) > 0 or (bedrooms or 0) > 0:
        return "improved"
    return "unknown"


def stable_id(s: str) -> str:
    """FNV-1a 32-bit over UTF-16 code units, base36 — identical to stableId() in the app."""
    h = 0x811C9DC5
    data = s.encode("utf-16-le")
    for i in range(0, len(data), 2):
        h ^= data[i] | (data[i + 1] << 8)
        h = (h * 0x01000193) & 0xFFFFFFFF
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    out = ""
    while True:
        h, r = divmod(h, 36)
        out = digits[r] + out
        if h == 0:
            return out


def canonical_url(raw: str) -> str:
    u = urllib.parse.urlsplit(raw.strip())
    host = (u.hostname or "").lower()
    if host.startswith("www."):
        host = host[4:]
    return f"https://{host}{u.path.rstrip('/')}"


def provider_for(url: str) -> str:
    host = (urllib.parse.urlsplit(url).hostname or "").lower()
    for pid, domain in [("zillow", "zillow.com"), ("redfin", "redfin.com"), ("realtor", "realtor.com"), ("landwatch", "landwatch.com")]:
        if host == domain or host.endswith("." + domain):
            return pid
    return host


def num(v) -> Optional[float]:
    if v is None:
        return None
    s = re.sub(r"[$,\s]", "", str(v))
    if not s:
        return None
    try:
        n = float(s)
    except ValueError:
        return None
    return int(n) if n.is_integer() else n


def distance_miles(a_lat: float, a_lng: float, b_lat: float, b_lng: float) -> float:
    r = math.radians
    d_lat, d_lng = r(b_lat - a_lat), r(b_lng - a_lng)
    h = math.sin(d_lat / 2) ** 2 + math.cos(r(a_lat)) * math.cos(r(b_lat)) * math.sin(d_lng / 2) ** 2
    return 2 * 3958.7613 * math.asin(min(1.0, math.sqrt(h)))


def norm_address(a: Optional[str]) -> Optional[str]:
    if not a:
        return None
    a = a.lower()
    for long, short in [("street", "st"), ("road", "rd"), ("avenue", "ave"), ("drive", "dr"), ("lane", "ln"), ("county road", "cr")]:
        a = re.sub(rf"\b{long}\b", short, a)
    return re.sub(r"[^a-z0-9]", "", a)


def clean(d: dict) -> dict:
    return {k: v for k, v in d.items() if v is not None and v != ""}


# ---------------------------------------------------------------- RentCast


def zillow_link(address: str) -> str:
    """Zillow's address search URL; it opens the property's page when Zillow has it."""
    slug = re.sub(r"[^A-Za-z0-9]+", "-", address).strip("-")
    return f"https://www.zillow.com/homes/{slug}_rb/"


def rentcast_property(item: dict, now: str) -> Optional[dict]:
    lat, lng = num(item.get("latitude")), num(item.get("longitude"))
    if lat is None or lng is None:
        return None
    address = item.get("formattedAddress")
    if address:
        url = zillow_link(address)
    elif item.get("mlsNumber"):
        # Undisclosed-address land: searching the MLS number finds it on the listing sites.
        q = f"MLS {item['mlsNumber']} {item.get('city', '')} {item.get('state', '')}"
        url = "https://www.google.com/search?q=" + urllib.parse.quote_plus(q.strip())
    else:
        return None
    lot = num(item.get("lotSize"))
    sqft = num(item.get("squareFootage"))
    beds = num(item.get("bedrooms"))
    listing = clean(
        {
            "provider": "rentcast",
            "providerListingId": item.get("id"),
            "canonicalUrl": canonical_url(url) if "zillow.com" in url else url,
            "status": "active" if str(item.get("status", "")).lower() == "active" else "unknown",
            "price": num(item.get("price")),
            "listedAt": (item.get("listedDate") or "")[:10] or None,
            "fetchedAt": now,
            "rawClassification": item.get("propertyType"),
            "attribution": " / ".join(x for x in ["RentCast", item.get("mlsName")] if x),
        }
    )
    return clean(
        {
            "id": stable_id(listing["canonicalUrl"]),
            "location": {"lat": lat, "lng": lng},
            "locationPrecision": "exact",
            "address": address,
            "category": classify(item.get("propertyType"), sqft, beds),
            "acreage": round(lot / 43560, 2) if lot else None,
            "bedrooms": beds,
            "bathrooms": num(item.get("bathrooms")),
            "squareFeet": sqft,
            "listings": [listing],
        }
    )


# ---------------------------------------------------------------- Redfin CSV inbox

ALIASES = {
    "url": ["url", "link", "listing url"],
    "price": ["price", "list price", "asking price"],
    "lat": ["latitude", "lat"],
    "lng": ["longitude", "lng", "lon", "long"],
    "address": ["address", "street address"],
    "city": ["city"],
    "state": ["state or province", "state"],
    "zip": ["zip or postal code", "zip", "zip code", "postal code"],
    "type": ["property type", "type", "home type"],
    "beds": ["beds", "bedrooms"],
    "baths": ["baths", "bathrooms"],
    "sqft": ["square feet", "sqft", "living area"],
    "lotSqft": ["lot size"],
    "acres": ["acres", "acreage", "lot acres"],
    "status": ["status"],
    "mlsId": ["mls#", "mls #", "mls"],
    "source": ["source"],
    "daysOnMarket": ["days on market"],
}


def read_csv(path: Path, now: str) -> List[dict]:
    text = path.read_text(encoding="utf-8-sig")
    rows = list(csv.DictReader(text.splitlines()))
    headers = list(rows[0].keys()) if rows else []
    col: Dict[str, Optional[str]] = {}
    for key, names in ALIASES.items():
        col[key] = next(
            (h for h in headers if h and (h.strip().lower() in names or (key == "url" and h.strip().lower().startswith("url ")))),
            None,
        )
    missing = [k for k in ("url", "price", "lat", "lng") if not col[k]]
    if missing:
        print(f"  {path.name}: skipped, missing columns {', '.join(missing)}")
        return []

    def get(row, key):
        c = col.get(key)
        v = row.get(c) if c else None
        return v.strip() if isinstance(v, str) and v.strip() else None

    out = []
    for row in rows:
        lat, lng, url = num(get(row, "lat")), num(get(row, "lng")), get(row, "url")
        if lat is None or lng is None or not url or not url.startswith("http"):
            continue  # Redfin's MLS disclaimer row has no coordinates
        sqft, beds, lot = num(get(row, "sqft")), num(get(row, "beds")), num(get(row, "lotSqft"))
        acres = num(get(row, "acres"))
        if acres is None and lot is not None:
            acres = round(lot / 43560, 2)
        status = (get(row, "status") or "").lower()
        dom = num(get(row, "daysOnMarket"))
        street = get(row, "address")
        canon = canonical_url(url)
        listing = clean(
            {
                "provider": provider_for(url),
                "providerListingId": get(row, "mlsId"),
                "canonicalUrl": canon,
                "status": "active" if status == "active" else "pending" if ("pending" in status or "contingent" in status) else "unknown",
                "price": num(get(row, "price")),
                "listedAt": (datetime.fromisoformat(now[:19]) - timedelta(days=dom)).date().isoformat() if dom is not None else None,
                "fetchedAt": now,
                "rawClassification": get(row, "type"),
                "attribution": get(row, "source"),
            }
        )
        state_zip = " ".join(x for x in [get(row, "state"), get(row, "zip")] if x)
        out.append(
            clean(
                {
                    "id": stable_id(canon),
                    "location": {"lat": lat, "lng": lng},
                    "locationPrecision": "exact",
                    "address": ", ".join(x for x in [street, get(row, "city"), state_zip] if x) if street else None,
                    "category": classify(get(row, "type"), sqft, beds),
                    "acreage": acres,
                    "bedrooms": beds,
                    "bathrooms": num(get(row, "baths")),
                    "squareFeet": sqft,
                    "listings": [listing],
                }
            )
        )
    return out


# ---------------------------------------------------------------- merge & publish


def merge(properties: Iterable[dict]) -> List[dict]:
    """Same listing URL -> one listing; same street address within ~150 m -> one property."""
    result: List[dict] = []
    by_url: Dict[str, dict] = {}
    by_address: Dict[str, List[dict]] = {}
    for inc in properties:
        target = next((by_url[l["canonicalUrl"]] for l in inc["listings"] if l["canonicalUrl"] in by_url), None)
        addr = norm_address(inc.get("address"))
        if target is None and addr and len(addr) > 6:
            target = next(
                (
                    p
                    for p in by_address.get(addr, [])
                    if distance_miles(p["location"]["lat"], p["location"]["lng"], inc["location"]["lat"], inc["location"]["lng"]) < 0.1
                ),
                None,
            )
        if target is None:
            result.append(inc)
            target = inc
        else:
            for l in inc["listings"]:
                if l["canonicalUrl"] not in by_url:
                    target["listings"].append(l)
        for l in inc["listings"]:
            by_url[l["canonicalUrl"]] = target
        if addr and len(addr) > 6 and not any(x is target for x in by_address.setdefault(addr, [])):
            by_address[addr].append(target)
        if target is inc:
            continue
        for k in ("address", "acreage", "bedrooms", "bathrooms", "squareFeet"):
            if k not in target and k in inc:
                target[k] = inc[k]
        if target.get("category") == "unknown":
            target["category"] = inc["category"]
    return result


def load_dotenv(path: Path) -> None:
    """Minimal .env support (KEY=value lines) so the API key never has to be typed or committed."""
    if not path.is_file():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip().removeprefix("export ").strip(), v.strip().strip("'\""))


EXAMPLES = f"""
examples:
  # How big is a search? Costs 1 call, and the real run reuses it from the cache.
  python3 seed.py --center 38.74,-106.0 --radius 60 --types land,house --price :700k --estimate

  # Build a bundle from that search.
  python3 seed.py --center 38.74,-106.0 --radius 60 --types land,house --price :700k

  # Land only, 5+ acres, under $250k, in one ZIP.
  python3 seed.py --zip 81211 --types land --acres 5: --price :250k

  # Houses with 3+ beds on at least 1 acre in a town.
  python3 seed.py --city Salida --types house --beds 3: --acres 1:

  # Saved presets from searches.json (see --list-presets). Flags override a preset's values.
  python3 seed.py --preset arkansas-valley
  python3 seed.py --preset arkansas-valley --price :400k

  # Weekly top-up: only listings posted in the last 7 days (usually 1 call).
  python3 seed.py --preset arkansas-valley --new-days 7

  # Only the Redfin CSVs in the inbox, no API calls. --add-only keeps the listings
  # from your last full bundle instead of replacing them.
  python3 seed.py --no-api --add-only

full vs partial bundles:
  A full bundle replaces the last one: seeded listings missing from it are removed in the app
  (unless someone rated them or wrote notes). --new-days, --add-only, or a search cut short by
  the cap make a partial bundle, which only adds and refreshes.

narrowing a search (each call returns up to 500 listings, so calls = matches / 500):
  --types        Biggest saver. Condos and townhouses fill pages fast near towns.
  --price        Cap the budget: :700k, or a band like 150k:400k.
  --acres        Lot size in acres: 5: (5 or more), :2 (up to 2), 1:10.
  --beds/--baths Only for houses: 3: means 3 or more.
  --radius       Up to {MAX_RADIUS_MILES} miles. One big circle is cheaper than several overlapping small ones.
  --new-days     Only new listings; makes a partial bundle (the app won't treat
                 missing listings as sold).
  Ranges are MIN:MAX; leave either end blank (or *) for no limit. A single number means
  exactly that value. Money accepts k and m: 250k, 1.2m.

call budget:
  Each run stops at --max-calls (default {DEFAULT_MAX_CALLS}) and warns when it gets there. The first call of a
  search reports how many listings match, so you see the cost before more calls are made.
  Pages are cached for --cache-days (default 3), and cached pages cost nothing. The script
  also counts calls per calendar month on this computer against the free plan's {FREE_PLAN_MONTHLY}.
"""


def load_presets(path: Path) -> Dict[str, dict]:
    if not path.is_file():
        return {}
    data = json.loads(path.read_text())
    return {p["name"]: p for p in data.get("presets", [])}


FILTER_KEYS = ("types", "price", "beds", "baths", "sqft", "acres", "year_built", "new_days")
AREA_KEYS = ("center", "radius", "zip", "city", "state")


def build_queries(args: argparse.Namespace, presets: Dict[str, dict]) -> List[Query]:
    """Presets named with --preset (or all with --all-presets), or one search from the area flags.
    Filter flags given on the command line override the preset's values."""
    cli = {k: getattr(args, k) for k in AREA_KEYS + FILTER_KEYS if getattr(args, k) not in (None, "")}
    names = list(presets) if args.all_presets else (args.preset or [])
    unknown = [n for n in names if n not in presets]
    if unknown:
        raise ValueError(f"no preset named {', '.join(unknown)}. Presets: {', '.join(presets) or 'none'}")
    if names:
        overrides = {k: v for k, v in cli.items() if k in FILTER_KEYS}
        return [Query.from_options(n, {**presets[n], **overrides}) for n in names]
    if any(k in cli for k in ("center", "zip", "city")):
        return [Query.from_options("command line", cli)]
    return []


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(
        prog="seed.py",
        description=__doc__,
        epilog=EXAMPLES,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    area = ap.add_argument_group("where to search (pick one, or use --preset)")
    area.add_argument("--center", metavar="LAT,LNG", help="center of a circle, e.g. 38.74,-106.0")
    area.add_argument("--radius", type=float, metavar="MILES", help=f"circle radius, up to {MAX_RADIUS_MILES} (default 25)")
    area.add_argument("--zip", metavar="ZIP", help="one 5-digit ZIP code")
    area.add_argument("--city", metavar="NAME", help="city name, exactly as spelled (e.g. 'Buena Vista')")
    area.add_argument("--state", metavar="ST", help="state for --city (default CO)")
    area.add_argument("--preset", action="append", metavar="NAME", help="saved search from searches.json; repeatable")
    area.add_argument("--all-presets", action="store_true", help="run every preset in searches.json")
    area.add_argument("--list-presets", action="store_true", help="show saved presets and exit")

    flt = ap.add_argument_group("what to search for (sent to RentCast, so narrower = fewer calls)")
    flt.add_argument("--types", metavar="LIST", help="land, house, manufactured, condo, townhouse, multi-family (comma-separated)")
    flt.add_argument("--price", metavar="RANGE", help="e.g. :700k, 150k:400k")
    flt.add_argument("--acres", metavar="RANGE", help="lot size in acres, e.g. 5: or 1:10")
    flt.add_argument("--beds", metavar="RANGE", help="e.g. 3: for 3 or more")
    flt.add_argument("--baths", metavar="RANGE", help="e.g. 2:")
    flt.add_argument("--sqft", metavar="RANGE", help="living area, e.g. 1200:")
    flt.add_argument("--year-built", dest="year_built", metavar="RANGE", help="e.g. 1990:")
    flt.add_argument("--new-days", dest="new_days", type=int, metavar="N", help="only listings posted in the last N days (partial bundle)")

    bud = ap.add_argument_group("call budget")
    bud.add_argument("--max-calls", type=int, default=DEFAULT_MAX_CALLS, metavar="N", help=f"hard cap on API calls this run (default {DEFAULT_MAX_CALLS})")
    bud.add_argument("--estimate", action="store_true", help="report matches and calls needed, write no bundle (1 call per search, reused later)")
    bud.add_argument("--cache-days", type=float, default=3, metavar="N", help="reuse cached pages up to N days old (default 3; 0 disables)")
    bud.add_argument("--refresh", action="store_true", help="ignore the cache and fetch fresh pages")
    bud.add_argument("--cache-dir", type=Path, default=HERE / "cache", help="where cached pages and the monthly tally live")

    io = ap.add_argument_group("sources and output")
    io.add_argument("--no-api", action="store_true", help="skip RentCast; only read the CSV inbox")
    io.add_argument("--inbox", type=Path, default=HERE / "inbox", help="folder of Redfin CSVs (default: pipelines/listings/inbox)")
    io.add_argument("--config", type=Path, default=HERE / "searches.json", help="presets file")
    io.add_argument("--out", type=Path, help="bundle file (default: pipelines/listings/out/seed-<date>.json)")
    io.add_argument(
        "--add-only",
        action="store_true",
        help="mark the bundle partial: the app adds and refreshes listings but removes none "
        "(use when this bundle doesn't include everything from your last one)",
    )
    args = ap.parse_args(argv)

    presets = load_presets(args.config)
    if args.list_presets:
        for name, p in presets.items():
            print(f"{name}: {Query.from_options(name, p).describe()}")
        return 0
    try:
        queries = build_queries(args, presets)
    except ValueError as e:
        ap.error(str(e))
    if args.max_calls < 0:
        ap.error("--max-calls can't be negative")

    now = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    collected: List[dict] = []
    sources: List[dict] = []
    partial = False
    capped = False

    load_dotenv(ROOT / ".env")
    key = os.environ.get("RENTCAST_API_KEY")
    use_api = not args.no_api and bool(queries)
    if not args.no_api and not queries:
        print("No RentCast search given (use --center/--zip/--city or --preset; see --help). Reading the CSV inbox only.")
    if use_api and not key:
        print("RENTCAST_API_KEY is not set (environment or .env), so skipping RentCast. Free key: https://app.rentcast.io/app/api")
        use_api = False
    if args.estimate and not use_api:
        ap.error("--estimate needs a RentCast search and RENTCAST_API_KEY")

    if use_api:
        budget = Budget(args.max_calls, args.cache_dir / "usage.json")
        client = Client(key, budget, Cache(args.cache_dir / "rentcast", args.cache_days, args.refresh))
        month_before = budget.month_total()
        if args.max_calls > DEFAULT_MAX_CALLS:
            print(f"Note: --max-calls {args.max_calls} is above the default cap of {DEFAULT_MAX_CALLS}.")
        if month_before >= FREE_PLAN_MONTHLY * 0.8:
            print(f"Note: {month_before} RentCast calls already made this month from this computer (free plan: {FREE_PLAN_MONTHLY}).")

        for i, q in enumerate(queries):
            print(f"RentCast: {q.name}: {q.describe()}")
            if budget.remaining == 0:
                print(f"  WARNING: hard cap reached (--max-calls {budget.cap}); skipped this search.")
                partial = capped = True
                sources.append({"kind": "rentcast", "search": q.name, "query": q.params(), "skipped": True})
                continue
            if args.estimate:
                total, cached = client.count(q)
                calls = max(1, -(-total // 500)) if total is not None else None
                print(f"  {total} listings match; a full run needs {calls} {'call' if calls == 1 else 'calls'}" + (" (count from cache)" if cached else ""))
                continue
            result = client.search(q)
            found = [p for p in (rentcast_property(item, now) for item in result.items) if p]
            note = f", {result.cached_pages} cached {'page' if result.cached_pages == 1 else 'pages'}" if result.cached_pages else ""
            print(f"  {len(found)} listings kept ({result.calls} {'call' if result.calls == 1 else 'calls'}{note})")
            if not result.complete:
                print(
                    f"  WARNING: hit the hard cap of {budget.cap} calls; got {len(result.items)} of {result.total} listings.\n"
                    f"  Narrow the search (--types, --price, --acres, smaller --radius) or raise the cap with --max-calls."
                )
            capped = capped or not result.complete
            partial = partial or q.partial or not result.complete
            collected.extend(found)
            sources.append(
                {"kind": "rentcast", "search": q.name, "query": q.params(), "total": result.total, "count": len(found), "complete": result.complete}
            )

        month_after = budget.month_total()
        print(
            f"RentCast calls: {budget.used} this run (cap {budget.cap}), {month_after} this month on this computer "
            f"(free plan: {FREE_PLAN_MONTHLY})."
        )
        if capped:
            print(f"WARNING: this run stopped at the hard cap of {budget.cap} calls. Use --max-calls N to allow more.")
        if args.estimate:
            return 0

    for path in sorted(args.inbox.glob("*.csv")):
        found = read_csv(path, now)
        age = (datetime.now().timestamp() - path.stat().st_mtime) / 86400
        print(f"CSV: {path.name}: {len(found)} listings" + (f" (file is {age:.0f} days old)" if age > 7 else ""))
        collected.extend(found)
        sources.append({"kind": "csv", "file": path.name, "count": len(found)})

    if not collected:
        print("Nothing collected, so no bundle written.")
        return 1

    partial = partial or args.add_only
    properties = merge(collected)
    for p in properties:
        p["seeded"] = True
        p["addedBy"] = "Seed"
        p["addedAt"] = now

    out = args.out or HERE / "out" / f"seed-{now[:10]}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    bundle = {
        "kind": "home-hunter-seed",
        "v": 1,
        "generatedAt": now,
        # Partial bundles only add and refresh; the app won't remove listings missing from them.
        "partial": partial,
        "sources": sources,
        "properties": properties,
    }
    out.write_text(json.dumps(bundle, separators=(",", ":")) + "\n")
    print(f"Wrote {len(properties)} listings to {out} ({out.stat().st_size // 1024} KB){' as a partial bundle' if partial else ''}.")
    print("Drag that file onto the Home Hunter page (or use Import) to add them to your map.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
