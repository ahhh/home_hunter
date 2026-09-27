import type { LatLng } from "../domain/types";

// OpenStreetMap Nominatim. Usage policy: at most 1 request/second and no search-as-you-type,
// so lookups run only on submit and go through a serial queue.
const BASE = "https://nominatim.openstreetmap.org";
const COLORADO_VIEWBOX = "-109.06,41.01,-102.04,36.99";

let queue: Promise<unknown> = Promise.resolve();
let last = 0;

function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const wait = last + 1100 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    return fn();
  });
  queue = run.catch(() => undefined);
  return run;
}

export interface GeocodeResult extends LatLng {
  label: string;
  postcode?: string;
}

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Address lookup failed (${res.status})`);
  return res.json();
}

const shortLabel = (r: any): string => {
  const a = r.address ?? {};
  const place = a.city || a.town || a.village || a.hamlet || a.county;
  const street = [a.house_number, a.road].filter(Boolean).join(" ");
  return [street, place, a.state === "Colorado" ? "CO" : a.state].filter(Boolean).join(", ") || r.display_name;
};

export function geocode(query: string, limit = 5): Promise<GeocodeResult[]> {
  const params = new URLSearchParams({
    q: query,
    format: "jsonv2",
    addressdetails: "1",
    countrycodes: "us",
    viewbox: COLORADO_VIEWBOX,
    limit: String(limit),
  });
  return throttled(async () => {
    const rows = await getJson(`${BASE}/search?${params}`);
    return rows.map((r: any) => ({ lat: +r.lat, lng: +r.lon, label: shortLabel(r), postcode: r.address?.postcode }));
  });
}

export function reverseGeocode(p: LatLng): Promise<GeocodeResult | undefined> {
  const params = new URLSearchParams({ lat: String(p.lat), lon: String(p.lng), format: "jsonv2", zoom: "14", addressdetails: "1" });
  return throttled(async () => {
    const r = await getJson(`${BASE}/reverse?${params}`);
    if (!r || r.error) return undefined;
    return { ...p, label: shortLabel(r), postcode: r.address?.postcode?.slice(0, 5) };
  });
}
