import { describe, expect, it } from "vitest";
import type { Property } from "../domain/types";
import { DEFAULT_SEARCH, reducer, type AppState } from "./store";

const prop = (id: string, over: Partial<Property> = {}): Property => ({
  id,
  location: { lat: 39, lng: -105 },
  locationPrecision: "exact",
  category: "vacant_land",
  listings: [{ provider: "rentcast", canonicalUrl: `https://zillow.com/homes/${id}_rb`, status: "active", price: 100, fetchedAt: "2026-09-01" }],
  addedAt: "2026-09-01",
  ...over,
});

const base = (properties: Property[], over: Partial<AppState> = {}): AppState => ({
  search: DEFAULT_SEARCH,
  properties,
  selection: null,
  pick: { kind: "none" },
  userName: "",
  removedIds: [],
  ...over,
});

const seed = (properties: Property[], partial = false) => ({ type: "applySeed" as const, generatedAt: "2026-09-20", properties, partial });

describe("applySeed", () => {
  it("adds new listings marked as seeded", () => {
    const s = reducer(base([]), seed([prop("a")]));
    expect(s.properties.map((p) => p.id)).toEqual(["a"]);
    expect(s.properties[0].seeded).toBe(true);
    expect(s.seedAt).toBe("2026-09-20");
  });

  it("drops seeded listings that are gone from the new seed", () => {
    const s = reducer(base([prop("a", { seeded: true }), prop("b", { seeded: true })]), seed([prop("b")]));
    expect(s.properties.map((p) => p.id)).toEqual(["b"]);
  });

  it("keeps gone listings someone rated or wrote notes on", () => {
    const s = reducer(base([prop("a", { seeded: true, rating: "love" }), prop("b", { seeded: true, notes: "call agent" })]), seed([]));
    expect(s.properties.map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("never removes listings people added themselves", () => {
    expect(reducer(base([prop("mine")]), seed([])).properties).toHaveLength(1);
  });

  it("keeps notes and verdicts while refreshing the price", () => {
    const mine = prop("a", { seeded: true, rating: "maybe", notes: "steep" });
    const fresh = prop("a", { listings: [{ ...mine.listings[0], price: 90, fetchedAt: "2026-09-20" }] });
    const [p] = reducer(base([mine]), seed([fresh])).properties;
    expect(p.rating).toBe("maybe");
    expect(p.notes).toBe("steep");
    expect(p.listings[0].price).toBe(90);
  });

  it("a partial bundle adds and refreshes but removes nothing", () => {
    const start = base([prop("a", { seeded: true })], { seedAt: "2026-09-10" });
    const s = reducer(start, seed([prop("b")], true));
    expect(s.properties.map((p) => p.id)).toEqual(["a", "b"]);
    expect(s.seedAt).toBe("2026-09-10");
  });

  it("does not bring back listings the person removed", () => {
    const removed = reducer(base([prop("a", { seeded: true })]), { type: "deleteProperty", id: "a" });
    expect(removed.removedIds).toEqual(["a"]);
    expect(reducer(removed, seed([prop("a"), prop("b")])).properties.map((p) => p.id)).toEqual(["b"]);
  });
});
