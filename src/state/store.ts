import { compressToEncodedURIComponent, decompressFromEncodedURIComponent } from "lz-string";
import type { CountySearchState, Property, SearchCenter, SearchFilters, SearchState, SortKey } from "../domain/types";
import { mergeProperties } from "../listings/collection";

export type Selection = { kind: "property"; id: string } | { kind: "county"; id: string } | null;

/** What a map click does right now. */
export type PickMode = { kind: "none" } | { kind: "center" } | { kind: "place"; propertyId: string };

export interface AppState {
  search: SearchState;
  properties: Property[];
  selection: Selection;
  pick: PickMode;
  userName: string;
  /** Properties this person removed; a new seed file won't bring them back. */
  removedIds: string[];
  /** generatedAt of the last seed file merged in. */
  seedAt?: string;
}

export const DEFAULT_FILTERS: SearchFilters = { category: "all", providers: [], ratings: "not_passed" };

export const DEFAULT_SEARCH: SearchState = {
  center: { lat: 39.7392, lng: -104.9903, label: "Denver, CO", postcode: "80202" },
  radiusMiles: 50,
  limitToRadius: true,
  counties: {},
  filters: DEFAULT_FILTERS,
  sort: "newest",
};

export type Action =
  | { type: "setCenter"; center: SearchCenter }
  | { type: "setRadius"; miles: number }
  | { type: "setLimitToRadius"; on: boolean }
  | { type: "setCounty"; id: string; state: CountySearchState | null }
  | { type: "clearCounties" }
  | { type: "setFilters"; filters: Partial<SearchFilters> }
  | { type: "resetFilters" }
  | { type: "setSort"; sort: SortKey }
  | { type: "select"; selection: Selection }
  | { type: "setPick"; pick: PickMode }
  | { type: "mergeProperties"; properties: Property[] }
  | { type: "updateProperty"; id: string; patch: Partial<Property> }
  | { type: "deleteProperty"; id: string }
  | { type: "setUserName"; name: string }
  | { type: "applySearch"; search: SearchState }
  | { type: "applySeed"; generatedAt: string; properties: Property[]; partial: boolean };

export function reducer(s: AppState, a: Action): AppState {
  switch (a.type) {
    case "setCenter":
      return { ...s, search: { ...s.search, center: a.center }, pick: { kind: "none" } };
    case "setRadius":
      return { ...s, search: { ...s.search, radiusMiles: a.miles } };
    case "setLimitToRadius":
      return { ...s, search: { ...s.search, limitToRadius: a.on } };
    case "setCounty": {
      const counties = { ...s.search.counties };
      if (a.state) counties[a.id] = a.state;
      else delete counties[a.id];
      return { ...s, search: { ...s.search, counties } };
    }
    case "clearCounties":
      return { ...s, search: { ...s.search, counties: {} } };
    case "setFilters":
      return { ...s, search: { ...s.search, filters: { ...s.search.filters, ...a.filters } } };
    case "resetFilters":
      return { ...s, search: { ...s.search, filters: DEFAULT_FILTERS } };
    case "setSort":
      return { ...s, search: { ...s.search, sort: a.sort } };
    case "select":
      return { ...s, selection: a.selection };
    case "setPick":
      return { ...s, pick: a.pick };
    case "mergeProperties":
      return { ...s, properties: mergeProperties(s.properties, a.properties).properties };
    case "updateProperty":
      return { ...s, properties: s.properties.map((p) => (p.id === a.id ? { ...p, ...a.patch } : p)) };
    case "deleteProperty":
      return {
        ...s,
        properties: s.properties.filter((p) => p.id !== a.id),
        removedIds: [...s.removedIds.filter((id) => id !== a.id), a.id].slice(-2000),
        selection: s.selection?.kind === "property" && s.selection.id === a.id ? null : s.selection,
      };
    case "setUserName":
      return { ...s, userName: a.name };
    case "applySearch":
      return { ...s, search: a.search };
    case "applySeed": {
      const removed = new Set(s.removedIds);
      const incoming = a.properties.filter((p) => !removed.has(p.id)).map((p) => ({ ...p, seeded: true }));
      // A partial bundle (new listings only, or cut short) can only add and refresh.
      if (a.partial) return { ...s, properties: mergeProperties(s.properties, incoming).properties };
      const fresh = new Set(a.properties.flatMap((p) => p.listings.map((l) => l.canonicalUrl)));
      // Seeded listings missing from a full bundle are off the market, unless someone cares about them.
      const kept = s.properties.filter(
        (p) => !p.seeded || p.rating || p.notes || p.listings.some((l) => fresh.has(l.canonicalUrl)),
      );
      return { ...s, properties: mergeProperties(kept, incoming).properties, seedAt: a.generatedAt };
    }
  }
}

// ---------- persistence (this browser only) ----------

const KEY = "home-hunter:v1";

export function loadSaved(): AppState {
  const empty: AppState = { search: DEFAULT_SEARCH, properties: [], selection: null, pick: { kind: "none" }, userName: "", removedIds: [] };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return empty;
    const saved = JSON.parse(raw);
    return {
      ...empty,
      search: { ...DEFAULT_SEARCH, ...saved.search, filters: { ...DEFAULT_FILTERS, ...saved.search?.filters } },
      properties: Array.isArray(saved.properties) ? saved.properties : [],
      userName: saved.userName ?? "",
      removedIds: Array.isArray(saved.removedIds) ? saved.removedIds : [],
      seedAt: typeof saved.seedAt === "string" ? saved.seedAt : undefined,
    };
  } catch {
    return empty;
  }
}

export function save(s: AppState) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ search: s.search, properties: s.properties, userName: s.userName, removedIds: s.removedIds, seedAt: s.seedAt }));
  } catch {
    // Storage full or blocked; the export button still works.
  }
}

// ---------- share links & file export ----------

export interface SharePayload {
  v: 1;
  from?: string;
  search?: SearchState;
  properties?: Property[];
}

export function shareUrl(payload: SharePayload): string {
  const url = new URL(window.location.href);
  url.hash = `share=${compressToEncodedURIComponent(JSON.stringify(payload))}`;
  return url.toString();
}

export function readShareHash(hash: string): SharePayload | undefined {
  const m = hash.match(/share=([^&]+)/);
  if (!m) return undefined;
  try {
    const payload = JSON.parse(decompressFromEncodedURIComponent(m[1]) ?? "");
    return payload?.v === 1 ? sanitizePayload(payload) : undefined;
  } catch {
    return undefined;
  }
}

/** Shared data comes from other people: keep only well-formed properties with http(s) links. */
export function sanitizePayload(p: any): SharePayload {
  const properties = Array.isArray(p.properties)
    ? p.properties.filter(
        (x: any) =>
          x &&
          typeof x.id === "string" &&
          Number.isFinite(x.location?.lat) &&
          Number.isFinite(x.location?.lng) &&
          Array.isArray(x.listings) &&
          x.listings.every((l: any) => typeof l.canonicalUrl === "string" && /^https?:\/\//.test(l.canonicalUrl)),
      )
    : undefined;
  const s = p.search;
  const search =
    s && Number.isFinite(s.center?.lat) && Number.isFinite(s.center?.lng) && Number.isFinite(s.radiusMiles)
      ? { ...DEFAULT_SEARCH, ...s, center: { ...s.center, label: String(s.center.label ?? "") }, filters: { ...DEFAULT_FILTERS, ...s.filters } }
      : undefined;
  return { v: 1, from: typeof p.from === "string" ? p.from.slice(0, 40) : undefined, search, properties };
}
