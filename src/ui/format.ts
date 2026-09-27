import type { PropertyCategory } from "../domain/types";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export const money = (n?: number) => (n === undefined ? "Price unknown" : usd.format(n));

/** Compact price for map pins: $425K, $1.2M */
export function shortMoney(n?: number): string {
  if (n === undefined) return "?";
  if (n >= 1e6) return `$${+(n / 1e6).toFixed(n >= 1e7 ? 0 : 2)}M`;
  if (n >= 1e3) return `$${Math.round(n / 1e3)}K`;
  return `$${n}`;
}

export const acres = (n?: number) => (n === undefined ? undefined : `${n.toLocaleString("en-US", { maximumFractionDigits: n < 10 ? 2 : 1 })} ac`);

export const categoryLabel: Record<PropertyCategory, string> = {
  vacant_land: "Vacant land",
  improved: "Home / improved",
  unknown: "Type unknown",
};

export function ago(iso: string, now = Date.now()): string {
  const days = Math.floor((now - Date.parse(iso)) / 864e5);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.round(days / 30);
  return months === 1 ? "a month ago" : `${months} months ago`;
}

export const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

/** Parse "250k", "1.2m", "$300,000" into a number; empty → undefined. */
export function parseMoney(s: string): number | undefined {
  const t = s.trim().toLowerCase().replace(/[$,\s]/g, "");
  if (!t) return undefined;
  const m = t.match(/^(\d+(?:\.\d+)?)([km])?$/);
  if (!m) return undefined;
  return Math.round(+m[1] * (m[2] === "m" ? 1e6 : m[2] === "k" ? 1e3 : 1));
}

export function parseNum(s: string): number | undefined {
  const t = s.trim().replace(/,/g, "");
  if (!t) return undefined;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}
