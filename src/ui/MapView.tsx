import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "leaflet.markercluster";
import "leaflet.markercluster/dist/MarkerCluster.css";
import type { LatLng, Property, SearchState } from "../domain/types";
import { displayPrice } from "../listings/collection";
import { loadTourism, type StateData } from "../services/data";
import type { PickMode, Selection } from "../state/store";
import { shortMoney } from "./format";
import { TourismOverlays } from "./tourismLayers";

const METERS_PER_MILE = 1609.344;

interface Props {
  data: StateData;
  search: SearchState;
  properties: Property[];
  selection: Selection;
  pick: PickMode;
  onSelectCounty(id: string): void;
  onSelectProperty(id: string): void;
  onPick(p: LatLng): void;
  onMoveCenter(p: LatLng): void;
  /** Bumped when the map should frame the search area (new center, new radius). */
  frameKey: number;
}

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function MapView(props: Props) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | undefined>(undefined);
  const counties = useRef<L.GeoJSON | undefined>(undefined);
  const circle = useRef<L.Circle | undefined>(undefined);
  const centerMarker = useRef<L.Marker | undefined>(undefined);
  const cluster = useRef<L.MarkerClusterGroup | undefined>(undefined);
  const markers = useRef(new Map<string, L.Marker>());
  const tourism = useRef<TourismOverlays | undefined>(undefined);
  const latest = useRef(props);
  latest.current = props;

  // One-time setup.
  useEffect(() => {
    const m = L.map(el.current!, { zoomControl: false, preferCanvas: false }).setView([39, -105.5], 7);
    map.current = m;
    L.control.zoom({ position: "topright" }).addTo(m);
    L.control.scale({ imperial: true, metric: false, position: "bottomright" }).addTo(m);

    const streets = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    });
    const topo = L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
      maxZoom: 17,
      attribution:
        'Map: &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA), data &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    });
    const satellite = L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      { maxZoom: 19, attribution: "Imagery &copy; Esri, Maxar, Earthstar Geographics" },
    );
    streets.addTo(m);
    tourism.current = new TourismOverlays(m, {
      load: () => loadTourism(latest.current.data.state.code),
      countyAt: (p) => {
        const d = latest.current.data;
        const id = d.index.locate(p);
        return id ? { id, name: d.areaById.get(id)?.name ?? id } : undefined;
      },
      onSelectCounty: (id) => latest.current.onSelectCounty(id),
    });
    L.control
      .layers({ Streets: streets, Topo: topo, Satellite: satellite }, tourism.current.overlays(), { position: "topright" })
      .addTo(m);

    counties.current = L.geoJSON(latest.current.data.geojson as any, {
      style: (f) => countyStyle(f!.properties.fips),
      onEachFeature: (f, layer) => {
        layer.bindTooltip(`${f.properties.name} County`, { sticky: true, direction: "top", className: "county-tip" });
        layer.on("click", (e: L.LeafletMouseEvent) => {
          L.DomEvent.stopPropagation(e);
          const p = latest.current;
          if (p.pick.kind !== "none") p.onPick({ lat: e.latlng.lat, lng: e.latlng.lng });
          else if (tourism.current?.active) tourism.current.openAt(e.latlng);
          else p.onSelectCounty(f.properties.fips);
        });
      },
    }).addTo(m);

    m.on("click", (e: L.LeafletMouseEvent) => {
      if (latest.current.pick.kind !== "none") latest.current.onPick({ lat: e.latlng.lat, lng: e.latlng.lng });
      else if (tourism.current?.active) tourism.current.openAt(e.latlng);
    });

    circle.current = L.circle([0, 0], { radius: 1, interactive: false, className: "search-circle" }).addTo(m);
    centerMarker.current = L.marker([0, 0], {
      draggable: true,
      keyboard: true,
      title: "Search center (drag to move)",
      icon: L.divIcon({ className: "center-pin", html: "<span></span>", iconSize: [22, 22] }),
    }).addTo(m);
    centerMarker.current.on("drag", (e: any) => circle.current!.setLatLng(e.target.getLatLng()));
    centerMarker.current.on("dragend", (e: any) => {
      const ll = e.target.getLatLng();
      latest.current.onMoveCenter({ lat: ll.lat, lng: ll.lng });
    });

    cluster.current = L.markerClusterGroup({
      showCoverageOnHover: false,
      maxClusterRadius: 44,
      iconCreateFunction: (c) =>
        L.divIcon({ className: "pin-cluster", html: `<span>${c.getChildCount()}</span>`, iconSize: [38, 38] }),
    }).addTo(m);
    tourism.current.restore();

    return () => {
      m.remove();
    };
  }, []);

  function countyStyle(fips: string): L.PathOptions {
    const p = latest.current;
    const state = p.search.counties[fips];
    const selected = p.selection?.kind === "county" && p.selection.id === fips;
    const ink = cssVar("--county-line");
    if (state === "include")
      return { color: cssVar("--include"), weight: selected ? 4 : 3, fillColor: cssVar("--include"), fillOpacity: 0.12, dashArray: undefined };
    if (state === "exclude")
      return { color: cssVar("--exclude"), weight: selected ? 4 : 2.5, fillColor: cssVar("--exclude"), fillOpacity: 0.22, dashArray: "6 5" };
    return { color: selected ? cssVar("--ink") : ink, weight: selected ? 3 : 1.2, fillColor: ink, fillOpacity: selected ? 0.08 : 0, dashArray: undefined };
  }

  // County styling follows include/exclude state and selection.
  useEffect(() => {
    counties.current?.setStyle((f) => countyStyle(f!.properties.fips));
  }, [props.search.counties, props.selection]);

  // Search circle and center.
  useEffect(() => {
    const { center, radiusMiles, limitToRadius } = props.search;
    circle.current!.setLatLng(center).setRadius(radiusMiles * METERS_PER_MILE);
    circle.current!.setStyle({ opacity: limitToRadius ? 1 : 0.35, fillOpacity: limitToRadius ? 0.05 : 0 });
    centerMarker.current!.setLatLng(center);
  }, [props.search.center, props.search.radiusMiles, props.search.limitToRadius]);

  useEffect(() => {
    map.current!.flyToBounds(circle.current!.getBounds(), { padding: [24, 24], duration: 0.6 });
  }, [props.frameKey]);

  // Property pins.
  useEffect(() => {
    const c = cluster.current!;
    c.clearLayers();
    markers.current.clear();
    const selectedId = props.selection?.kind === "property" ? props.selection.id : undefined;
    for (const p of props.properties) {
      const price = shortMoney(displayPrice(p));
      const cls = ["pin-tag", p.rating ?? "", p.category, p.id === selectedId ? "selected" : ""].join(" ");
      const marker = L.marker(p.location, {
        keyboard: true,
        title: `${price}${p.address ? `, ${p.address}` : ""}`,
        riseOnHover: true,
        zIndexOffset: p.id === selectedId ? 1000 : p.rating === "love" ? 500 : 0,
        icon: L.divIcon({ className: "pin", html: `<span class="${cls}">${price}</span>`, iconSize: undefined }),
      });
      marker.on("click", () => latest.current.onSelectProperty(p.id));
      markers.current.set(p.id, marker);
      c.addLayer(marker);
    }
  }, [props.properties, props.selection]);

  // Bring a selected property into view.
  useEffect(() => {
    if (props.selection?.kind !== "property") return;
    const marker = markers.current.get(props.selection.id);
    if (!marker) return;
    // Keep the pin clear of the details drawer (right side on desktop, bottom sheet on phones).
    const phone = window.innerWidth <= 760;
    const size = map.current!.getSize();
    const padding = phone ? L.point(20, size.y * 0.8) : L.point(Math.min(500, size.x * 0.55), 20);
    cluster.current!.zoomToShowLayer(marker, () =>
      map.current!.panInside(marker.getLatLng(), { paddingTopLeft: [20, 60], paddingBottomRight: padding }),
    );
  }, [props.selection]);

  useEffect(() => {
    el.current!.classList.toggle("picking", props.pick.kind !== "none");
  }, [props.pick]);

  return <div ref={el} className="map" role="application" aria-label="Map of listings and counties" />;
}
