import type { AdministrativeArea, CountyProfile, HostingSummary, RegulationSummary, RegulatorySource } from "../domain/types";
import { AreaIndex, type AreaGeometry } from "../geo/geo";
import { TourismModel } from "../tourism/heat";

export interface StateData {
  state: { code: string; name: string; fips: string };
  geometrySource: { dataset: string; authority: string; url: string };
  builtAt: string;
  areas: AdministrativeArea[];
  areaById: Map<string, AdministrativeArea>;
  geojson: GeoJSON.FeatureCollection<GeoJSON.Polygon | GeoJSON.MultiPolygon, { fips: string; name: string }>;
  index: AreaIndex;
  profiles: Map<string, CountyProfile>;
  regulations: Map<string, RegulationSummary>;
  regulationSources: Map<string, RegulatorySource>;
  regulationsVersion: string;
  hosting: Map<string, HostingSummary>;
  hostingMeta: { checkedAt: string; nextReview: string; wikiBase: string; incentivesCheckedAt: string };
}

async function json(path: string) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Could not load ${path} (${res.status})`);
  return res.json();
}

export async function loadState(code: string): Promise<StateData> {
  const base = `${import.meta.env.BASE_URL}data/states/${code}/`;
  const [areasFile, geojson, profiles, regs, hosting] = await Promise.all([
    json(`${base}areas.json`),
    json(`${base}counties.geojson`),
    json(`${base}profiles.json`),
    json(`${base}regulations.json`),
    json(`${base}hosting.json`),
  ]);
  const areas: AdministrativeArea[] = areasFile.areas;
  return {
    state: areasFile.state,
    geometrySource: areasFile.geometry,
    builtAt: areasFile.builtAt,
    areas,
    areaById: new Map(areas.map((a) => [a.id, a])),
    geojson,
    index: new AreaIndex(geojson.features.map((f: any) => ({ id: f.properties.fips, geometry: f.geometry as AreaGeometry }))),
    profiles: new Map(profiles.profiles.map((p: CountyProfile) => [p.areaId, p])),
    regulations: new Map(regs.records.map((r: RegulationSummary) => [r.areaId, r])),
    regulationSources: new Map(regs.sources.map((s: RegulatorySource) => [s.id, s])),
    regulationsVersion: regs.datasetVersion,
    hosting: new Map(hosting.records.map((h: HostingSummary) => [h.areaId, h])),
    hostingMeta: {
      checkedAt: hosting.checkedAt,
      nextReview: hosting.nextReview,
      wikiBase: hosting.wikiBase,
      incentivesCheckedAt: hosting.incentivesCheckedAt,
    },
  };
}

const tourism = new Map<string, Promise<TourismModel>>();

/** Tourism heat data, fetched the first time a tourism overlay is turned on. */
export function loadTourism(code: string): Promise<TourismModel> {
  let p = tourism.get(code);
  if (!p) {
    p = json(`${import.meta.env.BASE_URL}data/states/${code}/tourism.json`).then((d) => new TourismModel(d));
    p.catch(() => tourism.delete(code)); // let a later toggle retry
    tourism.set(code, p);
  }
  return p;
}
