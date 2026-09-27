import Papa from "papaparse";
import type { Listing, Property } from "../domain/types";
import { stableId } from "../listings/collection";
import { canonicalUrl, classify, sourceForUrl } from "./sources";

/**
 * Imports listing CSVs. Built for Redfin's "Download All" export (search results → Download All),
 * and also accepts any CSV with recognizable column names (price, latitude, longitude, url, …).
 */

const ALIASES: Record<string, string[]> = {
  url: ["url", "link", "listing url"],
  price: ["price", "list price", "asking price"],
  lat: ["latitude", "lat"],
  lng: ["longitude", "lng", "lon", "long"],
  address: ["address", "street address"],
  city: ["city"],
  state: ["state or province", "state"],
  zip: ["zip or postal code", "zip", "zip code", "postal code"],
  type: ["property type", "type", "home type"],
  beds: ["beds", "bedrooms"],
  baths: ["baths", "bathrooms"],
  sqft: ["square feet", "sqft", "living area"],
  lotSqft: ["lot size"],
  acres: ["acres", "acreage", "lot acres"],
  status: ["status"],
  mlsId: ["mls#", "mls #", "mls"],
  source: ["source"],
  daysOnMarket: ["days on market"],
};

function columnFinder(headers: string[]) {
  const norm = headers.map((h) => h.trim().toLowerCase());
  const index: Record<string, string | undefined> = {};
  for (const [key, names] of Object.entries(ALIASES)) {
    // Redfin's URL header is a long sentence starting with "URL (SEE https://…".
    const i = norm.findIndex((h) => names.includes(h) || (key === "url" && h.startsWith("url ")));
    index[key] = i >= 0 ? headers[i] : undefined;
  }
  return index;
}

const num = (v: unknown): number | undefined => {
  if (v === undefined || v === null) return undefined;
  const n = Number(String(v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && String(v).trim() !== "" ? n : undefined;
};

export interface CsvImportResult {
  properties: Property[];
  skipped: number;
  missingColumns: string[];
}

export function importCsv(text: string, now: string, addedBy?: string): CsvImportResult {
  const parsed = Papa.parse<Record<string, string>>(text.replace(/^﻿/, ""), { header: true, skipEmptyLines: true });
  const col = columnFinder(parsed.meta.fields ?? []);
  const missingColumns = (["url", "price", "lat", "lng"] as const).filter((k) => !col[k]);
  if (missingColumns.length) return { properties: [], skipped: parsed.data.length, missingColumns };

  const get = (row: Record<string, string>, key: string) => (col[key] ? row[col[key]!]?.trim() : undefined);
  const properties: Property[] = [];
  let skipped = 0;

  for (const row of parsed.data) {
    const lat = num(get(row, "lat"));
    const lng = num(get(row, "lng"));
    const rawUrl = get(row, "url");
    let url: URL | undefined;
    try {
      url = rawUrl ? new URL(rawUrl) : undefined;
    } catch {
      url = undefined;
    }
    // Redfin puts an MLS disclaimer in the first data row; it has no coordinates.
    if (lat === undefined || lng === undefined || !url) {
      skipped++;
      continue;
    }
    const squareFeet = num(get(row, "sqft"));
    const bedrooms = num(get(row, "beds"));
    const lotSqft = num(get(row, "lotSqft"));
    const acres = num(get(row, "acres")) ?? (lotSqft !== undefined ? +(lotSqft / 43560).toFixed(2) : undefined);
    const rawType = get(row, "type");
    const status = get(row, "status")?.toLowerCase();
    const dom = num(get(row, "daysOnMarket"));
    const street = get(row, "address");

    const listing: Listing = {
      provider: sourceForUrl(url).id,
      providerListingId: get(row, "mlsId") || undefined,
      canonicalUrl: canonicalUrl(url.href),
      status: status === "active" ? "active" : status?.includes("pending") || status?.includes("contingent") ? "pending" : "unknown",
      price: num(get(row, "price")),
      listedAt: dom !== undefined ? new Date(Date.parse(now) - dom * 864e5).toISOString().slice(0, 10) : undefined,
      fetchedAt: now,
      rawClassification: rawType || undefined,
      attribution: get(row, "source") || undefined,
    };
    properties.push({
      id: stableId(listing.canonicalUrl),
      location: { lat, lng },
      locationPrecision: "exact",
      address: street ? [street, get(row, "city"), [get(row, "state"), get(row, "zip")].filter(Boolean).join(" ")].filter(Boolean).join(", ") : undefined,
      category: classify(rawType, { squareFeet, bedrooms }),
      acreage: acres,
      bedrooms,
      bathrooms: num(get(row, "baths")),
      squareFeet,
      listings: [listing],
      addedBy,
      addedAt: now,
    });
  }
  return { properties, skipped, missingColumns };
}
