# Tourism heat data

Feeds the map's two tourism overlays:

- **Search interest**: how much Google search interest Colorado destinations draw, spread over each
  destination's footprint.
- **Where visitors stay**: the same interest moved to the towns where those visitors sleep.

Clicking the map with an overlay on lists the destinations (or lodging towns) behind that spot. Clicking a
destination's dot draws lines to its lodging towns, sized by share. Those lines show how far its pull reaches.

## Files

| File | What | Who edits it |
|---|---|---|
| `attractions.json` | ~90 destinations: location, category, Google Trends topic or search term, and the lodging split | People |
| `trends.py` | Asks Google Trends for each destination's interest and writes the app data | — |
| `cache/` | Raw Trends responses, kept 30 days (git-ignored) | — |
| `public/data/states/CO/tourism.json` | What the app loads when an overlay is first turned on | Generated |

```sh
python3 pipelines/tourism/trends.py            # ~95 requests at 4 s each; cached for 30 days
python3 pipelines/tourism/trends.py --offline  # rebuild from the cache only
```

Google rate-limits bursts. The script waits and retries, and every finished comparison is cached, so a run
that stops partway picks up where it left off.

## How interest is measured

Google Trends compares at most five terms at a time, each on its own 0-100 scale. `trends.py` puts all the
destinations on one scale in two passes:

1. Each destination is compared against Garden of the Gods to get a rough size.
2. Destinations are sorted by size and compared four at a time with similar-sized ones. Each group is anchored
   to the smallest destination in the group before it, so a backcountry hot spring isn't rounded to zero next
   to Red Rocks.

Scores are the mean weekly interest from US searchers over the last 12 months, rescaled so the top destination
is 100. The app colors on a log scale covering three orders of magnitude.

Destinations use a Trends **topic** where Google has a clean one, because a topic merges spellings and old
names (searches for Mount Evans count toward Mount Blue Sky). A few use a plain search term because their
topics are tours or ambiguous; `attractions.json` records which (`topic` is null).

## Choices and limits

- **Destinations, not towns.** Town topics count every search about the town, including residents, news and
  weather, which made Telluride outrank Rocky Mountain National Park. Towns are only lodging bases here.
  Denver attractions (zoo, museums, stadiums) are left out for the same reason. Red Rocks is kept, because it's
  a statewide draw.
- **Resort topics aren't equal.** Where a resort shares its town's name, most searches land on the town topic,
  not the resort's. So Breckenridge Ski Resort (9.5) scores below Copper Mountain (14), whose name *is* the
  resort. Copper's weekly curve is a normal ski season, not a spike, so the number is real. It's just narrower
  for Breckenridge, Vail, Aspen and Telluride.
- **Concert and event searches count.** Red Rocks ranks first partly because people search for shows.
- **Interest isn't visits.** Search interest tracks attention, and it skews toward famous names.
- **The lodging split is an editorial estimate**, based on which gateway towns serve each destination and
  their lodging. It isn't measured data. Edit `stays` in `attractions.json` when you know better. Shares must
  add to 1 (a test checks).
- **Footprints are by category** (`REACH_MILES` in `src/tourism/heat.ts`): national parks 8 mi, scenic drives
  6, ski areas and lakes 3, hikes 2.5, landmarks and hot springs 2. Lodging spreads 6 mi around each town.
