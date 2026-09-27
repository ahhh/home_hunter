import { useState, type Dispatch } from "react";
import type { LatLng, Property, PropertyCategory } from "../domain/types";
import { stableId } from "../listings/collection";
import { geocode } from "../services/geocode";
import { parseListingUrl, providerIdFor } from "../sources/sources";
import type { Action } from "../state/store";
import { parseMoney, parseNum } from "./format";
import { Modal } from "./Modal";

interface Props {
  initialUrl?: string;
  userName: string;
  center: LatLng;
  dispatch: Dispatch<Action>;
  onClose(): void;
}

export function AddListingDialog({ initialUrl, userName, center, dispatch, onClose }: Props) {
  const [url, setUrl] = useState(initialUrl ?? "");
  const [address, setAddress] = useState(() => (initialUrl && parseListingUrl(initialUrl)?.address) || "");
  const [addressTouched, setAddressTouched] = useState(false);
  const [price, setPrice] = useState("");
  const [category, setCategory] = useState<PropertyCategory>("unknown");
  const [acreage, setAcreage] = useState("");
  const [beds, setBeds] = useState("");
  const [baths, setBaths] = useState("");
  const [name, setName] = useState(userName);
  const [placeMyself, setPlaceMyself] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const parsed = url ? parseListingUrl(url) : undefined;

  function onUrl(v: string) {
    setUrl(v);
    const p = parseListingUrl(v);
    if (p?.address && !addressTouched) setAddress(p.address);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!parsed) return setError("Paste the full link from the listing page (it starts with https://).");
    const priceValue = parseMoney(price);
    if (price && priceValue === undefined) return setError('Enter the price as a number, like 245000 or 245k.');
    setError(undefined);
    setBusy(true);

    const now = new Date().toISOString();
    let location: LatLng = center;
    let found = false;
    if (address.trim() && !placeMyself) {
      try {
        const [hit] = await geocode(address, 1);
        if (hit) {
          location = hit;
          found = true;
        } else {
          // Rural addresses often aren't in OpenStreetMap; start the pin at the ZIP and ask for a click.
          const zip = address.match(/\b\d{5}\b/)?.[0];
          const [near] = zip ? await geocode(`${zip}, USA`, 1) : [];
          if (near) location = near;
        }
      } catch {
        // Fall through to placing the pin by hand.
      }
    }

    const property: Property = {
      id: stableId(parsed.canonicalUrl),
      location,
      locationPrecision: "approximate",
      address: address.trim() || undefined,
      category,
      acreage: parseNum(acreage),
      bedrooms: category === "vacant_land" ? undefined : parseNum(beds),
      bathrooms: category === "vacant_land" ? undefined : parseNum(baths),
      listings: [
        {
          provider: providerIdFor(parsed),
          providerListingId: parsed.providerListingId,
          canonicalUrl: parsed.canonicalUrl,
          status: "active",
          price: priceValue,
          fetchedAt: now,
        },
      ],
      addedBy: name.trim() || undefined,
      addedAt: now,
    };
    if (name.trim() !== userName) dispatch({ type: "setUserName", name: name.trim() });
    dispatch({ type: "mergeProperties", properties: [property] });
    dispatch({ type: "select", selection: { kind: "property", id: property.id } });
    if (!found) dispatch({ type: "setPick", pick: { kind: "place", propertyId: property.id } });
    setBusy(false);
    onClose();
  }

  return (
    <Modal title="Add a listing" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <label className="field">
          <span>Listing link</span>
          <input
            type="url"
            required
            autoFocus
            placeholder="https://www.zillow.com/homedetails/…"
            value={url}
            onChange={(e) => onUrl(e.target.value)}
          />
        </label>
        {parsed && (
          <p className="hint">
            {parsed.source.id === "other" ? `Link to ${new URL(parsed.canonicalUrl).hostname}.` : `${parsed.source.label} listing.`}{" "}
            {parsed.address ? "Address found in the link." : "No address in this link, so you'll click the map to place it."}
          </p>
        )}
        <label className="field">
          <span>Price</span>
          <input inputMode="decimal" placeholder="e.g. 245k" value={price} onChange={(e) => setPrice(e.target.value)} />
        </label>
        <label className="field">
          <span>Address</span>
          <input
            placeholder="Optional; used to place the pin"
            value={address}
            onChange={(e) => {
              setAddress(e.target.value);
              setAddressTouched(true);
            }}
          />
        </label>
        <div className="seg" role="group" aria-label="Property type">
          {(
            [
              ["vacant_land", "Vacant land"],
              ["improved", "Home"],
              ["unknown", "Not sure"],
            ] as const
          ).map(([v, label]) => (
            <button type="button" key={v} aria-pressed={category === v} onClick={() => setCategory(v)}>
              {label}
            </button>
          ))}
        </div>
        <div className={`pair ${category === "vacant_land" ? "" : "three"}`}>
          <label className="field">
            <span>Acres</span>
            <input inputMode="decimal" value={acreage} onChange={(e) => setAcreage(e.target.value)} />
          </label>
          {category !== "vacant_land" && (
            <>
              <label className="field">
                <span>Beds</span>
                <input inputMode="numeric" value={beds} onChange={(e) => setBeds(e.target.value)} />
              </label>
              <label className="field">
                <span>Baths</span>
                <input inputMode="decimal" value={baths} onChange={(e) => setBaths(e.target.value)} />
              </label>
            </>
          )}
        </div>
        <label className="field">
          <span>Your name</span>
          <input placeholder="Shows friends who found it" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="check">
          <input type="checkbox" checked={placeMyself} onChange={(e) => setPlaceMyself(e.target.checked)} />
          I'll click the map to place the pin
        </label>
        {error && <p className="note warn">{error}</p>}
        <div className="row end">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? "Finding address…" : "Add to map"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
