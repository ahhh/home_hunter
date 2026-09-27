import type { GeoBounds, PropertyCategory } from "../domain/types";

/**
 * Listing websites. The app never fetches these sites: people copy a price and location
 * from them, and the app keeps a link back so the site stays the authority on details.
 */
export interface SourceSite {
  id: string;
  label: string;
  hosts: string[];
  /** Pull what we can out of a listing URL. The address is used to place the pin. */
  parseListingUrl?(url: URL): { address?: string; providerListingId?: string };
}

const words = (slug: string) => decodeURIComponent(slug).replace(/-/g, " ").replace(/\s+/g, " ").trim();
const isUndisclosed = (s: string) => /undisclosed|^address not/i.test(s);

export const SOURCES: SourceSite[] = [
  {
    id: "zillow",
    label: "Zillow",
    hosts: ["zillow.com"],
    // /homedetails/123-Main-St-Salida-CO-81201/2077541234_zpid/
    parseListingUrl(url) {
      const m = url.pathname.match(/\/homedetails\/([^/]+)\/(\d+)_zpid/);
      if (!m) return {};
      const address = words(m[1]);
      return { address: isUndisclosed(address) ? undefined : address, providerListingId: m[2] };
    },
  },
  {
    id: "redfin",
    label: "Redfin",
    hosts: ["redfin.com"],
    // /CO/Salida/123-Main-St-81201/home/12345678
    parseListingUrl(url) {
      const m = url.pathname.match(/^\/([A-Z]{2})\/([^/]+)\/([^/]+?)(?:-(\d{5}))?\/(?:unit-[^/]+\/)?home\/(\d+)/);
      if (!m) return {};
      const [, state, city, street, zip, id] = m;
      if (isUndisclosed(words(street))) return { providerListingId: id };
      return { address: `${words(street)}, ${words(city)}, ${state}${zip ? ` ${zip}` : ""}`, providerListingId: id };
    },
  },
  {
    id: "realtor",
    label: "Realtor.com",
    hosts: ["realtor.com"],
    // /realestateandhomes-detail/123-Main-St_Salida_CO_81201_M12345-67890
    parseListingUrl(url) {
      const m = url.pathname.match(/\/realestateandhomes-detail\/([^/]+)/);
      if (!m) return {};
      const parts = m[1].split("_");
      const id = parts.find((p) => /^M\d/.test(p));
      const addrParts = parts.filter((p) => p !== id).map(words);
      if (addrParts.length < 3 || isUndisclosed(addrParts[0])) return { providerListingId: id };
      const [street, city, state, zip] = addrParts;
      return { address: `${street}, ${city}, ${state}${zip ? ` ${zip}` : ""}`, providerListingId: id };
    },
  },
  {
    id: "landwatch",
    label: "LandWatch",
    hosts: ["landwatch.com"],
    parseListingUrl(url) {
      const m = url.pathname.match(/\/pid\/(\d+)/);
      return m ? { providerListingId: m[1] } : {};
    },
  },
  { id: "rentcast", label: "MLS (via RentCast)", hosts: [] },
  { id: "landsofamerica", label: "Lands of America", hosts: ["landsofamerica.com"] },
  { id: "homes", label: "Homes.com", hosts: ["homes.com"] },
  { id: "craigslist", label: "Craigslist", hosts: ["craigslist.org"] },
  { id: "facebook", label: "Facebook", hosts: ["facebook.com"] },
];

export const OTHER_SOURCE: SourceSite = { id: "other", label: "Other site", hosts: [] };

export function sourceById(id: string): SourceSite {
  return SOURCES.find((s) => s.id === id) ?? { ...OTHER_SOURCE, id, label: id };
}

export function sourceForUrl(url: URL): SourceSite {
  const host = url.hostname.replace(/^www\./, "").toLowerCase();
  return SOURCES.find((s) => s.hosts.some((h) => host === h || host.endsWith(`.${h}`))) ?? OTHER_SOURCE;
}

/** Normalize a listing URL so the same listing pasted twice is recognized. */
export function canonicalUrl(raw: string): string {
  const url = new URL(raw.trim());
  const host = url.hostname.replace(/^www\./, "").toLowerCase();
  const path = url.pathname.replace(/\/+$/, "");
  return `https://${host}${path}`;
}

export interface ParsedListingUrl {
  canonicalUrl: string;
  source: SourceSite;
  address?: string;
  providerListingId?: string;
}

export function parseListingUrl(raw: string): ParsedListingUrl | undefined {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (!/^https?:$/.test(url.protocol)) return undefined;
  const source = sourceForUrl(url);
  return { canonicalUrl: canonicalUrl(raw), source, ...(source.parseListingUrl?.(url) ?? {}) };
}

// ---------- "Search this area on …" links ----------

export interface AreaQuery {
  bounds: GeoBounds;
  postcode?: string;
  countyName?: string; // "Chaffee County"
  stateName: string; // "Colorado"
  stateCode: string; // "CO"
  priceMin?: number;
  priceMax?: number;
  category: PropertyCategory | "all";
}

export interface SearchLink {
  sourceId: string;
  label: string;
  scope: string;
  url: string;
}

const shortPrice = (n: number) => (n >= 1e6 ? `${+(n / 1e6).toFixed(2)}M` : `${Math.round(n / 1000)}k`);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export function searchLinks(q: AreaQuery): SearchLink[] {
  const links: SearchLink[] = [];

  const filterState: Record<string, unknown> = { sort: { value: "days" } };
  if (q.priceMin || q.priceMax) filterState.price = { min: q.priceMin ?? null, max: q.priceMax ?? null };
  if (q.category === "vacant_land")
    for (const k of ["sf", "tow", "mf", "con", "apa", "manu", "apco"]) filterState[k] = { value: false };
  if (q.category === "improved") filterState.land = { value: false };
  const zillowState = { isMapVisible: true, isListVisible: true, mapBounds: q.bounds, filterState };
  links.push({
    sourceId: "zillow",
    label: "Zillow",
    scope: "whole search area",
    url: `https://www.zillow.com/homes/for_sale/?searchQueryState=${encodeURIComponent(JSON.stringify(zillowState))}`,
  });

  if (q.postcode) {
    const rf: string[] = [];
    if (q.category === "vacant_land") rf.push("property-type=land");
    if (q.category === "improved") rf.push("property-type=house+condo+townhouse+multifamily+manufactured");
    if (q.priceMin) rf.push(`min-price=${shortPrice(q.priceMin)}`);
    if (q.priceMax) rf.push(`max-price=${shortPrice(q.priceMax)}`);
    links.push({
      sourceId: "redfin",
      label: "Redfin",
      scope: `ZIP ${q.postcode}`,
      url: `https://www.redfin.com/zipcode/${q.postcode}${rf.length ? `/filter/${rf.join(",")}` : ""}`,
    });

    const rt: string[] = [q.postcode];
    if (q.category === "vacant_land") rt.push("type-land");
    if (q.priceMin || q.priceMax) rt.push(`price-${q.priceMin ?? "na"}-${q.priceMax ?? "na"}`);
    links.push({
      sourceId: "realtor",
      label: "Realtor.com",
      scope: `ZIP ${q.postcode}`,
      url: `https://www.realtor.com/realestateandhomes-search/${rt.join("/")}`,
    });
  }

  if (q.countyName) {
    links.push({
      sourceId: "landwatch",
      label: "LandWatch",
      scope: q.countyName,
      url: `https://www.landwatch.com/${slug(q.stateName)}-land-for-sale/${slug(q.countyName)}`,
    });
  }
  return links;
}

// ---------- property-type classification ----------

const LAND = /\b(vacant land|land|lots?(\/land)?|farm ?\/ ?ranch land|acreage)\b/i;
const IMPROVED =
  /\b(single family|residential|condo|co-op|townhouse|townhome|multi-family|duplex|triplex|mobile|manufactured|cabin|house)\b/i;

/**
 * Map a provider's own property-type string to our category. Explicit labels win;
 * the only fallback is "has living area/bedrooms → improved". Nothing is guessed into land.
 */
export function classify(raw: string | undefined, hints: { squareFeet?: number; bedrooms?: number } = {}): PropertyCategory {
  if (raw) {
    if (LAND.test(raw)) return "vacant_land";
    if (IMPROVED.test(raw)) return "improved";
  }
  if ((hints.squareFeet ?? 0) > 0 || (hints.bedrooms ?? 0) > 0) return "improved";
  return "unknown";
}

/** Provider id to store on a listing: the known site's id, or the hostname for other sites. */
export function providerIdFor(parsed: ParsedListingUrl): string {
  return parsed.source.id === "other" ? new URL(parsed.canonicalUrl).hostname : parsed.source.id;
}

/** Button text for a listing link, named after the site the link actually opens. */
export function linkLabel(canonicalUrl: string): string {
  const url = new URL(canonicalUrl);
  if (/(^|\.)google\./.test(url.hostname)) return "Search for this listing";
  const site = sourceForUrl(url);
  return `Open on ${site.id === "other" ? url.hostname.replace(/^www\./, "") : site.label}`;
}
