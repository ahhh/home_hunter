import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { LatLng } from "../domain/types";
import { inEffectiveArea } from "../geo/geo";
import { passesFilters, sortProperties } from "../listings/collection";
import { loadState, type StateData } from "../services/data";
import { reverseGeocode } from "../services/geocode";
import { parseListingUrl } from "../sources/sources";
import { readImportFile, type ImportOutcome } from "../state/importFile";
import { loadSaved, readShareHash, reducer, save, type SharePayload } from "../state/store";
import { AddListingDialog } from "./AddListingDialog";
import { CountyDetail } from "./CountyDetail";
import { ExportDialog } from "./ExportDialog";
import { ImportDialog } from "./ImportDialog";
import { MapView } from "./MapView";
import { PropertyDetail } from "./PropertyDetail";
import { SearchPanel } from "./SearchPanel";
import { ResultsList } from "./ResultsList";
import { ShareDialog } from "./ShareDialog";
import { IncomingShare } from "./IncomingShare";

type Dialog = "add" | "import" | "export" | "share" | null;

export function App() {
  const [data, setData] = useState<StateData>();
  const [loadError, setLoadError] = useState<string>();
  const [state, dispatch] = useReducer(reducer, undefined, loadSaved);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [frameKey, setFrameKey] = useState(0);
  const [incoming, setIncoming] = useState<SharePayload | undefined>(() => readShareHash(location.hash));
  const [sheetOpen, setSheetOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [droppedUrl, setDroppedUrl] = useState<string>();
  const [toast, setToast] = useState<ImportOutcome>();
  const latestState = useRef(state);
  latestState.current = state;

  useEffect(() => {
    loadState("CO").then(setData, (e) => setLoadError(String(e.message ?? e)));
  }, []);

  useEffect(() => save(state), [state.search, state.properties, state.userName, state.removedIds, state.seedAt]);

  // Drop a data bundle, export file or CSV anywhere on the page to import it,
  // or a listing link (from another tab or the address bar) to add it.
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) =>
      !!e.dataTransfer && (e.dataTransfer.types.includes("Files") || e.dataTransfer.types.includes("text/uri-list"));
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setDragging(true);
    };
    const onLeave = (e: DragEvent) => {
      if (hasFiles(e) && --depth <= 0) setDragging(false);
    };
    const onOver = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const onDrop = async (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const file = e.dataTransfer!.files[0];
      if (file) {
        const outcome = await readImportFile(file, latestState.current);
        if (outcome.action) dispatch(outcome.action);
        setToast(outcome);
        return;
      }
      const links = (e.dataTransfer!.getData("text/uri-list") || e.dataTransfer!.getData("text/plain"))
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#") && parseListingUrl(l));
      if (!links.length) {
        setToast({ ok: false, text: "That didn't contain a web link. Drag the listing's link or the address bar URL." });
        return;
      }
      setDroppedUrl(links[0]);
      setDialog("add");
      if (links.length > 1) setToast({ ok: true, text: `Dropped ${links.length} links; adding the first. Drop the others one at a time.` });
    };
    addEventListener("dragenter", onEnter);
    addEventListener("dragleave", onLeave);
    addEventListener("dragover", onOver);
    addEventListener("drop", onDrop);
    return () => {
      removeEventListener("dragenter", onEnter);
      removeEventListener("dragleave", onLeave);
      removeEventListener("dragover", onOver);
      removeEventListener("drop", onDrop);
    };
  }, []);

  useEffect(() => {
    if (!toast?.ok || toast.search) return;
    const t = setTimeout(() => setToast(undefined), 10000);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    const onHash = () => setIncoming(readShareHash(location.hash));
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);

  const { search, properties, selection } = state;

  // Phones: picking something closes the listings sheet so its details show over the map.
  useEffect(() => {
    if (selection || state.pick.kind !== "none") setSheetOpen(false);
  }, [selection, state.pick]);

  const countyOf = useMemo(() => {
    const m = new Map<string, string | undefined>();
    if (data) for (const p of properties) m.set(p.id, data.index.locate(p.location));
    return m;
  }, [data, properties]);

  const inArea = useMemo(
    () => properties.filter((p) => inEffectiveArea(p.location, countyOf.get(p.id), search)),
    [properties, countyOf, search.center, search.radiusMiles, search.limitToRadius, search.counties],
  );
  const visible = useMemo(
    () => sortProperties(inArea.filter((p) => passesFilters(p, search.filters)), search.sort, search.center),
    [inArea, search.filters, search.sort, search.center],
  );

  async function moveCenter(p: LatLng, label?: string, postcode?: string) {
    dispatch({ type: "setCenter", center: { ...p, label: label ?? "Dropped pin", postcode } });
    if (!label) {
      const r = await reverseGeocode(p).catch(() => undefined);
      if (r) dispatch({ type: "setCenter", center: { ...p, label: r.label, postcode: r.postcode } });
    }
  }

  function onPick(p: LatLng) {
    const pick = state.pick;
    if (pick.kind === "center") {
      moveCenter(p);
      setFrameKey((k) => k + 1);
    } else if (pick.kind === "place") {
      dispatch({ type: "updateProperty", id: pick.propertyId, patch: { location: p, locationPrecision: "exact" } });
      dispatch({ type: "setPick", pick: { kind: "none" } });
      dispatch({ type: "select", selection: { kind: "property", id: pick.propertyId } });
    }
  }

  if (loadError) return <p className="fatal">Couldn't load the county map: {loadError}. Reload the page to try again.</p>;
  if (!data) return <p className="fatal loading">Loading Colorado counties…</p>;

  const selectedProperty = selection?.kind === "property" ? properties.find((p) => p.id === selection.id) : undefined;
  const selectedCounty = selection?.kind === "county" ? data.areaById.get(selection.id) : undefined;
  const close = () => dispatch({ type: "select", selection: null });

  return (
    <div className={`app ${sheetOpen ? "sheet-open" : ""}`}>
      <aside className="panel" aria-label="Search and listings">
        <header className="brand">
          <h1>
            Home Hunter <span>Colorado</span>
          </h1>
          <nav className="brand-actions" aria-label="Listings">
            <button className="primary" onClick={() => setDialog("add")}>
              Add listing
            </button>
            <button onClick={() => setDialog("import")}>Import</button>
            <button onClick={() => setDialog("export")}>Export</button>
            <button onClick={() => setDialog("share")}>Share</button>
          </nav>
          <button className="sheet-toggle" onClick={() => setSheetOpen((o) => !o)} aria-expanded={sheetOpen}>
            {sheetOpen ? "Show map" : `Show ${visible.length} ${visible.length === 1 ? "listing" : "listings"}`}
          </button>
        </header>
        <div className="panel-scroll">
          <SearchPanel
            data={data}
            state={state}
            dispatch={dispatch}
            onMoveCenter={(p, label, postcode) => {
              moveCenter(p, label, postcode);
              setFrameKey((k) => k + 1);
            }}
            onFrame={() => setFrameKey((k) => k + 1)}
          />
          <ResultsList
            data={data}
            all={properties.length}
            inArea={inArea.length}
            visible={visible}
            countyOf={countyOf}
            search={search}
            selectedId={selectedProperty?.id}
            dispatch={dispatch}
            onAdd={() => setDialog("add")}
            onImport={() => setDialog("import")}
          />
        </div>
      </aside>

      <main className="map-wrap">
        {incoming && (
          <IncomingShare
            payload={incoming}
            existing={properties}
            onAccept={(withSearch) => {
              if (incoming.properties?.length) dispatch({ type: "mergeProperties", properties: incoming.properties });
              if (withSearch && incoming.search) {
                dispatch({ type: "applySearch", search: incoming.search });
                setFrameKey((k) => k + 1);
              }
              setIncoming(undefined);
              history.replaceState(null, "", location.pathname + location.search);
            }}
            onDismiss={() => {
              setIncoming(undefined);
              history.replaceState(null, "", location.pathname + location.search);
            }}
          />
        )}
        {state.pick.kind !== "none" && (
          <div className="pick-banner" role="status">
            {state.pick.kind === "center" ? "Click the map to move the search center." : "Click the map where this listing is."}
            <button onClick={() => dispatch({ type: "setPick", pick: { kind: "none" } })}>Cancel</button>
          </div>
        )}
        {toast && (
          <div className={`toast ${toast.ok ? "" : "warn"}`} role="status">
            <p>{toast.text}</p>
            {toast.search && (
              <button
                onClick={() => {
                  dispatch({ type: "applySearch", search: toast.search! });
                  setFrameKey((k) => k + 1);
                  setToast(undefined);
                }}
              >
                Use their search area
              </button>
            )}
            <button className="link" onClick={() => setToast(undefined)}>
              Dismiss
            </button>
          </div>
        )}
        <MapView
          data={data}
          search={search}
          properties={visible}
          selection={selection}
          pick={state.pick}
          frameKey={frameKey}
          onSelectCounty={(id) => dispatch({ type: "select", selection: { kind: "county", id } })}
          onSelectProperty={(id) => dispatch({ type: "select", selection: { kind: "property", id } })}
          onPick={onPick}
          onMoveCenter={(p) => moveCenter(p)}
        />
        {selectedProperty && (
          <PropertyDetail
            key={selectedProperty.id}
            property={selectedProperty}
            data={data}
            countyId={countyOf.get(selectedProperty.id)}
            center={search.center}
            hiddenReason={
              visible.includes(selectedProperty) ? undefined : inArea.includes(selectedProperty) ? "filters" : "area"
            }
            dispatch={dispatch}
            onClose={close}
          />
        )}
        {selectedCounty && (
          <CountyDetail
            key={selectedCounty.id}
            area={selectedCounty}
            data={data}
            search={search}
            listingCount={properties.filter((p) => countyOf.get(p.id) === selectedCounty.id).length}
            dispatch={dispatch}
            onClose={close}
          />
        )}
      </main>

      {dragging && (
        <div className="drop-overlay" aria-hidden="true">
          <p>Drop to add listings</p>
          <span>Listing link, data bundle, Home Hunter export or Redfin CSV</span>
        </div>
      )}
      {dialog === "add" && (
        <AddListingDialog
          initialUrl={droppedUrl}
          userName={state.userName}
          center={search.center}
          dispatch={dispatch}
          onClose={() => {
            setDialog(null);
            setDroppedUrl(undefined);
          }}
        />
      )}
      {dialog === "import" && (
        <ImportDialog
          state={state}
          dispatch={dispatch}
          onClose={() => setDialog(null)}
          onUseSearch={(search) => {
            dispatch({ type: "applySearch", search });
            setFrameKey((k) => k + 1);
          }}
        />
      )}
      {dialog === "export" && (
        <ExportDialog state={state} visible={visible} dispatch={dispatch} onClose={() => setDialog(null)} />
      )}
      {dialog === "share" && (
        <ShareDialog state={state} visible={visible} dispatch={dispatch} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}
