import type { CountySearchState, GeoBounds, LatLng } from "../domain/types";

const EARTH_RADIUS_MILES = 3958.7613;
const rad = (d: number) => (d * Math.PI) / 180;

export function distanceMiles(a: LatLng, b: LatLng): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Bounding box that fully contains the circle; used for provider search links. */
export function circleBounds(center: LatLng, radiusMiles: number): GeoBounds {
  const dLat = radiusMiles / 69.0;
  const dLng = radiusMiles / (69.172 * Math.cos(rad(center.lat)));
  return { south: center.lat - dLat, north: center.lat + dLat, west: center.lng - dLng, east: center.lng + dLng };
}

type Ring = number[][]; // [lng, lat][]
type PolygonCoords = Ring[];

export interface AreaGeometry {
  type: "Polygon" | "MultiPolygon";
  coordinates: PolygonCoords | PolygonCoords[];
}

function inRing(p: LatLng, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p.lat !== yj > p.lat && p.lng < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inPolygon(p: LatLng, poly: PolygonCoords): boolean {
  if (!inRing(p, poly[0])) return false;
  for (let h = 1; h < poly.length; h++) if (inRing(p, poly[h])) return false;
  return true;
}

export function pointInGeometry(p: LatLng, g: AreaGeometry): boolean {
  if (g.type === "Polygon") return inPolygon(p, g.coordinates as PolygonCoords);
  return (g.coordinates as PolygonCoords[]).some((poly) => inPolygon(p, poly));
}

function boundsOf(g: AreaGeometry): GeoBounds {
  const b = { south: Infinity, west: Infinity, north: -Infinity, east: -Infinity };
  const polys = g.type === "Polygon" ? [g.coordinates as PolygonCoords] : (g.coordinates as PolygonCoords[]);
  for (const poly of polys)
    for (const [lng, lat] of poly[0]) {
      b.south = Math.min(b.south, lat);
      b.north = Math.max(b.north, lat);
      b.west = Math.min(b.west, lng);
      b.east = Math.max(b.east, lng);
    }
  return b;
}

/** Resolves which area (county) contains a point. Returns undefined outside every area. */
export class AreaIndex {
  private entries: { id: string; geometry: AreaGeometry; bounds: GeoBounds }[];

  constructor(areas: { id: string; geometry: AreaGeometry }[]) {
    this.entries = areas.map((a) => ({ ...a, bounds: boundsOf(a.geometry) }));
  }

  locate(p: LatLng): string | undefined {
    for (const e of this.entries) {
      const b = e.bounds;
      if (p.lat < b.south || p.lat > b.north || p.lng < b.west || p.lng > b.east) continue;
      if (pointInGeometry(p, e.geometry)) return e.id;
    }
    return undefined;
  }
}

export interface EffectiveArea {
  center: LatLng;
  radiusMiles: number;
  limitToRadius: boolean;
  counties: Record<string, CountySearchState>;
}

/**
 * effective_area = radius ∩ union(included counties, if any) − union(excluded counties)
 * A point whose county is unknown (outside the state) can never satisfy an "only these counties" search.
 */
export function inEffectiveArea(p: LatLng, areaId: string | undefined, area: EffectiveArea): boolean {
  if (area.limitToRadius && distanceMiles(area.center, p) > area.radiusMiles) return false;
  const states = Object.entries(area.counties);
  const anyIncluded = states.some(([, s]) => s === "include");
  const own = areaId ? area.counties[areaId] : undefined;
  if (anyIncluded && own !== "include") return false;
  return own !== "exclude";
}
