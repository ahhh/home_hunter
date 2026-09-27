import { describe, expect, it } from "vitest";
import { classify, parseListingUrl, searchLinks } from "./sources";
import { importCsv } from "./csvImport";

describe("parseListingUrl", () => {
  it("reads a Zillow address and zpid", () => {
    const p = parseListingUrl("https://www.zillow.com/homedetails/123-Main-St-Salida-CO-81201/2077541234_zpid/?utm=x")!;
    expect(p.source.id).toBe("zillow");
    expect(p.address).toBe("123 Main St Salida CO 81201");
    expect(p.providerListingId).toBe("2077541234");
    expect(p.canonicalUrl).toBe("https://zillow.com/homedetails/123-Main-St-Salida-CO-81201/2077541234_zpid");
  });

  it("reads a Redfin address", () => {
    const p = parseListingUrl("https://www.redfin.com/CO/Buena-Vista/31000-County-Road-371-81211/home/123456")!;
    expect(p.source.id).toBe("redfin");
    expect(p.address).toBe("31000 County Road 371, Buena Vista, CO 81211");
  });

  it("does not invent an address for undisclosed Redfin land", () => {
    const p = parseListingUrl("https://www.redfin.com/CO/Westcliffe/Undisclosed-address-81252/home/999")!;
    expect(p.address).toBeUndefined();
    expect(p.providerListingId).toBe("999");
  });

  it("reads a Realtor.com address", () => {
    const p = parseListingUrl("https://www.realtor.com/realestateandhomes-detail/45-Elk-Ridge-Rd_Fairplay_CO_80440_M12345-67890")!;
    expect(p.source.id).toBe("realtor");
    expect(p.address).toBe("45 Elk Ridge Rd, Fairplay, CO 80440");
  });

  it("accepts unknown sites", () => {
    const p = parseListingUrl("https://example-realty.com/listing/42")!;
    expect(p.source.id).toBe("other");
    expect(p.address).toBeUndefined();
  });

  it("rejects non-URLs", () => {
    expect(parseListingUrl("not a url")).toBeUndefined();
    expect(parseListingUrl("javascript:alert(1)")).toBeUndefined();
  });
});

describe("classify", () => {
  it("uses explicit provider types", () => {
    expect(classify("Vacant Land")).toBe("vacant_land");
    expect(classify("Residential Land")).toBe("vacant_land");
    expect(classify("Single Family Residential")).toBe("improved");
    expect(classify("Mobile/Manufactured Home")).toBe("improved");
  });

  it("leaves ambiguous types unknown", () => {
    expect(classify("Ranch")).toBe("unknown");
    expect(classify("Other")).toBe("unknown");
    expect(classify(undefined)).toBe("unknown");
  });

  it("only falls back to improved, never to land", () => {
    expect(classify("Other", { squareFeet: 1200 })).toBe("improved");
    expect(classify(undefined, { squareFeet: 0 })).toBe("unknown");
  });
});

describe("searchLinks", () => {
  const q = {
    bounds: { south: 38, north: 39, west: -106.5, east: -105.5 },
    postcode: "81201",
    countyName: "Chaffee County",
    stateName: "Colorado",
    stateCode: "CO",
    priceMax: 250000,
    category: "vacant_land" as const,
  };

  it("builds a link for each site", () => {
    const links = searchLinks(q);
    expect(links.map((l) => l.sourceId)).toEqual(["zillow", "redfin", "realtor", "landwatch"]);
    expect(links[1].url).toBe("https://www.redfin.com/zipcode/81201/filter/property-type=land,max-price=250k");
    expect(links[2].url).toBe("https://www.realtor.com/realestateandhomes-search/81201/type-land/price-na-250000");
    expect(links[3].url).toBe("https://www.landwatch.com/colorado-land-for-sale/chaffee-county");
    const zillowState = JSON.parse(decodeURIComponent(links[0].url.split("searchQueryState=")[1]));
    expect(zillowState.mapBounds).toEqual(q.bounds);
    expect(zillowState.filterState.sf).toEqual({ value: false });
  });

  it("skips ZIP-based sites without a ZIP", () => {
    expect(searchLinks({ ...q, postcode: undefined }).map((l) => l.sourceId)).toEqual(["zillow", "landwatch"]);
  });
});

const REDFIN_CSV = `SALE TYPE,SOLD DATE,PROPERTY TYPE,ADDRESS,CITY,STATE OR PROVINCE,ZIP OR POSTAL CODE,PRICE,BEDS,BATHS,LOCATION,SQUARE FEET,LOT SIZE,YEAR BUILT,DAYS ON MARKET,$/SQUARE FEET,HOA/MONTH,STATUS,NEXT OPEN HOUSE START TIME,NEXT OPEN HOUSE END TIME,URL (SEE https://www.redfin.com/buy-a-home/comparative-market-analysis FOR INFO ON PRICING),SOURCE,MLS#,FAVORITE,INTERESTED,LATITUDE,LONGITUDE
In accordance with local MLS rules, some MLS listings are not included in the download,,,,,,,,,,,,,,,,,,,,,,,,,,
MLS Listing,,Vacant Land,TBD County Road 371,Buena Vista,CO,81211,"189,000",,,Buena Vista,,217800,,12,,,Active,,,https://www.redfin.com/CO/Buena-Vista/TBD-County-Road-371-81211/home/111,REcolorado,1234567,N,Y,38.85,-106.14
MLS Listing,,Single Family Residential,12 Pine Ln,Salida,CO,81201,525000,3,2,Salida,1600,21780,1998,40,328,,Active,,,https://www.redfin.com/CO/Salida/12-Pine-Ln-81201/home/222,REcolorado,7654321,N,Y,38.53,-106.0
`;

describe("importCsv", () => {
  const now = "2026-09-27T12:00:00.000Z";
  it("imports Redfin's Download All export", () => {
    const r = importCsv(REDFIN_CSV, now, "Sam");
    expect(r.missingColumns).toEqual([]);
    expect(r.skipped).toBe(1);
    expect(r.properties).toHaveLength(2);
    const [land, house] = r.properties;
    expect(land.category).toBe("vacant_land");
    expect(land.acreage).toBe(5);
    expect(land.listings[0].price).toBe(189000);
    expect(land.listings[0].provider).toBe("redfin");
    expect(land.listings[0].listedAt).toBe("2026-09-15");
    expect(land.address).toBe("TBD County Road 371, Buena Vista, CO 81211");
    expect(house.category).toBe("improved");
    expect(house.bedrooms).toBe(3);
    expect(house.location).toEqual({ lat: 38.53, lng: -106.0 });
    expect(house.addedBy).toBe("Sam");
  });

  it("reports missing required columns", () => {
    expect(importCsv("name,cost\nfoo,1\n", now).missingColumns).toEqual(["url", "price", "lat", "lng"]);
  });

  it("accepts a simple hand-made CSV", () => {
    const r = importCsv("url,price,lat,lng,acres,type\nhttps://landwatch.com/x/pid/5,50000,38.1,-105.2,35,Land\n", now);
    expect(r.properties[0].acreage).toBe(35);
    expect(r.properties[0].listings[0].provider).toBe("landwatch");
    expect(r.properties[0].category).toBe("vacant_land");
  });
});
