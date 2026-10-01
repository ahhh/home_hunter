import type { Dispatch } from "react";
import type {
  AdministrativeArea,
  CountySearchState,
  HostingSignal,
  HostingSummary,
  RegulationTopic,
  SearchState,
} from "../domain/types";
import { daysSince } from "../listings/collection";
import type { StateData } from "../services/data";
import { searchLinks } from "../sources/sources";
import type { Action } from "../state/store";
import { Drawer } from "./Drawer";
import { shortDate } from "./format";

interface Props {
  area: AdministrativeArea;
  data: StateData;
  search: SearchState;
  listingCount: number;
  dispatch: Dispatch<Action>;
  onClose(): void;
}

const TOPICS: [keyof RegulationTopics, string][] = [
  ["zoning", "Zoning and land use"],
  ["camping", "Camping on your land"],
  ["rvOccupancy", "Living in an RV or trailer"],
  ["shortTermRental", "Short-term rentals"],
  ["longTermRental", "Long-term rentals"],
  ["dwellingRequirements", "Building a home"],
];
type RegulationTopics = Record<"zoning" | "camping" | "rvOccupancy" | "shortTermRental" | "longTermRental" | "dwellingRequirements", RegulationTopic>;

const REVIEW_STALE_DAYS = 365;

const SIGNAL_LABELS: Record<HostingSignal, string> = {
  Pathway: "Small-camping permit exists",
  Campground: "Needs campground-type approval",
  Restrictive: "Restrictive for paid camping",
  Paused: "New applications paused",
  Unclear: "Rules unclear",
};

const EVIDENCE_LABELS: Record<HostingSummary["evidence"], string> = {
  verified: "Checked against the county's own documents.",
  partial: "Partly checked against the county's own documents.",
  unverified: "Not yet checked against the county's own documents.",
};

export function CountyDetail({ area, data, search, listingCount, dispatch, onClose }: Props) {
  const profile = data.profiles.get(area.id);
  const regs = data.regulations.get(area.id);
  const hosting = data.hosting.get(area.id);
  const state = search.counties[area.id];
  const set = (s: CountySearchState | null) => dispatch({ type: "setCounty", id: area.id, state: s });
  const google = (q: string) => `https://www.google.com/search?q=${encodeURIComponent(q)}`;
  const place = `${area.name} ${data.state.name}`;
  const stale = regs && (regs.status === "stale" || daysSince(regs.reviewedAt) > REVIEW_STALE_DAYS);

  const browse = searchLinks({
    bounds: area.bounds,
    countyName: area.name,
    stateName: data.state.name,
    stateCode: data.state.code,
    priceMin: search.filters.priceMin,
    priceMax: search.filters.priceMax,
    category: search.filters.category,
  });

  return (
    <Drawer label={`${area.name} details`} onClose={onClose} className="county">
      <header className="detail-head">
        <h2 tabIndex={-1}>{area.name}</h2>
        <p className="detail-sub">
          {[
            profile?.countySeat && `County seat: ${profile.countySeat}`,
            profile?.region,
            profile?.consolidatedCityCounty && "Consolidated city and county",
          ]
            .filter(Boolean)
            .join(". ")}
        </p>
        <p className="hint">
          {listingCount === 0 ? "None of your listings are here yet." : `${listingCount} of your listings ${listingCount === 1 ? "is" : "are"} here.`}
        </p>
      </header>

      <div className="seg county-state" role="group" aria-label={`Search setting for ${area.name}`}>
        <button aria-pressed={!state} onClick={() => set(null)}>
          Normal
        </button>
        <button className="include" aria-pressed={state === "include"} onClick={() => set("include")}>
          Only this county
        </button>
        <button className="exclude" aria-pressed={state === "exclude"} onClick={() => set("exclude")}>
          Leave out
        </button>
      </div>
      <p className="hint">
        {state === "include"
          ? "Listings must be in this county (or any other county marked Only) and inside the circle."
          : state === "exclude"
            ? "Listings in this county are hidden, even inside the circle."
            : "Listings here show when they're inside the circle."}
      </p>

      {hosting && (
        <section className="detail-section" aria-labelledby="hosting-h">
          <h3 id="hosting-h">Hosting campers (Hipcamp)</h3>
          <p>
            <span className={`signal signal-${hosting.signal.toLowerCase()}`}>{SIGNAL_LABELS[hosting.signal]}</span>
          </p>
          <p>{hosting.summary}</p>
          <p className={`note ${hosting.evidence === "verified" ? "ok" : "warn"}`}>
            {EVIDENCE_LABELS[hosting.evidence]} Research notes checked {shortDate(data.hostingMeta.checkedAt)}, not a
            zoning determination.
            {hosting.noBuildingDept && " This county has no building department."}
          </p>
          {hosting.sources.length > 0 && (
            <>
              <h4>County sources</h4>
              <ul className="link-list">
                {hosting.sources.map((s) => (
                  <li key={s.url}>
                    <a href={s.url} target="_blank" rel="noopener noreferrer">
                      {s.title}
                    </a>
                    {s.section && <span className="hint"> {s.section}</span>}
                  </li>
                ))}
              </ul>
            </>
          )}
          <ul className="link-list">
            <li>
              <a href={data.hostingMeta.wikiBase + hosting.wikiPath} target="_blank" rel="noopener noreferrer">
                Full {area.name} notes, with a source for every rule
              </a>
            </li>
            <li>
              <a href={data.hostingMeta.wikiBase + "04-property-worksheet.md"} target="_blank" rel="noopener noreferrer">
                Parcel worksheet: can we host here?
              </a>
            </li>
          </ul>
        </section>
      )}

      {hosting && (
        <section className="detail-section" aria-labelledby="incentives-h">
          <h3 id="incentives-h">Tax-credit zones</h3>
          <p>{hosting.incentives.summary}</p>
          {hosting.incentives.oz2Tracts.length > 0 && (
            <>
              <h4>Opportunity zones nominated for 2027</h4>
              <ul className="link-list">
                {hosting.incentives.oz2Tracts.map((t) => (
                  <li key={t.geoid}>
                    <a href={`https://data.census.gov/profile?g=1400000US${t.geoid}`} target="_blank" rel="noopener noreferrer">
                      Tract {t.geoid}
                    </a>
                    <span className="hint">
                      {" "}
                      {t.where}
                      {t.rural && ", rural"}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          <p className="note">
            Zone lines don't follow parcels. Confirm an address with the zone administrator. Checked{" "}
            {shortDate(data.hostingMeta.incentivesCheckedAt)}.
          </p>
          <ul className="link-list">
            <li>
              <a href={`${data.hostingMeta.wikiBase}${hosting.wikiPath}#tax-credit-zones-for-land-development`} target="_blank" rel="noopener noreferrer">
                {area.name} zones, administrator and what they pay for
              </a>
            </li>
            <li>
              <a href={`${data.hostingMeta.wikiBase}18-incentive-zones.md`} target="_blank" rel="noopener noreferrer">
                How enterprise and opportunity zones apply to land
              </a>
            </li>
          </ul>
        </section>
      )}

      <section className="detail-section" aria-labelledby="rules-h">
        <h3 id="rules-h">County rules</h3>
        {regs ? (
          <>
            <p className={`note ${regs.status === "reviewed" && !stale ? "" : "warn"}`}>
              {regs.status === "reviewed" ? "Reviewed" : "Not yet reviewed by a person"} {shortDate(regs.reviewedAt)}
              {stale && ". This summary is over a year old and may be out of date"}.
              {regs.jurisdictionScope === "county_unincorporated" && " Applies to unincorporated areas (outside town limits)."}
            </p>
            {TOPICS.map(([key, title]) => {
              const t = regs[key];
              if (!t) return null;
              return (
                <div key={key} className="topic">
                  <h4>{title}</h4>
                  <p>{t.summary}</p>
                  <p className="hint">
                    {t.confidence !== "high" && `${t.confidence === "medium" ? "Moderate" : "Low"} confidence. `}
                    {t.sourceIds.map((id, i) => {
                      const s = data.regulationSources.get(id);
                      return s ? (
                        <span key={id}>
                          {i > 0 && ", "}
                          <a href={s.url} target="_blank" rel="noopener noreferrer">
                            {s.title}
                          </a>
                        </span>
                      ) : null;
                    })}
                  </p>
                </div>
              );
            })}
            {regs.caveats.length > 0 && (
              <ul className="caveats">
                {regs.caveats.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <p className="note">
            No reviewed summary of zoning, camping, RV or rental rules for {area.name} yet. Check with the county
            planning department directly.
          </p>
        )}
        <ul className="link-list">
          <li>
            <a href={profile?.planningWebsite ?? google(`${place} planning department land use code`)} target="_blank" rel="noopener noreferrer">
              {profile?.planningWebsite ? "County planning department" : "Find the county planning department"}
            </a>
          </li>
          <li>
            <a href={google(`${place} RV camping on private property rules`)} target="_blank" rel="noopener noreferrer">
              Search RV and camping rules
            </a>
          </li>
          <li>
            <a href={google(`${place} short term rental license`)} target="_blank" rel="noopener noreferrer">
              Search short-term rental rules
            </a>
          </li>
          {profile?.officialWebsite && (
            <li>
              <a href={profile.officialWebsite} target="_blank" rel="noopener noreferrer">
                Official county website
              </a>
            </li>
          )}
        </ul>
        <p className="disclaimer">
          County-level summary. Rules for a specific parcel may differ based on municipality, zoning district, subdivision
          covenants, HOA rules, deed restrictions, permits, or other authorities. Verify the parcel with the applicable
          planning department before relying on this summary.
        </p>
      </section>

      <section className="detail-section" aria-labelledby="browse-h">
        <h3 id="browse-h">Browse this county</h3>
        <ul className="site-links">
          {browse.map((l) => (
            <li key={l.sourceId}>
              <a href={l.url} target="_blank" rel="noopener noreferrer">
                <strong>{l.label}</strong>
                <span>{l.sourceId === "zillow" ? "county map area" : l.scope}</span>
              </a>
            </li>
          ))}
        </ul>
      </section>
      <p className="hint">
        FIPS {area.fips}. Boundary: {data.geometrySource.authority}.
      </p>
    </Drawer>
  );
}
