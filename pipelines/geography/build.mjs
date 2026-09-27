// Builds Colorado county geometry from the US Census cartographic boundary file.
//
//   raw Census shapefile (1:5,000,000) -> filter to state -> normalize IDs
//   -> light simplification -> GeoJSON + registry with centroid/bounds + checksum
//
// Usage: npm run build:geo
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");

const STATE = { code: "CO", name: "Colorado", fips: "08" };
const SOURCE = {
  dataset: "cb_2023_us_county_5m",
  authority: "U.S. Census Bureau, Cartographic Boundary Files",
  url: "https://www2.census.gov/geo/tiger/GENZ2023/shp/cb_2023_us_county_5m.zip",
};

const rawDir = join(here, "raw");
const zip = join(rawDir, `${SOURCE.dataset}.zip`);
const shp = join(rawDir, `${SOURCE.dataset}.shp`);
const outDir = join(root, "public", "data", "states", STATE.code);
mkdirSync(rawDir, { recursive: true });
mkdirSync(outDir, { recursive: true });

if (!existsSync(zip)) {
  console.log(`Downloading ${SOURCE.url}`);
  execFileSync("curl", ["-sSfL", "-o", zip, SOURCE.url], { stdio: "inherit" });
}
if (!existsSync(shp)) execFileSync("unzip", ["-o", "-q", zip, "-d", rawDir], { stdio: "inherit" });

const geoPath = join(outDir, "counties.geojson");
const mapshaper = join(root, "node_modules", ".bin", "mapshaper");
execFileSync(
  mapshaper,
  [
    shp,
    "-filter", `STATEFP === '${STATE.fips}'`,
    "-each", "fips = GEOID, name = NAME",
    "-filter-fields", "fips,name",
    "-simplify", "40%", "keep-shapes",
    "-o", geoPath, "format=geojson", "precision=0.00001",
  ],
  { stdio: "inherit" },
);

const geo = JSON.parse(readFileSync(geoPath, "utf8"));
geo.features.sort((a, b) => a.properties.fips.localeCompare(b.properties.fips));
writeFileSync(geoPath, JSON.stringify(geo));

function rings(geometry) {
  return geometry.type === "Polygon" ? [geometry.coordinates[0]] : geometry.coordinates.map((p) => p[0]);
}

const counties = geo.features.map((f) => {
  let minLat = Infinity, minLng = Infinity, maxLat = -Infinity, maxLng = -Infinity;
  // Area-weighted centroid of the outer rings.
  let a = 0, cx = 0, cy = 0;
  for (const ring of rings(f.geometry)) {
    for (let i = 0; i < ring.length; i++) {
      const [x, y] = ring[i];
      minLng = Math.min(minLng, x); maxLng = Math.max(maxLng, x);
      minLat = Math.min(minLat, y); maxLat = Math.max(maxLat, y);
      const [x2, y2] = ring[(i + 1) % ring.length];
      const cross = x * y2 - x2 * y;
      a += cross; cx += (x + x2) * cross; cy += (y + y2) * cross;
    }
  }
  const r = (n) => Math.round(n * 1e5) / 1e5;
  return {
    id: f.properties.fips,
    type: "county",
    stateCode: STATE.code,
    fips: f.properties.fips,
    name: `${f.properties.name} County`,
    centroid: { lat: r(cy / (3 * a)), lng: r(cx / (3 * a)) },
    bounds: { south: r(minLat), west: r(minLng), north: r(maxLat), east: r(maxLng) },
  };
});

const checksum = createHash("sha256").update(readFileSync(geoPath)).digest("hex");
writeFileSync(
  join(outDir, "areas.json"),
  JSON.stringify(
    {
      state: { code: STATE.code, name: STATE.name, fips: STATE.fips },
      geometry: { file: "counties.geojson", sha256: checksum, simplification: "mapshaper -simplify 40% keep-shapes", ...SOURCE },
      builtAt: new Date().toISOString().slice(0, 10),
      areas: counties,
    },
    null,
    2,
  ) + "\n",
);
console.log(`Wrote ${counties.length} counties (${(readFileSync(geoPath).length / 1024).toFixed(0)} KB geojson)`);
