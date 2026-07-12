# Presentation Q&A — defending the system before technical leadership

Audience: senior GIS engineers, AI researchers, hydrologists, NDMA leadership.
Companion to `ARCHITECTURE.md` (read that first for diagrams and details).

---

## Where does each button's data come from — and why that source?

| Button | Source | Why this source |
|---|---|---|
| 🌧️ **Weather** | **NASA GPM IMERG V07** (observed rain, satellite, ~11 km, half-hourly) + **NOAA GFS 0.25°** (forecast rain, 4 runs/day), both via Google Earth Engine | The two global standards for satellite precipitation and openly licensed NWP forecasts. PMD produces excellent products but publishes no machine-readable API; IMERG+GFS are the best automatable equivalents, and both are the *official* NASA/NOAA archives (Google mirrors them unchanged). Radar/gauge networks in Pakistan are sparse over the upper catchments in India-administered territory — satellites see the whole basin. |
| 🌊 **Disaster** | **Copernicus GloFAS** operational river-discharge forecast (EU flood service, LISFLOOD model, 0.05°, daily cycle) via the official cdsapi | The only free, operational, daily river-discharge *forecast* covering the entire Indus system including upstream flows originating outside Pakistan. Classified against **Pakistan FFD's own flood-limit bands** (in cusecs, per station) so the output speaks NDMA's language. |
| ⛰️ **Terrain** | **NASA/USGS SRTM 30 m DEM** + **WWF HydroSHEDS** flow accumulation | The reference global elevation dataset and the reference hydrological derivative built from it; static, validated, universally accepted in hydrology. |
| 👥 **Exposure** | **WorldPop 100 m** population counts (2020) | The standard gridded population dataset for humanitarian planning (used by UN OCHA, WHO); 100 m resolution lets us split "in the AOI" vs "on the floodplain". 2020 is the latest year in Earth Engine — stated as a baseline. |
| ⚖️ **Full risk** | No new data — fuses the four outputs above with **rule-based** thresholds | The decision must be reproducible and auditable (see below). |

**Cross-checking:** GPM/GFS/SRTM/WorldPop are consumed from Google Earth
Engine's mirrors of the official archives — the asset IDs
(`NASA/GPM_L3/IMERG_V07`, `NOAA/GFS0P25`, `USGS/SRTMGL1_003`,
`WorldPop/GP/100m/pop`) are documented in each agent's header with update
frequency. GloFAS comes directly from Copernicus. The one number family that
*cannot* be machine-verified is FFD's per-station cusec bands (their site
blocks automated access) — Chenab bands were cross-checked manually against
Sep-2025 FFD reports; others are flagged `VERIFY` in `agents/basins.py`.

**Why might our rain number differ from a weather app?** Weather apps show a
*point* forecast for a city; we show the **area mean over the whole AOI
polygon** (and the max), because basin-average rain is what drives river
response. Both are "correct"; they answer different questions.

---

## Architecture & AI questions

**Q: Why this architecture?**
Separation of measurement, judgement, and language. Four deterministic data
agents *measure*; a rule-based coordinator *judges* (score, level, decision);
an LLM only *phrases* the public warning. Each layer can be tested, replaced
and audited independently — which is exactly what an early-warning authority
must be able to do.

**Q: Why multiple agents instead of one AI model?**
- Each domain has a different official source, cadence, resolution and failure
  mode; isolating them means one failure degrades — never corrupts — the
  assessment (weights renormalise, `degraded` flag raised).
- Pipelines run independently (the UI buttons), so a forecaster can refresh
  weather every hour without re-downloading terrain.
- The message-passing design gives an auditable conversation log: you can read
  exactly what the river agent knew (the weather agent's rain outlook) when it
  classified the discharge.
- A single end-to-end AI model would be a black box — unacceptable when the
  output is an evacuation-relevant decision.

**Q: Which LLM is used, and where?**
Exactly one call: Anthropic `claude-opus-4-8` drafts the ≤120-word public
warning text from already-computed numbers, under a system prompt that forbids
inventing/changing any figure or altering the recommended action. If the API
is unavailable, a deterministic template is used. The LLM cannot touch the
score, level, decision, report tables, or any map value.

**Q: How are hallucinations minimized?**
By construction, not by hoping: the LLM is downstream of every number and
decision, receives them as fixed facts, and its output lands in one clearly
labelled "Draft public warning" field which an operator reviews before any
dissemination. Everything else in the system is deterministic code.

**Q: How is confidence/uncertainty handled?**
- The score is a transparent weighted rule (river .5, forecast rain .3,
  observed rain .2) — anyone can recompute it from the report tables.
- Missing components ⇒ explicit `degraded` flag + renormalised weights, shown
  in the banner and the report; zero data ⇒ `manual_review`, never a guess.
- Data staleness is quantified (`observed_latency_hours`) and displayed.
- Known biases are printed in every report (GloFAS ≈2× low ⇒ river categories
  are conservative / under-warn).

**Q: How are the thresholds validated? / How are forecasts validated?**
Backtesting against known events (`scripts/`): rain thresholds calibrated so
2010 (≈100 mm basin-mean 72 h) and 2022 (≈51 mm) floods score high while the
2018 non-flood monsoon (≈34 mm) stays low; the discharge backtest confirms
GloFAS ranks 2010 > 2022 ≈ 2018 correctly and quantifies its ≈2× low bias vs
FFD-reported flows. GFS/IMERG/GloFAS each publish extensive peer-reviewed
validation of their own; our job is validating the *thresholds we apply*, and
that is what the backtests do.

**Q: How is GIS analysis integrated with AI reasoning?**
All spatial analysis (zonal statistics, slope, flow accumulation, point-in-
polygon station selection, admin-unit clipping) happens in Earth Engine /
xarray as classical GIS operations. The "AI reasoning" layer consumes only the
resulting *numbers*. The map shows literally the same images the statistics
are computed from (the rain tiles are the weather agent's own EE images), so
what the analyst sees and what the score uses can never diverge.

---

## Operations & scaling questions

**Q: How scalable is it?**
The heavy compute (terrain, zonal stats) runs on Google's Earth Engine
infrastructure, not our server — the Flask box only orchestrates. Nationwide
coverage is a registry change (add AOIs), not an architecture change: all 130+
districts already work today through the same resolver. Scale-out path:
scheduled runs per AOI (cron), results into PostGIS + object storage, multiple
stateless Flask workers behind a load balancer, and a task queue for the long
pipelines. Agent code is unchanged in that migration.

**Q: How would nationwide operational deployment look?**
(1) Verify all FFD station bands; (2) bias-correct GloFAS or switch to its
return-period thresholds; (3) schedule 6-hourly runs for all districts +
basins; (4) store assessments in PostGIS; (5) alerting hooks (SMS/email) off
the decision ladder; (6) SOP for operator review of LLM warning text before
dissemination; (7) production WSGI (gunicorn/waitress) + reverse proxy.

**Q: Real-time monitoring and future expansion?**
The per-pipeline design already supports different refresh cadences (weather
hourly, river daily, terrain never). Planned expansions slot in as new agents
with the same contract (JSON out, conversation in): Sentinel-1 SAR inundation
mapping (replaces the slope proxy), flash-flood indicators, snowmelt (MODIS),
reservoir levels, damage estimation.

**Q: What are the limitations?** *(volunteer these before being asked)*
See §14 of ARCHITECTURE.md — GloFAS 2× low bias, unverified non-Chenab FFD
bands, slope-proxy floodplain, Chenab-only calibration, no flash-flood/coastal
coverage, 1–3 day IMERG latency, 2020 exposure baseline, HydroBASINS AOI ~30%
oversized. Every one is printed in the generated reports as a caveat.

**Q: Cost?**
Data: $0 (all open licences — NASA, NOAA, Copernicus, WorldPop, SRTM, GAUL).
Compute: Earth Engine free research tier. The only paid call is the optional
warning-text LLM (fractions of a cent per assessment, and it degrades to a
free template).

**Q: What happens if internet/data services go down?**
Static layers (terrain, population, basins) are cached locally and keep
working. Weather/river fail gracefully: the run completes in degraded mode
with the failure named, or issues `manual_review`. The system never silently
substitutes old dynamic data for current.

---

## One-paragraph elevator summary

*Five deterministic pipelines pull official open data — NASA GPM rainfall,
NOAA GFS forecasts, Copernicus GloFAS river discharge, NASA SRTM terrain,
WorldPop exposure — for any basin, province or district of Pakistan. A
coordinator agent passes real numbers between them (auditable conversation
log), fuses them with backtest-calibrated rules into a 0–100 risk score and an
NDMA-style decision (routine monitoring → advisory → alert → warning), and
generates a fully traceable situation report saved locally in Markdown and
JSON. AI is used only to phrase the public warning text — never to produce a
number or a decision.*
