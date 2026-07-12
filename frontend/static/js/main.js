// NDMA Flood WebGIS frontend — presentation only. All agent logic lives
// in the Python agents\ modules, reached through the Flask API (/api/...).

/* ---------------- map ---------------- */
const map = L.map("map", { zoomControl: false }).setView([31.5, 72.5], 6);

const basemaps = {
  dark: L.tileLayer(
    "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    { maxZoom: 19, attribution: "&copy; OpenStreetMap &copy; CARTO" }),
  satellite: L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 19, attribution: "Esri World Imagery" }),
};
let currentBasemap = "dark";
basemaps.dark.addTo(map);

L.control.scale({ imperial: false, position: "bottomleft" }).addTo(map);

const BASIN_VIEWS = {
  chenab: [[32.2, 74.0], 7], jhelum: [[33.3, 73.8], 8], ravi: [[31.4, 74.3], 8],
  sutlej: [[30.5, 73.8], 8], indus: [[30.0, 70.5], 6],
};

/* ---------------- element handles ---------------- */
const $ = (id) => document.getElementById(id);
const backendStatus = $("backend-status");
const basinSelect = $("basin-select");

/* ---------------- 3D globe view (MapLibre, globe projection) ----------------
   The portal opens on a spinning satellite globe; 🌍 toggles back to the
   flat Leaflet map (drawing/measuring live there). Every AOI selection,
   station/city result and default EE raster is mirrored onto the globe,
   so prompts and manual picks reflect on it immediately. */
let globe = null, globeOn = false, globeSpin = true;
let globeMarkers = [];
let globeEeIds = [];
const globeEl = document.getElementById("globe-map");

function initGlobe() {
  if (globe || typeof maplibregl === "undefined") return;
  globe = new maplibregl.Map({
    container: "globe-map",
    style: {
      version: 8,
      projection: { type: "globe" },
      sources: {
        sat: {
          type: "raster", tileSize: 256, attribution: "Esri World Imagery",
          tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
        },
        aoi: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
      },
      layers: [
        { id: "sat", type: "raster", source: "sat" },
        { id: "aoi-line", type: "line", source: "aoi",
          paint: { "line-color": "#35c48d", "line-width": 2.5,
                   "line-dasharray": [2, 1.5] } },
      ],
      sky: { "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 1, 7, 0] },
    },
    center: [70.5, 29.5], zoom: 2.05, attributionControl: false,
  });
  globe.on("mousemove", (e) => {
    $("coords").textContent =
      `${e.lngLat.lat.toFixed(4)}°N, ${e.lngLat.lng.toFixed(4)}°E`;
  });
  // idle spin until the user interacts or picks an AOI
  ["mousedown", "wheel", "touchstart"].forEach((ev) =>
    globeEl.addEventListener(ev, () => (globeSpin = false)));
  const spinStep = () => {
    if (!globe || !globeOn || !globeSpin) return;
    const c = globe.getCenter();
    globe.easeTo({ center: [c.lng + 10, c.lat], duration: 2800, easing: (n) => n });
  };
  globe.on("moveend", () => { if (globeSpin) spinStep(); });
  globe.once("load", spinStep);
}

function globeReady(cb) {
  if (!globe) return;
  if (globe.loaded()) cb(); else globe.once("load", cb);
}

function globeSetOutline(gj) {
  globeReady(() => globe.getSource("aoi") && globe.getSource("aoi").setData(gj));
}

let globePendingBounds = null; // camera move queued while the globe is hidden

function globeFlyTo(bounds) { // Leaflet LatLngBounds -> globe camera
  globeSpin = false;
  if (!globe) return;
  if (!globeOn) { globePendingBounds = bounds; return; } // hidden = size 0
  globe.fitBounds(
    [[bounds.getWest(), bounds.getSouth()], [bounds.getEast(), bounds.getNorth()]],
    { padding: 90, duration: 2400, maxZoom: 7.5 });
}

function globeClearMarkers(kind) {
  globeMarkers = globeMarkers.filter((m) => {
    if (m._kind === kind) { m.remove(); return false; }
    return true;
  });
}

function globeAddMarker(kind, lat, lon, color, pulse, popupHtml) {
  if (!globe) return;
  const el = document.createElement("div");
  el.className = "gm" + (pulse ? " pulse" : "");
  el.style.setProperty("--gm-color", color);
  const m = new maplibregl.Marker({ element: el })
    .setLngLat([lon, lat])
    .setPopup(new maplibregl.Popup({ offset: 12 }).setHTML(popupHtml))
    .addTo(globe);
  m._kind = kind;
  globeMarkers.push(m);
}

// mirror the agents' Earth Engine rasters that are ON by default
function globeSetEeLayers(defs) {
  globeReady(() => {
    globeEeIds.forEach((id) => {
      if (globe.getLayer(id)) globe.removeLayer(id);
      if (globe.getSource(id)) globe.removeSource(id);
    });
    globeEeIds = [];
    defs.filter((d) => d.default_on && d.url && d.type !== "geojson" && d.type !== "urban")
      .forEach((d) => globeToggleEe(d, true));
  });
}

function globeToggleEe(def, on) {
  if (!globe) return;
  globeReady(() => {
    const id = `ee-${def.id}`;
    if (on) {
      if (globe.getSource(id)) return;
      globe.addSource(id, { type: "raster", tiles: [def.url], tileSize: 256 });
      globe.addLayer({ id, type: "raster", source: id,
        paint: { "raster-opacity": 0.8 } }, "aoi-line");
      globeEeIds.push(id);
    } else {
      if (globe.getLayer(id)) globe.removeLayer(id);
      if (globe.getSource(id)) globe.removeSource(id);
      globeEeIds = globeEeIds.filter((x) => x !== id);
    }
  });
}

function setGlobeView(on) {
  globeOn = on;
  const btn = $("ctrl-globe");
  if (on) {
    initGlobe();
    globeEl.classList.remove("hidden");
    if (globe) {
      globe.resize();
      if (globePendingBounds) { // AOI picked while the globe was hidden
        const b = globePendingBounds;
        globePendingBounds = null;
        globe.fitBounds(
          [[b.getWest(), b.getSouth()], [b.getEast(), b.getNorth()]],
          { padding: 90, duration: 2400, maxZoom: 7.5 });
      }
    }
    btn.classList.add("active");
    btn.textContent = "🗺️";
    btn.title = "Switch to flat map";
  } else {
    globeEl.classList.add("hidden");
    btn.classList.remove("active");
    btn.textContent = "🌍";
    btn.title = "Switch to 3D globe";
    map.invalidateSize();
  }
}

/* ---------------- backend health (silent unless broken) ---------------- */
fetch("/api/health")
  .then((r) => r.json())
  .then((d) => {
    if (d.status !== "ok") { backendStatus.textContent = "backend error"; backendStatus.className = "err"; }
  })
  .catch(() => { backendStatus.textContent = "backend unreachable"; backendStatus.className = "err"; });

/* ---------------- panels: collapse + drag ---------------- */
function setupPanel(panelId, handleId, collapseId) {
  const panel = $(panelId);
  $(collapseId).addEventListener("click", (e) => {
    e.stopPropagation();
    panel.classList.toggle("collapsed");
    e.target.textContent = panel.classList.contains("collapsed") ? "+" : "−";
  });
  // drag via header
  const handle = $(handleId);
  let drag = null;
  handle.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".icon-btn")) return;
    const rect = panel.getBoundingClientRect();
    drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener("pointermove", (e) => {
    if (!drag) return;
    panel.style.left = Math.max(4, Math.min(innerWidth - 60, e.clientX - drag.dx)) + "px";
    panel.style.top = Math.max(4, Math.min(innerHeight - 40, e.clientY - drag.dy)) + "px";
    panel.style.right = "auto";
  });
  handle.addEventListener("pointerup", () => (drag = null));
}
setupPanel("layers-panel", "layers-drag-handle", "layers-collapse");
setupPanel("assess-panel", "assess-drag-handle", "assess-collapse");
setupPanel("map-legend", "legend-drag-handle", "legend-collapse");

/* ---------------- GIS layers panel ---------------- */
const leafletLayers = {};   // layer id -> L.TileLayer / L.GeoJSON
const layerMeta = {};       // layer id -> def (for lazy geojson loading)
let stationLayer = null;
let outlineLayer = null;

// value -> colour along a palette (for choropleths)
function paletteColor(value, legend) {
  if (value == null) return "#555";
  const p = legend.palette;
  const t = Math.max(0, Math.min(1, (value - legend.min) / (legend.max - legend.min)));
  return `#${p[Math.min(p.length - 1, Math.floor(t * p.length))]}`;
}

const _geojsonDataCache = {}; // data_url -> parsed GeoJSON (obs+fcst variants share one fetch)

async function fetchGeojsonData(url) {
  if (!_geojsonDataCache[url]) _geojsonDataCache[url] = await (await fetch(url)).json();
  return _geojsonDataCache[url];
}

async function ensureGeojsonLayer(def, opacity) {
  if (leafletLayers[def.id]) return leafletLayers[def.id];
  const gj = await fetchGeojsonData(def.data_url);
  const valueField = def.value_field || "obs72_mm";
  const layer = L.geoJSON(gj, {
    style: (f) => ({
      color: "#0c1210", weight: 1,
      fillColor: paletteColor(f.properties[valueField], def.legend),
      fillOpacity: opacity,
    }),
    onEachFeature: (f, l) => {
      const p = f.properties;
      const label = (n) => (!n || n === "Administrative unit not available")
        ? "Disputed / unnamed area (GAUL)" : n;
      const province = p.province && p.province !== p.name
        ? ` <small>(${label(p.province)})</small>` : "";
      l.bindPopup(
        `<b>${label(p.name)}</b>${province}<br>` +
        `Forecast next 72h: ${p.fcst72_mm == null ? "n/a" : p.fcst72_mm.toFixed(1) + " mm"}<br>` +
        `Observed last 72h: ${p.obs72_mm == null ? "n/a" : p.obs72_mm.toFixed(1) + " mm"}`);
      // value printed on the polygon itself, so no clicking needed
      if (p[valueField] != null) {
        l.bindTooltip(`${p[valueField].toFixed(0)} mm`, {
          permanent: true, direction: "center", className: "poly-label",
        });
      }
    },
  });
  layer._isChoropleth = true;
  leafletLayers[def.id] = layer;
  return layer;
}

function legendHtml(legend) {
  if (!legend) return "";
  if (legend.type === "gradient") {
    const stops = legend.palette.map((c) => `#${c}`).join(", ");
    return `<div class="legend">
      <div class="legend-gradient" style="background: linear-gradient(90deg, ${stops});"></div>
      <div class="legend-labels"><span>${legend.min}${legend.unit}</span><span>${legend.max}${legend.unit}</span></div>
    </div>`;
  }
  if (legend.type === "categories") {
    return `<div class="legend">` + legend.items.map(([color, label]) =>
      `<span class="legend-swatch"><i style="background:${color}"></i>${label}</span>`
    ).join("") + `</div>`;
  }
  return `<div class="legend"><span class="legend-swatch">
    <i style="background:${legend.color}"></i>${legend.label}</span></div>`;
}

// on-map legend: floating panel showing the colour scale of every
// layer currently ON (drag/collapse wired via setupPanel above)
function updateMapLegend() {
  const panel = $("map-legend");
  const entries = Object.values(layerMeta)
    .filter((d) => d.legend && document.getElementById(`chk-${d.id}`)?.checked)
    .map((d) =>
      `<div class="map-legend-entry">
         <div class="map-legend-title">${d.name}</div>
         ${legendHtml(d.legend)}
       </div>`);
  $("legend-body").innerHTML = entries.join("");
  panel.style.display = entries.length ? "" : "none";
}

function renderLayerPanel(defs) {
  const groupsEl = $("layer-groups");
  groupsEl.innerHTML = "";
  const groups = {};
  defs.forEach((d) => (groups[d.group] = groups[d.group] || []).push(d));

  Object.entries(groups).forEach(([groupName, items]) => {
    const groupEl = document.createElement("div");
    groupEl.className = "layer-group";
    groupEl.innerHTML =
      `<div class="group-header">
         <input type="checkbox" class="group-master" title="Toggle every ${groupName} layer">
         <span class="group-caret">▼</span>${groupName}
       </div>
       <div class="group-items"></div>`;
    groupEl.querySelector(".group-header").addEventListener("click", (e) => {
      if (e.target.classList.contains("group-master")) return; // checkbox ≠ collapse
      groupEl.classList.toggle("closed");
    });
    const itemsEl = groupEl.querySelector(".group-items");

    // group master: one click switches EVERY layer in the group on/off
    const master = groupEl.querySelector(".group-master");
    const groupChks = () =>
      [...itemsEl.querySelectorAll('.layer-row input[type="checkbox"]')];
    function syncMaster() {
      const chks = groupChks();
      const on = chks.filter((c) => c.checked).length;
      master.checked = on > 0 && on === chks.length;
      master.indeterminate = on > 0 && on < chks.length;
    }
    master.addEventListener("change", () => {
      groupChks().forEach((chk) => {
        if (chk.checked !== master.checked) {
          chk.checked = master.checked;
          chk.dispatchEvent(new Event("change")); // reuse per-layer logic (incl. lazy loads)
        }
      });
      syncMaster();
    });
    itemsEl.addEventListener("change", syncMaster);
    setTimeout(syncMaster, 0); // after items are appended below

    items.forEach((d) => {
      const item = document.createElement("div");
      item.className = "layer-item";
      item.dataset.name = `${d.name} ${groupName}`.toLowerCase();
      item.innerHTML =
        `<div class="layer-row">
           <input type="checkbox" id="chk-${d.id}" ${d.default_on ? "checked" : ""}>
           <label for="chk-${d.id}">${d.name}</label>
         </div>
         <div class="layer-extras">
           <div class="opacity-row">
             <input type="range" min="0" max="100" value="80" id="op-${d.id}">
             <span class="opacity-val" id="opv-${d.id}">80%</span>
           </div>
           ${legendHtml(d.legend)}
         </div>`;
      itemsEl.appendChild(item);

      const chk = item.querySelector(`#chk-${d.id}`);
      const slider = item.querySelector(`#op-${d.id}`);
      const sliderVal = item.querySelector(`#opv-${d.id}`);
      chk.addEventListener("change", async () => {
        if (d.type === "urban") {
          // marker layer fed by the urban-flood agent — first enable
          // runs the nationwide scan (a few seconds)
          if (chk.checked) {
            item.style.opacity = 0.5;
            try {
              if (!leafletLayers[d.id]) {
                const data = await (await fetch(d.data_url)).json();
                if (data.status !== "ok") throw data.error || "urban scan failed";
                leafletLayers[d.id] = buildUrbanLayer(data, slider.value / 100);
                leafletLayers[d.id]._isChoropleth = true; // fillOpacity slider
              }
              leafletLayers[d.id].addTo(map);
            } catch (err) {
              alert(`Layer failed: ${err}`);
              chk.checked = false;
            }
            item.style.opacity = 1;
          } else {
            leafletLayers[d.id] && map.removeLayer(leafletLayers[d.id]);
          }
          updateMapLegend();
          return;
        }
        if (d.type === "geojson") {
          // choropleths load lazily on first enable (EE aggregation)
          if (chk.checked) {
            item.style.opacity = 0.5;
            try {
              const layer = await ensureGeojsonLayer(d, slider.value / 100);
              layer.addTo(map);
            } catch (err) {
              alert(`Layer failed: ${err}`);
              chk.checked = false;
            }
            item.style.opacity = 1;
          } else {
            leafletLayers[d.id] && map.removeLayer(leafletLayers[d.id]);
          }
          updateMapLegend();
          return;
        }
        const layer = leafletLayers[d.id];
        if (!layer) return;
        chk.checked ? layer.addTo(map) : map.removeLayer(layer);
        globeToggleEe(d, chk.checked); // keep the 3D globe in sync
        updateMapLegend();
      });
      slider.addEventListener("input", () => {
        sliderVal.textContent = `${slider.value}%`;
        const layer = leafletLayers[d.id];
        if (!layer) return;
        if (layer._isChoropleth) {
          layer.setStyle({ fillOpacity: slider.value / 100 });
        } else {
          layer.setOpacity(slider.value / 100);
        }
      });
    });
    groupsEl.appendChild(groupEl);
  });
}

$("layer-search").addEventListener("input", (e) => {
  const q = e.target.value.toLowerCase().trim();
  document.querySelectorAll(".layer-item").forEach((el) => {
    el.style.display = !q || el.dataset.name.includes(q) ? "" : "none";
  });
  document.querySelectorAll(".layer-group").forEach((g) => {
    const any = [...g.querySelectorAll(".layer-item")].some((el) => el.style.display !== "none");
    g.style.display = any ? "" : "none";
  });
});

async function loadLayers(basin) {
  // remove existing EE layers
  Object.values(leafletLayers).forEach((l) => map.removeLayer(l));
  for (const k of Object.keys(leafletLayers)) delete leafletLayers[k];
  $("layer-groups").innerHTML =
    '<div class="legend-swatch" style="padding:0.4rem">Loading layers…</div>';

  try {
    const defs = await (await fetch(`/api/layers?basin=${encodeURIComponent(basin)}`)).json();
    defs.forEach((d) => {
      layerMeta[d.id] = d;
      if (d.type === "geojson" || d.type === "urban") return; // lazy on first enable
      leafletLayers[d.id] = L.tileLayer(d.url, { opacity: 0.8, maxZoom: 14 });
      if (d.default_on) leafletLayers[d.id].addTo(map);
    });
    renderLayerPanel(defs);
    updateMapLegend();
    globeSetEeLayers(defs); // same rasters on the 3D globe
  } catch (err) {
    $("layer-groups").innerHTML =
      `<div class="legend-swatch" style="padding:0.4rem">Layer service failed: ${err}</div>`;
  }

  // AOI outline (basin or admin unit)
  try {
    if (outlineLayer) map.removeLayer(outlineLayer);
    const gj = await (await fetch(`/api/basin_outline?basin=${encodeURIComponent(basin)}`)).json();
    outlineLayer = L.geoJSON(gj, {
      style: { color: "#35c48d", weight: 2, fill: false, dashArray: "6 4" },
    }).addTo(map);
    // admin units have no preset view — zoom to the outline instead
    if (!BASIN_VIEWS[basin]) map.fitBounds(outlineLayer.getBounds(), { padding: [40, 40] });
    // mirror the AOI on the 3D globe and fly the camera to it
    globeSetOutline(gj);
    globeFlyTo(outlineLayer.getBounds());
  } catch { /* outline is cosmetic */ }
}

/* ---------------- AOIs (basins + admin units) + stations ---------------- */
let basinsMeta = [];
const allStations = {}; // station name -> {name, lat, lon} across all basins

// Master AOI list; the <select> is re-rendered from it so the search
// box can filter 100+ districts without losing the current selection.
let aoiEntries = []; // [{group, value, label}]

function renderAoiOptions() {
  const query = ($("aoi-search").value || "").trim().toLowerCase();
  const current = basinSelect.value;
  basinSelect.innerHTML = "";
  basinSelect.appendChild(phOption);
  const groups = new Map();
  aoiEntries.forEach((e) => {
    // drawn box + current selection always stay visible
    if (query && e.group !== "Custom" && e.value !== current &&
        !e.label.toLowerCase().includes(query)) return;
    if (!groups.has(e.group)) groups.set(e.group, []);
    groups.get(e.group).push(e);
  });
  groups.forEach((entries, label) => {
    const group = document.createElement("optgroup");
    group.label = label;
    entries.forEach((e) => {
      const opt = document.createElement("option");
      opt.value = e.value;
      opt.textContent = e.label;
      group.appendChild(opt);
    });
    basinSelect.appendChild(group);
  });
  if ([...basinSelect.options].some((o) => o.value === current)) {
    basinSelect.value = current;
  } else {
    phOption.selected = true;
  }
}

// Nothing loads until the user picks an AOI — no default basin.
function updateActionState() {
  const ready = !!basinSelect.value;
  document.querySelectorAll(".pipe-btn").forEach((b) =>
    (b.disabled = !ready && b.dataset.pipe !== "urban")); // urban = nationwide
  $("run-risk").disabled = !ready;
  $("assess-placeholder").style.display = ready ? "none" : "";
}
updateActionState();

const phOption = document.createElement("option");
phOption.value = "";
phOption.textContent = "Select AOI / basin…";
phOption.disabled = true;
phOption.selected = true;
basinSelect.appendChild(phOption);
$("layer-groups").innerHTML =
  '<div class="legend-swatch" style="padding:0.4rem">Select an AOI to load layers</div>';

Promise.all([
  fetch("/api/basins").then((r) => r.json()),
  fetch("/api/admin_units").then((r) => r.json()).catch(() => null),
]).then(([basins, admin]) => {
  basinsMeta = basins;
  basins.forEach((b) => b.stations.forEach((s) => (allStations[s.name] = s)));
  aoiEntries.push(...basins.map((b) => ({ group: "River basins", value: b.key, label: b.name })));
  if (admin && !admin.error) {
    // "District" is redundant with the group header — drop it so the
    // dropdown doesn't stretch the panel with long option text.
    const short = (n) => n.replace(/\s+District$/i, "");
    aoiEntries.push(...admin.provinces.map((p) =>
      ({ group: "Provinces", value: `province:${p.name}`, label: p.name })));
    aoiEntries.push(...admin.districts.map((d) =>
      ({ group: "Districts", value: `district:${d.name}`, label: `${short(d.name)} (${d.province})` })));
  }
  renderAoiOptions();
  updateActionState();
  restoreSession();
});

// Bring back whatever the panel/map was showing before the user visited
// a dashboard page — results are re-rendered from the cached agent JSON,
// never re-run. Freshness window matches the dashboards (30 min).
function restoreSession() {
  // A fresh login opens the portal clean: nothing is selected, loaded
  // or restored until the user acts. The previous session's cached
  // panel pointer is dropped so it cannot come back later either.
  if (window.FRESH_LOGIN) {
    try { localStorage.removeItem("pakclimint.lastPanel"); } catch { /* ignore */ }
    return;
  }
  let last = null;
  try { last = JSON.parse(localStorage.getItem("pakclimint.lastPanel")); } catch { /* ignore */ }
  if (!last || Date.now() - last.ts > 30 * 60 * 1000) return;
  const spec = last.spec;
  if (spec.startsWith("bbox:") &&
      !aoiEntries.some((e) => e.value === spec)) {
    aoiEntries.unshift({ group: "Custom", value: spec, label: "▦ Drawn box" });
    renderAoiOptions();
  }
  // urban runs nationwide (spec "pakistan") without an AOI selection
  if ([...basinSelect.options].some((o) => o.value === spec)) {
    basinSelect.value = spec;
    updateActionState();
    switchBasin(spec);
  } else if (spec !== "pakistan") {
    return;
  }
  try {
    if (last.kind === "risk") {
      const c = JSON.parse(localStorage.getItem("pakclimint.lastRisk"));
      if (c && c.spec === spec && c.data?.risk_level) {
        renderRiskResult(spec, c.data);
        $("pipeline-result").innerHTML +=
          `<a class="dash-link" href="/risk">📊 Click here to see the full report →</a>`;
      }
    } else {
      const c = JSON.parse(localStorage.getItem(`pakclimint.agent.${last.name}.${spec}`));
      if (c?.data) {
        showPipelineResult(last.name, spec, c.data);
        const btn = document.querySelector(`.pipe-btn[data-pipe="${last.name}"]`);
        if (btn) btn.classList.add("done");
      }
    }
  } catch { /* cached JSON unreadable — panel simply stays empty */ }
}

$("aoi-search").addEventListener("input", renderAoiOptions);
$("aoi-search").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault(); // pick the first match
  const first = [...basinSelect.options].find((o) => o.value);
  if (first) {
    basinSelect.value = first.value;
    basinSelect.dispatchEvent(new Event("change"));
  }
});

function drawStations(aoiValue, riskData) {
  if (stationLayer) { map.removeLayer(stationLayer); stationLayer = null; }
  const meta = basinsMeta.find((b) => b.key === aoiValue);
  // basin: its registered stations; admin unit: whichever registered
  // stations the river agent actually used (from the response)
  const stations = meta
    ? meta.stations
    : Object.keys(riskData?.agents?.river?.stations || {})
        .map((n) => allStations[n]).filter(Boolean);
  if (!stations.length) return;
  const catColor = { normal: "#35c48d", low: "#f0c53f", medium: "#ef6c00",
                     high: "#c62828", very_high: "#8e24aa", exceptional: "#4a0d67" };
  globeClearMarkers("station");
  stationLayer = L.layerGroup(stations.map((s) => {
    const st = riskData?.agents?.river?.stations?.[s.name];
    const color = catColor[st?.flood_category] || "#888";
    const popup =
      `<b>${s.name}</b><br>` +
      (st ? `Category: <b>${st.flood_category.replace(/_/g, " ")}</b><br>` +
            `Peak forecast: ${st.peak_m3s.toLocaleString()} m³/s`
          : "No assessment yet — press Run.");
    const marker = L.circleMarker([s.lat, s.lon], {
      radius: 7, weight: 2, color: "#0c1210", fillColor: color, fillOpacity: 0.95,
    });
    marker.bindPopup(popup);
    globeAddMarker("station", s.lat, s.lon, color,
      !!st && st.flood_category !== "normal", popup);
    return marker;
  })).addTo(map);
}

function switchBasin(basinKey) {
  const view = BASIN_VIEWS[basinKey];
  if (view) map.setView(view[0], view[1]);
  loadLayers(basinKey);
  drawStations(basinKey, null);
}
basinSelect.addEventListener("change", () => {
  if (!basinSelect.value) return;
  updateActionState();
  switchBasin(basinSelect.value);
});

/* ---------------- separate pipelines ---------------- */
// Weather stats card — every number comes straight out of the weather
// agent's structured response (no values computed or hardcoded here).
function weatherStatsHtml(d) {
  const o24 = d.observed_rain_mm.last_24h;
  const o72 = d.observed_rain_mm.last_72h;
  const f72 = d.forecast_rain_mm.next_72h;
  const v = (x) => (x == null ? "n/a" : x);
  const cell = (label, s) =>
    `<div class="stat">
       <div class="stat-value">${v(s.basin_mean)}<small> mm</small></div>
       <div class="stat-sub">max ${v(s.basin_max)} mm</div>
       <div class="stat-label">${label}</div>
     </div>`;
  // headline temp = Meteoblue station-quality point (matches weather
  // apps); GFS AOI mean/max shown as the area context / fallback
  const tp = d.temperature_c?.point;
  const t = d.temperature_c?.now;
  const gfsPart = t && t.aoi_mean != null
    ? `GFS 2 m model area: ${t.aoi_mean} °C mean · ${t.aoi_max} °C max` : "";
  const tempLine = tp && tp.value != null
    ? `<div class="stat-note">🌡️ Temperature now: <b>${tp.value} °C</b> ` +
      `(Meteoblue${tp.observed ? ", observed" : ""}, AOI centre)` +
      (gfsPart ? ` · ${gfsPart}` : "") + `</div>`
    : (gfsPart ? `<div class="stat-note">🌡️ Temperature now (${gfsPart})</div>` : "");
  // now-hour conditions grid (Meteoblue hourly at the AOI centre)
  const c = d.conditions_now;
  const compass = (deg) => (deg == null ? "" :
    ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(deg / 45) % 8]);
  const cv = (x, unit = "") => (x == null ? "n/a" : `${x}${unit}`);
  const condCell = (icon, val, label) =>
    `<div class="cond">
       <div class="cond-v">${icon} ${val}</div>
       <div class="cond-l">${label}</div>
     </div>`;
  const condGrid = c
    ? `<div class="cond-grid">
        ${condCell("🌡️", cv(c.feels_like_c, " °C"), "Feels like")}
        ${condCell("💧", cv(c.humidity_pct, " %"), "Humidity")}
        ${condCell("💨", `${cv(c.wind_ms, " m/s")} ${compass(c.wind_dir_deg)}`, "Wind")}
        ${condCell("☔", cv(c.precip_probability_pct, " %"), "Rain chance")}
        ${condCell("🔆", cv(c.uv_index), "UV index")}
        ${condCell("🔽", cv(c.pressure_hpa, " hPa"), "Pressure")}
      </div>`
    : "";
  // 7-day daily outlook strip (Meteoblue point at the AOI centre)
  const PICTO = { 1: "☀️", 2: "🌤️", 3: "⛅", 4: "☁️", 5: "🌫️", 6: "🌧️",
                  7: "🌦️", 8: "⛈️", 9: "🌨️", 10: "🌨️", 11: "🌨️", 12: "🌦️",
                  13: "🌨️", 14: "🌧️", 15: "🌨️", 16: "🌧️", 17: "🌨️" };
  const days = d.forecast_daily?.days || [];
  const fcstStrip = days.length
    ? `<div class="fcst-strip">` + days.map((x) => {
        const wd = new Date(x.date + "T00:00").toLocaleDateString("en", { weekday: "short" });
        return `<div class="fcst-day" title="${x.date}: rain ${x.precip_mm} mm (${x.precip_probability_pct}%), humidity ${x.humidity_mean_pct}%, wind max ${x.wind_max_ms} m/s">
            <div class="fcst-wd">${wd}</div>
            <div>${PICTO[x.pictocode] || "🌡️"}</div>
            <div class="fcst-t">${Math.round(x.temp_max_c)}°</div>
            <div class="fcst-tmin">${Math.round(x.temp_min_c)}°</div>
            <div class="fcst-rain">${x.precip_mm > 0 ? x.precip_mm + "mm" : "–"}</div>
          </div>`;
      }).join("") + `</div>
      <div class="stat-note">7-day outlook: Meteoblue, AOI centre point — hover a day for rain %, humidity, wind</div>`
    : "";
  return `<div class="stat-grid">
      ${cell("Observed 24 h", o24)}${cell("Observed 72 h", o72)}${cell("Forecast 72 h", f72)}
    </div>
    ${tempLine}
    ${condGrid}
    ${fcstStrip}
    <div class="stat-note">Observed: ${d.sources.observed} (latency ${d.observed_latency_hours} h,
    window ends ${d.observed_window_end_utc}) · Forecast: ${d.sources.forecast}</div>`;
}

// urban flood indicator: city markers coloured by category. Shared
// builder — used by the pipeline button/chat AND the GIS layer toggle.
function buildUrbanLayer(d, opacity = 0.95) {
  const col = { none: "#35c48d", watch: "#f0c53f",
                likely: "#ef6c00", severe: "#c62828" };
  return L.featureGroup((d.cities || []).map((c) => {
    const m = L.circleMarker([c.lat, c.lon], {
      radius: 8, weight: 2, color: "#0c1210",
      fillColor: col[c.category] || "#888", fillOpacity: opacity,
    });
    m.bindPopup(
      `<b>${c.name}</b> <small>(${c.province})</small><br>` +
      `Observed 24h: ${c.obs24_mm} mm · Forecast 24h: ${c.fcst24_mm} mm<br>` +
      `Urban flood indicator: <b>${c.category}</b>`);
    return m;
  }));
}
let urbanLayer = null;
function drawUrbanCities(d) {
  if (urbanLayer) map.removeLayer(urbanLayer);
  urbanLayer = buildUrbanLayer(d).addTo(map);
  // mirror the city indicators on the 3D globe (pulse when flagged)
  const col = { none: "#35c48d", watch: "#f0c53f",
                likely: "#ef6c00", severe: "#c62828" };
  globeClearMarkers("city");
  (d.cities || []).forEach((c) => {
    globeAddMarker("city", c.lat, c.lon, col[c.category] || "#888",
      c.category !== "none",
      `<b>${c.name}</b> <small>(${c.province})</small><br>` +
      `Observed 24h: ${c.obs24_mm} mm · Forecast 24h: ${c.fcst24_mm} mm<br>` +
      `Urban flood indicator: <b>${c.category}</b>`);
  });
}

function pipelineSummary(name, d) {
  if (d.status !== "ok") return `❌ ${name}: ${d.error || "failed"}`;
  switch (name) {
    case "urban":
      return (d.flagged || []).length
        ? `🏙️ urban flood indicator: ${d.flagged.join(", ")} — see city markers`
        : `🏙️ no urban flooding indicated in any major city ` +
          `(max 24h rain ${d.max_obs24_mm} mm, latency ${d.observed_latency_hours} h)`;
    case "disaster":
      return `🌊 worst: ${d.worst_station.name} ${d.worst_station.flood_category.replace(/_/g, " ")} ` +
             `(${d.worst_station.peak_m3s.toLocaleString()} m³/s)`;
    case "terrain":
      return `⛰️ basin ${d.basin_area_km2.toLocaleString()} km², layers cached`;
    case "population":
      return `👥 ${d.total_population.toLocaleString()} people | ` +
             `${d.floodplain_population.toLocaleString()} on floodplain`;
    default:
      return `✅ ${name} done`;
  }
}

// render a pipeline result into the panel + map — shared by the buttons,
// the chat assistant, and the session restore (back-from-dashboard).
function showPipelineResult(name, basin, data) {
  const link = `<a class="dash-link" href="/agent?pipeline=${name}&basin=${encodeURIComponent(basin)}">📊 Click here to see the full dashboard →</a>`;
  if (name === "weather" && data.status === "ok") {
    $("pipeline-result").innerHTML = weatherStatsHtml(data) + link;
  } else {
    $("pipeline-result").innerHTML =
      `<div>${pipelineSummary(name, data)}</div>` + (data.status === "ok" ? link : "");
  }
  if (name === "disaster" && data.status === "ok") {
    drawStations(basin, { agents: { river: data } });
  }
  if (name === "urban" && data.status === "ok") drawUrbanCities(data);
}

// remember what the panel is showing so the map can restore it after a
// visit to a dashboard page (results must not disappear on back-nav)
function storeLastPanel(kind, name, spec) {
  try {
    localStorage.setItem("pakclimint.lastPanel",
      JSON.stringify({ kind, name, spec, ts: Date.now() }));
  } catch { /* storage full */ }
}

// Pipelines run IN the panel (map markers, stat cards) — and the result
// is cached so the agent's full dashboard opens instantly via the link.
document.querySelectorAll(".pipe-btn").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const name = btn.dataset.pipe;
    const basin = basinSelect.value || (name === "urban" ? "pakistan" : "");
    if (!basin) return;
    btn.disabled = true;
    btn.classList.remove("done", "failed");
    $("pipeline-result").textContent = `Running ${name} pipeline…`;
    try {
      const res = await fetch(`/api/pipeline/${name}?basin=${encodeURIComponent(basin)}`);
      const data = await res.json();
      showPipelineResult(name, basin, data);
      btn.classList.add(data.status === "ok" ? "done" : "failed");
      if (data.status === "ok") {
        try { // hand the result to the /agent dashboard — no rerun there
          localStorage.setItem(`pakclimint.agent.${name}.${basin}`,
            JSON.stringify({ ts: Date.now(), data }));
        } catch { /* storage full */ }
        storeLastPanel("pipe", name, basin);
      }
    } catch (err) {
      $("pipeline-result").textContent = `❌ ${name}: ${err}`;
      btn.classList.add("failed");
    } finally {
      btn.disabled = false;
    }
  });
});

/* ---------------- reports: save ---------------- */
let lastRiskData = null; // assessment currently shown in the panel

$("save-report").addEventListener("click", async () => {
  if (!lastRiskData) return;
  const btn = $("save-report");
  btn.disabled = true;
  try {
    const res = await fetch("/api/save_report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(lastRiskData),
    });
    const d = await res.json();
    $("save-confirm").textContent = d.saved
      ? `✅ Saved to ${d.markdown_path} (+ .json)`
      : `❌ ${d.error || "save failed"}`;
  } catch (err) {
    $("save-confirm").textContent = `❌ save failed: ${err}`;
  } finally {
    btn.disabled = false;
  }
});

/* ---------------- risk assessment ---------------- */
const LEVEL_COLORS = { low: "#2e7d32", moderate: "#ef6c00", high: "#c62828", severe: "#7b1fa2" };

// render a full assessment into the panel + map (used by the Full risk
// button AND by the chat assistant when it runs the risk pipeline)
function renderRiskResult(basin, data) {
  $("risk-banner").textContent = "";
  $("warning-text").textContent = "";
  $("pipeline-result").innerHTML = "";
  if (data.risk_score !== null && data.risk_level) {
    const decision = data.decision ? ` | ${data.decision.action.replace(/_/g, " ")}` : "";
    $("risk-banner").textContent =
      `${data.risk_level.toUpperCase()} — ${data.risk_score}/100${decision}` +
      (data.degraded ? ` (degraded: ${data.failed_agents.join(", ")})` : "");
    $("risk-banner").style.background = LEVEL_COLORS[data.risk_level] || "#555";
  }
  $("warning-text").textContent = data.warning_text || data.decision?.description || "";
  // full weather card (temp, humidity, wind, 7-day) inside the risk view
  if (data.agents?.weather?.status === "ok") {
    $("pipeline-result").innerHTML = weatherStatsHtml(data.agents.weather);
  }
  drawStations(basin, data);
  if (data.risk_level) {
    lastRiskData = data;                 // enables 💾 Save report
    $("report-row").style.display = "";
    $("save-confirm").textContent = data.report_path
      ? `Auto-saved: ${data.report_path}` : "";
  }
}

// Full risk assessment runs IN the panel (like before) — and the result
// is stored so the 📊 full-report page opens instantly without rerunning.
$("run-risk").addEventListener("click", async () => {
  const basin = basinSelect.value;
  if (!basin) return;
  const btn = $("run-risk");
  btn.disabled = true;
  $("pipeline-result").textContent =
    "Running agent pipeline… first run on a new basin takes minutes";
  try {
    const res = await fetch(`/api/risk?basin=${encodeURIComponent(basin)}`);
    const data = await res.json();
    renderRiskResult(basin, data);
    if (data.risk_level) {
      storeRiskForDashboard(basin, data);
      storeLastPanel("risk", "risk", basin);
      $("pipeline-result").innerHTML +=
        `<a class="dash-link" href="/risk">📊 Click here to see the full report →</a>`;
    }
  } catch (err) {
    $("pipeline-result").textContent = "Request failed: " + err;
  } finally {
    btn.disabled = false;
  }
});

// stash an assessment so /risk can show it without re-running agents
function storeRiskForDashboard(spec, data) {
  try {
    localStorage.setItem("pakclimint.lastRisk",
      JSON.stringify({ spec, ts: Date.now(), data }));
  } catch { /* storage full — dashboard will refetch */ }
}

$("ctrl-risk-page").addEventListener("click", () => { location.href = "/risk"; });
$("ctrl-logout").addEventListener("click", () => { location.href = "/logout"; });

/* ---------------- AI assistant chat ---------------- */
setupPanel("chat-panel", "chat-drag-handle", "chat-collapse");
const chatHistory = [];

function addChat(cls, text) {
  const div = document.createElement("div");
  div.className = cls;
  div.textContent = text;
  $("chat-log").appendChild(div);
  $("chat-log").scrollTop = 1e9;
  return div;
}

$("ctrl-chat").addEventListener("click", () => {
  const p = $("chat-panel");
  const show = p.style.display === "none";
  p.style.display = show ? "" : "none";
  if (show) $("chat-input").focus();
});
$("chat-hide").addEventListener("click", (e) => {
  e.stopPropagation();
  $("chat-panel").style.display = "none";
});

// map commands the bot queues via its control_map tool, executed here
function applyMapCommand(a) {
  switch (a.command) {
    case "zoom_in": map.zoomIn(); break;
    case "zoom_out": map.zoomOut(); break;
    case "set_zoom": if (a.zoom) map.setZoom(Math.max(3, Math.min(14, a.zoom))); break;
    case "zoom_to_aoi":
      if (a.aoi && [...basinSelect.options].some((o) => o.value === a.aoi)) {
        basinSelect.value = a.aoi;
        updateActionState();
        switchBasin(a.aoi);
      }
      break;
    case "show_layer":
    case "hide_layer": {
      const chk = document.getElementById(`chk-${a.layer_id}`);
      const want = a.command === "show_layer";
      if (chk && chk.checked !== want) {
        chk.checked = want;
        chk.dispatchEvent(new Event("change")); // reuses lazy load + legend
      }
      break;
    }
    case "toggle_basemap": $("ctrl-basemap").click(); break;
    case "globe_view": setGlobeView(true); break;
    case "flat_view": setGlobeView(false); break;
    case "open_dashboard": {
      const pipe = a.dashboard;
      if (!pipe) break;
      const aoi = a.aoi || basinSelect.value || (pipe === "urban" ? "pakistan" : "");
      const url = pipe === "risk"
        ? "/risk" + (aoi ? `?basin=${encodeURIComponent(aoi)}` : "")
        : `/agent?pipeline=${pipe}&basin=${encodeURIComponent(aoi)}`;
      setTimeout(() => (location.href = url), 1500); // let the reply show first
      break;
    }
  }
}

// bot-run pipelines update the dashboard exactly like the buttons do
function applyChatActions(actions) {
  actions.forEach((a) => {
    if (a.tool === "control_map") { applyMapCommand(a); return; }
    if (a.tool !== "run_pipeline" || !a.result) return;
    const { pipeline, aoi, result } = a;
    if (basinSelect.value !== aoi &&
        [...basinSelect.options].some((o) => o.value === aoi)) {
      basinSelect.value = aoi;   // sync dropdown + map to the bot's AOI
      updateActionState();
      switchBasin(aoi);
    }
    if (pipeline === "risk" && result.risk_level) {
      renderRiskResult(aoi, result);
      storeRiskForDashboard(aoi, result); // 📊 page picks it up instantly
      storeLastPanel("risk", "risk", aoi);
      $("pipeline-result").innerHTML +=
        `<a class="dash-link" href="/risk">📊 Click here to see the full report →</a>`;
    } else if (result.status === "ok") {
      showPipelineResult(pipeline, aoi, result);
      try {
        localStorage.setItem(`pakclimint.agent.${pipeline}.${aoi}`,
          JSON.stringify({ ts: Date.now(), data: result }));
      } catch { /* storage full */ }
      storeLastPanel("pipe", pipeline, aoi);
    }
  });
}

$("chat-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = $("chat-input").value.trim();
  if (!q) return;
  $("chat-input").value = "";
  addChat("chat-user", q);
  chatHistory.push({ role: "user", content: q });
  const thinking = addChat("chat-bot thinking", "agents working…");
  $("chat-send").disabled = true;
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: chatHistory.slice(-12) }),
    });
    const d = await res.json();
    thinking.remove();
    if (d.error) { addChat("chat-bot", "⚠️ " + d.error); return; }
    (d.actions || []).forEach((a) => {
      if (a.tool === "run_pipeline")
        addChat("chat-run", `▶ ran ${a.pipeline} · ${a.aoi} · ${a.status}`);
      else if (a.tool === "control_map")
        addChat("chat-run", `▶ map: ${a.command}` +
          (a.layer_id ? ` ${a.layer_id}` : "") +
          (a.dashboard ? ` ${a.dashboard}` : "") + (a.aoi ? ` ${a.aoi}` : ""));
    });
    addChat("chat-bot", d.reply);
    chatHistory.push({ role: "assistant", content: d.reply });
    applyChatActions(d.actions || []);
    speakReply(d.reply);
  } catch (err) {
    thinking.remove();
    addChat("chat-bot", "⚠️ request failed: " + err);
  } finally {
    $("chat-send").disabled = false;
  }
});

/* ------- voice input (Web Speech API — Chrome/Edge built-in) ------- */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
if (SR) {
  const rec = new SR();
  rec.lang = "en-US";
  rec.interimResults = true;   // live transcription while speaking
  rec.continuous = false;
  rec.maxAlternatives = 1;
  let listening = false;
  let heardFinal = "";

  const MIC_ERRORS = {
    "not-allowed": "Microphone blocked. Click the 🔒/mic icon in the " +
      "browser address bar and ALLOW microphone for this site, then retry.",
    "service-not-allowed": "Speech service blocked by the browser. In " +
      "Edge: enable Windows Settings → Privacy → Speech → Online speech " +
      "recognition — or use Chrome.",
    "audio-capture": "No microphone found — check it is plugged in and " +
      "not in use by another app.",
    "network": "Speech service unreachable — the browser's recognizer " +
      "needs internet. Check the connection (or use Chrome).",
    "no-speech": "I didn't hear anything — click 🎤 and speak clearly " +
      "right away (it stops after a short silence).",
    "aborted": "",
  };

  function stopUI() {
    listening = false;
    $("chat-mic").classList.remove("listening");
    $("chat-input").placeholder = "Ask the agents…";
  }

  $("chat-mic").addEventListener("click", () => {
    if (listening) { rec.stop(); return; }
    heardFinal = "";
    $("chat-input").value = "";
    try {
      rec.start();
      listening = true;
      $("chat-mic").classList.add("listening");
      $("chat-input").placeholder = "🎤 listening… speak now";
    } catch { /* already started */ }
  });

  rec.onresult = (e) => {
    // accumulate finals + show interim text live so you SEE it parsing
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) heardFinal += t;
      else interim += t;
    }
    $("chat-input").value = (heardFinal + interim).trim();
  };

  rec.onerror = (e) => {
    stopUI();
    const msg = MIC_ERRORS[e.error] ?? `Voice input error: ${e.error}`;
    if (msg) addChat("chat-bot", "🎤 " + msg);
  };

  rec.onend = () => {
    stopUI();
    const text = (heardFinal || $("chat-input").value).trim();
    if (text) {
      $("chat-input").value = text;
      $("chat-form").requestSubmit();
    }
  };
} else {
  $("chat-mic").style.display = "none"; // browser without speech support
}

/* ------- voice output (speechSynthesis, toggle 🔇/🔊 in header) ------- */
let voiceOn = false;
$("chat-voice").addEventListener("click", (e) => {
  e.stopPropagation();
  voiceOn = !voiceOn;
  $("chat-voice").textContent = voiceOn ? "🔊" : "🔇";
  if (!voiceOn && window.speechSynthesis) speechSynthesis.cancel();
});
// Alpha speaks with a female voice — pick the best female English
// voice the browser ships (Edge: Aria/Jenny; Chrome: Zira/Google US).
let alphaVoice = null;
function pickAlphaVoice() {
  const voices = speechSynthesis.getVoices().filter((v) => v.lang.startsWith("en"));
  const prefs = [/aria/i, /jenny/i, /zira/i, /sonia/i, /libby/i,
                 /female/i, /google us english/i];
  for (const p of prefs) {
    const v = voices.find((v) => p.test(v.name));
    if (v) { alphaVoice = v; return; }
  }
  alphaVoice = voices[0] || null;
}
if (window.speechSynthesis) {
  pickAlphaVoice(); // voices load async — retry when the list arrives
  speechSynthesis.addEventListener("voiceschanged", pickAlphaVoice);
}

function speakReply(text) {
  if (!voiceOn || !window.speechSynthesis) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(String(text).slice(0, 600));
  u.lang = "en-US";
  u.rate = 1.05;
  u.pitch = 1.1;
  if (alphaVoice) u.voice = alphaVoice;
  speechSynthesis.speak(u);
}

/* ---------------- floating map controls ---------------- */
$("ctrl-zoom-in").addEventListener("click", () =>
  (globeOn && globe ? globe.zoomIn() : map.zoomIn()));
$("ctrl-zoom-out").addEventListener("click", () =>
  (globeOn && globe ? globe.zoomOut() : map.zoomOut()));

$("ctrl-globe").addEventListener("click", () => setGlobeView(!globeOn));
// Default = flat 2D map; 🌍 switches to the 3D globe. The globe is
// created up-front (hidden) so results keep mirroring onto it and it
// opens already populated.
initGlobe();
setGlobeView(false);

$("ctrl-locate").addEventListener("click", () => {
  map.locate({ setView: true, maxZoom: 12 });
});
map.on("locationfound", (e) =>
  L.circleMarker(e.latlng, { radius: 6, color: "#35c48d" }).addTo(map));

$("ctrl-fullscreen").addEventListener("click", () => {
  document.fullscreenElement
    ? document.exitFullscreen()
    : document.documentElement.requestFullscreen();
});

$("ctrl-basemap").addEventListener("click", () => {
  map.removeLayer(basemaps[currentBasemap]);
  currentBasemap = currentBasemap === "dark" ? "satellite" : "dark";
  basemaps[currentBasemap].addTo(map).bringToBack();
});

/* measurement + drawing (leaflet-draw) */
const drawnItems = new L.FeatureGroup().addTo(map);
let activeDraw = null;

function startDraw(kind, btn) {
  setGlobeView(false); // drawing/measuring happens on the flat map
  if (activeDraw) { activeDraw.disable(); activeDraw = null; }
  document.querySelectorAll(".ctrl-btn").forEach((b) => b.classList.remove("active"));
  const opts = { shapeOptions: { color: "#35c48d", weight: 3 } };
  activeDraw = kind === "line"
    ? new L.Draw.Polyline(map, opts)
    : new L.Draw.Rectangle(map, opts); // box becomes the pipeline AOI
  activeDraw.enable();
  btn.classList.add("active");
}
$("ctrl-measure").addEventListener("click", (e) => startDraw("line", e.currentTarget));
$("ctrl-draw").addEventListener("click", (e) => startDraw("area", e.currentTarget));

// A drawn box becomes a first-class AOI ("bbox:W,S,E,N") — the same
// resolver the basins/admin units use, so EVERY pipeline runs on it.
function setDrawnAoi(bounds) {
  const spec = `bbox:${bounds.getWest().toFixed(3)},${bounds.getSouth().toFixed(3)},` +
               `${bounds.getEast().toFixed(3)},${bounds.getNorth().toFixed(3)}`;
  const entry = { group: "Custom", value: spec, label: "▦ Drawn box" };
  const i = aoiEntries.findIndex((e) => e.group === "Custom");
  if (i >= 0) aoiEntries[i] = entry; else aoiEntries.unshift(entry);
  renderAoiOptions();
  basinSelect.value = spec;
  updateActionState();
  switchBasin(spec);
  $("pipeline-result").textContent =
    "Drawn box set as AOI — run any pipeline or the full risk assessment.";
}

map.on(L.Draw.Event.CREATED, (e) => {
  document.querySelectorAll(".ctrl-btn").forEach((b) => b.classList.remove("active"));
  const readout = $("measure-readout");
  if (e.layerType === "polyline") {
    drawnItems.addLayer(e.layer);
    const pts = e.layer.getLatLngs();
    let m = 0;
    for (let i = 1; i < pts.length; i++) m += pts[i - 1].distanceTo(pts[i]);
    readout.textContent = `distance: ${(m / 1000).toFixed(2)} km`;
  } else { // rectangle -> custom AOI
    drawnItems.clearLayers();
    drawnItems.addLayer(e.layer);
    const a = L.GeometryUtil
      ? L.GeometryUtil.geodesicArea(e.layer.getLatLngs()[0])
      : 0;
    readout.textContent = `area: ${(a / 1e6).toFixed(2)} km²`;
    setDrawnAoi(e.layer.getBounds());
  }
  activeDraw = null;
});

/* double-click clears drawings */
map.on("dblclick", () => { drawnItems.clearLayers(); $("measure-readout").textContent = ""; });

/* coordinate display */
map.on("mousemove", (e) => {
  $("coords").textContent =
    `${e.latlng.lat.toFixed(4)}°N, ${e.latlng.lng.toFixed(4)}°E`;
});
