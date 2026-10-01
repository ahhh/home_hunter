// Tourism heat model: where Colorado destinations draw search interest, and where their visitors sleep.
//
// Each destination spreads its Google search interest over a Gaussian footprint sized by what it is (a national
// park covers more ground than a hot spring). The "stays" field moves that same interest to the towns where
// visitors lodge, using each destination's estimated split, and spreads it over the surrounding area.
import type { LatLng } from "../domain/types";

export type AttractionCategory = "park" | "ski" | "hike" | "hot-springs" | "drive" | "landmark" | "water";

export interface Attraction extends LatLng {
  id: string;
  name: string;
  category: AttractionCategory;
  /** Relative Google search interest; 100 = the most-searched destination. */
  interest: number;
  peakMonth: string | null;
  trendsTerm: string;
  /** Lodging base id -> share of overnight visitors (sums to 1). */
  stays: Record<string, number>;
}

export interface LodgingBase extends LatLng {
  name: string;
}

export interface TourismData {
  builtAt: string;
  source: { name: string; url: string; geo: string; timeframe: string; note: string };
  staysNote: string;
  bases: Record<string, LodgingBase>;
  attractions: Attraction[];
}

/** Footprint (1 sigma, miles) of the search interest a destination draws. */
export const REACH_MILES: Record<AttractionCategory, number> = {
  park: 8,
  drive: 6,
  ski: 3,
  water: 3,
  hike: 2.5,
  landmark: 2,
  "hot-springs": 2,
};
/** Lodging spills out of a town into nearby cabins, campgrounds and rentals. */
export const STAY_SPREAD_MILES = 6;

export const CATEGORY_LABELS: Record<AttractionCategory, string> = {
  park: "National park or monument",
  drive: "Scenic drive or railway",
  ski: "Ski area",
  water: "Lake or river",
  hike: "Hike or peak",
  landmark: "Landmark",
  "hot-springs": "Hot springs",
};

const MI_PER_DEG_LAT = 69.05;
const CUTOFF_SIGMAS = 4;

/** Fast flat-earth miles; plenty within a few dozen miles. */
export function approxMiles(a: LatLng, b: LatLng): number {
  const dy = (a.lat - b.lat) * MI_PER_DEG_LAT;
  const dx = (a.lng - b.lng) * MI_PER_DEG_LAT * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  return Math.hypot(dx, dy);
}

function gaussian(d: number, sigma: number): number {
  return d > sigma * CUTOFF_SIGMAS ? 0 : Math.exp(-(d * d) / (2 * sigma * sigma));
}

export interface StayDemand {
  baseId: string;
  base: LodgingBase;
  /** Sum of interest x share over the destinations that send visitors here. */
  weight: number;
  from: { attraction: Attraction; weight: number }[];
}

export class TourismModel {
  readonly demand: StayDemand[];
  readonly maxInterest: number;
  readonly maxStays: number;

  constructor(readonly data: TourismData) {
    const byBase = new Map<string, StayDemand>();
    for (const a of data.attractions) {
      if (!(a.category in REACH_MILES)) throw new Error(`${a.id}: unknown category ${a.category}`);
      for (const [baseId, share] of Object.entries(a.stays)) {
        const base = data.bases[baseId];
        if (!base) throw new Error(`${a.id}: unknown lodging base ${baseId}`);
        const d = byBase.get(baseId) ?? { baseId, base, weight: 0, from: [] };
        d.weight += a.interest * share;
        d.from.push({ attraction: a, weight: a.interest * share });
        byBase.set(baseId, d);
      }
    }
    for (const d of byBase.values()) d.from.sort((x, y) => y.weight - x.weight);
    this.demand = [...byBase.values()].sort((x, y) => y.weight - x.weight);
    // Peaks sit on (or very near) a destination or lodging base, so sampling those points finds the maximum.
    this.maxInterest = Math.max(...data.attractions.map((a) => this.interestAt(a)));
    this.maxStays = Math.max(...this.demand.map((d) => this.staysAt(d.base)));
  }

  interestAt(p: LatLng): number {
    let v = 0;
    for (const a of this.data.attractions) v += a.interest * gaussian(approxMiles(p, a), REACH_MILES[a.category]);
    return v;
  }

  staysAt(p: LatLng): number {
    let v = 0;
    for (const d of this.demand) v += d.weight * gaussian(approxMiles(p, d.base), STAY_SPREAD_MILES);
    return v;
  }

  /** Destinations that make up the interest at a point, biggest first, with their share of it. */
  interestParts(p: LatLng, minShare = 0.03): { attraction: Attraction; share: number; miles: number }[] {
    const parts = this.data.attractions.map((a) => {
      const miles = approxMiles(p, a);
      return { attraction: a, miles, value: a.interest * gaussian(miles, REACH_MILES[a.category]) };
    });
    const total = parts.reduce((s, x) => s + x.value, 0);
    if (!total) return [];
    return parts
      .filter((x) => x.value / total >= minShare)
      .sort((x, y) => y.value - x.value)
      .map(({ attraction, value, miles }) => ({ attraction, miles, share: value / total }));
  }

  /** Lodging towns that make up the visitor-stay density at a point, biggest first. */
  stayParts(p: LatLng, minShare = 0.03): { demand: StayDemand; share: number; miles: number }[] {
    const parts = this.demand.map((d) => {
      const miles = approxMiles(p, d.base);
      return { demand: d, miles, value: d.weight * gaussian(miles, STAY_SPREAD_MILES) };
    });
    const total = parts.reduce((s, x) => s + x.value, 0);
    if (!total) return [];
    return parts
      .filter((x) => x.value / total >= minShare)
      .sort((x, y) => y.value - x.value)
      .map(({ demand, value, miles }) => ({ demand, miles, share: value / total }));
  }
}

/**
 * Maps a raw density to 0..1 on a log scale. Interest spans three orders of magnitude (Red Rocks vs. a
 * backcountry hot spring), so a linear scale would show only the top few destinations.
 */
export function intensity(value: number, max: number, decades = 3): number {
  if (value <= 0 || max <= 0) return 0;
  const t = 1 + Math.log10(value / max) / decades;
  return Math.min(1, Math.max(0, t));
}
