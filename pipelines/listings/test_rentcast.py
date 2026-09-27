import io
import json
import os
import sys
import tempfile
import unittest
import urllib.parse
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))
import rentcast  # noqa: E402
import seed  # noqa: E402
from rentcast import Budget, Cache, Client, Query, parse_range, parse_types  # noqa: E402


def listing(i: int) -> dict:
    return {
        "id": f"id-{i}",
        "formattedAddress": f"{i} Test Rd, Salida, CO 81201",
        "latitude": 38.5 + i * 1e-4,
        "longitude": -106.0,
        "propertyType": "Land",
        "status": "Active",
        "price": 100000 + i,
        "lotSize": 217800,
    }


class FakeRentCast:
    """Serves `total` listings in pages, like the real API, and records every call."""

    def __init__(self, total: int):
        self.total = total
        self.calls = []

    def __call__(self, url, headers):
        q = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(url).query))
        self.calls.append(q)
        offset, limit = int(q["offset"]), int(q["limit"])
        body = [listing(i) for i in range(offset, min(self.total, offset + limit))]
        hdrs = {"x-total-count": str(self.total)} if q.get("includeTotalCount") == "true" else {}
        return body, hdrs


class Ranges(unittest.TestCase):
    def test_ranges(self):
        self.assertEqual(parse_range(":700k"), "*:700000")
        self.assertEqual(parse_range("150k:400k"), "150000:400000")
        self.assertEqual(parse_range("3:"), "3:*")
        self.assertEqual(parse_range("*:2"), "*:2")
        self.assertEqual(parse_range("1.5:"), "1.5:*")
        self.assertEqual(parse_range("1.2m:"), "1200000:*")
        self.assertEqual(parse_range("3"), "3")

    def test_acres_become_square_feet(self):
        self.assertEqual(parse_range("5:", 43560), "217800:*")
        self.assertEqual(parse_range("0.5:2", 43560), "21780:87120")

    def test_bad_ranges(self):
        for bad in (":", "400k:100k", "lots"):
            with self.assertRaises(ValueError):
                parse_range(bad)

    def test_types(self):
        self.assertEqual(parse_types("land, house,mobile"), ["Land", "Single Family", "Manufactured"])
        with self.assertRaises(ValueError):
            parse_types("castle")


class Queries(unittest.TestCase):
    def test_params_are_sent_to_rentcast(self):
        q = Query.from_options("t", {"center": "38.74,-106", "radius": 60, "types": "land,house", "price": ":700k", "acres": "5:"})
        self.assertEqual(
            q.params(),
            {
                "latitude": "38.74000",
                "longitude": "-106.00000",
                "radius": "60",
                "propertyType": "Land|Single Family",
                "price": "*:700000",
                "lotSize": "217800:*",
                "status": "Active",
            },
        )
        self.assertFalse(q.partial)

    def test_new_days_is_partial(self):
        q = Query.from_options("t", {"zip": "81211", "new_days": 7})
        self.assertEqual(q.params()["daysOld"], "*:7")
        self.assertTrue(q.partial)

    def test_area_validation(self):
        with self.assertRaises(ValueError):
            Query.from_options("t", {"center": "38.74,-106", "radius": 150})
        with self.assertRaises(ValueError):
            Query.from_options("t", {"types": "land"})
        with self.assertRaises(ValueError):
            Query.from_options("t", {"zip": "812"})


class ClientBudget(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.q = Query.from_options("t", {"zip": "81211", "types": "land"})

    def client(self, api, cap=7, cache_days=3):
        budget = Budget(cap, self.dir / "usage.json")
        return Client("key", budget, Cache(self.dir / "cache", cache_days), transport=api, log=lambda *_: None), budget

    def test_one_call_when_matches_fit_in_a_page(self):
        api = FakeRentCast(120)
        client, budget = self.client(api)
        r = client.search(self.q)
        self.assertEqual((len(r.items), r.calls, r.complete), (120, 1, True))
        self.assertEqual(api.calls[0]["propertyType"], "Land")
        self.assertEqual(api.calls[0]["limit"], "500")

    def test_no_empty_extra_call_on_exact_multiple(self):
        api = FakeRentCast(1000)
        client, _ = self.client(api)
        r = client.search(self.q)
        self.assertEqual((len(r.items), r.calls), (1000, 2))

    def test_stops_at_cap_and_reports_incomplete(self):
        api = FakeRentCast(2600)  # needs 6 calls
        client, budget = self.client(api, cap=3)
        r = client.search(self.q)
        self.assertEqual((len(r.items), r.calls, r.total, r.complete), (1500, 3, 2600, False))
        self.assertEqual(len(api.calls), 3)
        self.assertEqual(budget.remaining, 0)

    def test_cache_makes_reruns_free(self):
        api = FakeRentCast(700)
        client, _ = self.client(api)
        client.search(self.q)
        client2, budget2 = self.client(api)
        r = client2.search(self.q)
        self.assertEqual((r.calls, r.cached_pages, len(api.calls), budget2.used), (0, 2, 2, 0))

    def test_estimate_is_reused_by_the_search(self):
        api = FakeRentCast(300)
        client, _ = self.client(api)
        self.assertEqual(client.count(self.q), (300, False))
        r = client.search(self.q)
        self.assertEqual((r.calls, len(api.calls)), (0, 1))

    def test_cache_disabled(self):
        api = FakeRentCast(10)
        self.client(api, cache_days=0)[0].search(self.q)
        self.client(api, cache_days=0)[0].search(self.q)
        self.assertEqual(len(api.calls), 2)

    def test_monthly_tally_accumulates_across_runs(self):
        api = FakeRentCast(10)
        self.client(api, cache_days=0)[0].search(self.q)
        _, budget = self.client(api, cache_days=0)
        budget.take()
        self.assertEqual(budget.month_total(), 2)


class Cli(unittest.TestCase):
    """seed.main() end to end against the fake API."""

    def run_cli(self, api, *args):
        tmp = Path(tempfile.mkdtemp())
        out = tmp / "seed.json"
        inbox = tmp / "inbox"
        inbox.mkdir()
        buf = io.StringIO()
        with mock.patch.object(rentcast, "http_transport", api), mock.patch.dict(os.environ, {"RENTCAST_API_KEY": "k"}), redirect_stdout(buf):
            code = seed.main(["--cache-dir", str(tmp / "cache"), "--inbox", str(inbox), "--out", str(out), *args])
        bundle = json.loads(out.read_text()) if out.exists() else None
        return code, buf.getvalue(), bundle

    def test_default_cap_is_7_with_warning(self):
        api = FakeRentCast(5000)  # needs 10 calls
        code, text, bundle = self.run_cli(api, "--zip", "81211")
        self.assertEqual(code, 0)
        self.assertEqual(len(api.calls), 7)
        self.assertIn("WARNING: hit the hard cap of 7 calls; got 3500 of 5000 listings", text)
        self.assertIn("WARNING: this run stopped at the hard cap of 7 calls", text)
        self.assertTrue(bundle["partial"])
        self.assertEqual(len(bundle["properties"]), 3500)

    def test_cap_override(self):
        api = FakeRentCast(5000)
        code, text, bundle = self.run_cli(api, "--zip", "81211", "--max-calls", "10")
        self.assertEqual(len(api.calls), 10)
        self.assertFalse(bundle["partial"])
        self.assertNotIn("WARNING", text)

    def test_cap_skips_later_searches(self):
        api = FakeRentCast(900)  # 2 calls each
        tmp = Path(tempfile.mkdtemp())
        presets = tmp / "p.json"
        presets.write_text(json.dumps({"presets": [{"name": "a", "zip": "81211"}, {"name": "b", "zip": "81201"}]}))
        code, text, bundle = self.run_cli(api, "--config", str(presets), "--all-presets", "--max-calls", "2")
        self.assertIn("hard cap reached (--max-calls 2); skipped this search", text)
        self.assertTrue(bundle["partial"])

    def test_estimate_writes_nothing(self):
        api = FakeRentCast(1234)
        code, text, bundle = self.run_cli(api, "--zip", "81211", "--estimate")
        self.assertIn("1234 listings match; a full run needs 3 calls", text)
        self.assertIsNone(bundle)
        self.assertEqual(len(api.calls), 1)

    def test_flags_override_preset_filters(self):
        api = FakeRentCast(5)
        tmp = Path(tempfile.mkdtemp())
        presets = tmp / "p.json"
        presets.write_text(json.dumps({"presets": [{"name": "a", "zip": "81211", "types": "land", "price": ":700k"}]}))
        self.run_cli(api, "--config", str(presets), "--preset", "a", "--price", ":400k")
        self.assertEqual(api.calls[0]["price"], "*:400000")
        self.assertEqual(api.calls[0]["propertyType"], "Land")

    def test_new_days_and_add_only_make_partial_bundles(self):
        self.assertTrue(self.run_cli(FakeRentCast(3), "--zip", "81211", "--new-days", "7")[2]["partial"])
        self.assertTrue(self.run_cli(FakeRentCast(3), "--zip", "81211", "--add-only")[2]["partial"])
        self.assertFalse(self.run_cli(FakeRentCast(3), "--zip", "81211")[2]["partial"])


if __name__ == "__main__":
    unittest.main()
