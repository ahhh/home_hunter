"""RentCast sale-listing search, built to spend as few API calls as possible.

- Filters (type, price, beds, lot size, …) are sent to RentCast, so every listing paid for is
  one you asked for.
- One call returns up to 500 listings; the first call also asks for the total so no call is
  wasted on an empty page and a search that would blow the budget is caught early.
- Every page is cached on disk, so re-running the same search costs nothing for a few days.
- A per-run cap (default 7) and a local monthly tally guard the free plan's 50 calls/month.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Dict, List, Optional, Tuple

API_URL = "https://api.rentcast.io/v1/listings/sale"
PAGE_SIZE = 500
MAX_RADIUS_MILES = 100
DEFAULT_MAX_CALLS = 7
FREE_PLAN_MONTHLY = 50
SQFT_PER_ACRE = 43560

TYPE_ALIASES = {
    "land": "Land",
    "lot": "Land",
    "house": "Single Family",
    "single-family": "Single Family",
    "sfh": "Single Family",
    "manufactured": "Manufactured",
    "mobile": "Manufactured",
    "condo": "Condo",
    "townhouse": "Townhouse",
    "townhome": "Townhouse",
    "multi-family": "Multi-Family",
    "apartment": "Apartment",
}


# ---------------------------------------------------------------- query building


def parse_amount(s: str) -> float:
    """'250k' -> 250000, '1.2m' -> 1200000, '5' -> 5."""
    t = s.strip().lower().replace(",", "").replace("$", "")
    m = re.fullmatch(r"(\d+(?:\.\d+)?)([km]?)", t)
    if not m:
        raise ValueError(f"not a number: {s!r}")
    return float(m.group(1)) * {"": 1, "k": 1e3, "m": 1e6}[m.group(2)]


def parse_range(s: str, scale: float = 1) -> str:
    """User range -> RentCast range. 'MIN:MAX', ':MAX' or 'MAX:' ends may be blank or '*'.
    A single value means exactly that value (RentCast's rule)."""
    s = s.strip()
    if ":" not in s:
        return _fmt(parse_amount(s) * scale)
    lo, hi = (part.strip() for part in s.split(":", 1))
    lo_v = "*" if lo in ("", "*") else _fmt(parse_amount(lo) * scale)
    hi_v = "*" if hi in ("", "*") else _fmt(parse_amount(hi) * scale)
    if lo_v == hi_v == "*":
        raise ValueError(f"range {s!r} has no minimum or maximum")
    if "*" not in (lo_v, hi_v) and float(lo_v) > float(hi_v):
        raise ValueError(f"range {s!r} has minimum above maximum")
    return f"{lo_v}:{hi_v}"


def _fmt(n: float) -> str:
    return str(int(round(n))) if abs(n - round(n)) < 1e-9 or n >= 100 else f"{n:g}"


def parse_types(s: str) -> List[str]:
    out = []
    for raw in re.split(r"[,|]", s):
        t = raw.strip().lower()
        if not t:
            continue
        if t not in TYPE_ALIASES:
            raise ValueError(f"unknown property type {raw.strip()!r}; use one of: {', '.join(sorted(TYPE_ALIASES))}")
        if TYPE_ALIASES[t] not in out:
            out.append(TYPE_ALIASES[t])
    return out


@dataclass
class Query:
    """One RentCast search. Build with Query.from_options()."""

    name: str
    area: Dict[str, str]
    filters: Dict[str, str] = field(default_factory=dict)

    @staticmethod
    def from_options(name: str, opts: Dict[str, object]) -> "Query":
        """opts uses the CLI's names: center 'LAT,LNG', radius, zip, city, state, types, price,
        beds, baths, sqft, acres, year_built, new_days."""
        area: Dict[str, str] = {}
        if opts.get("center"):
            try:
                lat, lng = (float(x) for x in str(opts["center"]).split(","))
            except ValueError:
                raise ValueError(f"--center must look like 38.74,-106.0 (got {opts['center']!r})")
            radius = float(opts.get("radius") or 25)
            if not 0 < radius <= MAX_RADIUS_MILES:
                raise ValueError(f"--radius must be between 0 and {MAX_RADIUS_MILES} miles (RentCast's limit)")
            area = {"latitude": f"{lat:.5f}", "longitude": f"{lng:.5f}", "radius": _fmt(radius)}
        elif opts.get("zip"):
            if not re.fullmatch(r"\d{5}", str(opts["zip"])):
                raise ValueError("--zip must be 5 digits")
            area = {"zipCode": str(opts["zip"])}
        elif opts.get("city"):
            area = {"city": str(opts["city"]), "state": str(opts.get("state") or "CO").upper()}
        else:
            raise ValueError("a search needs an area: --center LAT,LNG with --radius, --zip, or --city")

        f: Dict[str, str] = {}
        if opts.get("types"):
            f["propertyType"] = "|".join(parse_types(str(opts["types"])))
        for opt, param, scale in [
            ("price", "price", 1),
            ("beds", "bedrooms", 1),
            ("baths", "bathrooms", 1),
            ("sqft", "squareFootage", 1),
            ("acres", "lotSize", SQFT_PER_ACRE),
            ("year_built", "yearBuilt", 1),
        ]:
            if opts.get(opt):
                f[param] = parse_range(str(opts[opt]), scale)
        if opts.get("new_days"):
            f["daysOld"] = f"*:{int(opts['new_days'])}"
        return Query(name=name, area=area, filters=f)

    @property
    def partial(self) -> bool:
        """A new-listings-only search can't tell the app which listings went off the market."""
        return "daysOld" in self.filters

    def params(self) -> Dict[str, str]:
        return {**self.area, **self.filters, "status": "Active"}

    def describe(self) -> str:
        a = self.area
        where = (
            f"{a['radius']} mi around {a['latitude']},{a['longitude']}"
            if "radius" in a
            else f"ZIP {a['zipCode']}" if "zipCode" in a else f"{a['city']}, {a['state']}"
        )
        parts = [f"{k}={v}" for k, v in self.filters.items()]
        return where + (f" [{', '.join(parts)}]" if parts else " [no filters]")


# ---------------------------------------------------------------- budget, usage and cache


class CapReached(Exception):
    pass


class Budget:
    """Per-run hard cap plus a local tally of calls per calendar month."""

    def __init__(self, cap: int, usage_file: Path, today: Optional[datetime] = None):
        self.cap = cap
        self.used = 0
        self.usage_file = usage_file
        self.month = (today or datetime.now()).strftime("%Y-%m")

    @property
    def remaining(self) -> int:
        return max(0, self.cap - self.used)

    def month_total(self) -> int:
        return self._read().get(self.month, 0)

    def take(self) -> None:
        if self.used >= self.cap:
            raise CapReached()
        self.used += 1
        usage = self._read()
        usage[self.month] = usage.get(self.month, 0) + 1
        self.usage_file.parent.mkdir(parents=True, exist_ok=True)
        self.usage_file.write_text(json.dumps(usage, indent=2) + "\n")

    def _read(self) -> Dict[str, int]:
        try:
            return json.loads(self.usage_file.read_text())
        except (OSError, ValueError):
            return {}


class Cache:
    def __init__(self, folder: Path, max_age_days: float, refresh: bool = False):
        self.folder = folder
        self.max_age_days = max_age_days
        self.refresh = refresh

    def _path(self, params: Dict[str, str]) -> Path:
        key = hashlib.sha1(json.dumps(params, sort_keys=True).encode()).hexdigest()[:16]
        return self.folder / f"{key}.json"

    def get(self, params: Dict[str, str]) -> Optional[dict]:
        if self.refresh or self.max_age_days <= 0:
            return None
        try:
            entry = json.loads(self._path(params).read_text())
        except (OSError, ValueError):
            return None
        age = (datetime.now(timezone.utc) - datetime.fromisoformat(entry["fetchedAt"])).total_seconds() / 86400
        return entry if age <= self.max_age_days else None

    def put(self, params: Dict[str, str], items: list, total: Optional[int]) -> dict:
        entry = {"fetchedAt": datetime.now(timezone.utc).isoformat(), "params": params, "total": total, "items": items}
        self.folder.mkdir(parents=True, exist_ok=True)
        self._path(params).write_text(json.dumps(entry))
        return entry


# ---------------------------------------------------------------- fetching

# (url, headers) -> (json body, response headers). Swappable for tests.
Transport = Callable[[str, Dict[str, str]], Tuple[object, Dict[str, str]]]


def http_transport(url: str, headers: Dict[str, str]) -> Tuple[object, Dict[str, str]]:
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            return json.load(res), {k.lower(): v for k, v in res.headers.items()}
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")[:300]
        hint = " Check RENTCAST_API_KEY." if e.code in (401, 403) else " Monthly limit reached?" if e.code == 429 else ""
        raise SystemExit(f"RentCast refused the request ({e.code}): {body}{hint}")


@dataclass
class SearchResult:
    items: List[dict]
    total: Optional[int]
    calls: int
    cached_pages: int
    complete: bool


class Client:
    def __init__(self, key: str, budget: Budget, cache: Cache, transport: Optional[Transport] = None, log=print):
        self.key = key
        self.budget = budget
        self.cache = cache
        self.transport = transport or (lambda url, headers: http_transport(url, headers))
        self.log = log

    def _page(self, params: Dict[str, str]) -> Tuple[list, Optional[int], bool]:
        """Returns (items, total, came_from_cache). Raises CapReached before spending a call over the cap."""
        hit = self.cache.get(params)
        if hit is not None:
            return hit["items"], hit.get("total"), True
        self.budget.take()
        body, headers = self.transport(
            f"{API_URL}?{urllib.parse.urlencode(params)}",
            {"X-Api-Key": self.key, "Accept": "application/json", "User-Agent": "home-hunter-seed/2"},
        )
        items = body if isinstance(body, list) else []
        total = int(headers["x-total-count"]) if "x-total-count" in headers else None
        self.cache.put(params, items, total)
        return items, total, False

    @staticmethod
    def _page_params(q: Query, offset: int) -> Dict[str, str]:
        params = {**q.params(), "limit": str(PAGE_SIZE), "offset": str(offset)}
        if offset == 0:
            params["includeTotalCount"] = "true"
        return params

    def count(self, q: Query) -> Tuple[Optional[int], bool]:
        """How many listings match. Makes the same first call a search would, so a search run
        afterwards reuses it from the cache: estimating is free. Returns (total, came_from_cache)."""
        _, total, cached = self._page(self._page_params(q, 0))
        return total, cached

    def search(self, q: Query) -> SearchResult:
        items: List[dict] = []
        calls = cached_pages = 0
        total: Optional[int] = None
        offset = 0
        while True:
            try:
                page, page_total, cached = self._page(self._page_params(q, offset))
            except CapReached:
                return SearchResult(items, total, calls, cached_pages, complete=False)
            calls += 0 if cached else 1
            cached_pages += 1 if cached else 0
            if offset == 0:
                total = page_total
                if total is not None:
                    pages = max(1, math.ceil(total / PAGE_SIZE))
                    self.log(f"  {total} listings match: {pages} {'call' if pages == 1 else 'calls'} for the full set")
                    if pages - 1 > self.budget.remaining:
                        self.log(
                            f"  WARNING: only {self.budget.remaining} more {'call' if self.budget.remaining == 1 else 'calls'} "
                            f"allowed this run (--max-calls {self.budget.cap}), so this search will be cut short."
                        )
            items.extend(page)
            offset += PAGE_SIZE
            done = len(page) < PAGE_SIZE or (total is not None and offset >= total)
            if done:
                return SearchResult(items, total, calls, cached_pages, complete=True)
