import { useState, type Dispatch } from "react";
import type { LatLng, Property, PropertyCategory, Rating } from "../domain/types";
import { distanceMiles } from "../geo/geo";
import { currentListings, daysSince, displayPrice, hasConflictingPrices, pricePerAcre, STALE_AFTER_DAYS } from "../listings/collection";
import type { StateData } from "../services/data";
import { linkLabel, parseListingUrl, providerIdFor, sourceById } from "../sources/sources";
import type { Action } from "../state/store";
import { Drawer } from "./Drawer";
import { acres, ago, categoryLabel, money, parseMoney, parseNum, shortDate } from "./format";

interface Props {
  property: Property;
  data: StateData;
  countyId?: string;
  center: LatLng;
  hiddenReason?: "filters" | "area";
  dispatch: Dispatch<Action>;
  onClose(): void;
}

const RATINGS: [Rating, string][] = [
  ["love", "Love it"],
  ["maybe", "Maybe"],
  ["pass", "Pass"],
];

export function PropertyDetail({ property: p, data, countyId, center, hiddenReason, dispatch, onClose }: Props) {
  const update = (patch: Partial<Property>) => dispatch({ type: "updateProperty", id: p.id, patch });
  const county = data.areaById.get(countyId ?? "");
  const price = displayPrice(p);
  const ppa = pricePerAcre(p);
  const [notes, setNotes] = useState(p.notes ?? "");

  return (
    <Drawer label="Listing details" onClose={onClose}>
      <header className="detail-head">
        <h2 tabIndex={-1} className="detail-price">
          {money(price)}
        </h2>
        <p className="detail-sub">{p.address ?? "Address not listed"}</p>
        {hiddenReason && (
          <p className="note warn">
            {hiddenReason === "filters" ? "Hidden from the list by your filters." : "Outside the current search area."}
          </p>
        )}
      </header>

      <div className="seg rating" role="group" aria-label="Your verdict">
        {RATINGS.map(([r, label]) => (
          <button key={r} className={r} aria-pressed={p.rating === r} onClick={() => update({ rating: p.rating === r ? undefined : r })}>
            {label}
          </button>
        ))}
      </div>

      <dl className="facts">
        <div>
          <dt>Type</dt>
          <dd>{categoryLabel[p.category]}</dd>
        </div>
        <div>
          <dt>Land</dt>
          <dd>{acres(p.acreage) ?? "Not listed"}</dd>
        </div>
        {ppa !== undefined && (
          <div>
            <dt>Per acre</dt>
            <dd>{money(Math.round(ppa))}</dd>
          </div>
        )}
        {p.category !== "vacant_land" && (
          <div>
            <dt>Beds / baths</dt>
            <dd>
              {p.bedrooms ?? "?"} / {p.bathrooms ?? "?"}
            </dd>
          </div>
        )}
        {p.squareFeet !== undefined && (
          <div>
            <dt>Living area</dt>
            <dd>{p.squareFeet.toLocaleString()} sq ft</dd>
          </div>
        )}
        <div>
          <dt>County</dt>
          <dd>
            {county ? (
              <button className="link" onClick={() => dispatch({ type: "select", selection: { kind: "county", id: county.id } })}>
                {county.name}
              </button>
            ) : (
              `Outside ${data.state.name}`
            )}
          </dd>
        </div>
        <div>
          <dt>From center</dt>
          <dd>{distanceMiles(center, p.location).toFixed(1)} mi</dd>
        </div>
        <div>
          <dt>Pin</dt>
          <dd>
            {p.locationPrecision === "exact" ? "Exact" : "Approximate"}{" "}
            <button className="link" onClick={() => dispatch({ type: "setPick", pick: { kind: "place", propertyId: p.id } })}>
              Move
            </button>
          </dd>
        </div>
      </dl>

      <section className="detail-section" aria-labelledby="where-h">
        <h3 id="where-h">Where it's listed</h3>
        {hasConflictingPrices(p) && <p className="note">These sites show different prices. The lowest is used above.</p>}
        <ul className="listings">
          {currentListings(p).map((l) => (
            <ListingRow
              key={l.canonicalUrl}
              listing={l}
              onPrice={(price) =>
                update({
                  listings: p.listings.map((x) =>
                    x.canonicalUrl === l.canonicalUrl ? { ...x, price, fetchedAt: new Date().toISOString() } : x,
                  ),
                })
              }
              onRemove={
                p.listings.length > 1
                  ? () => update({ listings: p.listings.filter((x) => x.canonicalUrl !== l.canonicalUrl) })
                  : undefined
              }
            />
          ))}
        </ul>
        <AddLink property={p} dispatch={dispatch} />
      </section>

      <section className="detail-section" aria-labelledby="notes-h">
        <h3 id="notes-h">Notes</h3>
        <textarea
          aria-labelledby="notes-h"
          rows={4}
          placeholder="Road access, water, views, questions for the agent…"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={() => notes !== (p.notes ?? "") && update({ notes: notes || undefined })}
        />
        <p className="hint">
          Added {p.addedBy ? `by ${p.addedBy} ` : ""}on {shortDate(p.addedAt)}
        </p>
      </section>

      <details className="detail-section">
        <summary>
          <h3>Edit details</h3>
        </summary>
        <EditDetails property={p} onSave={update} />
      </details>

      <button
        className="danger"
        onClick={() => confirm("Remove this listing from your map?") && dispatch({ type: "deleteProperty", id: p.id })}
      >
        Remove from my map
      </button>
    </Drawer>
  );
}

function ListingRow({
  listing: l,
  onPrice,
  onRemove,
}: {
  listing: Property["listings"][number];
  onPrice(n: number): void;
  onRemove?(): void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const site = sourceById(l.provider);
  const stale = daysSince(l.fetchedAt) > STALE_AFTER_DAYS;
  return (
    <li className="listing">
      <div className="listing-top">
        <span className={`badge src-${site.id}`}>{site.label}</span>
        <strong>{money(l.price)}</strong>
        {l.status === "pending" && <span className="badge">Pending</span>}
      </div>
      <p className={`hint ${stale ? "stale" : ""}`}>
        Copied {ago(l.fetchedAt)}
        {stale && ". Check the site for the current price."}
        {l.attribution && ` Listing data: ${l.attribution}.`}
      </p>
      <div className="row">
        <a className="button primary" href={l.canonicalUrl} target="_blank" rel="noopener noreferrer">
          {linkLabel(l.canonicalUrl)}
        </a>
        {editing ? (
          <form
            className="inline"
            onSubmit={(e) => {
              e.preventDefault();
              const n = parseMoney(text);
              if (n !== undefined) onPrice(n);
              setEditing(false);
            }}
          >
            <input aria-label="New price" autoFocus inputMode="decimal" placeholder="e.g. 245k" value={text} onChange={(e) => setText(e.target.value)} />
            <button type="submit">Save</button>
          </form>
        ) : (
          <button onClick={() => setEditing(true)}>Update price</button>
        )}
        {onRemove && (
          <button className="link" onClick={onRemove}>
            Remove link
          </button>
        )}
      </div>
    </li>
  );
}

function AddLink({ property, dispatch }: { property: Property; dispatch: Dispatch<Action> }) {
  const [url, setUrl] = useState("");
  const [price, setPrice] = useState("");
  const [error, setError] = useState<string>();
  return (
    <details className="add-link">
      <summary>Add the same property from another site</summary>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const parsed = parseListingUrl(url);
          if (!parsed) return setError("That doesn't look like a web link. Copy it from the browser's address bar.");
          if (property.listings.some((l) => l.canonicalUrl === parsed.canonicalUrl)) return setError("That link is already here.");
          dispatch({
            type: "updateProperty",
            id: property.id,
            patch: {
              listings: [
                ...property.listings,
                {
                  provider: providerIdFor(parsed),
                  providerListingId: parsed.providerListingId,
                  canonicalUrl: parsed.canonicalUrl,
                  status: "active",
                  price: parseMoney(price),
                  fetchedAt: new Date().toISOString(),
                },
              ],
            },
          });
          setUrl("");
          setPrice("");
          setError(undefined);
        }}
      >
        <label className="field">
          <span>Link</span>
          <input type="url" required value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" />
        </label>
        <label className="field">
          <span>Price there</span>
          <input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="e.g. 245k" />
        </label>
        {error && <p className="note warn">{error}</p>}
        <button type="submit">Add link</button>
      </form>
    </details>
  );
}

function EditDetails({ property: p, onSave }: { property: Property; onSave(patch: Partial<Property>): void }) {
  const [f, setF] = useState({
    address: p.address ?? "",
    category: p.category,
    acreage: p.acreage?.toString() ?? "",
    bedrooms: p.bedrooms?.toString() ?? "",
    bathrooms: p.bathrooms?.toString() ?? "",
  });
  return (
    <form
      className="edit"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({
          address: f.address.trim() || undefined,
          category: f.category,
          acreage: parseNum(f.acreage),
          bedrooms: parseNum(f.bedrooms),
          bathrooms: parseNum(f.bathrooms),
        });
      }}
    >
      <label className="field">
        <span>Address</span>
        <input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} />
      </label>
      <label className="field">
        <span>Type</span>
        <select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value as PropertyCategory })}>
          {Object.entries(categoryLabel).map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <div className="pair three">
        <label className="field">
          <span>Acres</span>
          <input inputMode="decimal" value={f.acreage} onChange={(e) => setF({ ...f, acreage: e.target.value })} />
        </label>
        <label className="field">
          <span>Beds</span>
          <input inputMode="numeric" value={f.bedrooms} onChange={(e) => setF({ ...f, bedrooms: e.target.value })} />
        </label>
        <label className="field">
          <span>Baths</span>
          <input inputMode="decimal" value={f.bathrooms} onChange={(e) => setF({ ...f, bathrooms: e.target.value })} />
        </label>
      </div>
      <button type="submit">Save details</button>
    </form>
  );
}
