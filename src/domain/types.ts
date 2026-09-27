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
