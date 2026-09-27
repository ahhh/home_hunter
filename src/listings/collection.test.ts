import { describe, expect, it } from "vitest";
import type { Property, SearchFilters } from "../domain/types";
import { displayPrice, hasConflictingPrices, mergeProperties, passesFilters, pricePerAcre, sortProperties, stableId } from "./collection";

const prop = (over: Partial<Property> & { url?: string; price?: number; fetchedAt?: string } = {}): Property => {
  const { url = "https://zillow.com/a", price = 100000, fetchedAt = "2026-09-01", ...rest } = over;
  return {
    id: url,
    location: { lat: 39, lng: -105 },
    locationPrecision: "exact",
    category: "vacant_land",
    acreage: 10,
    listings: [{ provider: "zillow", canonicalUrl: url, status: "active", price, fetchedAt }],
    addedAt: fetchedAt,
    ...rest,
  };
};

const noFilters: SearchFilters = { category: "all", providers: [], ratings: "all" };

describe("mergeProperties", () => {
  it("refreshes a re-imported listing but keeps notes and rating", () => {
    const mine = prop({ rating: "love", notes: "creek!" });
    const again = prop({ price: 90000, fetchedAt: "2026-09-20" });
    const { properties, added, updated } = mergeProperties([mine], [again]);
    expect(added).toBe(0);
    expect(updated).toBe(1);
    expect(displayPrice(properties[0])).toBe(90000);
    expect(properties[0].rating).toBe("love");
    expect(properties[0].notes).toBe("creek!");
  });

  it("does not let an older copy overwrite a newer price", () => {
    const { properties } = mergeProperties([prop({ price: 90000, fetchedAt: "2026-09-20" })], [prop({ price: 120000, fetchedAt: "2026-09-01" })]);
    expect(displayPrice(properties[0])).toBe(90000);
  });

  it("attaches another site's listing of the same address", () => {
    const z = prop({ address: "12 Pine Lane, Salida, CO" });
    const r = prop({ url: "https://redfin.com/b", price: 105000, address: "12 Pine Ln, Salida, CO" });
    const { properties, added } = mergeProperties([z], [r]);
    expect(added).toBe(0);
    expect(properties[0].listings).toHaveLength(2);
    expect(hasConflictingPrices(properties[0])).toBe(true);
    expect(displayPrice(properties[0])).toBe(100000);
  });

  it("keeps same-address listings far apart as separate properties", () => {
    const a = prop({ address: "12 Pine Ln" });
    const b = prop({ url: "https://redfin.com/b", address: "12 Pine Ln", location: { lat: 40, lng: -105 } });
    expect(mergeProperties([a], [b]).added).toBe(1);
  });

  it("does not merge listings with no address", () => {
    expect(mergeProperties([prop()], [prop({ url: "https://redfin.com/b" })]).added).toBe(1);
  });

  it("combines notes from a friend", () => {
    const { properties } = mergeProperties([prop({ notes: "mine" })], [prop({ notes: "looks steep", addedBy: "Alex" })]);
    expect(properties[0].notes).toBe("mine\n\nAlex: looks steep");
  });
});

describe("passesFilters", () => {
  it("filters by price range", () => {
    expect(passesFilters(prop({ price: 100000 }), { ...noFilters, priceMax: 90000 })).toBe(false);
    expect(passesFilters(prop({ price: 100000 }), { ...noFilters, priceMin: 50000, priceMax: 150000 })).toBe(true);
  });

  it("strict land filter hides improved and unknown", () => {
    const land = { ...noFilters, category: "vacant_land" as const };
    expect(passesFilters(prop({ category: "improved" }), land)).toBe(false);
    expect(passesFilters(prop({ category: "unknown" }), land)).toBe(false);
    expect(passesFilters(prop({ category: "unknown" }), noFilters)).toBe(true);
  });

  it("treats missing acreage as not matching an acreage filter", () => {
    expect(passesFilters(prop({ acreage: undefined }), { ...noFilters, acreageMin: 1 })).toBe(false);
  });

  it("hides passed properties when asked", () => {
    expect(passesFilters(prop({ rating: "pass" }), { ...noFilters, ratings: "not_passed" })).toBe(false);
  });
});

describe("sortProperties", () => {
  it("sorts by price per acre with unknowns last", () => {
    const a = prop({ url: "a", price: 100000, acreage: 10 });
    const b = prop({ url: "b", price: 100000, acreage: 40 });
    const c = prop({ url: "c", price: 100000, acreage: undefined });
    expect(pricePerAcre(b)).toBe(2500);
    expect(sortProperties([c, a, b], "ppa_asc", { lat: 39, lng: -105 }).map((p) => p.id)).toEqual(["b", "a", "c"]);
  });
});

describe("stableId", () => {
  it("matches the Python seed script's ids", async () => {
    const { readFileSync } = await import("node:fs");
    const expected: Record<string, string> = JSON.parse(readFileSync("tests/fixtures/stable-ids.json", "utf8"));
    for (const [input, id] of Object.entries(expected)) expect(stableId(input)).toBe(id);
  });
});
