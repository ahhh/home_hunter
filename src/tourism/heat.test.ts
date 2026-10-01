import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { distanceMiles } from "../geo/geo";
import { TourismModel, approxMiles, intensity, type TourismData } from "./heat";

const data: TourismData = JSON.parse(readFileSync("public/data/states/CO/tourism.json", "utf8"));
const model = new TourismModel(data);

const ESTES = { lat: 40.3772, lng: -105.5217 };
const BOULDER = { lat: 40.015, lng: -105.2705 };
const KIT_CARSON = { lat: 38.76, lng: -102.79 }; // eastern plains, nothing tracked nearby

describe("tourism data", () => {
  it("every destination's lodging split adds to 1 and names real towns", () => {
    for (const a of data.attractions) {
      const total = Object.values(a.stays).reduce((s, x) => s + x, 0);
      expect(total, a.id).toBeCloseTo(1, 6);
      for (const id of Object.keys(a.stays)) expect(data.bases[id], `${a.id} -> ${id}`).toBeDefined();
    }
  });

  it("interest is scaled so the top destination is 100", () => {
    expect(Math.max(...data.attractions.map((a) => a.interest))).toBe(100);
    expect(data.attractions.every((a) => a.interest >= 0)).toBe(true);
  });
});

describe("approxMiles", () => {
  it("is within 0.5% of the great-circle distance at destination scale", () => {
    const exact = distanceMiles(ESTES, BOULDER);
    expect(Math.abs(approxMiles(ESTES, BOULDER) - exact) / exact).toBeLessThan(0.005);
  });
});

describe("TourismModel", () => {
  const rmnp = data.attractions.find((a) => a.id === "rmnp")!;

  it("interest is highest near destinations and zero far from all of them", () => {
    expect(model.interestAt(rmnp)).toBeGreaterThan(model.interestAt(BOULDER));
    expect(model.interestAt(KIT_CARSON)).toBe(0);
    expect(model.staysAt(KIT_CARSON)).toBe(0);
  });

  it("explains a point by the destinations around it, shares adding to at most 1", () => {
    const parts = model.interestParts(rmnp);
    expect(parts[0].attraction.id).toBe("rmnp");
    const sum = parts.reduce((s, x) => s + x.share, 0);
    expect(sum).toBeLessThanOrEqual(1 + 1e-9);
    expect(sum).toBeGreaterThan(0.5);
  });

  it("moves each destination's interest to its lodging towns", () => {
    const estes = model.demand.find((d) => d.baseId === "estes-park")!;
    expect(estes.from.map((f) => f.attraction.id)).toContain("rmnp");
    expect(estes.weight).toBeCloseTo(estes.from.reduce((s, f) => s + f.weight, 0), 6);
    expect(model.stayParts(ESTES)[0].demand.baseId).toBe("estes-park");
  });

  it("the maxima bound the field at destinations and towns", () => {
    for (const a of data.attractions) expect(model.interestAt(a)).toBeLessThanOrEqual(model.maxInterest);
    for (const d of model.demand) expect(model.staysAt(d.base)).toBeLessThanOrEqual(model.maxStays);
  });
});

describe("intensity", () => {
  it("maps the max to 1, 1000x less to 0, on a log scale", () => {
    expect(intensity(50, 50)).toBe(1);
    expect(intensity(0.05, 50)).toBeCloseTo(0, 6);
    expect(intensity(5, 50)).toBeCloseTo(2 / 3, 6);
    expect(intensity(0, 50)).toBe(0);
  });
});
