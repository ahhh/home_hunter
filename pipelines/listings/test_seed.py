import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import seed  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
NOW = "2026-09-27T12:00:00.000Z"

REDFIN_CSV = """SALE TYPE,SOLD DATE,PROPERTY TYPE,ADDRESS,CITY,STATE OR PROVINCE,ZIP OR POSTAL CODE,PRICE,BEDS,BATHS,LOCATION,SQUARE FEET,LOT SIZE,YEAR BUILT,DAYS ON MARKET,$/SQUARE FEET,HOA/MONTH,STATUS,NEXT OPEN HOUSE START TIME,NEXT OPEN HOUSE END TIME,URL (SEE https://www.redfin.com/buy-a-home/comparative-market-analysis FOR INFO ON PRICING),SOURCE,MLS#,FAVORITE,INTERESTED,LATITUDE,LONGITUDE
In accordance with local MLS rules, some MLS listings are not included in the download,,,,,,,,,,,,,,,,,,,,,,,,,,
MLS Listing,,Vacant Land,TBD County Road 371,Buena Vista,CO,81211,"189,000",,,Buena Vista,,217800,,12,,,Active,,,https://www.redfin.com/CO/Buena-Vista/TBD-County-Road-371-81211/home/111,REcolorado,1234567,N,Y,38.85,-106.14
MLS Listing,,Single Family Residential,12 Pine Ln,Salida,CO,81201,525000,3,2,Salida,1600,21780,1998,40,328,,Active,,,https://www.redfin.com/CO/Salida/12-Pine-Ln-81201/home/222,REcolorado,7654321,N,Y,38.53,-106.0
"""

RENTCAST_ITEM = {
    "id": "12-Pine-Ln,-Salida,-CO-81201",
    "formattedAddress": "12 Pine Ln, Salida, CO 81201",
    "city": "Salida",
    "state": "CO",
    "latitude": 38.5301,
    "longitude": -106.0001,
    "propertyType": "Single Family",
    "bedrooms": 3,
    "bathrooms": 2,
    "squareFootage": 1600,
    "lotSize": 21780,
    "status": "Active",
    "price": 519000,
    "listedDate": "2026-08-18T00:00:00.000Z",
    "mlsName": "REcolorado",
    "mlsNumber": "7654321",
}


class SharedRules(unittest.TestCase):
    def test_ids_match_the_web_app(self):
        fixture = json.loads((ROOT / "tests/fixtures/stable-ids.json").read_text(encoding="utf-8"))
        for text, expected in fixture.items():
            self.assertEqual(seed.stable_id(text), expected, text)

    def test_classify_matches_app_rules(self):
        self.assertEqual(seed.classify("Vacant Land"), "vacant_land")
        self.assertEqual(seed.classify("Land"), "vacant_land")
        self.assertEqual(seed.classify("Residential Land"), "vacant_land")
        self.assertEqual(seed.classify("Single Family"), "improved")
        self.assertEqual(seed.classify("Manufactured"), "improved")
        self.assertEqual(seed.classify("Ranch"), "unknown")
        self.assertEqual(seed.classify(None, square_feet=900), "improved")

    def test_canonical_url(self):
        self.assertEqual(
            seed.canonical_url("https://www.redfin.com/CO/Salida/12-Pine-Ln-81201/home/222/?x=1"),
            "https://redfin.com/CO/Salida/12-Pine-Ln-81201/home/222",
        )


class RedfinCsv(unittest.TestCase):
    def test_reads_download_all_export(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "redfin.csv"
            path.write_text(REDFIN_CSV)
            land, house = seed.read_csv(path, NOW)
        self.assertEqual(land["category"], "vacant_land")
        self.assertEqual(land["acreage"], 5)
        self.assertEqual(land["listings"][0]["price"], 189000)
        self.assertEqual(land["listings"][0]["provider"], "redfin")
        self.assertEqual(land["listings"][0]["listedAt"], "2026-09-15")
        self.assertEqual(house["category"], "improved")
        self.assertEqual(house["id"], seed.stable_id("https://redfin.com/CO/Salida/12-Pine-Ln-81201/home/222"))


class RentCast(unittest.TestCase):
    def test_maps_listing_with_zillow_link(self):
        p = seed.rentcast_property(RENTCAST_ITEM, NOW)
        listing = p["listings"][0]
        self.assertEqual(listing["canonicalUrl"], "https://zillow.com/homes/12-Pine-Ln-Salida-CO-81201_rb")
        self.assertEqual(listing["provider"], "rentcast")
        self.assertEqual(listing["attribution"], "RentCast / REcolorado")
        self.assertEqual(listing["listedAt"], "2026-08-18")
        self.assertEqual(p["acreage"], 0.5)
        self.assertEqual(p["category"], "improved")

    def test_undisclosed_land_links_to_mls_search(self):
        item = dict(RENTCAST_ITEM, formattedAddress=None, propertyType="Land", bedrooms=None, squareFootage=None)
        p = seed.rentcast_property(item, NOW)
        self.assertIn("google.com/search?q=MLS+7654321", p["listings"][0]["canonicalUrl"])
        self.assertEqual(p["category"], "vacant_land")
        self.assertNotIn("address", p)

    def test_skips_items_without_coordinates(self):
        self.assertIsNone(seed.rentcast_property(dict(RENTCAST_ITEM, latitude=None), NOW))


class Merge(unittest.TestCase):
    def test_same_address_from_two_sources_becomes_one_property(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "redfin.csv"
            path.write_text(REDFIN_CSV)
            csv_props = seed.read_csv(path, NOW)
        merged = seed.merge(csv_props + [seed.rentcast_property(RENTCAST_ITEM, NOW)])
        self.assertEqual(len(merged), 2)
        house = next(p for p in merged if p["category"] == "improved")
        self.assertEqual(sorted(l["provider"] for l in house["listings"]), ["redfin", "rentcast"])

    def test_far_apart_same_address_stays_separate(self):
        far = dict(seed.rentcast_property(RENTCAST_ITEM, NOW), location={"lat": 40.0, "lng": -105.0})
        other = seed.rentcast_property(dict(RENTCAST_ITEM, formattedAddress="12 Pine Lane, Salida, CO 81201"), NOW)
        self.assertEqual(len(seed.merge([far, other])), 2)


if __name__ == "__main__":
    unittest.main()
