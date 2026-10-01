// Map overlays for the tourism model: two toggleable heat layers, destination and lodging markers, click-to-explain
// popups, reach lines from a destination to where its visitors stay, and a legend.
import L from "leaflet";
import type { LatLng } from "../domain/types";
import { CATEGORY_LABELS, TourismModel, intensity, type Attraction, type StayDemand } from "../tourism/heat";

export type TourismMode = "interest" | "stays";

type Rgb = [number, number, number];
// Single-hue sequential ramps, light -> dark. Orange for interest, violet for stays, so both can show at once
// and neither collides with the include/exclude blue and red of the county outlines.
const RAMPS: Record<TourismMode, Rgb[]> = {
  interest: [[254, 230, 206], [253, 174, 107], [241, 105, 19], [204, 76, 2], [140, 45, 4]],
  stays: [[226, 220, 241], [188, 176, 222], [140, 117, 196], [102, 69, 168], [63, 0, 125]],
};
const TITLES: Record<TourismMode, string> = {
  interest: "Tourism: search interest",
  stays: "Tourism: where visitors stay",
};
const SAMPLE_PX = 4;
const STORAGE_KEY = "hh.tourismLayers";

function rampAt(mode: TourismMode, t: number): Rgb {
  const r = RAMPS[mode];
  const x = Math.min(0.9999, t) * (r.length - 1);
  const i = Math.floor(x);
  const f = x - i;
  return [0, 1, 2].map((k) => Math.round(r[i][k] + (r[i + 1][k] - r[i][k]) * f)) as Rgb;
}

function css(mode: TourismMode, t: number) {
  return `rgb(${rampAt(mode, t).join(",")})`;
}

class HeatLayer extends L.GridLayer {
  constructor(
    private mode: TourismMode,
    private model: () => Promise<TourismModel>,
  ) {
    super({ pane: "tourism", updateWhenZooming: false, keepBuffer: 1 });
  }

  protected createTile(coords: L.Coords, done: L.DoneCallback): HTMLElement {
    const size = this.getTileSize();
    const tile = document.createElement("canvas");
    tile.width = size.x;
    tile.height = size.y;
    const map = (this as any)._map as L.Map;
    this.model().then(
      (model) => {
        // The data may arrive after the layer was switched off or its map torn down.
        if (map && (this as any)._map === map) this.draw(tile, coords, model, map);
        done(undefined, tile);
      },
      (e) => done(e, tile),
    );
    return tile;
  }

  private draw(tile: HTMLCanvasElement, coords: L.Coords, model: TourismModel, map: L.Map) {
    const nx = Math.ceil(tile.width / SAMPLE_PX);
    const ny = Math.ceil(tile.height / SAMPLE_PX);
    const small = document.createElement("canvas");
    small.width = nx;
    small.height = ny;
    const sctx = small.getContext("2d")!;
    const img = sctx.createImageData(nx, ny);
    const origin = coords.scaleBy(this.getTileSize());
    const max = this.mode === "interest" ? model.maxInterest : model.maxStays;
    let any = false;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const ll = map.unproject([origin.x + (i + 0.5) * SAMPLE_PX, origin.y + (j + 0.5) * SAMPLE_PX], coords.z);
        const p = { lat: ll.lat, lng: ll.lng };
        const t = intensity(this.mode === "interest" ? model.interestAt(p) : model.staysAt(p), max);
        if (t <= 0) continue;
        any = true;
        const [r, g, b] = rampAt(this.mode, t);
        const o = (j * nx + i) * 4;
        img.data[o] = r;
        img.data[o + 1] = g;
        img.data[o + 2] = b;
        // Fade in from nothing so the edge of the reach doesn't draw a hard line.
        img.data[o + 3] = Math.round(255 * Math.min(1, t * 5) * (0.25 + 0.5 * t));
      }
    }
    if (!any) return;
    sctx.putImageData(img, 0, 0);
    const ctx = tile.getContext("2d")!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(small, 0, 0, tile.width, tile.height);
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: (Node | string)[]) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const miles = (m: number) => (m < 1 ? "here" : `${Math.round(m)} mi`);

export interface TourismOptions {
  load(): Promise<TourismModel>;
  /** County at a point, for the popup's link to the county panel. */
  countyAt(p: LatLng): { id: string; name: string } | undefined;
  onSelectCounty(id: string): void;
}

export class TourismOverlays {
  readonly layers: Record<TourismMode, L.Layer>;
  private model?: Promise<TourismModel>;
  private on = new Set<TourismMode>();
  private markers = L.layerGroup();
  private reach = L.layerGroup();
  private legend: L.Control;
  private legendBox = el("div", { className: "tourism-legend" });

  constructor(
    private map: L.Map,
    private opts: TourismOptions,
  ) {
    map.createPane("tourism").style.zIndex = "350"; // above tiles, below county outlines and pins
    map.getPane("tourism")!.style.pointerEvents = "none";
    const model = () => (this.model ??= opts.load());
    this.layers = { interest: new HeatLayer("interest", model), stays: new HeatLayer("stays", model) };

    const box = this.legendBox;
    const Legend = L.Control.extend({ onAdd: () => box });
    this.legend = new Legend({ position: "bottomleft" });
    L.DomEvent.disableClickPropagation(box);

    for (const mode of ["interest", "stays"] as TourismMode[]) {
      this.layers[mode].on("add", () => this.toggled(mode, true));
      this.layers[mode].on("remove", () => this.toggled(mode, false));
    }
    map.on("popupclose", () => this.reach.clearLayers());
    // Remember the user's choice. These fire only for layer-menu toggles, not when the map is torn down.
    const save = () => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify([...this.on]));
      } catch {
        /* not remembered; fine */
      }
    };
    map.on("overlayadd overlayremove", save);
  }

  /** Overlay entries for L.control.layers. */
  overlays(): Record<string, L.Layer> {
    return {
      [`<span class="overlay-swatch interest"></span>${TITLES.interest}`]: this.layers.interest,
      [`<span class="overlay-swatch stays"></span>${TITLES.stays}`]: this.layers.stays,
    };
  }

  /** Turns layers back on that were on last visit. */
  restore() {
    let saved: TourismMode[] = [];
    try {
      saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    } catch {
      /* storage unavailable: start with the overlays off */
    }
    for (const m of saved) if (m in this.layers) this.layers[m].addTo(this.map);
  }

  get active() {
    return this.on.size > 0;
  }

  private toggled(mode: TourismMode, on: boolean) {
    if (on) this.on.add(mode);
    else this.on.delete(mode);
    if (!this.active) {
      this.legend.remove();
      this.markers.remove();
      this.reach.clearLayers().remove();
      this.map.closePopup();
      return;
    }
    this.legend.addTo(this.map);
    this.markers.addTo(this.map);
    this.reach.addTo(this.map);
    (this.model ??= this.opts.load()).then(
      (m) => {
        this.drawMarkers(m);
        this.drawLegend(m);
      },
      () => this.legendBox.replaceChildren("Couldn't load the tourism data."),
    );
  }

  private drawMarkers(model: TourismModel) {
    this.markers.clearLayers();
    if (this.on.has("stays")) {
      for (const d of model.demand) {
        const m = L.circleMarker([d.base.lat, d.base.lng], {
          radius: 3 + 6 * Math.sqrt(d.weight / model.demand[0].weight),
          color: "#fff",
          weight: 1.5,
          fillColor: css("stays", 0.85),
          fillOpacity: 1,
        });
        m.bindTooltip(`Lodging: ${d.base.name}`, { direction: "top", className: "county-tip" });
        m.on("click", (e) => {
          L.DomEvent.stopPropagation(e);
          this.openBase(d, model);
        });
        this.markers.addLayer(m);
      }
    }
    const top = model.data.attractions[0].interest;
    for (const a of model.data.attractions) {
      const m = L.circleMarker([a.lat, a.lng], {
        radius: 3.5 + 7 * Math.sqrt(a.interest / top),
        color: "#fff",
        weight: 1.5,
        fillColor: css("interest", 0.9),
        fillOpacity: 1,
      });
      m.bindTooltip(a.name, { direction: "top", className: "county-tip" });
      m.on("click", (e) => {
        L.DomEvent.stopPropagation(e);
        this.openAttraction(a, model);
      });
      this.markers.addLayer(m);
    }
  }

  private drawLegend(model: TourismModel) {
    const src = model.data.source;
    const rows = (["interest", "stays"] as TourismMode[])
      .filter((m) => this.on.has(m))
      .map((mode) =>
        el(
          "div",
          { className: "legend-row" },
          el("strong", {}, mode === "interest" ? "Search interest" : "Where visitors stay"),
          el("span", { className: `legend-ramp ${mode}` }),
          el("span", { className: "legend-ends" }, el("span", {}, "Less"), el("span", {}, "More (log scale)")),
        ),
      );
    this.legendBox.replaceChildren(
      ...rows,
      el(
        "p",
        { className: "hint" },
        el("a", { href: src.url, target: "_blank", rel: "noopener noreferrer" }, src.name),
        `, ${src.geo} searches, ${src.timeframe} (to ${model.data.builtAt}). Lodging splits are estimates. Click the map or a dot for details.`,
      ),
    );
  }

  /** Popup for a map click while an overlay is on. */
  openAt(latlng: L.LatLng) {
    this.model?.then((model) => {
      const p = { lat: latlng.lat, lng: latlng.lng };
      const body = el("div", { className: "tourism-pop" });
      if (this.on.has("interest")) {
        const parts = model.interestParts(p).slice(0, 6);
        body.append(el("h4", {}, "Search interest here comes from"));
        body.append(
          parts.length
            ? el(
                "ol",
                {},
                ...parts.map((x) =>
                  el("li", {}, this.attractionButton(x.attraction, model), el("span", { className: "hint" }, ` ${pct(x.share)} · ${miles(x.miles)}`)),
                ),
              )
            : el("p", { className: "hint" }, "No tracked destination draws searches to this spot."),
        );
      }
      if (this.on.has("stays")) {
        const towns = model.stayParts(p).slice(0, 4);
        body.append(el("h4", {}, "Visitors lodging near here"));
        if (!towns.length) body.append(el("p", { className: "hint" }, "Outside the lodging reach of any tracked destination."));
        else {
          body.append(el("p", {}, "Stay in ", towns.map((t) => `${t.demand.base.name} (${pct(t.share)})`).join(", "), "."));
          // Which destinations bring them: each town's mix, weighted by how much of this spot it explains.
          const why = new Map<Attraction, number>();
          for (const t of towns)
            for (const f of t.demand.from) why.set(f.attraction, (why.get(f.attraction) ?? 0) + (t.share * f.weight) / t.demand.weight);
          const top = [...why].sort((x, y) => y[1] - x[1]).slice(0, 5);
          body.append(
            el("p", { className: "hint" }, "They come for:"),
            el("ol", {}, ...top.map(([a, w]) => el("li", {}, this.attractionButton(a, model), el("span", { className: "hint" }, ` ${pct(w)}`)))),
          );
        }
      }
      const county = this.opts.countyAt(p);
      if (county) {
        const b = el("button", { className: "link", type: "button" }, `${county.name} details`);
        b.onclick = () => {
          this.map.closePopup();
          this.opts.onSelectCounty(county.id);
        };
        body.append(b);
      }
      L.popup({ maxWidth: 320, autoPanPadding: [24, 24] }).setLatLng(latlng).setContent(body).openOn(this.map);
    });
  }

  private attractionButton(a: Attraction, model: TourismModel) {
    const b = el("button", { className: "link", type: "button", title: CATEGORY_LABELS[a.category] }, a.name);
    b.onclick = () => this.openAttraction(a, model);
    return b;
  }

  private openAttraction(a: Attraction, model: TourismModel) {
    const stays = Object.entries(a.stays)
      .map(([id, share]) => ({ base: model.data.bases[id], share }))
      .sort((x, y) => y.share - x.share);
    const rank = model.data.attractions.indexOf(a) + 1;
    const body = el(
      "div",
      { className: "tourism-pop" },
      el("h4", {}, a.name),
      el("p", { className: "hint" }, CATEGORY_LABELS[a.category], a.peakMonth ? ` · searches peak in ${a.peakMonth}` : ""),
      el(
        "p",
        {},
        `Search interest ${a.interest >= 1 ? Math.round(a.interest) : a.interest.toFixed(2)} on a 0-100 scale `,
        `(#${rank} of ${model.data.attractions.length} tracked).`,
      ),
      el("h4", {}, "Visitors stay in"),
      el("ol", {}, ...stays.map((s) => el("li", {}, `${s.base.name} `, el("span", { className: "hint" }, `${pct(s.share)} · ${miles(this.map.distance([a.lat, a.lng], [s.base.lat, s.base.lng]) / 1609.344)}`)))),
      el("p", { className: "hint" }, `Google Trends term: ${a.trendsTerm}. Lodging split is an estimate.`),
    );
    L.popup({ maxWidth: 320, autoPanPadding: [24, 24] }).setLatLng([a.lat, a.lng]).setContent(body).openOn(this.map);
    this.drawReach(a, stays);
  }

  private openBase(d: StayDemand, model: TourismModel) {
    const body = el(
      "div",
      { className: "tourism-pop" },
      el("h4", {}, `Lodging: ${d.base.name}`),
      el("p", { className: "hint" }, "Visitors who stay here come for:"),
      el(
        "ol",
        {},
        ...d.from.slice(0, 8).map((f) => el("li", {}, this.attractionButton(f.attraction, model), el("span", { className: "hint" }, ` ${pct(f.weight / d.weight)}`))),
      ),
    );
    L.popup({ maxWidth: 320, autoPanPadding: [24, 24] }).setLatLng([d.base.lat, d.base.lng]).setContent(body).openOn(this.map);
  }

  /** Lines from a destination to its lodging towns: how far its interest reaches. */
  private drawReach(a: Attraction, stays: { base: { name: string; lat: number; lng: number }; share: number }[]) {
    // Opening the new popup closed the old one (and cleared its lines) before this runs.
    for (const s of stays) {
      this.reach.addLayer(
        L.polyline(
          [
            [a.lat, a.lng],
            [s.base.lat, s.base.lng],
          ],
          { color: css("stays", 0.9), weight: 1.5 + 6 * s.share, opacity: 0.85, dashArray: "2 6", lineCap: "round", interactive: false },
        ),
      );
      this.reach.addLayer(
        L.circleMarker([s.base.lat, s.base.lng], { radius: 4, color: "#fff", weight: 1.5, fillColor: css("stays", 0.9), fillOpacity: 1, interactive: false }).bindTooltip(
          `${s.base.name} ${pct(s.share)}`,
          { permanent: true, direction: "right", className: "reach-tip" },
        ),
      );
    }
  }
}
