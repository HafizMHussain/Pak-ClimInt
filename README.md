# Pak-ClimInt

A multi-agent flood early-warning portal for Pakistan, built entirely on free and
open data. It watches rainfall, river discharge, terrain and population exposure,
fuses them into a single risk score, and puts everything on an interactive WebGIS
map — with a chat assistant (Alpha) that can run any of the analysis pipelines
for you in plain English.

I started this because Pakistan keeps getting hit by floods (2010 and 2022 being
the worst in recent memory) and the tooling available to duty forecasters is
scattered across half a dozen websites. The idea was simple: what if one portal
pulled the official global datasets together and a set of agents did the boring
cross-checking automatically?

Live instance: https://15.207.86.94.sslip.io (login required)

## How it works

There are six agents, each responsible for one question:

| Agent | Question it answers | Data behind it |
|---|---|---|
| Weather | How much rain fell, and how much is coming? | NASA GPM IMERG (observed), NOAA GFS (forecast), Meteoblue (point conditions + 7-day outlook) |
| River / Disaster | Are the rivers rising? | Copernicus GloFAS discharge forecasts, classified against FFD flood categories |
| Terrain | Where does the water go? | SRTM DEM, HydroSHEDS flow accumulation and slope |
| Exposure | Who is in the way? | WorldPop 2020 (100 m constrained) |
| Urban flooding | Which cities are getting dumped on? | 24 h rain over 17 major cities vs fixed thresholds |
| Coordinator | So what do we do? | Rule-based fusion of the above into a 0–100 score and a decision level |

One rule I've been strict about from day one: **the LLM never touches the
numbers.** The risk score comes from transparent rule-based thresholds and
published weights. The chat assistant and the warning text generator can only
orchestrate pipelines and quote their outputs — if a pipeline fails, the
assistant says the data is unavailable rather than guessing. A data gap is not
a flood signal.

## The frontend

- Flask backend + vanilla JS with Leaflet (flat map) and MapLibre (3D globe view)
- Draw a box anywhere on the map and every pipeline runs on exactly that area;
  or pick from basins, provinces and 119 districts
- Full-page dashboards for the overall risk assessment and for each agent,
  with charts and a plain-language "Summary" button for non-technical readers
- Alpha, the chat assistant, can run pipelines, toggle layers, fly the map
  around and open dashboards — it speaks its answers too if you turn voice on
- Sign in with email/password or Google

There's also a Streamlit app under `webapp/` — that's my internal scratchpad
for trying agent changes quickly. The Flask app is the real portal; both call
the same agent modules so they can't drift apart.

## Running it locally

You'll need Python 3.11+ and accounts/keys for the data services (all free):

- a Google Earth Engine service account (weather, terrain, exposure)
- a Copernicus CDS/EWDS key (GloFAS river forecasts)
- optionally a Groq key for the chat assistant and a Meteoblue key for
  station-quality temperature — both degrade gracefully if missing

```
pip install -r requirements.txt
copy .env.example .env        # fill in your keys
python backend\app.py
```

Then open http://localhost:5000. First run on a new basin takes a few minutes
because the terrain agent downloads and caches the DEM.

For a production-style setup there's a Dockerfile and compose file (gunicorn,
credentials mounted read-only, nothing sensitive baked into the image):

```
docker compose up -d --build
```

## Honest limitations

I'd rather list these here than have someone find out the hard way:

- GloFAS runs roughly **2x low** against FFD-reported cusecs at the Chenab
  stations I backtested (2010 and 2022 events). The flood *categories* and the
  relative ranking between stations are reliable; the absolute m³/s numbers are
  conservative.
- GloFAS covers the big rivers well but does not do flash floods, coastal
  flooding, or inundation extent. Sentinel-1 mapping is on the wishlist.
- Copernicus publishes GloFAS cycles with a delay (I've seen up to 2 days).
  The portal shows the forecast age instead of pretending the data is current.
- "Floodplain population" is a slope-based proxy (land flatter than 2°), not a
  mapped flood zone. It answers "who is exposed if water arrives", not "who
  will flood".
- Observed rain arrives with a satellite publication latency of several hours,
  which is printed next to every observed value.

## Project layout

```
agents/      the six agents + AOI resolver + chat assistant
backend/     Flask app, API routes, auth
frontend/    templates + static JS/CSS (map, globe, dashboards, login)
webapp/      Streamlit dev frontend
scripts/     deploy script, backtests, pipeline runner
tests/       agent tests
docs/        architecture notes, report, presentation
```

Secrets live in `.env` and `credentials/` — both gitignored, see
`.env.example` for what goes where.

## Acknowledgements

Data: NASA, NOAA, Copernicus/ECMWF, WorldPop, USGS, Meteoblue. Basemaps: CARTO,
Esri. None of this would be possible without these services being free for this
kind of work. Built with a lot of help from Claude Code along the way.
