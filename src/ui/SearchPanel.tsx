import { useState, type Dispatch } from "react";
import type { LatLng, SearchFilters } from "../domain/types";
import { circleBounds } from "../geo/geo";
import type { StateData } from "../services/data";
import { geocode, type GeocodeResult } from "../services/geocode";
import { searchLinks, sourceById } from "../sources/sources";
import type { Action, AppState } from "../state/store";
import { parseMoney, parseNum } from "./format";

const PRESETS = [5, 10, 25, 50, 75, 100];
export const MAX_RADIUS = 150;

interface Props {
  data: StateData;
  state: AppState;
  dispatch: Dispatch<Action>;
  onMoveCenter(p: LatLng, label: string, postcode?: string): void;
  onFrame(): void;
}

export function SearchPanel({ data, state, dispatch, onMoveCenter, onFrame }: Props) {
  const { search } = state;
  const f = search.filters;
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [choices, setChoices] = useState<GeocodeResult[]>([]);
  const [customRadius, setCustomRadius] = useState(PRESETS.includes(search.radiusMiles) ? "" : String(search.radiusMiles));

  async function find(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    setBusy(true);
    setError(undefined);
    setChoices([]);
    try {
      const results = await geocode(query);
      if (!results.length) setError(`No match for "${query}". Try a town or ZIP, or pick a spot on the map.`);
      else if (results.length === 1) onMoveCenter(results[0], results[0].label, results[0].postcode);
      else setChoices(results);
    } catch {
      setError("Address lookup isn't responding. Pick a spot on the map instead.");
    } finally {
      setBusy(false);
    }
  }

  const setFilters = (filters: Partial<SearchFilters>) => dispatch({ type: "setFilters", filters });
  const countyEntries = Object.entries(search.counties);
  const centerCounty = data.areaById.get(data.index.locate(search.center) ?? "");
  const providersInUse = [...new Set(state.properties.flatMap((p) => p.listings.map((l) => l.provider)))];
  const links = searchLinks({
    bounds: circleBounds(search.center, search.radiusMiles),
    postcode: search.center.postcode,
    countyName: centerCounty?.name,
    stateName: data.state.name,
    stateCode: data.state.code,
    priceMin: f.priceMin,
    priceMax: f.priceMax,
    category: f.category,
  });

  return (
    <>
      <section className="block" aria-labelledby="area-h">
        <h2 id="area-h">Search area</h2>
        <form className="find" onSubmit={find} role="search">
          <label className="sr-only" htmlFor="place">
            Town, address or ZIP
          </label>
          <input
            id="place"
            type="search"
            placeholder="Town, address or ZIP"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
          />
          <button type="submit" disabled={busy}>
            {busy ? "Finding…" : "Find"}
          </button>
        </form>
        {error && <p className="note warn">{error}</p>}
        {choices.length > 0 && (
          <ul className="choices" aria-label="Matching places">
            {choices.map((c, i) => (
              <li key={i}>
                <button
                  onClick={() => {
                    onMoveCenter(c, c.label, c.postcode);
                    setChoices([]);
                  }}
                >
                  {c.label}
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="center-line">
          Centered on <strong>{search.center.label}</strong>
          <button className="link" onClick={() => dispatch({ type: "setPick", pick: { kind: "center" } })}>
            Pick on map
          </button>
        </p>

        <div className="radius" role="group" aria-labelledby="radius-h">
          <div className="radius-head">
            <span id="radius-h">Radius</span>
            <output className="radius-value" aria-live="polite">
              {search.radiusMiles} mi
            </output>
          </div>
          <div className="seg wrap">
            {PRESETS.map((m) => (
              <button
                key={m}
                aria-pressed={search.radiusMiles === m}
                onClick={() => {
                  dispatch({ type: "setRadius", miles: m });
                  setCustomRadius("");
                  onFrame();
                }}
              >
                {m}
              </button>
            ))}
            <input
              aria-label={`Custom radius in miles, up to ${MAX_RADIUS}`}
              inputMode="numeric"
              placeholder="Other"
              value={customRadius}
              onChange={(e) => setCustomRadius(e.target.value)}
              onBlur={() => {
                const n = parseNum(customRadius);
                if (n && n > 0) {
                  dispatch({ type: "setRadius", miles: Math.min(MAX_RADIUS, Math.round(n)) });
                  setCustomRadius(String(Math.min(MAX_RADIUS, Math.round(n))));
                  onFrame();
                }
              }}
              onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            />
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={search.limitToRadius}
              onChange={(e) => dispatch({ type: "setLimitToRadius", on: e.target.checked })}
            />
            Only show listings inside the circle
          </label>
        </div>

        <div className="counties">
          <div className="counties-head">
            <span>Counties</span>
            {countyEntries.length > 0 && (
              <button className="link" onClick={() => dispatch({ type: "clearCounties" })}>
                Clear all
              </button>
            )}
          </div>
          {countyEntries.length === 0 ? (
            <p className="hint">Click a county on the map to search only that county or leave it out.</p>
          ) : (
            <ul className="chips">
              {countyEntries.map(([id, s]) => (
                <li key={id} className={`chip ${s}`}>
                  <button className="chip-name" onClick={() => dispatch({ type: "select", selection: { kind: "county", id } })}>
                    <span className="chip-state">{s === "include" ? "Only" : "Excluded"}</span> {data.areaById.get(id)?.name}
                  </button>
                  <button
                    className="chip-x"
                    aria-label={`Remove ${data.areaById.get(id)?.name} from ${s === "include" ? "only" : "excluded"} counties`}
                    onClick={() => dispatch({ type: "setCounty", id, state: null })}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          <select
            aria-label="Look up a county"
            value=""
            onChange={(e) => e.target.value && dispatch({ type: "select", selection: { kind: "county", id: e.target.value } })}
          >
            <option value="">Look up a county…</option>
            {[...data.areas]
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
          </select>
        </div>
      </section>

      <details className="block" open>
        <summary>
          <h2>Filters</h2>
          <button
            className="link"
            onClick={(e) => {
              e.preventDefault();
              dispatch({ type: "resetFilters" });
            }}
          >
            Reset
          </button>
        </summary>
        <div className="seg" role="group" aria-label="Property type">
          {(
            [
              ["all", "All"],
              ["vacant_land", "Vacant land"],
              ["improved", "Homes"],
            ] as const
          ).map(([v, label]) => (
            <button key={v} aria-pressed={f.category === v} onClick={() => setFilters({ category: v })}>
              {label}
            </button>
          ))}
        </div>
        <div className="pair">
          <MoneyField key={`a${f.priceMin}`} label="Min price" value={f.priceMin} onChange={(v) => setFilters({ priceMin: v })} />
          <MoneyField key={`b${f.priceMax}`} label="Max price" value={f.priceMax} onChange={(v) => setFilters({ priceMax: v })} />
        </div>
        <div className="pair">
          <NumField key={`c${f.acreageMin}`} label="Min acres" value={f.acreageMin} onChange={(v) => setFilters({ acreageMin: v })} />
          <NumField key={`d${f.acreageMax}`} label="Max acres" value={f.acreageMax} onChange={(v) => setFilters({ acreageMax: v })} />
        </div>
        {f.category !== "vacant_land" && (
          <div className="pair">
            <NumField key={`e${f.bedsMin}`} label="Beds (min)" value={f.bedsMin} onChange={(v) => setFilters({ bedsMin: v })} />
            <NumField key={`f${f.bathsMin}`} label="Baths (min)" value={f.bathsMin} onChange={(v) => setFilters({ bathsMin: v })} />
          </div>
        )}
        <div className="seg" role="group" aria-label="Show">
          {(
            [
              ["not_passed", "Hide passed"],
              ["love", "Loved only"],
              ["all", "Everything"],
            ] as const
          ).map(([v, label]) => (
            <button key={v} aria-pressed={f.ratings === v} onClick={() => setFilters({ ratings: v })}>
              {label}
            </button>
          ))}
        </div>
        {providersInUse.length > 1 && (
          <fieldset className="sites">
            <legend>Sites</legend>
            {providersInUse.map((id) => (
              <label key={id} className="check">
                <input
                  type="checkbox"
                  checked={!f.providers.length || f.providers.includes(id)}
                  onChange={(e) => {
                    const current = f.providers.length ? f.providers : providersInUse;
                    const next = e.target.checked ? [...current, id] : current.filter((x) => x !== id);
                    setFilters({ providers: next.length === providersInUse.length ? [] : next });
                  }}
                />
                {sourceById(id).label}
              </label>
            ))}
          </fieldset>
        )}
      </details>

      <section className="block" aria-labelledby="find-h">
        <h2 id="find-h">Browse listing sites</h2>
        <p className="hint">Opens each site with this area, price and type. Copy what you like back here with Add listing.</p>
        <ul className="site-links">
          {links.map((l) => (
            <li key={l.sourceId}>
              <a href={l.url} target="_blank" rel="noopener noreferrer">
                <strong>{l.label}</strong>
                <span>{l.scope}</span>
              </a>
            </li>
          ))}
        </ul>
        {!search.center.postcode && <p className="hint">Redfin and Realtor.com links need a ZIP. Search for a town or ZIP to add them.</p>}
      </section>
    </>
  );
}

function MoneyField({ label, value, onChange }: { label: string; value?: number; onChange(v?: number): void }) {
  const [text, setText] = useState(value ? value.toLocaleString("en-US") : "");
  return (
    <label className="field">
      <span>{label}</span>
      <input
        inputMode="decimal"
        placeholder="Any"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const v = parseMoney(text);
          onChange(v);
          setText(v ? v.toLocaleString("en-US") : "");
        }}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      />
    </label>
  );
}

function NumField({ label, value, onChange }: { label: string; value?: number; onChange(v?: number): void }) {
  const [text, setText] = useState(value !== undefined ? String(value) : "");
  return (
    <label className="field">
      <span>{label}</span>
      <input
        inputMode="decimal"
        placeholder="Any"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const v = parseNum(text);
          onChange(v);
          setText(v !== undefined ? String(v) : "");
        }}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      />
    </label>
  );
}
