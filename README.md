# Home Hunter

A map for hunting Colorado houses and land with friends. It's a static single-page app
(no server) that runs on GitHub Pages. It's based on [plan.md](plan.md), cut down to what
works without a backend.

## How it works

Listing sites (Zillow, Redfin, Realtor.com, LandWatch…) stay the source of truth. Home
Hunter holds just enough to put each listing on the map (price, location, a few facts)
plus a link back to the original page.

- **Browse listing sites**: opens Zillow (whole circle), Redfin and Realtor.com (ZIP of the
  search center) and LandWatch (county), already filtered by your price and property type.
- **Add listing**: paste a listing link. The address is read from Zillow, Redfin and
  Realtor.com URLs and looked up on OpenStreetMap. If it can't be found, click the map.
- **Import**: on Redfin, search, then choose *Download All* under the results list. Import
  that CSV to drop the whole search on the map. Importing again refreshes prices and keeps
  your notes and verdicts.
- **Search area**: a center (search, pick on map, or drag the pin) plus a radius. Click a
  county to search *only* that county or *leave it out*.
- **Drop onto the page**: a listing link (dragged from another tab or the address bar)
  opens Add listing with the link filled in. A data bundle, export file or Redfin CSV
  imports straight away.
- **Export**: saves your mapped listings, with pins, notes and verdicts, to a file. You can
  export only Loved, Loved and Maybe, the listings shown now, or everything, with or without
  your search area. Drop the file on another device or a friend's map.
- **Share**: listings are saved in your browser. *Share* makes a link with your search and
  listings that a friend opens to add them to their map.

Prices carry the date they were copied. After 14 days they're flagged as possibly out of
date.

## Pre-load listings before a trip

The app never fetches listings by itself. An offline script builds a **data bundle** that
you drop onto the page. `pipelines/listings/seed.py` needs Python 3.9+ and nothing else.

Sources:
- **RentCast API**: active MLS listings, each linked to its Zillow page. Put a
  [free key](https://app.rentcast.io/app/api) in `.env` as `RENTCAST_API_KEY=...`
  (git ignores `.env`).
- **Redfin CSVs**: save *Download All* files into `pipelines/listings/inbox/`.

```sh
cd pipelines/listings
python3 seed.py --help                                    # every option, with examples

# Check how big a search is (1 call; the real run reuses it from the cache)
python3 seed.py --center 38.74,-106.0 --radius 60 --types land,house --price :700k --estimate
# Build the bundle
python3 seed.py --center 38.74,-106.0 --radius 60 --types land,house --price :700k
# Narrower searches cost fewer calls
python3 seed.py --zip 81211 --types land --acres 5: --price :250k
# Saved searches in searches.json
python3 seed.py --list-presets
python3 seed.py --preset arkansas-valley
# Weekly top-up: only listings posted in the last 7 days
python3 seed.py --preset arkansas-valley --new-days 7
```

Then drag `pipelines/listings/out/seed-<date>.json` onto the page (or use Import) and send
the same file to friends.

**Staying under RentCast's free 50 calls a month:**
- One call returns up to 500 listings from a circle of up to 100 miles, so the cost is the
  number of matching listings divided by 500.
- Filters (`--types`, `--price`, `--acres`, `--beds`, …) are applied by RentCast before
  anything is sent back, so every listing you pay for is one you asked for.
- Each run stops at **7 calls** and warns when it hits that cap. Change it with
  `--max-calls N`.
- The first call reports the total matches, so the cost is known before more calls are
  made.
- Pages are cached for 3 days (`--cache-days`, `--refresh`), and cached pages are free.
- The script counts calls per month on your computer and prints the tally after every run.

**Full vs. partial bundles:**
- A full bundle replaces the last one: seeded listings missing from it drop off as no longer
  for sale, unless someone gave them a verdict or notes.
- `--new-days`, `--add-only`, or a search cut short by the cap make a partial bundle, which
  only adds listings and updates prices.
- Listings you removed stay removed, and your notes and verdicts are never changed.

Bundles, inbox CSVs, the RentCast cache and app exports are git-ignored. To keep a bundle
in the repo, move it to `pipelines/listings/saved/`.

## Develop

```sh
npm install
npm run dev        # http://localhost:5173
npm test           # geo, parsing, import/export, merge/filter logic
python3 -m unittest discover -s pipelines/listings   # seed script, RentCast budget/cache
npm run build      # static site in dist/
```

## Deploy to GitHub Pages

1. Push this repo to GitHub on the `main` branch.
2. In the repo, go to **Settings → Pages → Build and deployment** and set **Source** to
   **GitHub Actions**.
3. Every push to `main` runs the tests, builds, and publishes to
   `https://<user>.github.io/<repo>/`.

## Data

`public/data/states/CO/` holds everything Colorado-specific:

| File | What | Source |
| --- | --- | --- |
| `counties.geojson` | 64 county boundaries | US Census cartographic boundary file, 2023, 1:5M (`npm run build:geo`) |
| `areas.json` | County registry keyed by FIPS, with centroid, bounds, source and checksum | Generated by `npm run build:geo` |
| `profiles.json` | County seat and region | Hand-entered |
| `regulations.json` | Zoning, camping, RV, rental summaries with sources | **Empty so far.** See below |

### County rules

No county has a reviewed rules summary yet, and the app says so, linking to searches for
the planning department instead. To add one, append a record to `regulations.json`
following `RegulationSummary` / `RegulatorySource` in `src/domain/types.ts`. Every topic
cites source IDs, and the UI shows the review date, confidence and a parcel-verification
disclaimer. Per the plan, start with 3–5 pilot counties and only publish summaries a
person has checked against the county's own code.

## Differences from plan.md

GitHub Pages can't run the plan's backend API. So:

- listings are copied in by people (link paste or Redfin CSV), not fetched by provider
  adapters, which also keeps clear of the listing sites' scraping rules;
- geography, filtering and dedupe run in the browser against the static GeoJSON;
- Leaflet with OpenStreetMap, OpenTopoMap and Esri imagery replaces Google Maps (no API
  key or billing);
- place search uses OpenStreetMap Nominatim on submit only (its usage policy forbids
  search-as-you-type).

The domain types, include/exclude semantics, strict land/improved classification, source
and freshness metadata, and the regulations schema follow the plan, so a backend can be
added later without changing them.
