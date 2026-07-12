"""Weather agent — observed and forecast rainfall over a registered basin.

DATA SOURCES (via Google Earth Engine, service-account auth — these are
the official NASA/NOAA archives mirrored by Google, not third-party
re-hosts):
  - OBSERVED: NASA/GPM_L3/IMERG_V07 — NASA Global Precipitation
    Measurement mission, IMERG Late Run V07. Half-hourly, ~11 km grid.
    UPDATE FREQUENCY: new images every 30 min but published with a
    ~1-3 day latency; this agent anchors its 24h/72h windows to the
    newest available image and reports `observed_latency_hours` so the
    staleness is always visible in the UI and reports.
  - FORECAST: NOAA/GFS0P25 — NOAA Global Forecast System, 0.25 deg
    (~28 km). UPDATE FREQUENCY: 4 model runs/day (00/06/12/18 UTC),
    available in EE a few hours after each run; the agent always uses
    the latest run's 6-hourly steps summed to +72 h.
No PMD data is used: PMD/FFD do not publish a machine-readable API, so
GPM+GFS are the best openly licensed equivalents. Values are area
statistics (mean/max over the AOI polygon), so they will legitimately
differ from any single city's weather app reading.
  - TEMPERATURE POINT READING (optional): Meteoblue `current` package
    at the AOI centroid when METEOBLUE_API_KEY is set — station-quality
    (isobserveddata flag) and matches consumer weather apps, unlike raw
    GFS 2 m which can run several °C hot over Pakistan in monsoon
    conditions (verified 11 Jul 2026: GFS 40 °C vs observed 33 °C at
    Islamabad). GFS AOI mean/max is kept as the area statistic and the
    fallback when the key is missing or the request fails.

All reductions are combined into a single getInfo() round-trip to keep
Earth Engine quota use down.

Caveat on GFS: total_precipitation_surface accumulates within 6-hour
windows, so the 72 h forecast total is the sum of the 6-hourly images —
an approximation good enough for threshold-based risk scoring, not for
hydrological modelling.
"""

import datetime as dt
import json
import os

import requests

from agents.ee_common import basin_geometry, initialize_ee

import ee

IMERG_ASSET = "NASA/GPM_L3/IMERG_V07"
GFS_ASSET = "NOAA/GFS0P25"

# Reducer scales match native resolution — finer wastes quota.
IMERG_SCALE_M = 11000
GFS_SCALE_M = 27750


# GAUL admin layers for province/district aggregation
GAUL_LEVELS = {
    "province": ("FAO/GAUL_SIMPLIFIED_500m/2015/level1", "ADM1_NAME"),
    "district": ("FAO/GAUL_SIMPLIFIED_500m/2015/level2", "ADM2_NAME"),
}


class WeatherAgent:
    def __init__(self, key_file: str | None = None):
        initialize_ee(key_file)

    def _rain_images(self):
        """Shared image builders: (obs24, obs72, fcst72, obs_end, latency_h).

        Raises RuntimeError if no recent IMERG imagery exists.
        """
        now = dt.datetime.now(dt.timezone.utc)
        imerg = ee.ImageCollection(IMERG_ASSET).select("precipitation")
        latest_ms = (
            imerg.filterDate(
                (now - dt.timedelta(days=14)).isoformat(), now.isoformat()
            ).aggregate_max("system:time_start")
        ).getInfo()
        if latest_ms is None:
            raise RuntimeError("No IMERG rainfall images in the last 14 days")
        obs_end = dt.datetime.fromtimestamp(latest_ms / 1000, dt.timezone.utc)
        latency_h = round((now - obs_end).total_seconds() / 3600, 1)

        # Half-hourly rates in mm/hr; sum(rate) * 0.5 h = accumulated mm.
        def imerg_total(hours: int) -> ee.Image:
            coll = imerg.filterDate(
                (obs_end - dt.timedelta(hours=hours)).isoformat(),
                (obs_end + dt.timedelta(minutes=30)).isoformat(),
            )
            return coll.sum().multiply(0.5).rename("mm")

        gfs = ee.ImageCollection(GFS_ASSET).filterDate(
            (now - dt.timedelta(hours=24)).isoformat(), now.isoformat()
        )
        latest_run = gfs.aggregate_max("creation_time")
        fcst72 = (
            gfs.filter(ee.Filter.eq("creation_time", latest_run))
            .filter(ee.Filter.inList("forecast_hours", [6, 12, 18, 24, 30, 36, 42, 48, 54, 60, 66, 72]))
            .select("total_precipitation_surface")
            .sum()
            .rename("mm")
        )
        return imerg_total(24), imerg_total(72), fcst72, obs_end, latency_h

    def admin_breakdown(self, basin: str = "chenab", level: str = "district",
                        geometry: ee.Geometry | None = None) -> dict:
        """Observed + forecast 72h rain aggregated per admin unit.

        Returns a GeoJSON FeatureCollection: each feature is a GAUL
        province/district intersecting the basin AOI with properties
        name, obs72_mm, fcst72_mm (area means). One reduceRegions call.
        """
        if level not in GAUL_LEVELS:
            raise ValueError(f"level must be one of {list(GAUL_LEVELS)}")
        aoi = geometry if geometry is not None else basin_geometry(basin)
        _, obs72, fcst72, obs_end, latency_h = self._rain_images()

        asset, name_prop = GAUL_LEVELS[level]
        units = ee.FeatureCollection(asset).filterBounds(aoi)
        combined = obs72.rename("obs72_mm").addBands(fcst72.rename("fcst72_mm"))
        stats = combined.reduceRegions(
            collection=units, reducer=ee.Reducer.mean(), scale=IMERG_SCALE_M
        )

        def clean(f):
            # Show only the part of the district/province that actually
            # overlaps the AOI — filterBounds() keeps a unit if ANY part
            # touches the AOI, so without this a district that only
            # edges into the basin would still draw its full shape.
            geom = f.geometry().intersection(aoi, maxError=1000).simplify(maxError=1000)
            return ee.Feature(
                geom,
                {
                    # GAUL uses "Administrative unit not available" for
                    # disputed territories (Kashmir) — frontend relabels.
                    "name": f.get(name_prop),
                    "province": f.get("ADM1_NAME"),
                    "obs72_mm": f.get("obs72_mm"),
                    "fcst72_mm": f.get("fcst72_mm"),
                },
            )

        fc = stats.map(clean).getInfo()
        # Simplifying a jagged coastline (tidal creeks/mudflat slivers
        # near Karachi, Turbat) can collapse a tiny province/district
        # fragment into a degenerate Point or 2-vertex LineString,
        # which Leaflet renders as a stray pin marker. Drop anything
        # that isn't an area — those fragments carry no rain signal.
        fc["features"] = [
            f for f in fc["features"]
            if f["geometry"] and f["geometry"]["type"] in ("Polygon", "MultiPolygon")
        ]
        fc["properties"] = {
            "basin": basin,
            "level": level,
            "observed_window_end_utc": obs_end.isoformat(timespec="seconds"),
            "observed_latency_hours": latency_h,
        }
        return fc

    def _temperature_now(self, now: dt.datetime):
        """(image, forecast_hour) — GFS 2 m air temperature (°C) valid
        at the current hour, from the latest model run. A model value
        over the AOI, not a single station reading."""
        gfs = ee.ImageCollection(GFS_ASSET).filterDate(
            (now - dt.timedelta(hours=24)).isoformat(), now.isoformat()
        )
        latest_run_ms = gfs.aggregate_max("creation_time").getInfo()
        hours_since_run = max(0, min(120, round(
            (now.timestamp() * 1000 - latest_run_ms) / 3600000)))
        temp = (
            gfs.filter(ee.Filter.eq("creation_time", latest_run_ms))
            .filter(ee.Filter.eq("forecast_hours", hours_since_run))
            .select("temperature_2m_above_ground")
            .first()
        )
        return ee.Image(temp).rename("c"), hours_since_run

    @staticmethod
    def _meteoblue_point(lat: float, lon: float) -> dict:
        """{"point", "conditions", "daily"} at a point from Meteoblue —
        ONE combined `current_basic-1h_basic-day` request.
          point:      station-quality current temperature (isobserveddata)
          conditions: now-hour humidity, wind, feels-like, pressure, UV,
                      rain probability (from the hourly series)
          daily:      7-day daily forecast incl. humidity and wind
        All keys None when no METEOBLUE_API_KEY is configured or the
        request fails — the caller falls back to GFS silently."""
        empty = {"point": None, "conditions": None, "daily": None}
        key = os.environ.get("METEOBLUE_API_KEY")
        if not key:
            return empty
        try:
            r = requests.get(
                "https://my.meteoblue.com/packages/current_basic-1h_basic-day",
                params={"apikey": key, "lat": f"{lat:.4f}",
                        "lon": f"{lon:.4f}", "format": "json"},
                timeout=8)
            if not r.ok:
                return empty
            body = r.json()
        except (requests.RequestException, ValueError):
            return empty

        out = dict(empty)
        cur = body.get("data_current") or {}
        if cur.get("temperature") is not None:
            out["point"] = {
                "value": round(cur["temperature"], 1),
                "observed": bool(cur.get("isobserveddata")),
                "time_local": cur.get("time"),
                "lat": round(lat, 3), "lon": round(lon, 3),
                "source": "meteoblue current (AOI centroid)",
            }

        def col(block, name, i):
            v = (block.get(name) or [])
            v = v[i] if i is not None and i < len(v) else None
            return round(v, 1) if isinstance(v, (int, float)) else v

        # now-hour conditions from the hourly series (last hour <= now)
        hourly = body.get("data_1h") or {}
        times = hourly.get("time") or []
        now_local = cur.get("time") or ""
        idx = None
        for i, t in enumerate(times):
            if t <= now_local:
                idx = i
        if idx is not None:
            out["conditions"] = {
                "time_local": times[idx],
                "feels_like_c": col(hourly, "felttemperature", idx),
                "humidity_pct": col(hourly, "relativehumidity", idx),
                "wind_ms": col(hourly, "windspeed", idx),
                "wind_dir_deg": col(hourly, "winddirection", idx),
                "pressure_hpa": col(hourly, "sealevelpressure", idx),
                "uv_index": col(hourly, "uvindex", idx),
                "precip_probability_pct": col(hourly, "precipitation_probability", idx),
                "pictocode": col(hourly, "pictocode", idx),
                "source": "meteoblue basic-1h (AOI centroid)",
            }

        day = body.get("data_day") or {}
        if day.get("time"):
            out["daily"] = {
                "lat": round(lat, 3), "lon": round(lon, 3),
                "source": "meteoblue basic-day (AOI centroid)",
                "days": [{
                    "date": t,
                    "temp_max_c": col(day, "temperature_max", i),
                    "temp_min_c": col(day, "temperature_min", i),
                    "precip_mm": col(day, "precipitation", i),
                    "precip_probability_pct": col(day, "precipitation_probability", i),
                    "humidity_mean_pct": col(day, "relativehumidity_mean", i),
                    "wind_max_ms": col(day, "windspeed_max", i),
                    "pictocode": col(day, "pictocode", i),
                } for i, t in enumerate(day["time"])],
            }
        return out

    def run(self, basin: str = "chenab",
            geometry: ee.Geometry | None = None) -> dict:
        # `basin` may be a registered key OR an AOI slug when geometry
        # is passed in explicitly (province/district runs).
        aoi = geometry if geometry is not None else basin_geometry(basin)
        now = dt.datetime.now(dt.timezone.utc)

        try:
            obs24, obs72, fcst72, obs_end, latency_h = self._rain_images()
            temp_now, temp_fh = self._temperature_now(now)
        except RuntimeError as e:
            return {"agent": "weather", "status": "error", "error": str(e)}

        # --- One combined server round-trip --------------------------
        reducer = ee.Reducer.mean().combine(ee.Reducer.max(), sharedInputs=True)

        def stats(img: ee.Image, scale: int) -> ee.Dictionary:
            return img.reduceRegion(
                reducer=reducer, geometry=aoi, scale=scale, bestEffort=True
            )

        combined = ee.Dictionary(
            {
                "obs24": stats(obs24, IMERG_SCALE_M),
                "obs72": stats(obs72, IMERG_SCALE_M),
                "fcst72": stats(fcst72, GFS_SCALE_M),
                "temp": stats(temp_now, GFS_SCALE_M),
                # centroid rides along in the same round-trip — used for
                # the Meteoblue station-quality point reading
                "centroid": aoi.centroid(maxError=1000).coordinates(),
            }
        ).getInfo()

        mb = {"point": None, "conditions": None, "daily": None}
        centroid = combined.get("centroid")
        if centroid and len(centroid) == 2:
            mb = self._meteoblue_point(lat=centroid[1], lon=centroid[0])
        temp_point, fcst_daily = mb["point"], mb["daily"]

        def rnd(d: dict, k: str) -> float | None:
            v = d.get(k)
            return round(v, 1) if v is not None else None

        return {
            "agent": "weather",
            "status": "ok",
            "basin": basin,
            "as_of_utc": now.isoformat(timespec="seconds"),
            "observed_window_end_utc": obs_end.isoformat(timespec="seconds"),
            "observed_latency_hours": latency_h,
            "observed_rain_mm": {
                "last_24h": {"basin_mean": rnd(combined["obs24"], "mm_mean"),
                             "basin_max": rnd(combined["obs24"], "mm_max")},
                "last_72h": {"basin_mean": rnd(combined["obs72"], "mm_mean"),
                             "basin_max": rnd(combined["obs72"], "mm_max")},
            },
            "forecast_rain_mm": {
                "next_72h": {"basin_mean": rnd(combined["fcst72"], "mm_mean"),
                             "basin_max": rnd(combined["fcst72"], "mm_max")},
            },
            "temperature_c": {
                # "point" (when present) is the headline reading —
                # station-quality Meteoblue at the AOI centroid. "now"
                # stays as the GFS 2 m AOI area statistic (and the
                # fallback): raw GFS can run several °C hot here.
                "point": temp_point,
                "now": {"aoi_mean": rnd(combined["temp"], "c_mean"),
                        "aoi_max": rnd(combined["temp"], "c_max")},
                "model_hour_offset": temp_fh,
            },
            # Now-hour conditions at the AOI centre (Meteoblue): feels
            # like, humidity, wind, pressure, UV, rain probability.
            "conditions_now": mb["conditions"],
            # 7-day daily outlook (Meteoblue point at the AOI centre) —
            # temp max/min, rain mm + probability, humidity, wind.
            # None when no METEOBLUE_API_KEY; rain AREA statistics above
            # remain the GPM/GFS products used for risk scoring.
            "forecast_daily": fcst_daily,
            "sources": {"observed": IMERG_ASSET, "forecast": GFS_ASSET,
                        "temperature": ("Meteoblue current (point) + "
                                        f"{GFS_ASSET} 2m (area)")
                        if temp_point else f"{GFS_ASSET} 2m temperature"},
        }


if __name__ == "__main__":
    print(json.dumps(WeatherAgent().run(), indent=2))
