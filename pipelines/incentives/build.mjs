// Builds per-county incentive-zone facts from programs.json and the official GIS layers.
//
//   programs.json (hand-entered, cited) ───────┐
//   OEDIT enterprise zones, 2026-2036 ─────────┤
//   HUD 2018 opportunity zone tracts ──────────┼─> zones.json, one record per county
//   Census 2020 tracts (OZ 2.0 nominations) ───┤     └─> pipelines/hosting/build.py renders the wiki
//   Census 2020 places (town names) ───────────┘
//
// Geometry downloads are cached in raw/ (git-ignored). Overlaps are measured with mapshaper.
//
// Usage: node pipelines/incentives/build.mjs [--refresh]
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const rawDir = join(here, "raw");
const stateDir = join(root, "public", "data", "states", "CO");
const mapshaper = join(root, "node_modules", ".bin", "mapshaper");
const refresh = process.argv.includes("--refresh");
mkdirSync(rawDir, { recursive: true });

const programs = JSON.parse(readFileSync(join(here, "programs.json"), "utf8"));
const areas = JSON.parse(readFileSync(join(stateDir, "areas.json"), "utf8")).areas;
const countyName = new Map(areas.map((a) => [a.id, a.name.replace(/ County$/, "")]));
const fipsOf = new Map([...countyName].map(([f, n]) => [n, f]));

const EZ_LAYER = "https://services3.arcgis.com/DgjqnJA1rgO92Soi/arcgis/rest/services/Enterprise_Zones/FeatureServer/2";
const OZ1_LAYER = "https://services.arcgis.com/VTyQ9soqVukalItT/arcgis/rest/services/Opportunity_Zones/FeatureServer/13";
const TIGER = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb";
const TRACTS_2020 = `${TIGER}/Tracts_Blocks/MapServer/10`;
const PLACES_2020 = [`${TIGER}/Places_CouSub_ConCity_SubMCD/MapServer/25`, `${TIGER}/Places_CouSub_ConCity_SubMCD/MapServer/26`];
const SIMPLIFY_DEG = 0.0003; // ~30 m, plenty for area shares

// A zone counts in a county when OEDIT lists it there, or it covers at least this share of the county.
// Smaller overlaps are boundary slivers between the zone layer and the simplified county outlines.
const MIN_UNLISTED_SHARE = 0.01;
// A place names a tract when it covers this share of the tract, or this share of the place lies in the tract.
const TRACT_SHARE = 0.15;
const PLACE_SHARE = 0.5;
const SQ_M_PER_SQ_MI = 2589988.11;

/** Pages through an ArcGIS query and caches the result as GeoJSON. */
async function arcgis(file, layer, params) {
  const path = join(rawDir, file);
  if (existsSync(path) && !refresh) return path;
  const features = [];
  for (let offset = 0; ; offset += 1000) {
    const q = new URLSearchParams({
      outSR: "4326",
      f: "geojson",
      maxAllowableOffset: String(SIMPLIFY_DEG),
      resultOffset: String(offset),
      resultRecordCount: "1000",
      ...params,
    });
    const res = await fetch(`${layer}/query`, { method: "POST", body: q });
    if (!res.ok) throw new Error(`${layer}: HTTP ${res.status}`);
    const page = await res.json();
    if (page.error) throw new Error(`${layer}: ${JSON.stringify(page.error)}`);
    features.push(...page.features);
    if (page.features.length < 1000) break;
  }
  console.log(`Downloaded ${features.length} features -> raw/${file}`);
  writeFileSync(path, JSON.stringify({ type: "FeatureCollection", features }));
  return path;
}

/** Runs mapshaper and returns the output records (attributes only). */
function shapes(args) {
  const out = join(rawDir, "_out.json");
  execFileSync(mapshaper, ["-quiet", ...args, "-o", out, "format=json", "force"], { stdio: "inherit" });
  return JSON.parse(readFileSync(out, "utf8"));
}

const counties = join(stateDir, "counties.geojson");
const ezPath = await arcgis("ez.geojson", EZ_LAYER, { where: "currentZone='y'", outFields: "Admin_Zone,start_date,end_date" });
const oz1Path = await arcgis("oz1.geojson", OZ1_LAYER, { where: "STATE='08'", outFields: "GEOID10,COUNTY" });
const oz2Ids = programs.opportunityZones.oz2.tracts;
const oz2Path = await arcgis("oz2.geojson", TRACTS_2020, { where: `GEOID IN (${oz2Ids.map((g) => `'${g}'`).join(",")})`, outFields: "GEOID" });
const placePaths = [];
for (const [i, layer] of PLACES_2020.entries())
  placePaths.push(await arcgis(`places-${i}.geojson`, layer, { where: "STATE='08'", outFields: "GEOID,BASENAME,LSADC,POP100,INTPTLAT,INTPTLON" }));
const placesPath = join(rawDir, "places.geojson");
writeFileSync(placesPath, JSON.stringify({
  type: "FeatureCollection",
  features: placePaths.flatMap((p) => JSON.parse(readFileSync(p, "utf8")).features)
    .map((f) => ({ ...f, properties: { ...f.properties, CDP: f.properties.LSADC === "57" } })),
}));

// ---- Enterprise zone coverage of each county and of each town ----
const ezPieces = shapes([
  "-i", counties, ezPath, "combine-files", "snap",
  "-union", "fields=fips,Admin_Zone",
  "-each", "a=this.area",
]);
const countyArea = new Map();
const zoneArea = new Map(); // fips -> zone -> m2
for (const r of ezPieces) {
  if (!r.fips) continue;
  countyArea.set(r.fips, (countyArea.get(r.fips) ?? 0) + r.a);
  if (!r.Admin_Zone) continue;
  const m = zoneArea.get(r.fips) ?? new Map();
  m.set(r.Admin_Zone, (m.get(r.Admin_Zone) ?? 0) + r.a);
  zoneArea.set(r.fips, m);
}
const listed = new Map(); // county name -> zone names OEDIT lists for it
for (const [zone, z] of Object.entries(programs.enterpriseZones.zones))
  for (const c of z.counties) listed.set(c, [...(listed.get(c) ?? []), zone]);
for (const c of listed.keys()) if (!fipsOf.has(c)) throw new Error(`programs.json: unknown county ${c}`);

const placePieces = shapes([
  "-i", placesPath, ezPath, "combine-files", "snap",
  "-union", "fields=GEOID,Admin_Zone",
  "-each", "a=this.area",
]);
const placeEz = new Map(); // place GEOID -> {total, ez}
for (const r of placePieces) {
  if (!r.GEOID) continue;
  const p = placeEz.get(r.GEOID) ?? { total: 0, ez: 0 };
  p.total += r.a;
  if (r.Admin_Zone) p.ez += r.a;
  placeEz.set(r.GEOID, p);
}
// Which county each place sits in (by its internal point).
const placeCounty = new Map(
  shapes([
    "-i", placesPath,
    "-each", "lon=+INTPTLON, lat=+INTPTLAT",
    "-points", "x=lon", "y=lat",
    "-join", counties, "fields=fips",
  ]).map((r) => [r.GEOID, r]),
);

// ---- Opportunity zone tracts: area, rural status and the places they cover ----
const ruralOz2 = new Map(
  readFileSync(join(here, "oz2-eligible-tracts.csv"), "utf8").trim().split("\n").slice(1).map((line) => {
    const cols = line.split(",");
    return [cols[2].padStart(11, "0"), cols[3].trim() === "Rural"];
  }),
);
const ruralOz1 = new Set(programs.opportunityZones.oz1Rural.tracts);

function describeTracts(file, idField) {
  // Places also have a GEOID field, so store the tract id as `tract` before overlaying them.
  const src = JSON.parse(readFileSync(file, "utf8"));
  const path = join(rawDir, `_tracts.geojson`);
  writeFileSync(path, JSON.stringify({
    type: "FeatureCollection",
    features: src.features.map((f) => ({ ...f, properties: { tract: f.properties[idField] } })),
  }));
  const tractInfo = new Map(
    shapes(["-i", path, "-each", "geoid=tract, a=this.area, cx=this.centroidX, cy=this.centroidY"]).map((r) => [r.geoid, r]),
  );
  const placeArea = new Map(shapes(["-i", placesPath, "-each", "a=this.area"]).map((r) => [r.GEOID, r]));
  const pieces = shapes([
    "-i", path, placesPath, "combine-files", "snap",
    "-union", "fields=tract,GEOID",
    "-each", "a=this.area",
  ]);
  const byTract = new Map();
  for (const r of pieces) {
    const tract = r.tract;
    if (!tract || !r.GEOID) continue;
    const overlaps = byTract.get(tract) ?? new Map(); // place GEOID -> overlap; -union can split one place into pieces
    const o = overlaps.get(r.GEOID) ?? { place: placeArea.get(r.GEOID), a: 0 };
    o.a += r.a;
    overlaps.set(r.GEOID, o);
    byTract.set(tract, overlaps);
  }
  return [...tractInfo.values()].map((t) => {
    const overlaps = [...(byTract.get(t.geoid)?.values() ?? [])]
      .filter((o) => o.a / t.a >= TRACT_SHARE || o.a / o.place.a >= PLACE_SHARE)
      .sort((x, y) => y.a - x.a);
    const places = overlaps.map((o) => o.place.BASENAME + (o.place.CDP ? " (CDP)" : ""));
    let near;
    if (!overlaps.some((o) => !o.place.CDP)) {
      // Name the closest incorporated town so a rural tract can be found on a map.
      let best = Infinity;
      for (const p of placeArea.values()) {
        if (p.CDP) continue;
        const d = Math.hypot((+p.INTPTLON - t.cx) * Math.cos((t.cy * Math.PI) / 180), +p.INTPTLAT - t.cy);
        if (d < best) [best, near] = [d, p.BASENAME];
      }
    }
    return { geoid: t.geoid, sqmi: Math.round((t.a / SQ_M_PER_SQ_MI) * 10) / 10, places, near };
  });
}

const oz1 = describeTracts(oz1Path, "GEOID10").map((t) => ({ ...t, rural: ruralOz1.has(t.geoid) }));
const oz2 = describeTracts(oz2Path, "GEOID").map((t) => ({ ...t, rural: ruralOz2.get(t.geoid) ?? false }));
const missing = oz2Ids.filter((g) => !oz2.some((t) => t.geoid === g));
if (missing.length) throw new Error(`No Census 2020 geometry for OZ 2.0 tracts: ${missing.join(", ")}`);
if (oz1.length !== 126) throw new Error(`Expected 126 Colorado OZ 1.0 tracts, got ${oz1.length}`);

const eligibleByCounty = new Map();
for (const g of ruralOz2.keys()) eligibleByCounty.set(g.slice(0, 5), (eligibleByCounty.get(g.slice(0, 5)) ?? 0) + 1);

// ---- One record per county ----
const pct = (x) => Math.round(x * 1000) / 10;
const records = areas.map((area) => {
  const fips = area.id;
  const name = countyName.get(fips);
  const total = countyArea.get(fips);
  const zones = [...(zoneArea.get(fips) ?? new Map())]
    .map(([zone, a]) => ({ zone, share: a / total, listed: (listed.get(name) ?? []).includes(zone) }))
    .filter((z) => z.listed || z.share >= MIN_UNLISTED_SHARE)
    .sort((x, y) => y.share - x.share);
  const towns = [...placeCounty.values()]
    .filter((p) => p.fips === fips && !p.CDP)
    .map((p) => {
      const e = placeEz.get(p.GEOID);
      return { name: p.BASENAME, pop: p.POP100, share: e && e.total ? e.ez / e.total : 0 };
    })
    .sort((x, y) => y.pop - x.pop);
  const tracts = (list) => list.filter((t) => t.geoid.slice(0, 5) === fips).sort((x, y) => x.geoid.localeCompare(y.geoid));
  const erez = programs.enhancedRural;
  const rjs = programs.ruralJumpStart;
  return {
    fips,
    name,
    enterpriseZone: {
      zones: zones.map((z) => ({ zone: z.zone, coveragePct: pct(z.share), listedByOedit: z.listed })),
      coveragePct: pct(zones.reduce((s, z) => s + z.share, 0)),
      towns: towns.map((t) => ({ name: t.name, population: t.pop, inZonePct: pct(t.share) })),
    },
    enhancedRural: erez.partial[name] ?? (erez.counties.includes(name) ? "whole county" : null),
    ruralJumpStart: rjs.zones.includes(name) ? "zone" : rjs.eligibleNotJoined.includes(name) ? "eligible, not joined" : null,
    justTransitionTier1: name in rjs.tier1 ? rjs.tier1[name] || "whole county" : null,
    opportunityZones: {
      oz1: tracts(oz1),
      oz2Nominated: tracts(oz2),
      oz2Eligible: eligibleByCounty.get(fips) ?? 0,
      oz2RejectedOffList: Object.keys(programs.opportunityZones.oz2.rejectedOffList).filter((g) => g.startsWith(fips)),
    },
  };
});

const out = join(here, "zones.json");
writeFileSync(out, JSON.stringify({
  _about: "Generated by pipelines/incentives/build.mjs from programs.json and the GIS layers listed in layers. Don't edit by hand.",
  checkedAt: programs.checkedAt,
  layers: { enterpriseZones: EZ_LAYER, oz1: OZ1_LAYER, tracts2020: TRACTS_2020, places2020: PLACES_2020 },
  counties: records,
}, null, 1) + "\n");
console.log(`Wrote ${out} (${records.length} counties, ${oz1.length} OZ 1.0 tracts, ${oz2.length} OZ 2.0 tracts)`);
