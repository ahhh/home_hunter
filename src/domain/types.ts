// Canonical domain model. State-specific facts (Colorado) live in data files, not here.

export interface LatLng {
  lat: number;
  lng: number;
}

export interface GeoBounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface AdministrativeArea {
  id: string;
  type: "county" | "municipality" | "other";
  stateCode: string;
  fips?: string;
  name: string;
  centroid: LatLng;
  bounds: GeoBounds;
}

export interface CountyProfile {
  areaId: string;
  countySeat?: string;
  region?: string;
  synopsis?: string;
  officialWebsite?: string;
  planningWebsite?: string;
  consolidatedCityCounty?: boolean;
  updatedAt: string;
}

export type PropertyCategory = "vacant_land" | "improved" | "unknown";

/** One website's listing of a property. Values are copied by a person and stamped with when. */
export interface Listing {
  provider: string;
  providerListingId?: string;
  canonicalUrl: string;
  status: "active" | "pending" | "unknown";
  price?: number;
  listedAt?: string;
  /** When the price/details were copied from the provider. */
  fetchedAt: string;
  rawClassification?: string;
  attribution?: string;
}

export type Rating = "love" | "maybe" | "pass";

/** The real-world asset; several listings from different sites can point at it. */
export interface Property {
  id: string;
  location: LatLng;
  /** "approximate" when the pin came from an address lookup rather than provider coordinates or a hand-placed pin. */
  locationPrecision: "exact" | "approximate";
  address?: string;
  category: PropertyCategory;
  acreage?: number;
  bedrooms?: number;
  bathrooms?: number;
  squareFeet?: number;
  listings: Listing[];
  rating?: Rating;
  notes?: string;
  addedBy?: string;
  addedAt: string;
  /** Came from the seed script; removed automatically when it drops off the market unless someone rated or noted it. */
  seeded?: boolean;
}

export type CountySearchState = "include" | "exclude";

export interface SearchFilters {
  priceMin?: number;
  priceMax?: number;
  category: "all" | "vacant_land" | "improved";
  acreageMin?: number;
  acreageMax?: number;
  bedsMin?: number;
  bathsMin?: number;
  providers: string[];
  ratings: "all" | "love" | "not_passed";
}

export type SortKey = "newest" | "price_asc" | "price_desc" | "acres_desc" | "ppa_asc" | "distance";

export interface SearchCenter extends LatLng {
  label: string;
  postcode?: string;
}

export interface SearchState {
  center: SearchCenter;
  radiusMiles: number;
  limitToRadius: boolean;
  counties: Record<string, CountySearchState>;
  filters: SearchFilters;
  sort: SortKey;
}

export interface RegulationTopic {
  summary: string;
  confidence: "high" | "medium" | "low";
  sourceIds: string[];
  requiresParcelVerification: boolean;
}

export interface RegulationSummary {
  areaId: string;
  jurisdictionScope: "county_unincorporated" | "county_general" | "mixed";
  reviewedAt: string;
  effectiveAsOf?: string;
  status: "reviewed" | "generated" | "stale" | "needs_review";
  zoning: RegulationTopic;
  camping: RegulationTopic;
  rvOccupancy: RegulationTopic;
  shortTermRental: RegulationTopic;
  longTermRental: RegulationTopic;
  dwellingRequirements: RegulationTopic;
  caveats: string[];
}

/** Research signal for hosting paid campers (Hipcamp) in a county. Built from wiki/counties by pipelines/hosting. */
export type HostingSignal = "Pathway" | "Campground" | "Restrictive" | "Paused" | "Unclear";

export interface HostingSummary {
  areaId: string;
  signal: HostingSignal;
  summary: string;
  /** verified: every sourced claim was read in a primary source; partial: some were; unverified: none. */
  evidence: "verified" | "partial" | "unverified";
  noBuildingDept: boolean;
  /** Path of the county's wiki page, relative to the dataset's wikiBase. */
  wikiPath: string;
  /** Primary (government) sources, the ones actually read first. */
  sources: { title: string; url: string; section?: string; read: boolean }[];
  incentives: IncentiveSummary;
  land: LandSummary;
}

export type SubdivisionSignal = "Exemption path" | "Full subdivision" | "Restrictive" | "Unclear";
export type StrSignal = "Permit" | "Allowed" | "Limited" | "Lodging review" | "Unclear";

/** Splitting a parcel and renting a cabin short-term in a county. Built from pipelines/hosting/counties.json. */
export interface LandSummary {
  subdivisionSignal: SubdivisionSignal;
  strSignal: StrSignal;
  /** Empty until the county has been researched. */
  summary: string;
}

/** Location-based tax-credit programs in a county. Built from pipelines/incentives by pipelines/hosting. */
export interface IncentiveSummary {
  summary: string;
  /** Enterprise zone name(s) on the 2026-2036 map, or null when the county has none. */
  enterpriseZone: string | null;
  /** Share of the county's land inside an enterprise zone, 0-100. */
  enterpriseZonePct: number;
  /** "whole county", a description of the part that qualifies, or null. */
  enhancedRural: string | null;
  ruralJumpStart: "zone" | "eligible, not joined" | null;
  /** Opportunity zone tracts on the 2018 map, open through 2028. */
  oz1Tracts: number;
  /** Tracts nominated for the 2027 opportunity zone map. */
  oz2Tracts: { geoid: string; where: string; rural: boolean }[];
}

export interface RegulatorySource {
  id: string;
  title: string;
  authority: string;
  url: string;
  documentType: string;
  retrievedAt: string;
  effectiveDate?: string;
  contentHash?: string;
  appliesTo: string[];
}
