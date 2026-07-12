// Pak-ClimInt — full-page Risk Assessment dashboard.
// Presentation only: every number is read from the coordinator's JSON
// (fetched here or handed over via localStorage from the map page).
// Nothing is computed or invented in this file beyond formatting.

const $ = (id) => document.getElementById(id);
const qs = new URLSearchParams(location.search);
const SPEC = qs.get("basin");
const STORE_KEY = "pakclimint.lastRisk";
const FRESH_MS = 30 * 60 * 1000;

const LEVEL_COLORS = {
  low: "#2e7d52", moderate: "#b9950a", medium: "#b9950a",
  high: "#c46a0e", severe: "#b03434", extreme: "#b03434",
};
const CAT_COLORS = {
  normal: "#35c48d", low: "#f0c53f", medium: "#ef6c00",
  high: "#c62828", very_high: "#8e24aa", exceptional: "#4a0d67",
};
const SERIES = ["#3987e5", "#199e70", "#c98500", "#9085e9", "#e66767"];

/* ---------------- chart theme ---------------- */
Chart.defaults.color = "#8fa39a";
Chart.defaults.borderColor = "rgba(255,255,255,0.08)";
Chart.defaults.font.family = "'Segoe UI', system-ui, sans-serif";
Chart.defaults.plugins.legend.labels.boxWidth = 12;
Chart.defaults.plugins.legend.labels.boxHeight = 12;
Chart.defaults.animation = { duration: 950, easing: "easeOutQuart" };
Chart.defaults.datasets.bar = { ...(Chart.defaults.datasets.bar || {}),
  animation: { delay: (c) => c.type === "data" ? c.dataIndex * 90 : 0 } };

const fmt = (n) => (n == null ? "n/a" : n.toLocaleString());

/* ---------------- data loading ---------------- */
function cached() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)); } catch { return null; }
}
function store(spec, data) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify({ spec, ts: Date.now(), data })); } catch { /* full */ }
}

async function boot() {
  const c = cached();
  if (SPEC) {
    if (c && c.spec === SPEC && Date.now() - c.ts < FRESH_MS) return render(SPEC, c.data);
    $("loading").style.display = "";
    try {
      const r = await fetch(`/api/risk?basin=${encodeURIComponent(SPEC)}`);
      if (r.status === 401) { location.href = "/login"; return; }
      const data = await r.json();
      if (data.error) throw data.error;
      store(SPEC, data);
      $("loading").style.display = "none";
      render(SPEC, data);
    } catch (err) {
      $("loading-note").textContent = `Assessment failed: ${err}`;
    }
    return;
  }
  if (c) return render(c.spec, c.data);
  $("empty").style.display = "";
  $("h-chip").textContent = "no data";
}

/* ---------------- live animation layer ---------------- */
// count-up: animate a number from 0 to its real value (display only)
function countUp(el, target, { suffix = "", decimals = 0, ms = 1100 } = {}) {
  if (target == null || isNaN(target)) { el.textContent = "n/a"; return; }
  const t0 = performance.now();
  (function step(t) {
    const k = Math.min(1, (t - t0) / ms);
    const eased = 1 - Math.pow(1 - k, 3);
    el.textContent = (target * eased).toFixed(decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ",") + suffix;
    if (k < 1) requestAnimationFrame(step);
  })(t0);
}

// falling-rain canvas — drop count scales with the REAL forecast rain
function startRainFX(fcstMeanMm) {
  const cvs = $("fx-canvas"), ctx = cvs.getContext("2d");
  let W, H;
  const resize = () => { W = cvs.width = innerWidth; H = cvs.height = innerHeight; };
  resize(); addEventListener("resize", resize);
  const n = Math.min(140, Math.round((fcstMeanMm || 0) * 6) + 12); // 12 drops minimum drizzle
  const drops = Array.from({ length: n }, () => ({
    x: Math.random() * innerWidth, y: Math.random() * innerHeight,
    v: 2.4 + Math.random() * 3.2, len: 8 + Math.random() * 12,
  }));
  ctx.strokeStyle = "rgba(74,163,240,0.16)";
  ctx.lineWidth = 1.4;
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

// hero strip: animated icon picked from the ACTUAL current conditions
function renderHero(w) {
  const c = w.conditions_now || {};
  const tp = w.temperature_c?.point;
  const tn = w.temperature_c?.now;
  const temp = tp?.value ?? tn?.aoi_mean;
  const rainChance = c.precip_probability_pct ?? 0;
  const rainy = rainChance >= 40 || (c.pictocode >= 6 && c.pictocode <= 17);

  const icon = $("wx-icon");
  icon.innerHTML = rainy
    ? `<div class="wx-cloud"></div>` +
      [16, 30, 44].map((x, i) =>
        `<div class="wx-drop" style="left:${x}px; animation-delay:${i * 0.35}s"></div>`).join("")
    : `<div class="wx-sun"></div><div class="wx-cloud" style="opacity:0.55"></div>`;

  $("hero-temp").innerHTML = `<span id="hero-temp-n">0</span> <small>°C</small>`;
  countUp($("hero-temp-n"), temp, { decimals: 1 });
  $("hero-desc").textContent =
    (tp ? `Meteoblue${tp.observed ? " observed" : ""} reading at the AOI centre` : "GFS 2 m model area value") +
    (c.time_local ? ` · ${c.time_local} local` : "");

  const ticks = [
    { v: c.feels_like_c, d: 1, s: "°", l: "Feels like" },
    { v: c.humidity_pct, d: 0, s: "%", l: "Humidity" },
    { v: c.wind_ms, d: 1, s: "", l: "Wind m/s" },
    { v: c.precip_probability_pct, d: 0, s: "%", l: "Rain chance" },
    { v: c.pressure_hpa, d: 0, s: "", l: "hPa" },
    { v: c.uv_index, d: 0, s: "", l: "UV index" },
  ];
  $("tickers").innerHTML = ticks.map((t, i) =>
    `<div class="ticker"><div class="tv" id="tk-${i}">—</div><div class="tl">${t.l}</div></div>`).join("");
  ticks.forEach((t, i) => t.v != null &&
    countUp($(`tk-${i}`), t.v, { decimals: t.d, suffix: t.s, ms: 900 + i * 150 }));
}

// 3D tilt on cards + lightning flashes during storm conditions.
// Storm mode is DATA-driven: heavy forecast rain or an elevated level.
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

// scroll reveal for sections
function watchReveal() {
  const io = new IntersectionObserver((entries) => entries.forEach((e) => {
    if (e.isIntersecting) { e.target.classList.add("revealed"); io.unobserve(e.target); }
  }), { threshold: 0.08 });
  document.querySelectorAll("section.block").forEach((s) => io.observe(s));
}

/* ---------------- render ---------------- */
let miniMap = null, stationMarkers = {};

function render(spec, d) {
  $("dash").style.display = "";
  const w = d.agents?.weather || {};
  const rv = d.agents?.river || {};
  const pop = d.agents?.population || {};
  const ter = d.agents?.terrain || {};
  const level = d.risk_level || "unknown";
  const lc = LEVEL_COLORS[level] || "#555";

  /* header */
  const aoiName = d.aoi?.name || d.basin || spec;
  $("h-aoi").textContent = `${aoiName} · assessed ${new Date().toLocaleString()}`;
  $("h-chip").textContent = `${level.toUpperCase()} · ${d.risk_score}/100`;
  $("h-chip").style.background = lc;
  document.title = `${level.toUpperCase()} ${d.risk_score}/100 · ${aoiName} — Pak-ClimInt`;

  /* completeness — how many agents returned ok (shown, never invented) */
  const agentsAll = Object.keys(d.agents || {});
  const agentsOk = agentsAll.filter((k) => (d.agents[k] || {}).status === "ok");

  /* summary cards */
  const o72 = w.observed_rain_mm?.last_72h || {};
  const f72 = w.forecast_rain_mm?.next_72h || {};
  const tp = w.temperature_c?.point;
  const tn = w.temperature_c?.now;
  const worst = rv.worst_station;
  const cards = [
    { v: level.toUpperCase(), l: "Overall risk level", s: d.degraded ? `degraded — ${d.failed_agents.join(", ")} unavailable` : "all components available", color: lc },
    { v: (d.decision?.action || "—").replace(/_/g, " "), l: "Decision", s: d.decision?.description || "" },
    { v: fmt(pop.total_population), l: "Population in AOI", s: "WorldPop 2020", zoom: "aoi" },
    { v: fmt(pop.floodplain_population), l: "On floodplain (proxy)", s: pop.total_population ? `${Math.round(100 * pop.floodplain_population / pop.total_population)}% of AOI population` : "", zoom: "aoi" },
    { v: `${o72.basin_mean ?? "n/a"} mm`, l: "Observed rain 72 h", s: `max ${o72.basin_max ?? "n/a"} mm · latency ${w.observed_latency_hours ?? "?"} h` },
    { v: `${f72.basin_mean ?? "n/a"} mm`, l: "Forecast rain 72 h", s: `max ${f72.basin_max ?? "n/a"} mm (GFS)` },
    { v: tp ? `${tp.value} °C` : (tn?.aoi_mean != null ? `${tn.aoi_mean} °C` : "n/a"),
      l: "Temperature now", s: tp ? "Meteoblue, AOI centre" + (tp.observed ? " (observed)" : "") : "GFS 2 m model area" },
    worst
      ? { v: `${fmt(worst.peak_m3s)} m³/s`, l: `Worst station — ${worst.name}`, s: `category: ${worst.flood_category.replace(/_/g, " ")}`, color: CAT_COLORS[worst.flood_category], zoom: worst.name }
      : { v: "n/a", l: "River discharge", s: rv.error ? "data unavailable" : "no station in AOI" },
  ];
  $("cards").innerHTML = cards.map((c) => `
    <div class="kcard ${c.zoom ? "clickable" : ""}" ${c.zoom ? `data-zoom="${c.zoom}"` : ""}>
      <div class="kv" ${c.color ? `style="color:${c.color}"` : ""}>${c.v}</div>
      <div class="kl">${c.l}</div>
      ${c.s ? `<div class="ks">${c.s}</div>` : ""}
    </div>`).join("");

  /* executive summary */
  $("exec-warning").textContent = d.warning_text || d.decision?.description || "";
  const findings = [];
  findings.push(`Fused risk score <b>${d.risk_score}/100 (${level})</b> → decision: <b>${(d.decision?.action || "—").replace(/_/g, " ")}</b>.`);
  if (o72.basin_mean != null) findings.push(`Observed rain last 72 h: <b>${o72.basin_mean} mm</b> AOI mean (max ${o72.basin_max} mm); forecast next 72 h: <b>${f72.basin_mean ?? "n/a"} mm</b> mean.`);
  if (worst) findings.push(`Highest river reading: <b>${worst.name}</b> at ${fmt(worst.peak_m3s)} m³/s — category <b>${worst.flood_category.replace(/_/g, " ")}</b>${rv.forecast_age_days ? ` (forecast ${rv.forecast_age_days} day(s) old — Copernicus publication lag)` : ""}.`);
  if (pop.total_population) findings.push(`Exposure: <b>${fmt(pop.total_population)}</b> people in the AOI, <b>${fmt(pop.floodplain_population)}</b> on the floodplain proxy.`);
  findings.push(`Data completeness: <b>${agentsOk.length}/${agentsAll.length} agents</b> returned data${d.degraded ? " — fusion renormalised around the missing component" : ""}.`);
  $("exec-findings").innerHTML = findings.map((f) => `<li>${f}</li>`).join("");

  const alerts = [];
  Object.entries(rv.stations || {}).forEach(([name, st]) => {
    if (st.flood_category !== "normal") alerts.push(`<span class="alert-chip" style="background:${CAT_COLORS[st.flood_category]}33; color:${CAT_COLORS[st.flood_category]}">🌊 ${name}: ${st.flood_category.replace(/_/g, " ")}</span>`);
  });
  if (d.degraded) alerts.push(`<span class="alert-chip" style="background:#5a4a1a55; color:#f0c53f">⚠ degraded: ${d.failed_agents.join(", ")} unavailable</span>`);
  $("exec-alerts").innerHTML = alerts.length ? alerts.join("") : `<span class="alert-chip" style="background:#1d3a2c; color:#35c48d">✓ no station above normal, no critical alerts</span>`;

  /* collapsible sections */
  document.querySelectorAll(".sec-head").forEach((h) =>
    h.addEventListener("click", () => h.parentElement.classList.toggle("collapsed")));

  /* live layer: hero conditions, data-driven rain, scroll reveal */
  renderHero(w);
  startRainFX(f72.basin_mean);
  watchReveal();
  fancyFX((f72.basin_mean || 0) >= 15 || ["high", "severe", "extreme"].includes(level));

  renderCharts(d, w, rv, pop);
  renderHeadline(d);
  renderDayStrip(w.forecast_daily?.days || []);
  renderHydro(spec, rv);
  renderAI(d, w);
  renderActions(d, pop);
  wireSummary(buildSummary(d));

  $("foot").textContent = `Report auto-saved server-side${d.report_path ? ` (${d.report_path.split(/[\\/]/).pop()})` : ""} · sources: NASA GPM IMERG, NOAA GFS, Copernicus GloFAS, WorldPop, USGS/HydroSHEDS, Meteoblue`;

  /* card → map zoom */
  document.querySelectorAll(".kcard.clickable").forEach((c) =>
    c.addEventListener("click", () => focusMap(c.dataset.zoom)));
}

/* ---------------- charts ---------------- */
function renderCharts(d, w, rv, pop) {
  const o24 = w.observed_rain_mm?.last_24h || {};
  const o72 = w.observed_rain_mm?.last_72h || {};
  const f72 = w.forecast_rain_mm?.next_72h || {};

  new Chart($("ch-rain"), {
    type: "bar",
    data: {
      labels: ["Observed 24 h", "Observed 72 h", "Forecast 72 h"],
      datasets: [
        { label: "AOI mean", data: [o24.basin_mean, o72.basin_mean, f72.basin_mean], backgroundColor: SERIES[0], borderRadius: 4, maxBarThickness: 42 },
        { label: "AOI max", data: [o24.basin_max, o72.basin_max, f72.basin_max], backgroundColor: SERIES[1], borderRadius: 4, maxBarThickness: 42 },
      ],
    },
    options: { maintainAspectRatio: false, scales: { y: { title: { display: true, text: "mm" } } } },
  });

  /* gauge — half doughnut, coloured by level */
  const lc = LEVEL_COLORS[d.risk_level] || "#555";
  new Chart($("ch-gauge"), {
    type: "doughnut",
    data: { labels: ["score", ""], datasets: [{ data: [d.risk_score, 100 - d.risk_score], backgroundColor: [lc, "rgba(255,255,255,0.07)"], borderWidth: 0 }] },
    options: {
      maintainAspectRatio: false, rotation: -90, circumference: 180, cutout: "72%",
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
    },
    plugins: [{
      id: "center",
      afterDraw(chart) {
        const { ctx, chartArea } = chart;
        ctx.save();
        ctx.textAlign = "center";
        ctx.fillStyle = "#e8f0ec";
        ctx.font = "700 34px 'Segoe UI'";
        ctx.fillText(d.risk_score, (chartArea.left + chartArea.right) / 2, chartArea.bottom - 28);
        ctx.fillStyle = "#8fa39a"; ctx.font = "12px 'Segoe UI'";
        ctx.fillText(`${(d.risk_level || "").toUpperCase()} · /100`, (chartArea.left + chartArea.right) / 2, chartArea.bottom - 8);
        ctx.restore();
      },
    }],
  });

  /* 7-day rain + temp (two charts — never dual axis) */
  const days = w.forecast_daily?.days || [];
  const wd = (x) => new Date(x.date + "T00:00").toLocaleDateString("en", { weekday: "short" });
  if (days.length) {
    new Chart($("ch-7rain"), {
      type: "bar",
      data: { labels: days.map(wd), datasets: [{ label: "rain mm/day", data: days.map((x) => x.precip_mm), backgroundColor: SERIES[0], borderRadius: 4, maxBarThickness: 34 }] },
      options: {
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { afterLabel: (c) => `probability ${days[c.dataIndex].precip_probability_pct}% · humidity ${days[c.dataIndex].humidity_mean_pct}% · wind ${days[c.dataIndex].wind_max_ms} m/s` } } },
        scales: { y: { title: { display: true, text: "mm" } } },
      },
    });
    new Chart($("ch-7temp"), {
      type: "line",
      data: {
        labels: days.map(wd),
        datasets: [
          { label: "max °C", data: days.map((x) => x.temp_max_c), borderColor: SERIES[2], backgroundColor: SERIES[2], borderWidth: 2, pointRadius: 4 },
          { label: "min °C", data: days.map((x) => x.temp_min_c), borderColor: SERIES[0], backgroundColor: SERIES[0], borderWidth: 2, pointRadius: 4 },
        ],
      },
      options: { maintainAspectRatio: false, interaction: { mode: "index", intersect: false } },
    });
    $("met-note").textContent = `7-day outlook: Meteoblue point at the AOI centre. Rain area statistics: ${w.sources?.observed || "GPM"} (observed, latency ${w.observed_latency_hours} h) + ${w.sources?.forecast || "GFS"} (forecast). These area values feed the risk score; the 7-day point outlook is situational context only.`;
  } else {
    $("ch-7rain").closest(".chart-box").style.display = "none";
    $("ch-7temp").closest(".chart-box").style.display = "none";
  }

  /* exposure */
  new Chart($("ch-pop"), {
    type: "bar",
    data: {
      labels: ["Total population", "Floodplain (proxy)"],
      datasets: [{ data: [pop.total_population, pop.floodplain_population], backgroundColor: SERIES[1], borderRadius: 4, maxBarThickness: 60 }],
    },
    options: { maintainAspectRatio: false, indexAxis: "y", plugins: { legend: { display: false } } },
  });
  $("exp-cards").innerHTML = [
    { v: fmt(pop.total_population), l: "People in AOI", s: "WorldPop 2020 constrained 100 m" },
    { v: fmt(pop.floodplain_population), l: "On floodplain", s: "slope < 2° proxy" },
    { v: d.agents?.terrain?.basin_area_km2 ? `${fmt(d.agents.terrain.basin_area_km2)} km²` : "n/a", l: "AOI area", s: "HydroSHEDS / GAUL geometry" },
    { v: pop.total_population && d.agents?.terrain?.basin_area_km2 ? `${Math.round(pop.total_population / d.agents.terrain.basin_area_km2)}/km²` : "n/a", l: "Mean density", s: "population ÷ area" },
  ].map((c) => `<div class="kcard"><div class="kv">${c.v}</div><div class="kl">${c.l}</div><div class="ks">${c.s}</div></div>`).join("");
}

/* ---------------- hydrology: discharge chart, table, mini map ---------------- */
async function renderHydro(spec, rv) {
  const stations = rv.stations || {};
  const names = Object.keys(stations);

  if (names.length) {
    const leadLabels = Object.keys(Object.values(stations)[0].forecast_discharge_m3s || {});
    new Chart($("ch-discharge"), {
      type: "line",
      data: {
        labels: leadLabels,
        datasets: names.map((n, i) => ({
          label: n, data: leadLabels.map((L) => stations[n].forecast_discharge_m3s[L]),
          borderColor: SERIES[i % SERIES.length], backgroundColor: SERIES[i % SERIES.length],
          borderWidth: 2, pointRadius: 4,
        })),
      },
      options: {
        maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
        scales: { y: { title: { display: true, text: "m³/s" } } },
      },
    });
    $("st-table").querySelector("tbody").innerHTML = names.map((n) => {
      const st = stations[n];
      return `<tr class="st-row" data-st="${n}">
        <td><span class="cat-dot" style="background:${CAT_COLORS[st.flood_category]}"></span>${n}</td>
        <td>${fmt(st.peak_m3s)}</td>
        <td>${st.flood_category.replace(/_/g, " ")}</td></tr>`;
    }).join("");
    $("hydro-note").textContent = `GloFAS control forecast, cycle ${rv.forecast_date || "?"}` +
      (rv.forecast_age_days ? ` (${rv.forecast_age_days} day(s) old — Copernicus publication lag)` : "") +
      ". Known ~2x low bias vs FFD-reported cusecs at Chenab stations — relative ranking is reliable, absolute values conservative.";
  } else {
    $("ch-discharge").closest(".chart-box").style.display = "none";
    $("hydro-note").textContent = rv.error
      ? `River discharge data unavailable: ${String(rv.error).slice(0, 160)}`
      : "No registered FFD station falls inside this AOI — the fusion renormalised without the river component.";
  }

  /* mini map */
  miniMap = L.map("mini-map", { zoomControl: true, attributionControl: false });
  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", { maxZoom: 14 }).addTo(miniMap);
  miniMap.setView([30.5, 71.5], 5);
  try {
    const gj = await (await fetch(`/api/basin_outline?basin=${encodeURIComponent(spec)}`)).json();
    const outline = L.geoJSON(gj, { style: { color: "#35c48d", weight: 2, fill: false, dashArray: "6 4" } }).addTo(miniMap);
    miniMap.fitBounds(outline.getBounds(), { padding: [22, 22] });
    miniMap._aoiBounds = outline.getBounds();
  } catch { /* cosmetic */ }
  try {
    const basins = await (await fetch("/api/basins")).json();
    const coords = {};
    basins.forEach((b) => b.stations.forEach((s) => (coords[s.name] = s)));
    names.forEach((n, i) => {
      const c = coords[n]; if (!c) return;
      const st = stations[n];
      stationMarkers[n] = L.circleMarker([c.lat, c.lon], {
        radius: 8, weight: 2, color: "#0c1210",
        fillColor: CAT_COLORS[st.flood_category] || "#888", fillOpacity: 0.95,
      }).bindPopup(`<b>${n}</b><br>Peak: ${fmt(st.peak_m3s)} m³/s<br>Category: ${st.flood_category.replace(/_/g, " ")}`)
        .addTo(miniMap);
    });
  } catch { /* cosmetic */ }

  document.querySelectorAll(".st-row").forEach((r) =>
    r.addEventListener("click", () => focusMap(r.dataset.st)));
}

function focusMap(target) {
  if (!miniMap) return;
  $("sec-hydro").scrollIntoView({ behavior: "smooth", block: "center" });
  if (target === "aoi") {
    if (miniMap._aoiBounds) miniMap.fitBounds(miniMap._aoiBounds, { padding: [22, 22] });
    return;
  }
  const m = stationMarkers[target];
  if (m) { miniMap.setView(m.getLatLng(), 10); m.openPopup(); }
}

/* ---------------- AI explanation + actions ---------------- */
function renderAI(d, w) {
  const comps = d.components || {};
  const weights = d.weights || {};
  const keys = Object.keys(comps);
  new Chart($("ch-comp"), {
    type: "bar",
    data: {
      labels: keys.map((k) => `${k.replace(/_/g, " ")} (w=${weights[k] ?? "?"})`),
      datasets: [{ data: keys.map((k) => +(comps[k] * (weights[k] || 0)).toFixed(1)), backgroundColor: SERIES[0], borderRadius: 4, maxBarThickness: 40 }],
    },
    options: {
      maintainAspectRatio: false, indexAxis: "y",
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { afterLabel: (c) => `raw component score: ${comps[keys[c.dataIndex]]}/100` } },
      },
      scales: { x: { title: { display: true, text: "contribution to fused score" }, max: 100 } },
    },
  });

  const parts = keys.map((k) => `<b>${k.replace(/_/g, " ")}</b> scored ${comps[k]}/100 (weight ${weights[k]}) contributing ${(comps[k] * (weights[k] || 0)).toFixed(1)} points`);
  $("ai-text").innerHTML =
    `The fused score of <b>${d.risk_score}/100</b> is the weighted sum of the rule-scored components: ${parts.join("; ")}. ` +
    `That total falls in the <b>${(d.risk_level || "").toUpperCase()}</b> band, which maps to the decision ` +
    `<b>${(d.decision?.action || "").replace(/_/g, " ")}</b>.` +
    (d.degraded ? ` The assessment is <b>degraded</b>: ${d.failed_agents.join(", ")} returned no data, and the remaining weights were renormalised — treat the score as a floor, not a ceiling.` : "") +
    (w.observed_latency_hours ? ` Observed rain carries a ${w.observed_latency_hours} h satellite publication latency.` : "");
}

/* ---------------- plain-language summary modal ---------------- */
// Every sentence is templated from the coordinator's real JSON fields —
// nothing is estimated or invented here.
function buildSummary(d) {
  const w = d.agents?.weather || {};
  const rv = d.agents?.river || {};
  const pop = d.agents?.population || {};
  const o72 = w.observed_rain_mm?.last_72h || {};
  const f72 = w.forecast_rain_mm?.next_72h || {};
  const level = (d.risk_level || "unknown").toUpperCase();
  const p = [];
  p.push(`This assessment scores the area at <b>${d.risk_score}/100</b>, which is the <b>${level}</b> band. In practical terms the recommended posture is: <b>${(d.decision?.action || "n/a").replace(/_/g, " ")}</b> — ${d.decision?.description || ""}`);
  if (o72.basin_mean != null) {
    p.push(`<b>Rain:</b> over the last 3 days the area received about <b>${o72.basin_mean} mm</b> on average (the wettest spot got ${o72.basin_max} mm). The next 3 days are forecast to bring about <b>${f72.basin_mean ?? "n/a"} mm</b> on average${f72.basin_max != null ? ` (locally up to ${f72.basin_max} mm)` : ""}.`);
  }
  const worst = rv.worst_station;
  if (worst) {
    p.push(`<b>Rivers:</b> the highest forecast flow is at <b>${worst.name}</b> — about <b>${fmt(worst.peak_m3s)} m³/s</b>, rated "<b>${worst.flood_category.replace(/_/g, " ")}</b>" against its long-term flood thresholds. ${worst.flood_category === "normal" ? "No station is above its normal range." : "Anything above “normal” deserves attention."}`);
  } else if (rv.error) {
    p.push(`<b>Rivers:</b> discharge data is unavailable for this run — the score was computed without the river component (reported honestly, not guessed).`);
  }
  if (pop.total_population) {
    p.push(`<b>People:</b> roughly <b>${fmt(pop.total_population)}</b> people live in this area, of whom <b>${fmt(pop.floodplain_population)}</b> (${Math.round(100 * pop.floodplain_population / pop.total_population)}%) live on land flat enough to flood (a proxy estimate).`);
  }
  if (d.degraded) {
    p.push(`⚠ <b>Caveat:</b> ${d.failed_agents.join(", ")} returned no data this run, so the score is a floor, not a ceiling.`);
  }
  p.push(`<span class="sum-note">All numbers above are quoted directly from the agent outputs (NASA GPM, NOAA GFS, Copernicus GloFAS, WorldPop, Meteoblue). The wording is templated — no AI invented any value.</span>`);
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

/* ---------------- Google-Weather 7-day strip ---------------- */
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

function renderDayStrip(days) {
  if (!days.length) return;
  const wd = (x) => new Date(x.date + "T00:00").toLocaleDateString("en", { weekday: "short" });
  $("day-strip-wrap").innerHTML = `<div class="day-strip">${days.map((x) => `
    <div class="day-card" title="humidity ${x.humidity_mean_pct}% · wind max ${x.wind_max_ms} m/s · rain probability ${x.precip_probability_pct}%">
      <div class="dc-wd">${wd(x)}</div>
      <div class="dc-icon">${dayIcon(x)}</div>
      <div class="dc-desc">${dayLabel(x)}</div>
      <div class="dc-t">${Math.round(x.temp_max_c)}°</div>
      <div class="dc-tmin">${Math.round(x.temp_min_c)}°</div>
      <div class="dc-rain">${x.precip_mm > 0 ? x.precip_mm + " mm" : ""}</div>
    </div>`).join("")}</div>`;
}

/* scrolling headline ticker under the hero — news-ticker of short items,
   all quoted from the coordinator JSON (per forecast day + per station) */
function renderHeadline(d) {
  const w = d.agents?.weather || {};
  const rv = d.agents?.river || {};
  const pop = d.agents?.population || {};
  const wd = (x) => new Date(x.date + "T00:00").toLocaleDateString("en", { weekday: "long" });
  const items = [];
  items.push(`Risk <b>${(d.risk_level || "?").toUpperCase()} ${d.risk_score}/100</b> → <b>${(d.decision?.action || "n/a").replace(/_/g, " ")}</b>`);
  const o24 = w.observed_rain_mm?.last_24h?.basin_mean;
  const f72 = w.forecast_rain_mm?.next_72h?.basin_mean;
  if (o24 != null) items.push(`Last 24 h: <b>${o24} mm</b> rain observed`);
  if (f72 != null) items.push(`Next 3 days: <b>${f72} mm</b> forecast`);
  Object.entries(rv.stations || {}).forEach(([n, st]) => {
    items.push(`<b>${n}</b>: ${st.flood_category.replace(/_/g, " ")}, peak ${fmt(st.peak_m3s)} m³/s`);
  });
  (w.forecast_daily?.days || []).forEach((x) => {
    items.push(`<b>${wd(x)}</b>: ${dayLabel(x)}, ${Math.round(x.temp_max_c)}°/${Math.round(x.temp_min_c)}°` +
      (x.precip_mm >= 0.5 ? `, ${x.precip_mm} mm rain (${x.precip_probability_pct}%)` : ""));
  });
  if (pop.total_population) {
    items.push(`Exposure: <b>${fmt(pop.total_population)}</b> people, <b>${fmt(pop.floodplain_population)}</b> on floodplain`);
  }
  const seq = items.map((t) => `<span class="tk-item">${t}</span>`).join("");
  const secs = Math.max(18, items.length * 5);
  $("headline").innerHTML =
    `<span class="hl-tag">Live</span>
     <div class="tick-wrap"><div class="tick-track" style="--tick-s:${secs}s">${seq}${seq}</div></div>`;
  $("headline").style.display = "";
}

function renderActions(d, pop) {
  const ACTIONS = {
    routine_monitoring: [
      "Continue scheduled monitoring runs (no alert threshold crossed).",
      "Verify FFD station readings against the portal once daily.",
      "Keep the 7-day outlook under watch for the next monsoon pulse.",
      "No public action required at this level.",
    ],
    advisory: [
      "Brief the relevant PDMA duty officers on the elevated score and its drivers.",
      "Increase assessment frequency to every 6 hours for this AOI.",
      "Cross-check GloFAS discharge against FFD gauge readings (known low bias).",
      "Pre-verify communication channels with district administrations.",
    ],
    alert: [
      "Issue a public advisory for the AOI through standard NDMA channels.",
      "Pre-position response teams and relief stocks near the flagged stations.",
      `Review evacuation readiness for the floodplain population (${fmt(pop.floodplain_population)} people, proxy estimate).`,
      "Move to hourly monitoring; validate every satellite value against ground reports.",
    ],
    warning: [
      "Activate emergency protocols with the relevant PDMAs immediately.",
      "Initiate evacuation of low-lying settlements per district contingency plans.",
      "Establish continuous (hourly or better) monitoring of all stations in the AOI.",
      "Coordinate with PMD/FFD for official confirmation before wide public broadcast.",
    ],
  };
  const list = ACTIONS[d.decision?.action] || ["No decision available — run the assessment again."];
  $("actions").innerHTML = list.map((a) => `<li>${a}</li>`).join("");
}

boot();
