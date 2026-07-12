// Pak-ClimInt — per-agent full-page dashboards.
// One page serves all pipelines (?pipeline=weather|disaster|terrain|
// population|urban & basin=<spec>). Presentation only — every value is
// read from the agent's JSON; nothing is computed or invented here.

const $ = (id) => document.getElementById(id);
const qs = new URLSearchParams(location.search);
const PIPE = qs.get("pipeline") || "weather";
const SPEC = qs.get("basin") || (PIPE === "urban" ? "pakistan" : "");
const FRESH_MS = 15 * 60 * 1000;
const KEY = `pakclimint.agent.${PIPE}.${SPEC}`;

const SERIES = ["#3987e5", "#199e70", "#c98500", "#9085e9", "#e66767"];
const CAT_COLORS = {
  normal: "#35c48d", low: "#f0c53f", medium: "#ef6c00",
  high: "#c62828", very_high: "#8e24aa", exceptional: "#4a0d67",
  none: "#35c48d", watch: "#f0c53f", likely: "#ef6c00", severe: "#c62828",
};
const META = {
  weather: { icon: "🌧️", name: "Weather Agent", layers: ["rain72", "rain_fcst72", "temp_now"] },
  disaster: { icon: "🌊", name: "River / Disaster Agent", layers: ["rivers"] },
  terrain: { icon: "⛰️", name: "Terrain Agent", layers: ["dem", "slope", "rivers"] },
  population: { icon: "👥", name: "Exposure Agent", layers: ["population"] },
  urban: { icon: "🏙️", name: "Urban Flood Agent", layers: [] },
};

Chart.defaults.color = "#8fa39a";
Chart.defaults.borderColor = "rgba(255,255,255,0.08)";
Chart.defaults.font.family = "'Segoe UI', system-ui, sans-serif";
Chart.defaults.animation = { duration: 950, easing: "easeOutQuart" };

const fmt = (n) => (n == null ? "n/a" : n.toLocaleString());

function countUp(el, target, { suffix = "", decimals = 0, ms = 1100 } = {}) {
  if (target == null || isNaN(target)) { el.textContent = "n/a"; return; }
  const t0 = performance.now();
  (function step(t) {
    const k = Math.min(1, (t - t0) / ms);
    const eased = 1 - Math.pow(1 - k, 3);
    el.textContent = (target * eased).toFixed(decimals)
      .replace(/\B(?=(\d{3})+(?!\d))/g, ",") + suffix;
    if (k < 1) requestAnimationFrame(step);
  })(t0);
}

function rainFX(mm) {
  const cvs = $("fx-canvas"), ctx = cvs.getContext("2d");
  let W, H;
  const resize = () => { W = cvs.width = innerWidth; H = cvs.height = innerHeight; };
  resize(); addEventListener("resize", resize);
  const n = Math.min(140, Math.round((mm || 0) * 6) + 10);
  const drops = Array.from({ length: n }, () => ({
    x: Math.random() * innerWidth, y: Math.random() * innerHeight,
    v: 2.4 + Math.random() * 3.2, len: 8 + Math.random() * 12,
  }));
  ctx.strokeStyle = "rgba(74,163,240,0.15)"; ctx.lineWidth = 1.4;
  (function tick() {
    ctx.clearRect(0, 0, W, H);
    ctx.beginPath();
    for (const d of drops) {
      ctx.moveTo(d.x, d.y); ctx.lineTo(d.x - 1.5, d.y + d.len);
      d.y += d.v; d.x -= 0.35;
      if (d.y > H) { d.y = -d.len; d.x = Math.random() * W; }
    }
    ctx.stroke();
    requestAnimationFrame(tick);
  })();
}

function fancyFX(storm) {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!reduced) {
    document.querySelectorAll(".kcard").forEach((c) => {
      c.addEventListener("mousemove", (e) => {
        const r = c.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width - 0.5;
        const y = (e.clientY - r.top) / r.height - 0.5;
        c.style.transform =
          `perspective(700px) rotateY(${x * 8}deg) rotateX(${-y * 8}deg) translateY(-3px)`;
      });
      c.addEventListener("mouseleave", () => (c.style.transform = ""));
    });
  }
  if (storm && !reduced && !$("flash")) {
    const f = document.createElement("div");
    f.id = "flash";
    document.body.appendChild(f);
    (function zap() {
      setTimeout(() => {
        f.classList.remove("zap"); void f.offsetWidth; f.classList.add("zap");
        zap();
      }, 7000 + Math.random() * 10000);
    })();
  }
}

function reveal() {
  const io = new IntersectionObserver((es) => es.forEach((e) => {
    if (e.isIntersecting) { e.target.classList.add("revealed"); io.unobserve(e.target); }
  }), { threshold: 0.08 });
  document.querySelectorAll(".panel").forEach((p) => io.observe(p));
}

function cardsHtml(cards) {
  return cards.map((c) => `
    <div class="kcard">
      ${c.scene || ""}
      <div class="kv" ${c.color ? `style="color:${c.color}"` : ""}>${c.v}</div>
      <div class="kl">${c.l}</div>${c.s ? `<div class="ks">${c.s}</div>` : ""}
    </div>`).join("");
}

/* ---- 4D card scenes (all data-driven) ---- */
function sceneRain(n, storm = false) {
  const drops = Array.from({ length: Math.max(3, Math.min(14, n)) }, () =>
    `<i style="left:${5 + Math.random() * 90}%; animation-delay:${(Math.random() * 1.2).toFixed(2)}s"></i>`).join("");
  return `<div class="kscene rain ${storm ? "storm" : ""}">${drops}</div>`;
}
const sceneSun = () =>
  `<div class="kscene sun"></div><div class="kscene cloud" style="opacity:.35"></div>`;
const sceneCloud = () => `<div class="kscene cloud"></div>`;
// liquid fill: lvlPct = how full (0..100); colour optional
function sceneWater(lvlPct, color) {
  const top = 100 - Math.max(8, Math.min(88, lvlPct));
  const bubbles = Array.from({ length: 4 }, () =>
    `<i style="left:${28 + Math.random() * 44}%; animation-delay:${(Math.random() * 3).toFixed(1)}s"></i>`).join("");
  return `<div class="kwater" style="--lvl:${top}%${color ? `; --wcol:${color}` : ""}">${bubbles}</div>`;
}
const sceneMount = () => `<div class="kmount"></div>`;
const sceneSky = () => `<div class="ksky"></div>`;

// Google-Weather style animated icon for a forecast day
function dayIcon(x) {
  const storm = x.precip_mm >= 8 || x.precip_probability_pct >= 60;
  const rainy = x.precip_mm >= 0.5;
  const sunny = (x.pictocode || 9) <= 2;
  if (storm) return `<div class="mi-cloud"></div><span class="mi-bolt">⚡</span>` +
    [30, 50, 66].map((l, i) => `<span class="mi-drop" style="left:${l}%; animation-delay:${i * 0.3}s"></span>`).join("");
  if (rainy) return `<div class="mi-cloud"></div>` +
    [32, 52, 68].map((l, i) => `<span class="mi-drop" style="left:${l}%; animation-delay:${i * 0.3}s"></span>`).join("");
  if (sunny) return `<div class="mi-sun"></div>`;
  return `<div class="mi-sun" style="opacity:.55; left:38%"></div><div class="mi-cloud"></div>`;
}

// one-word condition per forecast day (same thresholds as the icon)
function dayLabel(x) {
  if (x.precip_mm >= 8 || x.precip_probability_pct >= 60) return "Stormy";
  if (x.precip_mm >= 0.5) return "Rain";
  if ((x.pictocode || 9) <= 2) return "Sunny";
  return "Cloudy";
}

function dayStripHtml(days) {
  const wd = (x) => new Date(x.date + "T00:00").toLocaleDateString("en", { weekday: "short" });
  return `<div class="panel" id="day-panel"><h3>📅 7-day outlook — Meteoblue, AOI centre</h3>
    <div class="day-strip">${days.map((x) => `
      <div class="day-card" title="humidity ${x.humidity_mean_pct}% · wind max ${x.wind_max_ms} m/s · rain probability ${x.precip_probability_pct}%">
        <div class="dc-wd">${wd(x)}</div>
        <div class="dc-icon">${dayIcon(x)}</div>
        <div class="dc-desc">${dayLabel(x)}</div>
        <div class="dc-t">${Math.round(x.temp_max_c)}°</div>
        <div class="dc-tmin">${Math.round(x.temp_min_c)}°</div>
        <div class="dc-rain">${x.precip_mm > 0 ? x.precip_mm + " mm" : ""}</div>
      </div>`).join("")}</div></div>`;
}

/* ---------------- one-line headline (top of the page) ---------------- */
// Compact "what's the story" line — every value quoted from the agent JSON.
function buildHeadline(pipe, d) {
  const wd = (x) => new Date(x.date + "T00:00").toLocaleDateString("en", { weekday: "short" });
  if (pipe === "weather") {
    const o24 = d.observed_rain_mm.last_24h.basin_mean;
    const f72 = d.forecast_rain_mm.next_72h.basin_mean;
    const days = d.forecast_daily?.days || [];
    let ahead = "";
    if (days.length) {
      const wettest = days.reduce((a, b) => (b.precip_mm > a.precip_mm ? b : a));
      ahead = wettest.precip_mm >= 0.5
        ? ` Wettest day ahead: <b>${wd(wettest)}</b> (${wettest.precip_mm} mm).`
        : " No rain day expected this week.";
    }
    return `<b>${o24 ?? "n/a"} mm</b> of rain fell in the last 24 h; about <b>${f72 ?? "n/a"} mm</b> more is forecast over the next 3 days.${ahead}`;
  }
  if (pipe === "disaster") {
    const stations = d.stations || {}, names = Object.keys(stations);
    const above = names.filter((n) => stations[n].flood_category !== "normal");
    const worst = d.worst_station;
    if (!worst) return "No river station falls inside this area.";
    return above.length
      ? `<b>${above.length}/${names.length}</b> stations above normal — highest: <b>${worst.name}</b> at ${fmt(worst.peak_m3s)} m³/s (<b>${worst.flood_category.replace(/_/g, " ")}</b>).`
      : `All <b>${names.length}</b> station(s) in their normal range — highest flow <b>${worst.name}</b> at ${fmt(worst.peak_m3s)} m³/s.`;
  }
  if (pipe === "terrain") {
    return `<b>${fmt(d.basin_area_km2)} km²</b> analysed — elevation, slope and river network cached for the other agents.`;
  }
  if (pipe === "population") {
    const pct = d.total_population ? Math.round(100 * d.floodplain_population / d.total_population) : null;
    return `<b>${fmt(d.total_population)}</b> people live here; <b>${fmt(d.floodplain_population)}</b>${pct != null ? ` (${pct}%)` : ""} are on flood-prone flat land (proxy).`;
  }
  if (pipe === "urban") {
    const flagged = d.flagged || [];
    return flagged.length
      ? `<b>${flagged.join(", ")}</b> flagged for possible urban flooding — heaviest 24 h rain <b>${d.max_obs24_mm} mm</b>.`
      : `All <b>${d.cities.length}</b> cities clear — heaviest 24 h rain <b>${d.max_obs24_mm} mm</b>, below the ${d.thresholds_mm_24h.watch} mm watch level.`;
  }
  return "";
}

function showHeadline(text) {
  if (!text) return;
  $("headline").innerHTML = `<span class="hl-tag">At a glance</span><span>${text}</span>`;
  $("headline").style.display = "";
}

/* ---------------- plain-language summary modal ---------------- */
// Every sentence is templated from the agent's real JSON fields —
// nothing is estimated or invented here.
function buildSummary(pipe, d) {
  const p = [];
  if (pipe === "weather") {
    const o24 = d.observed_rain_mm.last_24h, o72 = d.observed_rain_mm.last_72h;
    const f72 = d.forecast_rain_mm.next_72h;
    const tp = d.temperature_c?.point, c = d.conditions_now || {};
    p.push(`<b>What this page shows:</b> satellite-observed rain over the area (NASA GPM), model-forecast rain (NOAA GFS), and current conditions from Meteoblue at the AOI centre.`);
    p.push(`<b>Rain:</b> the last 24 h brought about <b>${o24.basin_mean ?? "n/a"} mm</b> on average (72 h total: ${o72.basin_mean ?? "n/a"} mm). The next 3 days are forecast at about <b>${f72.basin_mean ?? "n/a"} mm</b> average, locally up to ${f72.basin_max ?? "n/a"} mm.`);
    if (tp?.value != null) p.push(`<b>Right now:</b> it is <b>${tp.value} °C</b>${c.feels_like_c != null ? ` (feels like ${c.feels_like_c} °C)` : ""}${c.humidity_pct != null ? `, humidity ${c.humidity_pct}%` : ""}${c.precip_probability_pct != null ? `, ${c.precip_probability_pct}% chance of rain this hour` : ""}.`);
    p.push(`<b>How to read it:</b> observed values arrive with a ${d.observed_latency_hours} h satellite delay, so "now" on the map is really ${d.observed_latency_hours} hours ago. The 7-day strip is a point forecast at the centre of the area, not an area average.`);
  } else if (pipe === "disaster") {
    const stations = d.stations || {}, names = Object.keys(stations);
    const above = names.filter((n) => stations[n].flood_category !== "normal");
    const worst = d.worst_station;
    p.push(`<b>What this page shows:</b> river discharge forecasts from Copernicus GloFAS at the FFD stations inside this area, each rated against its own long-term flood thresholds.`);
    if (worst) p.push(`<b>Headline:</b> the highest forecast flow is at <b>${worst.name}</b> — about <b>${fmt(worst.peak_m3s)} m³/s</b>, rated "<b>${worst.flood_category.replace(/_/g, " ")}</b>".`);
    p.push(above.length
      ? `<b>Stations above normal:</b> ${above.map((n) => `${n} (${stations[n].flood_category.replace(/_/g, " ")})`).join(", ")} — these are the ones to watch.`
      : `<b>All ${names.length} station(s) are in their normal range</b> — no river flood signal in this forecast cycle.`);
    p.push(`<b>How to read it:</b> the forecast cycle is ${d.forecast_date}${d.forecast_age_days ? `, published ${d.forecast_age_days} day(s) ago (Copernicus lag)` : ""}. GloFAS runs about half the FFD-reported cusecs at Chenab stations, so trust the category and the ranking more than the absolute number.`);
  } else if (pipe === "terrain") {
    p.push(`<b>What this page shows:</b> the shape of the land the other agents work on — elevation (SRTM 90 m), slope, and where water converges into rivers (HydroSHEDS flow accumulation).`);
    p.push(`<b>Headline:</b> the assessed area covers about <b>${fmt(d.basin_area_km2)} km²</b>, with ${Object.keys(d.layers || {}).length} terrain layers cached for analysis.`);
    p.push(`<b>How to read it:</b> flat, low-lying pixels near high flow accumulation are where rain and river water collect — that is what the exposure agent's floodplain proxy is built on. Toggle the DEM / slope / river layers on the map to see it.`);
  } else if (pipe === "population") {
    const pct = d.total_population ? Math.round(100 * d.floodplain_population / d.total_population) : null;
    p.push(`<b>What this page shows:</b> how many people live in the assessed area (WorldPop 2020, 100 m grid) and how many of them live on flood-prone land.`);
    p.push(`<b>Headline:</b> about <b>${fmt(d.total_population)}</b> people live here; roughly <b>${fmt(d.floodplain_population)}</b>${pct != null ? ` (${pct}%)` : ""} are on land flat enough to flood.`);
    p.push(`<b>How to read it:</b> "floodplain" is a slope-based proxy (${d.floodplain_definition || "slope < 2°"}), not a mapped flood extent — it tells you who is exposed IF water arrives, not that it will. Sentinel-1 inundation mapping is the planned upgrade.`);
  } else if (pipe === "urban") {
    const flagged = d.flagged || [];
    p.push(`<b>What this page shows:</b> a nationwide urban-flash-flood indicator — 24 h rain observed and forecast over ${d.cities.length} major cities, compared to fixed thresholds (watch ${d.thresholds_mm_24h.watch} mm · likely ${d.thresholds_mm_24h.likely} mm · severe ${d.thresholds_mm_24h.severe} mm).`);
    p.push(flagged.length
      ? `<b>Headline:</b> <b>${flagged.length} city(ies) flagged</b>: ${flagged.join(", ")} — drainage capacity, not rivers, is the concern here.`
      : `<b>Headline:</b> no city crossed a threshold — the wettest city got <b>${d.max_obs24_mm} mm</b> in 24 h, below the ${d.thresholds_mm_24h.watch} mm watch level.`);
    p.push(`<b>How to read it:</b> this is an indicator, not a forecast of street flooding — it measures rain intensity over a 12 km city footprint with a ${d.observed_latency_hours} h satellite delay. ${d.caveats?.[0] || ""}`);
  }
  p.push(`<span class="sum-note">All numbers are quoted directly from the agent's JSON output — the wording is templated, no AI invented any value.</span>`);
  return p.map((x) => `<p>${x}</p>`).join("");
}

function wireSummary(html) {
  $("btn-summary").style.display = "";
  $("btn-summary").onclick = () => {
    $("sum-body").innerHTML = html;
    $("sum-overlay").classList.add("open");
  };
  $("sum-close").onclick = () => $("sum-overlay").classList.remove("open");
  $("sum-overlay").addEventListener("click", (e) => {
    if (e.target === $("sum-overlay")) $("sum-overlay").classList.remove("open");
  });
}

function chartBox(id, title) {
  return `<div class="chart-box"><h4>${title}</h4>
    <div class="chart-wrap"><canvas id="${id}"></canvas></div></div>`;
}

/* ---------------- map with real EE tile layers ---------------- */
let map = null;
async function buildMap(layerIds) {
  map = L.map("big-map", { zoomControl: true, attributionControl: false });
  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", { maxZoom: 14 }).addTo(map);
  map.setView([30.5, 70.5], 5);
  if (SPEC && SPEC !== "pakistan") {
    try {
      const gj = await (await fetch(`/api/basin_outline?basin=${encodeURIComponent(SPEC)}`)).json();
      const o = L.geoJSON(gj, { style: { color: "#35c48d", weight: 2, fill: false, dashArray: "6 4" } }).addTo(map);
      map.fitBounds(o.getBounds(), { padding: [24, 24] });
    } catch { /* cosmetic */ }
  }
  if (!layerIds.length) { $("layer-chips").style.display = "none"; return; }
  try {
    const defs = await (await fetch(`/api/layers?basin=${encodeURIComponent(SPEC)}`)).json();
    const tiles = {};
    const chips = layerIds
      .map((id) => defs.find((d) => d.id === id))
      .filter((d) => d && d.url);
    chips.forEach((d, i) => {
      tiles[d.id] = L.tileLayer(d.url, { opacity: 0.85, maxZoom: 14 });
      if (i === 0) tiles[d.id].addTo(map); // first layer on by default
    });
    $("layer-chips").innerHTML = chips.map((d, i) =>
      `<button class="chip ${i === 0 ? "on" : ""}" data-id="${d.id}">${d.name}</button>`).join("");
    document.querySelectorAll(".chip").forEach((c) =>
      c.addEventListener("click", () => {
        const t = tiles[c.dataset.id];
        if (c.classList.toggle("on")) t.addTo(map); else map.removeLayer(t);
      }));
  } catch { $("layer-chips").style.display = "none"; }
}

function pulseMarker(lat, lon, color, popup) {
  const icon = L.divIcon({
    className: "",
    html: `<div class="pulse-marker" style="color:${color}">
             <div class="ring"></div>
             <div class="core" style="background:${color}"></div>
           </div>`,
    iconSize: [16, 16], iconAnchor: [8, 8],
  });
  return L.marker([lat, lon], { icon }).bindPopup(popup).addTo(map);
}

/* ---------------- boot + per-pipeline renderers ---------------- */
async function boot() {
  const meta = META[PIPE] || META.weather;
  $("h-pipe").textContent = meta.name;
  $("hero-icon").textContent = meta.icon;
  $("h-sub").innerHTML = `<span class="live-dot"></span>${SPEC || "—"}`;
  document.title = `${meta.name} — Pak-ClimInt`;

  if (!SPEC) { $("loading-note").textContent = "No AOI given — go back to the map and pick one."; $("loading").style.display = ""; return; }

  let data = null;
  try {
    const c = JSON.parse(localStorage.getItem(KEY));
    if (c && Date.now() - c.ts < FRESH_MS) data = c.data;
  } catch { /* ignore */ }

  if (!data) {
    $("loading").style.display = "";
    try {
      const r = await fetch(`/api/pipeline/${PIPE}?basin=${encodeURIComponent(SPEC)}`);
      if (r.status === 401) { location.href = "/login"; return; }
      data = await r.json();
      if (data.status !== "ok") throw data.error || "agent failed";
      try { localStorage.setItem(KEY, JSON.stringify({ ts: Date.now(), data })); } catch { /* full */ }
    } catch (err) {
      $("loading-note").textContent = `Agent failed: ${String(err).slice(0, 220)}`;
      return;
    }
    $("loading").style.display = "none";
  }

  $("dash").style.display = "";
  await buildMap(meta.layers);
  ({ weather, disaster, terrain, population, urban })[PIPE](data);
  showHeadline(buildHeadline(PIPE, data));
  wireSummary(buildSummary(PIPE, data));
  reveal();
  const storm = (PIPE === "weather" && (data.forecast_rain_mm?.next_72h?.basin_mean || 0) >= 15)
    || (PIPE === "urban" && (data.flagged || []).length > 0)
    || (PIPE === "disaster" && data.worst_station &&
        data.worst_station.flood_category !== "normal");
  fancyFX(storm);
  $("foot").textContent = "Every value on this page is read directly from the agent's JSON output — sources shown in the notes above.";
}

function tickers(list) {
  $("tickers").innerHTML = list.map((t, i) =>
    `<div class="ticker"><div class="tv" id="tk-${i}">—</div><div class="tl">${t.l}</div></div>`).join("");
  list.forEach((t, i) => t.v != null &&
    countUp($(`tk-${i}`), t.v, { decimals: t.d ?? 0, suffix: t.s || "", ms: 900 + i * 140 }));
}

/* --- weather --- */
function weather(d) {
  const o24 = d.observed_rain_mm.last_24h, o72 = d.observed_rain_mm.last_72h;
  const f72 = d.forecast_rain_mm.next_72h;
  const tp = d.temperature_c?.point, tn = d.temperature_c?.now;
  const c = d.conditions_now || {};
  rainFX(f72.basin_mean);

  $("hero-big").innerHTML = `<span id="hb">0</span> <small>°C now</small>`;
  countUp($("hb"), tp?.value ?? tn?.aoi_mean, { decimals: 1 });
  $("hero-desc").textContent = tp ? `Meteoblue${tp.observed ? " observed" : ""} at the AOI centre` : "GFS 2 m model area value";
  tickers([
    { v: c.feels_like_c, d: 1, s: "°", l: "Feels like" },
    { v: c.humidity_pct, s: "%", l: "Humidity" },
    { v: c.wind_ms, d: 1, l: "Wind m/s" },
    { v: c.precip_probability_pct, s: "%", l: "Rain chance" },
    { v: c.pressure_hpa, l: "hPa" },
  ]);
  const wxScene = (mm, stormMm) => mm >= 0.5
    ? sceneRain(Math.round(mm), mm >= (stormMm || 25))
    : ((c.precip_probability_pct || 0) >= 40 ? sceneCloud() : sceneSun());
  $("cards").innerHTML = cardsHtml([
    { v: `${o24.basin_mean ?? "n/a"} mm`, l: "Observed 24 h", s: `max ${o24.basin_max} mm`, scene: wxScene(o24.basin_mean) },
    { v: `${o72.basin_mean ?? "n/a"} mm`, l: "Observed 72 h", s: `max ${o72.basin_max} mm`, scene: wxScene(o72.basin_mean, 50) },
    { v: `${f72.basin_mean ?? "n/a"} mm`, l: "Forecast 72 h", s: `max ${f72.basin_max} mm (GFS)`, scene: wxScene(f72.basin_mean, 50) },
    { v: `${d.observed_latency_hours} h`, l: "Satellite latency", s: "IMERG publication delay", scene: sceneCloud() },
  ]);
  const days7 = d.forecast_daily?.days || [];
  if (days7.length) $("map-panel").insertAdjacentHTML("beforebegin", dayStripHtml(days7));
  $("charts").innerHTML =
    chartBox("c1", "Rain — observed vs forecast (mm)") +
    chartBox("c2", "7-day outlook — daily rain (mm)") +
    chartBox("c3", "7-day outlook — temperature (°C)") +
    chartBox("c4", "7-day outlook — humidity (%)");
  new Chart($("c1"), { type: "bar", data: {
    labels: ["Obs 24 h", "Obs 72 h", "Fcst 72 h"],
    datasets: [
      { label: "AOI mean", data: [o24.basin_mean, o72.basin_mean, f72.basin_mean], backgroundColor: SERIES[0], borderRadius: 4, maxBarThickness: 44 },
      { label: "AOI max", data: [o24.basin_max, o72.basin_max, f72.basin_max], backgroundColor: SERIES[1], borderRadius: 4, maxBarThickness: 44 },
    ] }, options: { maintainAspectRatio: false } });
  const days = d.forecast_daily?.days || [];
  const wd = (x) => new Date(x.date + "T00:00").toLocaleDateString("en", { weekday: "short" });
  if (days.length) {
    new Chart($("c2"), { type: "bar", data: { labels: days.map(wd),
      datasets: [{ data: days.map((x) => x.precip_mm), backgroundColor: SERIES[0], borderRadius: 4, maxBarThickness: 34 }] },
      options: { maintainAspectRatio: false, plugins: { legend: { display: false },
        tooltip: { callbacks: { afterLabel: (c2) => `probability ${days[c2.dataIndex].precip_probability_pct}%` } } } } });
    new Chart($("c3"), { type: "line", data: { labels: days.map(wd), datasets: [
      { label: "max", data: days.map((x) => x.temp_max_c), borderColor: SERIES[2], backgroundColor: SERIES[2], borderWidth: 2, pointRadius: 4 },
      { label: "min", data: days.map((x) => x.temp_min_c), borderColor: SERIES[0], backgroundColor: SERIES[0], borderWidth: 2, pointRadius: 4 },
    ] }, options: { maintainAspectRatio: false, interaction: { mode: "index", intersect: false } } });
    new Chart($("c4"), { type: "line", data: { labels: days.map(wd), datasets: [
      { label: "mean humidity", data: days.map((x) => x.humidity_mean_pct), borderColor: SERIES[1], backgroundColor: "rgba(25,158,112,0.25)", fill: true, borderWidth: 2, pointRadius: 4 },
    ] }, options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { min: 0, max: 100 } } } });
  }
  $("charts-note").textContent = `Sources: ${d.sources.observed} (observed, window ends ${d.observed_window_end_utc}) · ${d.sources.forecast} (forecast) · ${d.sources.temperature}. 7-day outlook is a Meteoblue point at the AOI centre.`;
  $("map-note").textContent = "Rain rasters are the weather agent's own images — the map and the numbers can never disagree.";
}

/* --- disaster / river --- */
function disaster(d) {
  const stations = d.stations || {};
  const names = Object.keys(stations);
  const worst = d.worst_station;
  $("hero-big").innerHTML = `<span id="hb">0</span> <small>m³/s peak — ${worst?.name || "n/a"}</small>`;
  countUp($("hb"), worst?.peak_m3s);
  $("hero-desc").textContent = `GloFAS cycle ${d.forecast_date}${d.forecast_age_days ? ` (${d.forecast_age_days} day(s) old — publication lag)` : ""}`;
  tickers([
    { v: names.length, l: "Stations" },
    { v: names.filter((n) => stations[n].flood_category !== "normal").length, l: "Above normal" },
    { v: d.leadtime_hours?.length, l: "Lead times" },
  ]);
  // liquid fill height follows the station's flood category
  const LVL = { normal: 22, low: 38, medium: 52, high: 68, very_high: 78, exceptional: 88 };
  $("cards").innerHTML = cardsHtml(names.slice(0, 8).map((n) => ({
    v: `${fmt(stations[n].peak_m3s)}`, l: n,
    s: `category: ${stations[n].flood_category.replace(/_/g, " ")}`,
    color: CAT_COLORS[stations[n].flood_category],
    scene: sceneWater(LVL[stations[n].flood_category] ?? 22,
      stations[n].flood_category === "normal" ? undefined : "rgba(230,103,103,0.16)"),
  })));
  $("charts").innerHTML = chartBox("c1", "Forecast discharge by lead time (m³/s)") +
    `<div class="chart-box"><h4>Station categories</h4><table id="st-t">
       <thead><tr><th>Station</th><th>Peak m³/s</th><th>Category</th></tr></thead><tbody>${
      names.map((n) => `<tr><td><span class="cat-dot" style="background:${CAT_COLORS[stations[n].flood_category]}"></span>${n}</td>
        <td>${fmt(stations[n].peak_m3s)}</td><td>${stations[n].flood_category.replace(/_/g, " ")}</td></tr>`).join("")
    }</tbody></table></div>`;
  const leads = Object.keys(Object.values(stations)[0]?.forecast_discharge_m3s || {});
  new Chart($("c1"), { type: "line", data: { labels: leads,
    datasets: names.map((n, i) => ({ label: n, data: leads.map((L2) => stations[n].forecast_discharge_m3s[L2]),
      borderColor: SERIES[i % 5], backgroundColor: SERIES[i % 5], borderWidth: 2, pointRadius: 4 })) },
    options: { maintainAspectRatio: false, interaction: { mode: "index", intersect: false } } });
  $("charts-note").textContent = "GloFAS control forecast — known ~2x low bias vs FFD cusecs at Chenab stations; relative ranking reliable.";
  // station markers (pulse when above normal)
  fetch("/api/basins").then((r) => r.json()).then((basins) => {
    const coords = {};
    basins.forEach((b) => b.stations.forEach((s) => (coords[s.name] = s)));
    names.forEach((n) => {
      const s = coords[n]; if (!s) return;
      const cat = stations[n].flood_category;
      const popup = `<b>${n}</b><br>Peak: ${fmt(stations[n].peak_m3s)} m³/s<br>Category: ${cat.replace(/_/g, " ")}`;
      if (cat !== "normal") pulseMarker(s.lat, s.lon, CAT_COLORS[cat], popup);
      else L.circleMarker([s.lat, s.lon], { radius: 8, weight: 2, color: "#0c1210", fillColor: CAT_COLORS[cat], fillOpacity: 0.95 }).bindPopup(popup).addTo(map);
    });
  });
  $("map-note").textContent = "Blue lines: HydroSHEDS river network. Markers: FFD stations coloured by flood category (pulsing = above normal).";
}

/* --- terrain --- */
function terrain(d) {
  $("hero-big").innerHTML = `<span id="hb">0</span> <small>km² assessed</small>`;
  countUp($("hb"), d.basin_area_km2);
  $("hero-desc").textContent = "SRTM 90 m DEM · HydroSHEDS flow accumulation";
  tickers([{ v: Object.keys(d.layers || {}).length, l: "Cached layers" }]);
  $("cards").innerHTML = cardsHtml([
    { v: `${fmt(d.basin_area_km2)} km²`, l: "AOI area", s: "HydroSHEDS/GAUL geometry", scene: sceneMount() },
    { v: "SRTM 90 m", l: "Elevation source", s: "USGS/NASA", scene: sceneMount() },
    { v: "HydroSHEDS", l: "Hydrography", s: "flow accumulation > 1000 cells = river", scene: sceneWater(30) },
    { v: Object.keys(d.layers || {}).length, l: "GeoTIFFs cached", s: "DEM · slope · flow accumulation", scene: sceneMount() },
  ]);
  $("charts-panel").style.display = "none";
  $("map-title").textContent = "🗺️ Terrain layers — toggle DEM / slope / rivers";
  $("map-note").textContent = "Tiles are rendered by Earth Engine from the same rasters the terrain agent analyses.";
}

/* --- population / exposure --- */
function population(d) {
  $("hero-big").innerHTML = `<span id="hb">0</span> <small>people in AOI</small>`;
  countUp($("hb"), d.total_population, { ms: 1500 });
  $("hero-desc").textContent = "WorldPop 2020 constrained, 100 m grid";
  const pct = d.total_population ? Math.round(100 * d.floodplain_population / d.total_population) : null;
  tickers([
    { v: d.floodplain_population, l: "On floodplain" },
    { v: pct, s: "%", l: "Of population" },
  ]);
  $("cards").innerHTML = cardsHtml([
    { v: fmt(d.total_population), l: "Total population", s: "WorldPop 2020", scene: sceneSky() },
    { v: fmt(d.floodplain_population), l: "Floodplain population", s: d.floodplain_definition || "slope proxy",
      color: "#c98500", scene: sceneWater(Math.min(88, pct || 30), "rgba(201,133,0,0.14)") },
    { v: pct != null ? pct + "%" : "n/a", l: "Share on floodplain", s: "proxy — Sentinel-1 mapping planned",
      scene: sceneWater(Math.min(88, pct || 30)) },
  ]);
  $("charts").innerHTML = chartBox("c1", "Population split (people)");
  new Chart($("c1"), { type: "doughnut", data: {
    labels: ["Floodplain (proxy)", "Rest of AOI"],
    datasets: [{ data: [d.floodplain_population, Math.max(0, d.total_population - d.floodplain_population)],
      backgroundColor: [SERIES[2], SERIES[1]], borderWidth: 2, borderColor: "#131c18" }] },
    options: { maintainAspectRatio: false, cutout: "62%" } });
  $("charts-note").textContent = "Floodplain = slope < 2° proxy (documented limitation).";
  $("map-note").textContent = "Raster: WorldPop population density — brighter means more people per pixel.";
}

/* --- urban --- */
function urban(d) {
  rainFX(d.max_obs24_mm);
  const flagged = d.flagged || [];
  $("hero-big").innerHTML = flagged.length
    ? `<span style="color:#ef6c00">${flagged.length}</span> <small>city(ies) flagged: ${flagged.join(", ")}</small>`
    : `<span style="color:#35c48d">All clear</span> <small>no urban flooding indicated</small>`;
  $("hero-desc").textContent = `Nationwide scan of ${d.cities.length} major cities · as of ${d.as_of_utc}`;
  tickers([
    { v: d.max_obs24_mm, d: 1, s: " mm", l: "Max 24 h rain" },
    { v: d.observed_latency_hours, d: 1, s: " h", l: "Obs latency" },
    { v: d.cities.length, l: "Cities" },
  ]);
  // city cards: skyline + water rising toward the severe threshold (80 mm),
  // plus in-card rain when anything actually fell
  const topCities = [...d.cities].slice(0, 8);
  $("cards").innerHTML = cardsHtml(topCities.map((c) => ({
    v: `${c.obs24_mm} mm`, l: c.name, s: `fcst ${c.fcst24_mm} mm · ${c.category}`,
    color: CAT_COLORS[c.category],
    scene: sceneSky() +
      sceneWater(10 + Math.min(78, (Math.max(c.obs24_mm, c.fcst24_mm) / d.thresholds_mm_24h.severe) * 78),
        c.category === "none" ? undefined : "rgba(239,108,0,0.18)") +
      (c.obs24_mm >= 1 ? sceneRain(Math.round(c.obs24_mm / 2), c.category === "severe") : ""),
  })));
  $("charts").innerHTML = chartBox("c1", "24 h rain per city — observed vs forecast (mm)");
  $("charts").firstElementChild.style.gridColumn = "1 / -1";
  new Chart($("c1"), { type: "bar", data: {
    labels: d.cities.map((c) => c.name),
    datasets: [
      { label: "observed 24 h", data: d.cities.map((c) => c.obs24_mm), backgroundColor: SERIES[0], borderRadius: 4 },
      { label: "forecast 24 h", data: d.cities.map((c) => c.fcst24_mm), backgroundColor: SERIES[1], borderRadius: 4 },
    ] }, options: { maintainAspectRatio: false, scales: { y: { title: { display: true, text: "mm" } } } } });
  $("charts-note").textContent = `Thresholds (mm/24 h over a 12 km footprint): watch ${d.thresholds_mm_24h.watch} · likely ${d.thresholds_mm_24h.likely} · severe ${d.thresholds_mm_24h.severe}. ${d.caveats?.[0] || ""}`;
  d.cities.forEach((c) => {
    const popup = `<b>${c.name}</b> (${c.province})<br>Obs 24h: ${c.obs24_mm} mm · Fcst: ${c.fcst24_mm} mm<br>Indicator: <b>${c.category}</b>`;
    if (c.category !== "none") pulseMarker(c.lat, c.lon, CAT_COLORS[c.category], popup);
    else L.circleMarker([c.lat, c.lon], { radius: 7, weight: 2, color: "#0c1210", fillColor: CAT_COLORS.none, fillOpacity: 0.9 }).bindPopup(popup).addTo(map);
  });
  map.setView([30.2, 69.5], 5);
  $("map-note").textContent = "City indicator markers — pulsing means watch or above.";
}

boot();
