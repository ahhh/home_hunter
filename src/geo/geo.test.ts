import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AreaIndex, circleBounds, distanceMiles, inEffectiveArea } from "./geo";

const geo = JSON.parse(readFileSync("public/data/states/CO/counties.geojson", "utf8"));
const index = new AreaIndex(geo.features.map((f: any) => ({ id: f.properties.fips, geometry: f.geometry })));

const DENVER = { lat: 39.7392, lng: -104.9903 };
const BOULDER = { lat: 40.015, lng: -105.2705 };
const SALIDA = { lat: 38.5347, lng: -105.9989 };
const BUENA_VISTA = { lat: 38.8422, lng: -106.1311 };
const CHEYENNE_WY = { lat: 41.14, lng: -104.8202 };

describe("distance", () => {
  it("matches known Denver–Boulder distance (~24.5 mi)", () => {
    expect(distanceMiles(DENVER, BOULDER)).toBeCloseTo(24.5, 0);
  });

  it("circle bounds contain the whole radius", () => {
    const b = circleBounds(DENVER, 50);
    expect(distanceMiles(DENVER, { lat: b.north, lng: DENVER.lng })).toBeGreaterThanOrEqual(49.9);
    expect(distanceMiles(DENVER, { lat: DENVER.lat, lng: b.east })).toBeGreaterThanOrEqual(49.9);
  });
});

describe("county lookup", () => {
  it("locates towns in the right county", () => {
    expect(index.locate(DENVER)).toBe("08031");
    expect(index.locate(BOULDER)).toBe("08013");
    expect(index.locate(SALIDA)).toBe("08015");
    expect(index.locate(BUENA_VISTA)).toBe("08015");
  });

  it("returns undefined outside Colorado", () => {
    expect(index.locate(CHEYENNE_WY)).toBeUndefined();
  });

  it("has all 64 counties", () => {
    expect(geo.features).toHaveLength(64);
  });
});

describe("effective search area", () => {
  const base = { center: DENVER, radiusMiles: 50, limitToRadius: true, counties: {} };

  it("keeps points inside the radius", () => {
    expect(inEffectiveArea(BOULDER, "08013", base)).toBe(true);
  });

  it("drops points outside the radius", () => {
    expect(inEffectiveArea(SALIDA, "08015", base)).toBe(false);
  });

  it("ignores the radius when it is switched off", () => {
    expect(inEffectiveArea(SALIDA, "08015", { ...base, limitToRadius: false })).toBe(true);
  });

  it("drops points in an excluded county even inside the radius", () => {
    expect(inEffectiveArea(BOULDER, "08013", { ...base, counties: { "08013": "exclude" } })).toBe(false);
  });

  it("with included counties, keeps only those counties", () => {
    const area = { ...base, counties: { "08031": "include" as const } };
    expect(inEffectiveArea(DENVER, "08031", area)).toBe(true);
    expect(inEffectiveArea(BOULDER, "08013", area)).toBe(false);
  });

  it("an included county outside the radius still returns nothing", () => {
    expect(inEffectiveArea(SALIDA, "08015", { ...base, counties: { "08015": "include" } })).toBe(false);
  });

  it("points outside the state fail an include-only search", () => {
    expect(inEffectiveArea(CHEYENNE_WY, undefined, { ...base, radiusMiles: 200, counties: { "08031": "include" } })).toBe(false);
    expect(inEffectiveArea(CHEYENNE_WY, undefined, { ...base, radiusMiles: 200 })).toBe(true);
  });
});
