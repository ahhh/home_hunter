import type { LatLng, Listing, Property, SearchFilters, SortKey } from "../domain/types";
import { distanceMiles } from "../geo/geo";

/** Short stable id derived from a string (FNV-1a), so shared links stay compact. */
export function stableId(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export const STALE_AFTER_DAYS = 14;

export function daysSince(iso: string, now = Date.now()): number {
  return Math.floor((now - Date.parse(iso)) / 864e5);
}

export function currentListings(p: Property): Listing[] {
  return [...p.listings].sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt));
}

/** Lowest known asking price across the property's listings. */
export function displayPrice(p: Property): number | undefined {
  const prices = p.listings.map((l) => l.price).filter((x): x is number => x !== undefined);
  return prices.length ? Math.min(...prices) : undefined;
}

export function hasConflictingPrices(p: Property): boolean {
  return new Set(p.listings.map((l) => l.price).filter((x) => x !== undefined)).size > 1;
}

export function pricePerAcre(p: Property): number | undefined {
  const price = displayPrice(p);
  return price !== undefined && p.acreage ? price / p.acreage : undefined;
}

export function newestFetch(p: Property): string {
  return p.listings.reduce((m, l) => (l.fetchedAt > m ? l.fetchedAt : m), p.addedAt);
}

const normAddress = (a?: string) =>
  a
    ?.toLowerCase()
    .replace(/\b(street)\b/g, "st")
    .replace(/\b(road)\b/g, "rd")
    .replace(/\b(avenue)\b/g, "ave")
    .replace(/\b(drive)\b/g, "dr")
    .replace(/\b(lane)\b/g, "ln")
    .replace(/\b(county road)\b/g, "cr")
    .replace(/[^a-z0-9]/g, "");

/**
 * Merge incoming properties into the collection.
 *  1. Same listing URL → same listing: refresh its price/date, keep the person's notes and rating.
 *  2. Same normalized street address within 150 m → another site's listing of the same property.
 *  3. Otherwise it's a new property. Uncertain matches are never merged.
 */
export function mergeProperties(existing: Property[], incoming: Property[]): { properties: Property[]; added: number; updated: number } {
  const result = existing.map((p) => ({ ...p, listings: [...p.listings] }));
  let added = 0;
  let updated = 0;

  for (const inc of incoming) {
    const byUrl = result.find((p) => p.listings.some((l) => inc.listings.some((il) => il.canonicalUrl === l.canonicalUrl)));
    const addr = normAddress(inc.address);
    const target =
      byUrl ??
      (addr && addr.length > 6
        ? result.find((p) => normAddress(p.address) === addr && distanceMiles(p.location, inc.location) < 0.1)
        : undefined);

    if (!target) {
      result.push({ ...inc, listings: [...inc.listings] });
      added++;
      continue;
    }

    for (const il of inc.listings) {
      const i = target.listings.findIndex((l) => l.canonicalUrl === il.canonicalUrl);
      if (i < 0) target.listings.push(il);
      else if (il.fetchedAt >= target.listings[i].fetchedAt) target.listings[i] = { ...target.listings[i], ...il };
    }
    // Fill gaps, never overwrite what's already known.
    target.address ??= inc.address;
    target.acreage ??= inc.acreage;
    target.bedrooms ??= inc.bedrooms;
    target.bathrooms ??= inc.bathrooms;
    target.squareFeet ??= inc.squareFeet;
    target.rating ??= inc.rating;
    if (target.category === "unknown") target.category = inc.category;
    if (target.locationPrecision === "approximate" && inc.locationPrecision === "exact") {
      target.location = inc.location;
      target.locationPrecision = "exact";
    }
    if (inc.notes && !target.notes?.includes(inc.notes)) {
      target.notes = target.notes ? `${target.notes}\n\n${inc.addedBy ?? "Shared"}: ${inc.notes}` : inc.notes;
    }
    updated++;
  }
  return { properties: result, added, updated };
}

export function passesFilters(p: Property, f: SearchFilters): boolean {
  const price = displayPrice(p);
  if (f.priceMin !== undefined && (price === undefined || price < f.priceMin)) return false;
  if (f.priceMax !== undefined && (price === undefined || price > f.priceMax)) return false;
  // Strict: unknown category only shows under "All".
  if (f.category !== "all" && p.category !== f.category) return false;
  if (f.acreageMin !== undefined && (p.acreage === undefined || p.acreage < f.acreageMin)) return false;
  if (f.acreageMax !== undefined && (p.acreage === undefined || p.acreage > f.acreageMax)) return false;
  if (f.bedsMin !== undefined && (p.category === "vacant_land" || (p.bedrooms ?? 0) < f.bedsMin)) return false;
  if (f.bathsMin !== undefined && (p.category === "vacant_land" || (p.bathrooms ?? 0) < f.bathsMin)) return false;
  if (f.providers.length && !p.listings.some((l) => f.providers.includes(l.provider))) return false;
  if (f.ratings === "love" && p.rating !== "love") return false;
  if (f.ratings === "not_passed" && p.rating === "pass") return false;
  return true;
}

export function sortProperties(list: Property[], key: SortKey, center: LatLng): Property[] {
  // Missing values always sort last.
  const by = (get: (p: Property) => number | undefined, dir: 1 | -1) => (a: Property, b: Property) => {
    const x = get(a);
    const y = get(b);
    if (x === undefined) return y === undefined ? 0 : 1;
    if (y === undefined) return -1;
    return (x - y) * dir;
  };
  const cmp: Record<SortKey, (a: Property, b: Property) => number> = {
    newest: (a, b) => newestFetch(b).localeCompare(newestFetch(a)),
    price_asc: by(displayPrice, 1),
    price_desc: by(displayPrice, -1),
    acres_desc: by((p) => p.acreage, -1),
    ppa_asc: by(pricePerAcre, 1),
    distance: by((p) => distanceMiles(center, p.location), 1),
  };
  return [...list].sort(cmp[key]);
}
