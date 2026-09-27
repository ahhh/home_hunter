import { describe, expect, it } from "vitest";
import type { Property } from "../domain/types";
import { buildExport, pickProperties } from "./exportFile";
import { readImportFile } from "./importFile";
import { DEFAULT_SEARCH, reducer, type AppState } from "./store";

const prop = (id: string, over: Partial<Property> = {}): Property => ({
  id,
  location: { lat: 38.5, lng: -106 },
  locationPrecision: "exact",
  category: "vacant_land",
  listings: [{ provider: "zillow", canonicalUrl: `https://zillow.com/homedetails/${id}`, status: "active", price: 100, fetchedAt: "2026-09-01T00:00:00Z" }],
  addedAt: "2026-09-01T00:00:00Z",
  ...over,
});

const state = (properties: Property[], over: Partial<AppState> = {}): AppState => ({
  search: DEFAULT_SEARCH,
  properties,
  selection: null,
  pick: { kind: "none" },
  userName: "",
  removedIds: [],
  ...over,
});

const file = (data: unknown, name = "x.json") => new File([JSON.stringify(data)], name, { type: "application/json" });

async function importInto(s: AppState, data: unknown) {
  const outcome = await readImportFile(file(data), s);
  return { outcome, next: outcome.action ? reducer(s, outcome.action) : s };
}

describe("export", () => {
  const mine = [prop("a", { rating: "love", notes: "creek" }), prop("b", { rating: "maybe" }), prop("c", { rating: "pass" }), prop("d")];

  it("picks loved, rated, shown or all", () => {
    expect(pickProperties("loved", mine, []).map((p) => p.id)).toEqual(["a"]);
    expect(pickProperties("rated", mine, []).map((p) => p.id)).toEqual(["a", "b"]);
    expect(pickProperties("visible", mine, [mine[3]]).map((p) => p.id)).toEqual(["d"]);
    expect(pickProperties("all", mine, [])).toHaveLength(4);
  });

  it("round-trips loved listings with notes into a friend's map", async () => {
    const exported = buildExport(state(mine), "loved", [], { includeSearch: true, from: "Sam", now: "2026-09-27T00:00:00Z" });
    expect(exported.kind).toBe("home-hunter-export");
    const { outcome, next } = await importInto(state([prop("z")]), JSON.parse(JSON.stringify(exported)));
    expect(outcome.text).toBe("Export from Sam: Added 1 new listing.");
    expect(outcome.search?.center.label).toBe(DEFAULT_SEARCH.center.label);
    expect(next.properties.map((p) => p.id)).toEqual(["z", "a"]);
    expect(next.properties[1].notes).toBe("creek");
    expect(next.properties[1].rating).toBe("love");
  });

  it("leaves out the search area when asked", () => {
    expect(buildExport(state(mine), "all", [], { includeSearch: false }).search).toBeUndefined();
  });
});

describe("importing data bundles", () => {
  const bundle = (properties: Property[], over: object = {}) => ({
    kind: "home-hunter-seed",
    v: 1,
    generatedAt: "2026-09-20T00:00:00.000Z",
    partial: false,
    properties,
    ...over,
  });

  it("a full bundle replaces the previous one", async () => {
    const { outcome, next } = await importInto(state([prop("old", { seeded: true })]), bundle([prop("new")]));
    expect(next.properties.map((p) => p.id)).toEqual(["new"]);
    expect(outcome.text).toContain("1 no longer for sale removed");
  });

  it("a partial (top-up) bundle only adds", async () => {
    const { outcome, next } = await importInto(state([prop("old", { seeded: true })]), bundle([prop("new")], { partial: true }));
    expect(next.properties.map((p) => p.id)).toEqual(["old", "new"]);
    expect(outcome.text).toContain("top-up bundle");
  });

  it("refuses a full bundle older than the last one", async () => {
    const { outcome } = await importInto(state([], { seedAt: "2026-09-25T00:00:00.000Z" }), bundle([prop("x")]));
    expect(outcome.ok).toBe(false);
    expect(outcome.action).toBeUndefined();
  });

  it("accepts an older partial bundle", async () => {
    const { outcome } = await importInto(state([], { seedAt: "2026-09-25T00:00:00.000Z" }), bundle([prop("x")], { partial: true }));
    expect(outcome.ok).toBe(true);
  });

  it("rejects unknown JSON", async () => {
    expect((await importInto(state([]), { hello: 1 })).outcome.ok).toBe(false);
  });
});
