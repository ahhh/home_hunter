import type { Property, SearchState } from "../domain/types";
import type { AppState } from "./store";

/** The app's own file of mapped listings: everything needed to put them back on a map. */
export interface ExportFile {
  kind: "home-hunter-export";
  v: 1;
  exportedAt: string;
  from?: string;
  scope: ExportScope;
  search?: SearchState;
  properties: Property[];
}

export type ExportScope = "loved" | "rated" | "visible" | "all";

export const SCOPE_LABEL: Record<ExportScope, string> = {
  loved: "Loved listings",
  rated: "Loved and Maybe",
  visible: "Listings shown now",
  all: "Everything on my map",
};

export function pickProperties(scope: ExportScope, all: Property[], visible: Property[]): Property[] {
  switch (scope) {
    case "loved":
      return all.filter((p) => p.rating === "love");
    case "rated":
      return all.filter((p) => p.rating === "love" || p.rating === "maybe");
    case "visible":
      return visible;
    case "all":
      return all;
  }
}

export function buildExport(
  state: AppState,
  scope: ExportScope,
  visible: Property[],
  opts: { includeSearch: boolean; from?: string; now?: string },
): ExportFile {
  return {
    kind: "home-hunter-export",
    v: 1,
    exportedAt: opts.now ?? new Date().toISOString(),
    from: opts.from || undefined,
    scope,
    search: opts.includeSearch ? state.search : undefined,
    properties: pickProperties(scope, state.properties, visible),
  };
}

export function exportFileName(scope: ExportScope, now = new Date()): string {
  return `home-hunter-${scope}-${now.toISOString().slice(0, 10)}.json`;
}

export function downloadJson(data: unknown, name: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
