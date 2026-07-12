"""Urban-flood indicator agent — rainfall-driven street-flooding risk
for Pakistan's major cities.

There is NO free real-time sensor network for urban inundation, and
GloFAS explicitly excludes urban drainage — so this agent provides the
honest next-best thing: a RULE-BASED INDICATOR built from official rain
data over each city's footprint. It answers "where is urban flooding
likely happening / about to happen", not "which streets are underwater".

DATA SOURCES (same official archives as the weather agent):
  observed: NASA GPM IMERG V07, last 24 h anchored to the newest image
            (the satellite lags 1-3 days; latency is reported, so
            "currently" is as current as the data physically allows)
  forecast: NOAA GFS 0.25, latest run, next 24 h

City footprint = 12 km buffer around the city centre — the rain grids
are ~11 km, so a land-cover mask would not change the numbers.

Bands (mm / 24 h over the city footprint):
    < 20  none    · 20-50  watch  (ponding possible)
  50-80  likely  (street flooding expected) · >= 80  severe
Aligned with PMD's heavy (50-99 mm) / very heavy (>=100 mm) rainfall
categories; Karachi drainage studies show street flooding from
~40-50 mm/24 h. Indicative thresholds — not a hydraulic drainage model.
"""

import datetime as dt
import json

from agents.ee_common import initialize_ee
from agents.weather_agent import GFS_ASSET, IMERG_SCALE_M, WeatherAgent

import ee

CITY_RADIUS_M = 12000

# Major flood-prone cities: name -> (lon, lat, province)
CITIES = {
    "Karachi": (67.01, 24.86, "Sindh"),
    "Hyderabad": (68.37, 25.38, "Sindh"),
    "Sukkur": (68.86, 27.71, "Sindh"),
    "Lahore": (74.35, 31.52, "Punjab"),
    "Faisalabad": (73.08, 31.42, "Punjab"),
    "Rawalpindi-Islamabad": (73.05, 33.65, "Punjab"),
    "Multan": (71.47, 30.20, "Punjab"),
    "Gujranwala": (74.19, 32.16, "Punjab"),
    "Sialkot": (74.53, 32.49, "Punjab"),
    "Bahawalpur": (71.68, 29.40, "Punjab"),
    "Dera Ghazi Khan": (70.63, 30.06, "Punjab"),
    "Peshawar": (71.53, 34.01, "Khyber Pakhtunkhwa"),
    "Nowshera": (71.98, 34.02, "Khyber Pakhtunkhwa"),
    "Dera Ismail Khan": (70.90, 31.83, "Khyber Pakhtunkhwa"),
    "Quetta": (66.99, 30.18, "Balochistan"),
    "Gilgit": (74.31, 35.92, "Gilgit-Baltistan"),
    "Muzaffarabad": (73.47, 34.36, "Azad Kashmir"),
}

# (threshold mm/24h, category) — cumulative like the FFD bands
URBAN_BANDS = [(20, "watch"), (50, "likely"), (80, "severe")]
CATEGORY_ORDER = ["none", "watch", "likely", "severe"]


def classify_urban(mm: float | None) -> str:
    if mm is None:
        return "none"
    category = "none"
    for threshold, name in URBAN_BANDS:
        if mm >= threshold:
            category = name
    return category


class UrbanFloodAgent:
    def __init__(self, key_file: str | None = None):
        initialize_ee(key_file)

    def run(self, basin: str = "pakistan") -> dict:
        """Scan all registered cities (nationwide). The AOI spec is
        ignored EXCEPT "province:<Name>", which filters to that
        province's cities — urban flooding is a national question."""
        province = None
        if basin.startswith("province:"):
            province = basin.partition(":")[2].strip().lower()

        cities = {n: c for n, c in CITIES.items()
                  if province is None or c[2].lower() == province}
        if not cities:
            return {"agent": "urban_flood", "status": "error",
                    "error": f"no registered city in {basin!r}; "
                             "urban scan covers major cities only"}

        now = dt.datetime.now(dt.timezone.utc)
        # observed 24 h, anchored to newest IMERG image (weather agent's
        # own builder, so the two agents can never disagree)
        try:
            obs24, _, _, obs_end, latency_h = WeatherAgent()._rain_images()
        except RuntimeError as e:
            return {"agent": "urban_flood", "status": "error", "error": str(e)}

        gfs = ee.ImageCollection(GFS_ASSET).filterDate(
            (now - dt.timedelta(hours=24)).isoformat(), now.isoformat())
        latest_run = gfs.aggregate_max("creation_time")
        fcst24 = (gfs.filter(ee.Filter.eq("creation_time", latest_run))
                  .filter(ee.Filter.inList("forecast_hours", [6, 12, 18, 24]))
                  .select("total_precipitation_surface").sum())

        fc = ee.FeatureCollection([
            ee.Feature(ee.Geometry.Point(lon, lat).buffer(CITY_RADIUS_M),
                       {"city": name, "province": prov,
                        "lon": lon, "lat": lat})
            for name, (lon, lat, prov) in cities.items()
        ])
        combined = obs24.rename("obs24_mm").addBands(fcst24.rename("fcst24_mm"))
        stats = combined.reduceRegions(
            collection=fc, reducer=ee.Reducer.mean(), scale=IMERG_SCALE_M
        ).getInfo()

        results = []
        for f in stats["features"]:
            p = f["properties"]
            obs = round(p.get("obs24_mm") or 0, 1)
            fcst = round(p.get("fcst24_mm") or 0, 1)
            obs_cat, fcst_cat = classify_urban(obs), classify_urban(fcst)
            overall = max(obs_cat, fcst_cat, key=CATEGORY_ORDER.index)
            results.append({
                "name": p["city"], "province": p["province"],
                "lon": p["lon"], "lat": p["lat"],
                "obs24_mm": obs, "fcst24_mm": fcst,
                "obs_category": obs_cat, "fcst_category": fcst_cat,
                "category": overall,
            })
        results.sort(key=lambda c: (-CATEGORY_ORDER.index(c["category"]),
                                    -(c["obs24_mm"] + c["fcst24_mm"])))
        flagged = [c["name"] for c in results if c["category"] != "none"]

        return {
            "agent": "urban_flood",
            "status": "ok",
            "scope": f"province:{province}" if province else "pakistan",
            "as_of_utc": now.isoformat(timespec="seconds"),
            "observed_window_end_utc": obs_end.isoformat(timespec="seconds"),
            "observed_latency_hours": latency_h,
            "cities": results,
            "flagged": flagged,
            "max_obs24_mm": max((c["obs24_mm"] for c in results), default=0),
            "thresholds_mm_24h": {"watch": 20, "likely": 50, "severe": 80},
            "caveats": [
                "Rain-based indicator over a 12 km city footprint — not a "
                "drainage/hydraulic model and not observed inundation.",
                "Observed rain lags by the reported latency (satellite "
                "publication delay).",
                "Verify against PMD warnings and local reports before acting.",
            ],
            "sources": {"observed": "NASA/GPM_L3/IMERG_V07",
                        "forecast": GFS_ASSET},
        }


if __name__ == "__main__":
    print(json.dumps(UrbanFloodAgent().run(), indent=2))
