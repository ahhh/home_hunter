import type { Property } from "../domain/types";
import { mergeProperties } from "../listings/collection";
import { importCsv } from "../sources/csvImport";
import { reducer, sanitizePayload, type Action, type AppState } from "./store";
import { shortDate } from "../ui/format";

export interface ImportOutcome {
  ok: boolean;
  text: string;
  action?: Action;
  /** An export that carried a search area the person may want to switch to. */
  search?: AppState["search"];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Reads a dropped or chosen file:
 *  - data bundle from pipelines/listings/seed.py → full bundles replace the previous one
 *    (listings gone from the market drop off); partial bundles only add and refresh
 *  - export file from this app (all listings, or just loved ones) → merged in
 *  - older backup/share files → merged in
 *  - CSV (Redfin "Download All", or any CSV with url/price/latitude/longitude) → merged in
 */
export async function readImportFile(file: File, state: AppState): Promise<ImportOutcome> {
  const text = await file.text();
  const now = new Date().toISOString();

  if (file.name.toLowerCase().endsWith(".json") || text.trimStart().startsWith("{")) {
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, text: `${file.name} isn't valid JSON. Use a data bundle from the script or a Home Hunter export.` };
    }

    if (json?.kind === "home-hunter-seed") return readSeed(json, file.name, state);

    if (json?.kind === "home-hunter-export") {
      const payload = sanitizePayload({ ...json, v: 1 });
      const who = payload.from ? ` from ${payload.from}` : "";
      const outcome = mergeOutcome(state, payload.properties ?? [], "");
      return { ...outcome, text: `Export${who}: ${outcome.text}`, search: payload.search };
    }

    if (json?.v === 1) return mergeOutcome(state, sanitizePayload(json).properties ?? [], "");
    return { ok: false, text: `${file.name} isn't a Home Hunter data bundle or export.` };
  }

  const r = importCsv(text, now, state.userName || undefined);
  if (r.missingColumns.length)
    return {
      ok: false,
      text: `This spreadsheet is missing columns for: ${r.missingColumns.join(", ")}. Redfin's "Download All" file has them all.`,
    };
  const skipped = r.skipped ? ` Skipped ${plural(r.skipped, "row")} without a map location.` : "";
  return mergeOutcome(state, r.properties, skipped);
}

function readSeed(json: any, name: string, state: AppState): ImportOutcome {
  if (typeof json.generatedAt !== "string" || Number.isNaN(Date.parse(json.generatedAt)))
    return { ok: false, text: `${name} is missing a valid creation date. Run the seed script again to rebuild it.` };
  const partial = json.partial === true;
  if (!partial && state.seedAt && json.generatedAt < state.seedAt)
    return {
      ok: false,
      text: `This bundle is from ${shortDate(json.generatedAt)}, older than the one you already loaded (${shortDate(state.seedAt)}). Nothing changed.`,
    };
  const properties = sanitizePayload(json).properties ?? [];
  const action: Action = { type: "applySeed", generatedAt: json.generatedAt, properties, partial };
  const before = new Set(state.properties.map((p) => p.id));
  const after = reducer(state, action).properties;
  const afterIds = new Set(after.map((p) => p.id));
  const added = after.filter((p) => !before.has(p.id)).length;
  const dropped = state.properties.filter((p) => !afterIds.has(p.id)).length;
  return {
    ok: true,
    action,
    text:
      `Loaded ${plural(properties.length, "listing")} from the ${shortDate(json.generatedAt)} ${partial ? "top-up " : ""}bundle: ${added} new` +
      (dropped ? `, ${dropped} no longer for sale removed` : "") +
      ". Your notes and verdicts are unchanged.",
  };
}

function mergeOutcome(state: AppState, incoming: Property[], suffix: string): ImportOutcome {
  const { added, updated } = mergeProperties(state.properties, incoming);
  return {
    ok: true,
    action: { type: "mergeProperties", properties: incoming },
    text: `Added ${added} new ${added === 1 ? "listing" : "listings"}${updated ? ` and updated ${updated} you already had` : ""}.${suffix}`,
  };
}
