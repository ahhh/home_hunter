import type { Dispatch } from "react";
import type { Property, SearchState, SortKey } from "../domain/types";
import { distanceMiles } from "../geo/geo";
import { daysSince, displayPrice, newestFetch, pricePerAcre, STALE_AFTER_DAYS } from "../listings/collection";
import type { StateData } from "../services/data";
import { sourceById } from "../sources/sources";
import type { Action } from "../state/store";
import { acres, ago, categoryLabel, money } from "./format";

interface Props {
  data: StateData;
  all: number;
  inArea: number;
  visible: Property[];
  countyOf: Map<string, string | undefined>;
  search: SearchState;
  selectedId?: string;
  dispatch: Dispatch<Action>;
  onAdd(): void;
  onImport(): void;
}

const SORTS: [SortKey, string][] = [
  ["newest", "Recently added"],
  ["price_asc", "Price, low to high"],
  ["price_desc", "Price, high to low"],
  ["acres_desc", "Most acres"],
  ["ppa_asc", "Lowest price per acre"],
  ["distance", "Closest to center"],
];

const RATING_LABEL = { love: "Loved", maybe: "Maybe", pass: "Passed" } as const;

export function ResultsList({ data, all, inArea, visible, countyOf, search, selectedId, dispatch, onAdd, onImport }: Props) {
  const hiddenByFilters = inArea - visible.length;
  const outsideArea = all - inArea;

  return (
    <section className="block results" aria-labelledby="results-h">
      <div className="results-head">
        <h2 id="results-h">
          {visible.length} {visible.length === 1 ? "listing" : "listings"}
        </h2>
        <label className="sr-only" htmlFor="sort">
          Sort by
        </label>
        <select id="sort" value={search.sort} onChange={(e) => dispatch({ type: "setSort", sort: e.target.value as SortKey })}>
          {SORTS.map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
      </div>
      {(hiddenByFilters > 0 || outsideArea > 0) && (
        <p className="hint" role="status">
          {hiddenByFilters > 0 && `${hiddenByFilters} hidden by filters. `}
          {outsideArea > 0 && `${outsideArea} outside the search area.`}
        </p>
      )}

      {all === 0 ? (
        <div className="empty">
          <p>
            <strong>No listings yet.</strong> Paste a link from Zillow, Redfin or any listing site, or import Redfin's
            "Download All" spreadsheet to drop a whole search onto the map.
          </p>
          <div className="row">
            <button className="primary" onClick={onAdd}>
              Add listing
            </button>
            <button onClick={onImport}>Import</button>
          </div>
        </div>
      ) : visible.length === 0 ? (
        <div className="empty">
          <p>Nothing matches here. Widen the radius, clear county choices, or loosen the filters.</p>
          {hiddenByFilters > 0 && <button onClick={() => dispatch({ type: "resetFilters" })}>Reset filters</button>}
        </div>
      ) : (
        <ol className="cards">
          {visible.map((p) => {
            const fetched = newestFetch(p);
            const stale = daysSince(fetched) > STALE_AFTER_DAYS;
            const ppa = pricePerAcre(p);
            const county = data.areaById.get(countyOf.get(p.id) ?? "");
            const facts = [
              categoryLabel[p.category],
              acres(p.acreage),
              p.category !== "vacant_land" && p.bedrooms !== undefined ? `${p.bedrooms} bd` : undefined,
              p.category !== "vacant_land" && p.bathrooms !== undefined ? `${p.bathrooms} ba` : undefined,
            ].filter(Boolean);
            return (
              <li key={p.id} className={`card ${p.rating ?? ""} ${p.id === selectedId ? "selected" : ""}`}>
                <button
                  className="card-hit"
                  aria-current={p.id === selectedId}
                  onClick={() => dispatch({ type: "select", selection: { kind: "property", id: p.id } })}
                >
                  <span className="card-price">{money(displayPrice(p))}</span>
                  {ppa !== undefined && <span className="card-ppa">{money(Math.round(ppa))}/ac</span>}
                  {p.rating && <span className={`rating-mark ${p.rating}`}>{RATING_LABEL[p.rating]}</span>}
                  <span className="card-addr">{p.address ?? (county ? `Somewhere in ${county.name}` : "Address not listed")}</span>
                  <span className="card-facts">{facts.join(", ")}</span>
                  <span className="card-meta">
                    {p.listings.map((l) => sourceById(l.provider).label).join(" + ")}
                    {county && p.address ? `, ${county.name}` : ""}
                    {search.limitToRadius ? `, ${distanceMiles(search.center, p.location).toFixed(0)} mi away` : ""}
                  </span>
                  <span className={`card-fresh ${stale ? "stale" : ""}`}>
                    Price copied {ago(fetched)}
                    {stale && ", may have changed"}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
