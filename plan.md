# HomeHunter — Technical Implementation Plan

## 1. Purpose

HomeHunter is a single-page web application for discovering residential properties and vacant land for sale within a configurable geographic radius in Colorado. It combines a Google Maps-centered search experience, normalized results from multiple property-listing/search sources, county-aware geographic filtering, and a curated knowledge base describing county-level rules relevant to owning, renting, developing, or temporarily occupying land.

The initial audience is nontechnical but familiar with real-estate transactions, especially buyers, investors, and realtors. The UI should therefore use familiar real-estate terminology and hide GIS, data-provider, and regulatory-system complexity.

Colorado is the only supported state in v1, but state-specific data must be configuration/data rather than application architecture so additional states can be added later without rewriting the core product.

---

## 2. Product Goals

HomeHunter should allow a user to:

1. Enter an address, place, town, ZIP code, or map location.
2. Define a circular search radius in miles around that point.
3. Search for currently listed properties within the resulting area.
4. Filter listings by price and property characteristics, particularly vacant land versus improved property.
5. See Colorado county boundaries clearly overlaid on the map.
6. Include, exclude, or exclusively search individual counties.
7. Inspect a property and follow links to its original listing source(s).
8. Inspect a county and quickly understand relevant county-level rules concerning zoning, camping/RV occupancy, short-term rentals, long-term rentals, and related land-use restrictions.
9. See authoritative links and freshness/provenance information for regulatory summaries.
10. Receive fast responses by serving geographic and county knowledge from prebuilt/static data while querying current listings dynamically.

### Non-goals for v1

HomeHunter is not intended to:

- replace a title search, survey, zoning determination, legal opinion, or realtor/attorney due diligence;
- guarantee that a county-level rule applies to an individual parcel;
- provide nationwide coverage;
- become a full MLS/CRM platform;
- store or reproduce third-party listing content beyond what the relevant provider permits;
- depend on runtime LLM calls for ordinary user interactions;
- perform parcel-level zoning analysis in the initial release.

---

## 3. Core Product Principles

### 3.1 Map first

The map is the primary workspace. Filters and results should modify the map rather than forcing users into a separate search workflow.

### 3.2 Source-aware data

Every dynamic property result and every regulatory assertion should retain its source and freshness metadata.

### 3.3 County summaries are guidance, not parcel determinations

County rules can differ from municipal ordinances, zoning districts, subdivision covenants, HOA rules, special districts, deed restrictions, and parcel-specific approvals. The data model and UI must preserve this distinction.

### 3.4 Provider independence

The frontend must never know how Zillow, Redfin, Google/search services, MLS feeds, or future providers are queried. All listing sources implement a common backend provider interface.

Do not architect HomeHunter around unsupported browser scraping of listing sites. Provider adapters should use permitted APIs, licensed feeds, compliant search/data services, or other explicitly approved acquisition methods. Provider terms and data-display restrictions must be reviewed before production integration.

### 3.5 Static-first regulatory content

Regulatory research is produced offline, reviewed, versioned, and deployed as structured data. Runtime requests should normally read precomputed records rather than invoke an LLM.

### 3.6 Colorado is data, not architecture

Use generic domain concepts such as `State`, `AdministrativeArea`, `Jurisdiction`, `Listing`, and `RegulationSummary`. Do not create core abstractions such as `ColoradoCounty` that make future expansion expensive.

---

## 4. Recommended System Architecture

```text
┌──────────────────────────────────────────────────────────┐
│                    HomeHunter SPA                        │
│  Google Maps + filters + county controls + result cards │
└───────────────────────┬──────────────────────────────────┘
                        │ HTTPS / JSON
                        ▼
┌──────────────────────────────────────────────────────────┐
│                     HomeHunter API                       │
│                                                          │
│ Search orchestration │ Geo filtering │ County knowledge │
│ Deduplication        │ Cache         │ Provider routing  │
└─────────────┬──────────────────┬─────────────────────────┘
              │                  │
              ▼                  ▼
       Listing Providers    Static / DB Data
       ┌───────────────┐    ┌──────────────────────┐
       │ Provider A    │    │ County profiles      │
       │ Provider B    │    │ County geometry      │
       │ Search source │    │ Regulation summaries│
       │ Future MLS    │    │ Source metadata      │
       └───────────────┘    └──────────────────────┘
                                   ▲
                                   │ generated offline
                          ┌────────┴─────────┐
                          │ Python pipelines │
                          │ + optional LLMs  │
                          │ + human review   │
                          └──────────────────┘
```

A practical initial stack is TypeScript across the web/API layers and Python for offline data pipelines. The exact framework may be selected by the implementation team, but the architectural boundaries in this document should remain stable.

---

## 5. Frontend SPA

### 5.1 Primary layout

Desktop should use a two-pane layout:

- large interactive map;
- collapsible search/results panel;
- filter controls above or within the results panel;
- detail drawer/card for a selected property or county.

On smaller screens, the map remains primary while results/details become a bottom sheet or drawer.

### 5.2 Search origin

Allow users to establish the center point using:

- address/place autocomplete;
- city/town/ZIP search;
- clicking the map;
- dragging an existing search-center marker.

Persist normalized latitude/longitude and the human-readable label separately.

### 5.3 Radius control

Support a configurable radius expressed in miles. The UI should show the radius visually as a circle and display its current value prominently.

Recommended initial presets:

`5, 10, 25, 50, 75, 100 miles`

Also allow a custom value within a server-configured maximum.

Changing the center or radius should not immediately generate excessive third-party requests. Debounce map interactions and require either an explicit Search/Update Results action or an intentional auto-search policy with strong caching.

### 5.4 Property filters

Minimum v1 filters:

- minimum price;
- maximum price;
- property category: All / Vacant Land / Improved Property;
- minimum acreage;
- maximum acreage;
- listing source;
- listing age when supported;
- bedrooms/bathrooms for improved properties where available.

Potential later filters:

- utilities;
- road access;
- HOA;
- water/sewer/well information;
- manufactured-home allowance;
- zoning classification;
- parcel size;
- elevation;
- flood/fire risk.

Unknown provider values must remain `unknown`; do not infer missing facts.

### 5.5 Map layers

The map should support these conceptual layers:

1. Google base map.
2. Search-radius circle.
3. Colorado county boundaries.
4. Property markers/clusters.
5. Selected county/property emphasis.
6. Future optional parcel/zoning/risk layers.

County borders must remain legible without overwhelming roads and property markers.

### 5.6 County interaction

Clicking a county opens its detail panel and exposes three search states:

- **Neutral** — normal radius rules apply.
- **Included/Only** — constrain results to the selected county or selected included counties.
- **Excluded** — remove the county from results even where it intersects the radius.

The UI must make these states visually distinct and easy to clear.

Recommended query semantics:

```text
effective_area = radius_geometry

if included_counties is not empty:
    effective_area = effective_area ∩ union(included_counties)

effective_area = effective_area - union(excluded_counties)
```

If an explicitly included county does not intersect the radius, return no listings from that county unless a future product mode explicitly permits county-only searches outside the radius.

### 5.7 Property interaction

A property marker/card should show a concise preview:

- price;
- address or approximate location according to provider permissions;
- land/improved classification;
- acreage when available;
- beds/baths for improved properties;
- source badges;
- listing freshness;
- thumbnail if permitted.

Selecting the property opens a larger detail card with normalized information and links to every known original listing.

Never imply that HomeHunter is the listing authority. Clearly identify original providers.

### 5.8 County detail panel

Display:

- county name;
- permanent synopsis;
- official county/planning links;
- zoning/land-use summary;
- camping/tent occupancy summary;
- RV/trailer occupancy summary;
- short-term rental summary;
- long-term rental summary where meaningful;
- dwelling/building considerations;
- important caveats;
- date last reviewed;
- links/citations to relevant authoritative sources.

Use plain language first, with source/legal detail available immediately below it.

---

## 6. Domain Model

### 6.1 State

```ts
interface State {
  code: string;       // "CO"
  name: string;       // "Colorado"
  fips: string;
  bounds: GeoBounds;
  datasetVersion: string;
}
```

### 6.2 Administrative area / county

```ts
interface AdministrativeArea {
  id: string;
  type: "county" | "municipality" | "other";
  stateCode: string;
  fips?: string;
  name: string;
  geometryId: string;
  centroid: LatLng;
  bounds: GeoBounds;
}
```

For Colorado counties, FIPS should be the stable external identifier. Do not use display names as primary keys.

### 6.3 Property

A property represents the underlying real-world asset rather than an individual website listing.

```ts
interface Property {
  id: string;
  location: LatLng;
  address?: NormalizedAddress;
  parcelId?: string;
  countyFips?: string;
  category: "vacant_land" | "improved" | "unknown";
  acreage?: number;
  bedrooms?: number;
  bathrooms?: number;
  structureType?: string;
  listings: Listing[];
}
```

### 6.4 Listing

```ts
interface Listing {
  provider: string;
  providerListingId: string;
  canonicalUrl: string;
  status: "active" | "pending" | "unknown";
  price?: number;
  firstSeenAt?: string;
  listedAt?: string;
  fetchedAt: string;
  title?: string;
  thumbnailUrl?: string;
  rawClassification?: string;
  attribution?: string;
}
```

### 6.5 County profile

```ts
interface CountyProfile {
  areaId: string;
  synopsis: string;
  countySeat?: string;
  officialWebsite?: string;
  planningWebsite?: string;
  updatedAt: string;
}
```

### 6.6 Regulation summary

```ts
interface RegulationSummary {
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
  sources: RegulatorySource[];
}
```

```ts
interface RegulationTopic {
  summary: string;
  confidence: "high" | "medium" | "low";
  sourceIds: string[];
  requiresParcelVerification: boolean;
}
```

### 6.7 Regulatory source

```ts
interface RegulatorySource {
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
```

---

## 7. Listing Provider Architecture

All external listing sources implement a common interface.

```ts
interface ListingProvider {
  id: string;

  search(request: ProviderSearchRequest): Promise<ProviderSearchResult>;

  capabilities(): ProviderCapabilities;
}
```

Provider capabilities should declare support for fields/features such as:

- geographic circle/bounding box/polygon queries;
- vacant-land filtering;
- price filters;
- acreage filters;
- pagination;
- listing dates;
- images;
- exact coordinates;
- attribution requirements.

The orchestration layer converts a HomeHunter query into provider-specific requests, then normalizes the responses.

### 7.1 Provider compliance

Before implementing a production adapter, document:

- authorized access method;
- terms governing caching;
- display/attribution requirements;
- rate limits;
- permitted fields;
- image permissions;
- deep-link requirements;
- retention limits.

Do not make Zillow or Redfin HTML scraping a foundational dependency. If direct access is unavailable, the adapter can remain disabled while compliant alternatives are integrated.

### 7.2 Search-provider fallback

General web/search results may help discover publicly indexed property pages, but they should be modeled separately from structured listing feeds because their completeness, freshness, and field quality differ.

Each result should communicate source quality rather than silently treating all providers as equivalent.

---

## 8. Search Pipeline

A user search should execute approximately as follows:

```text
1. Validate filters and radius.
2. Resolve search center to lat/lng.
3. Construct radius geometry.
4. Apply included/excluded county geometry.
5. Calculate provider-friendly bounding geometry.
6. Query enabled listing providers concurrently.
7. Normalize provider results.
8. Reject clearly out-of-area results.
9. Classify property type.
10. Apply normalized filters.
11. Deduplicate listings into properties.
12. Rank/sort results.
13. Cache suitable intermediate/final results.
14. Return properties + provider diagnostics + freshness metadata.
```

### 8.1 Spatial filtering

Use authoritative server-side spatial filtering rather than relying solely on provider radius behavior.

For a listing coordinate `P`:

```text
insideRadius(P, center, radius)
AND
(includedCounties empty OR P ∈ includedCountyUnion)
AND
P ∉ excludedCountyUnion
```

A spatial database such as PostgreSQL/PostGIS is appropriate if the project progresses beyond a static prototype. A smaller v1 can use robust geospatial libraries against prebuilt GeoJSON, but APIs should be designed so storage can migrate to PostGIS without changing the client contract.

### 8.2 Bounding-box optimization

Providers that cannot accept a circle may receive its bounding box. HomeHunter must subsequently calculate true point-to-center distance and discard corner results outside the circle.

### 8.3 Deduplication

The same property can appear on multiple providers.

Deduplication should use a confidence-scored strategy based on available data:

1. parcel/APN identifier when reliable;
2. normalized street address;
3. exact/near-exact coordinates;
4. acreage + location + address components;
5. provider-specific identifiers only within the same provider.

Never merge uncertain records aggressively. False duplicates are worse than showing two listings.

Store a deduplication reason/confidence for debugging.

### 8.4 Vacant-land classification

Normalize provider-specific types into:

- `vacant_land`;
- `improved`;
- `unknown`.

Classification should prioritize explicit provider metadata. Heuristics may be used as fallback but should be testable and should not silently convert ambiguous listings into land.

---

## 9. API Design

Suggested API namespace:

```text
/api/v1/
```

### Search

```text
POST /api/v1/search
```

Example request:

```json
{
  "center": { "lat": 39.7392, "lng": -104.9903 },
  "radiusMiles": 50,
  "filters": {
    "priceMin": 50000,
    "priceMax": 500000,
    "propertyCategory": "vacant_land",
    "acreageMin": 2
  },
  "includedAreas": [],
  "excludedAreas": ["08059"]
}
```

Response should contain:

- normalized properties;
- total/partial result metadata;
- provider status/errors;
- search geometry metadata;
- cache/freshness information.

A single provider failure should normally produce a partial result rather than failing the entire search.

### Geography

```text
GET /api/v1/states
GET /api/v1/states/CO
GET /api/v1/states/CO/areas?type=county
GET /api/v1/areas/:id
GET /api/v1/areas/:id/profile
GET /api/v1/areas/:id/regulations
```

Geometry itself may be served as versioned static assets/CDN resources rather than repeated through the application API.

### Diagnostics/admin

Internal-only endpoints can expose provider health, dataset versions, and regulatory freshness. They should not be publicly writable.

---

## 10. Colorado Geographic Data

### Required v1 data

- Colorado state boundary;
- all 64 county boundaries;
- county FIPS identifiers;
- county names;
- centroids;
- bounding boxes;
- simplified browser geometry;
- higher-resolution server geometry where necessary.

Prefer authoritative government geographic datasets and record source/version metadata during ingestion.

### Geometry build pipeline

```text
raw authoritative geometry
        ↓
validate CRS / geometry
        ↓
repair invalid polygons if necessary
        ↓
normalize IDs
        ↓
produce server representation
        ↓
simplify for web visualization
        ↓
GeoJSON or TopoJSON build artifact
        ↓
version + checksum
```

Never simplify server-side filtering geometry so aggressively that county-edge classification becomes unreliable.

---

## 11. County Knowledge Base

County data has two different lifecycles and should be separated accordingly.

### 11.1 Permanent/static profile

Changes rarely:

- county name;
- county seat;
- short geographic/community synopsis;
- official website;
- planning department link;
- basic contextual information.

This can be committed as version-controlled structured content.

### 11.2 Semi-dynamic regulatory knowledge

Changes periodically:

- land-use/zoning code summary;
- temporary camping rules;
- RV/trailer occupancy;
- short-term rental rules;
- rental/licensing considerations;
- dwelling requirements;
- links to current ordinances/codes;
- known municipal-versus-unincorporated caveats.

These records are rebuilt by an offline pipeline and reviewed before publication.

### 11.3 Jurisdiction caveat

County summaries must explicitly state their jurisdictional scope. Many county land-use codes primarily govern unincorporated county territory while incorporated municipalities maintain separate rules.

The UI should include language such as:

> County-level summary. Rules for a specific parcel may differ based on municipality, zoning district, subdivision covenants, HOA rules, deed restrictions, permits, or other authorities. Verify the parcel with the applicable planning department before relying on this summary.

This disclaimer does not replace accurate source attribution.

---

## 12. Offline Regulatory Research Pipeline

The regulatory pipeline lives outside the runtime application.

### 12.1 Pipeline stages

```text
County registry
      ↓
Source discovery
      ↓
Fetch authoritative pages/documents
      ↓
Store raw source + metadata + hash
      ↓
Extract/normalize text
      ↓
Detect changed documents
      ↓
Structured LLM extraction/summarization
      ↓
Schema validation
      ↓
Citation validation
      ↓
Automated quality checks
      ↓
Human review/override
      ↓
Approved JSON artifact
      ↓
Application deployment
```

### 12.2 Source priority

Prefer sources in approximately this order:

1. official county code/ordinance repository;
2. official county planning/development department;
3. official county commissioners/clerk records;
4. official municipal material when needed for caveats;
5. state government material;
6. secondary sources only for discovery/context, never as the sole authority for a regulatory conclusion when primary material is available.

### 12.3 LLM role

LLMs may:

- identify relevant passages;
- classify rules by topic;
- summarize dense ordinance language;
- identify ambiguity/conflicts;
- produce structured output.

LLMs must not be allowed to invent citations or convert silence in a code into permission.

Require structured output against a schema and provide the model only the retrieved source corpus for factual regulatory claims.

### 12.4 Example pipeline output

```json
{
  "areaId": "08031",
  "reviewedAt": "2026-09-15",
  "status": "reviewed",
  "camping": {
    "summary": "...",
    "confidence": "medium",
    "sourceIds": ["source-123", "source-124"],
    "requiresParcelVerification": true
  },
  "caveats": [
    "Municipal rules may supersede county rules within incorporated areas."
  ]
}
```

### 12.5 Change detection

Store for each source:

- URL;
- retrieval timestamp;
- HTTP metadata when available;
- content/document hash;
- extracted-text hash;
- last successful parse version.

On subsequent runs, unchanged sources can skip expensive LLM processing.

Changed sources should mark affected county topics as `needs_review` until rebuilt/approved.

### 12.6 Human overrides

Human-reviewed content must survive regeneration.

Use explicit fields such as:

```text
generated_summary
reviewed_summary
active_summary
review_notes
reviewed_by
reviewed_at
```

Do not overwrite a reviewed summary automatically simply because a pipeline reruns.

---

## 13. Caching and Freshness

Different data requires different policies.

### Static geography

Cache effectively indefinitely using versioned filenames/content hashes.

### County profiles

Cache aggressively; invalidate only when a new dataset version deploys.

### Regulation summaries

Cache aggressively because they are deployment artifacts. Always expose `reviewedAt`/`effectiveAsOf` metadata.

### Listing searches

Use short-lived caching keyed by normalized search geometry and filters. Exact TTL depends on provider terms and expected listing volatility.

Do not retain third-party data longer than provider agreements permit.

### Provider requests

Use request coalescing so simultaneous equivalent searches do not generate duplicate upstream calls.

---

## 14. Search Result Ranking

Do not hide results using opaque AI ranking in v1.

Support deterministic sorting such as:

- price low/high;
- acreage high/low;
- newest;
- distance from search center;
- price per acre when calculable.

If a future relevance score is introduced, expose the factors used.

---

## 15. Error and Partial-Failure Behavior

HomeHunter must remain useful when individual dependencies fail.

Examples:

### Listing provider unavailable

Return other provider results and mark the failed source as temporarily unavailable.

### County regulation record missing

Show the county profile plus official planning links and state that a reviewed regulatory summary is not currently available.

### Geocoder failure

Retain map interaction and allow manual center placement.

### Unknown property classification

Display the listing as unknown when All is selected; do not include it in a strict Vacant Land search unless product requirements explicitly permit uncertain matches.

### Stale regulatory record

Display its review date and stale status. Never silently present stale content as current.

---

## 16. Security and Privacy

### API keys

- Restrict Google Maps browser keys by domain and permitted APIs.
- Keep server/provider credentials exclusively server-side.
- Never commit secrets.
- Use environment/secret management in deployment.

### API protection

- rate-limit search endpoints;
- validate all filter/radius inputs;
- cap maximum radius/result counts;
- enforce provider-specific quotas;
- sanitize externally sourced text before rendering;
- apply SSRF protections to any internal fetch tooling.

### User data

A basic v1 does not require accounts. Avoid collecting user information until a feature needs it.

If saved searches/accounts are introduced later, treat search locations as user data and document retention/deletion behavior.

---

## 17. Accessibility and UX Requirements

The map cannot be the only way to use search results.

Required:

- keyboard-accessible filters;
- accessible result list mirroring map markers;
- screen-reader labels for county controls and listings;
- sufficient contrast for county states;
- status not communicated by color alone;
- logical focus behavior when opening/closing detail drawers;
- readable currency/acreage formatting;
- mobile touch targets;
- loading states that identify what is being updated.

Prefer realtor/buyer vocabulary such as **Search area**, **Vacant land**, **County**, **Exclude county**, and **Listings**, rather than terms such as polygon intersection or geometry mask.

---

## 18. Observability

Collect structured metrics/logs for:

- search latency;
- searches per provider;
- provider success/error/rate-limit rates;
- normalized result count;
- deduplication count;
- cache hit rate;
- geocoder failures;
- regulatory dataset version;
- regulatory records by freshness/status;
- frontend errors.

Assign every search a correlation/request ID that propagates through provider calls.

Do not log provider credentials or unnecessary user-entered location details.

---

## 19. Testing Strategy

### Unit tests

Focus heavily on:

- radius calculations;
- county include/exclude logic;
- coordinate containment;
- provider normalization;
- land/improved classification;
- price/acreage filtering;
- deduplication;
- regulatory schema validation;
- freshness calculations.

### Geometry fixture tests

Create known Colorado test points:

- clearly inside selected counties;
- close to county borders;
- outside Colorado;
- inside radius but excluded county;
- inside included county but outside radius;
- near polygon holes/complex edges where applicable.

### Provider contract tests

Each adapter must pass the same contract suite independent of its upstream API.

Mock external providers in CI. Live integration tests should run separately and respect quotas.

### Regulatory pipeline tests

Validate:

- every summary source ID exists;
- every URL is syntactically valid;
- required topics are present;
- no generated summary is published as reviewed without review metadata;
- changed source hashes trigger the expected state;
- human overrides are preserved.

### End-to-end tests

Critical flows:

1. Search location → radius → results.
2. Select Vacant Land → improved properties disappear.
3. Exclude county → its results disappear.
4. Include only county → results are constrained correctly.
5. Click property → source link/details visible.
6. Click county → synopsis/regulatory summary/sources visible.
7. One provider fails → partial results still render.

---

## 20. Repository Structure

```text
homehunter/
├── apps/
│   ├── web/
│   │   ├── src/
│   │   │   ├── map/
│   │   │   ├── search/
│   │   │   ├── listings/
│   │   │   ├── counties/
│   │   │   └── shared/
│   │   └── tests/
│   │
│   └── api/
│       ├── src/
│       │   ├── routes/
│       │   ├── search/
│       │   ├── providers/
│       │   ├── geo/
│       │   └── knowledge/
│       └── tests/
│
├── packages/
│   ├── domain/
│   ├── geo/
│   ├── listing-providers/
│   ├── schemas/
│   └── ui/
│
├── data/
│   └── states/
│       └── CO/
│           ├── state.json
│           ├── counties/
│           ├── geometry/
│           ├── regulations/
│           └── sources/
│
├── pipelines/
│   ├── geography/
│   ├── regulations/
│   └── validation/
│
├── schemas/
│   ├── property.schema.json
│   ├── listing.schema.json
│   ├── county.schema.json
│   └── regulations.schema.json
│
├── docs/
│   ├── architecture/
│   ├── providers/
│   ├── data-sources/
│   └── ADR/
│
└── tests/
    ├── fixtures/
    └── e2e/
```

---

## 21. Configuration

Keep state/provider behavior declarative where possible.

Example:

```yaml
states:
  CO:
    enabled: true
    county_dataset: "co-counties-v1"
    regulations_dataset: "co-regulations-2026-09"

providers:
  provider_a:
    enabled: true
    cache_ttl_seconds: 300
  provider_b:
    enabled: false

search:
  max_radius_miles: 150
  max_results: 1000
```

Adding another state should primarily require geography, administrative-area metadata, regulatory content, and configuration—not changes to search orchestration.

---

## 22. Suggested Agent Workstreams

The project is well suited to parallel implementation after interfaces/schemas are frozen.

### Agent A — SPA / Map

Owns:

- application shell;
- Google Maps integration;
- center/radius controls;
- county rendering;
- county state interactions;
- markers/clustering;
- filters;
- property/county detail UI;
- responsive/accessibility behavior.

Consumes mocked API contracts initially.

### Agent B — Geography

Owns:

- Colorado authoritative geographic source selection;
- county ingestion;
- FIPS normalization;
- geometry validation;
- web simplification;
- spatial utilities;
- boundary fixtures/tests.

Produces stable geometry artifacts and library contracts.

### Agent C — Listing Providers

Owns:

- provider interface;
- provider compliance notes;
- adapters;
- normalization;
- provider capability declarations;
- caching/rate limiting;
- provider contract tests.

Begin with one real/compliant provider plus fixture/mock adapters rather than blocking the entire application on every desired source.

### Agent D — Regulatory Pipeline

Owns:

- county registry;
- source manifest;
- document retrieval;
- content hashing/change detection;
- extraction;
- LLM structured summarization;
- validation;
- review/override mechanism;
- final county regulation artifacts.

### Agent E — API / Domain Integration

Owns:

- canonical domain models;
- search endpoint;
- query validation;
- search orchestration;
- geospatial post-filtering;
- deduplication;
- county/profile endpoints;
- observability;
- partial-failure behavior.

### Integration rule

Agents should not invent incompatible local schemas. `packages/domain`, JSON schemas, API OpenAPI definitions, and provider contracts are shared interfaces and should be established early.

---

## 23. Implementation Milestones

### Milestone 0 — Architecture contracts

Deliver:

- repository skeleton;
- ADRs for map provider, API framework, storage, and geographic representation;
- canonical domain types;
- API specification;
- provider interface;
- regulatory schemas;
- Colorado dataset source decisions.

**Exit criterion:** parallel agents can work against stable mocks/contracts.

### Milestone 1 — Map prototype

Deliver:

- Colorado map;
- location search;
- movable center;
- radius visualization;
- all county boundaries;
- county selection/exclusion states;
- mocked property markers.

**Exit criterion:** complete geographic interaction can be demonstrated without live listings.

### Milestone 2 — Search vertical slice

Deliver:

- API search endpoint;
- one compliant live listing source;
- mock secondary providers;
- price/category/acreage filters;
- server radius validation;
- county include/exclude filtering;
- property cards;
- source deep links;
- initial deduplication.

**Exit criterion:** a real Colorado location can produce current normalized results through the complete stack.

### Milestone 3 — Regulatory vertical slice

Implement 3–5 representative counties before researching all 64.

Choose counties that exercise different characteristics, e.g. urban/front-range, mountain/tourism, rural, and differing land-use practices.

Deliver:

- county profile records;
- regulatory source manifests;
- offline retrieval/summarization pipeline;
- human review mechanism;
- county tooltip/detail UI;
- citations/source links;
- freshness metadata.

**Exit criterion:** one county can be traced from authoritative source → pipeline → reviewed artifact → production UI.

### Milestone 4 — Colorado coverage

Deliver:

- all 64 county profiles;
- reviewed regulatory summaries or explicit `needs_review` status;
- pipeline quality report;
- stale/missing-data UI;
- scheduled/manual refresh process.

Do not block deployment solely to make every county look complete. Explicitly representing unknown/unreviewed information is preferable to fabricated certainty.

### Milestone 5 — Production hardening

Deliver:

- provider rate limiting;
- caching;
- monitoring;
- error tracking;
- performance optimization;
- security review;
- accessibility audit;
- E2E suite;
- provider/legal compliance review;
- backup/rebuild documentation.

### Milestone 6 — Multi-state readiness

Before adding state #2, prove that it can be added without changing core search logic.

Document the state onboarding process and identify any Colorado-specific assumptions that escaped into generic packages.

---

## 24. Initial Vertical Slice Recommendation

Do not begin by researching every county or integrating every desired listing site.

Build one narrow but real end-to-end slice:

1. Colorado state and all county outlines are visible.
2. 3–5 counties have complete knowledge records.
3. User chooses a location and 25/50-mile radius.
4. User filters to vacant land and a price range.
5. One real listing provider returns current data.
6. Mock adapters prove multiple-provider aggregation.
7. Results outside the true radius are removed.
8. User excludes a county and sees results update.
9. User clicks a property and reaches the original listing.
10. User clicks a county and sees reviewed regulatory information and authoritative sources.

Once this works, additional providers and county records are incremental work rather than architectural experiments.

---

## 25. Performance Targets

Initial engineering targets rather than contractual SLAs:

- static application shell interactive quickly on a normal broadband connection;
- county geometry cached and reused across sessions where browser caching permits;
- map interaction remains smooth with county layer enabled;
- cached searches feel near-immediate;
- uncached multi-provider searches stream or render partial results where practical rather than waiting for the slowest provider;
- property clustering prevents hundreds of markers from degrading map performance;
- county detail content opens without a runtime LLM request.

Instrument actual performance before setting hard production SLOs.

---

## 26. Data Provenance Requirements

Every data category should answer: **Where did this come from, when was it obtained, and how was it transformed?**

For listing data retain provider/fetch timestamps.

For geographic data retain dataset name, authority, version/date, processing version, and checksums.

For regulatory data retain source URL, authority, retrieval date, content hash, topic citations, generated/reviewed state, and review date.

Generated prose without traceable source metadata should fail publication validation.

---

## 27. Regulatory Content UX Rules

Avoid categorical statements where the underlying law is conditional.

Prefer:

```text
RV occupancy
May be allowed under limited circumstances. Duration, permits, sanitation,
and zoning district can affect whether an RV may be occupied on a parcel.

Reviewed: Sep 2026
Sources: [County Land Use Code] [Planning Department]
Verify for this parcel →
```

Avoid:

```text
RVs are allowed in this county.
```

The latter incorrectly converts a jurisdiction-level summary into a parcel-level determination.

---

## 28. Future Extensions

The architecture should leave room for, but not prematurely implement:

- parcel boundaries/APNs;
- parcel-specific zoning layers;
- municipal overlays;
- HOA/subdivision information;
- flood/fire/wildfire layers;
- water rights/well-permit information;
- utilities and road access;
- saved searches;
- alerts for new listings;
- favorites/collections;
- listing comparison;
- export/share links;
- realtor collaboration;
- additional states;
- natural-language search translated into deterministic filters.

A particularly valuable future capability is a parcel-level **Due Diligence** panel combining county, municipality, zoning district, parcel, and other known constraints. This should be treated as a separate product phase because it requires substantially stronger jurisdiction-resolution logic.

---

## 29. Key Risks

### Listing-provider access

Desired consumer listing sites may not provide unrestricted APIs or may limit reuse. Mitigation: isolate adapters, verify terms before implementation, support multiple provider classes, and avoid making one consumer site mandatory to core operation.

### Regulatory accuracy

Land-use rules are nuanced and change. Mitigation: authoritative sources, topic-level citations, freshness metadata, conservative summaries, human review, and explicit parcel-verification warnings.

### Jurisdiction ambiguity

County boundaries do not determine every applicable rule. Mitigation: model jurisdiction scope explicitly and never describe county summaries as parcel determinations.

### Duplicate/inconsistent listings

Different providers expose conflicting prices/statuses. Mitigation: preserve source-level listings underneath the normalized property and show provenance rather than destroying conflicts during normalization.

### GIS payload/performance

Detailed polygons and large marker sets can degrade browsers. Mitigation: geometry simplification, static caching, clustering, viewport-aware rendering, and server-side filtering.

### Scope expansion

Parcel zoning, utilities, HOAs, water rights, and risk layers can rapidly expand the project. Mitigation: keep v1 centered on radius + county + listing discovery + county-level regulatory context.

---

## 30. Definition of Done for v1

HomeHunter v1 is complete when a user can:

- open a responsive Colorado map;
- locate a place/address or manually choose a center;
- set a radius;
- filter by price and vacant-land/improved-property category;
- see current results from at least one production-approved dynamic listing source;
- see provider/source attribution;
- see all Colorado county boundaries;
- include/exclude counties from the effective search area;
- inspect properties and open original listings;
- inspect county profiles and regulatory summaries;
- follow authoritative regulatory sources;
- see regulatory freshness/review information;
- receive useful partial results when a provider fails.

Engineering must also have:

- automated tests for critical geographic/search logic;
- documented provider compliance assumptions;
- reproducible Colorado geography builds;
- reproducible regulatory-data builds;
- no runtime dependency on an LLM for standard browsing;
- monitoring for provider failures;
- documented procedure for refreshing county regulations;
- an architecture capable of adding another state without redesigning the core domain/search system.

---

## 31. First Tasks for Coding Agents

Before writing substantial feature code:

1. Create the monorepo and shared domain package.
2. Write JSON schemas/OpenAPI definitions for search, properties, counties, and regulations.
3. Select and document authoritative Colorado county geometry sources.
4. Produce the 64-county normalized registry keyed by FIPS.
5. Implement the `ListingProvider` interface with fixture/mock providers.
6. Build the map prototype against fixtures.
7. Implement and test circle + county include/exclude spatial logic.
8. Research and approve the first production listing-data integration method.
9. Select 3–5 pilot counties for the regulatory vertical slice.
10. Create the regulatory source manifest and review workflow.
11. Connect the first real provider only after its compliance/display requirements are understood.
12. Demonstrate the full vertical slice before expanding county/provider coverage.

The guiding implementation rule is: **prove the complete information path before increasing breadth**. HomeHunter should first demonstrate that it can accurately connect geography, live listings, county filtering, and sourced regulatory context. Once those contracts are stable, expanding Colorado coverage and adding additional listing providers becomes parallelizable, lower-risk work.
