"""River agent — GloFAS forecast river discharge for a registered basin.

DATA SOURCE: CEMS GloFAS operational forecast (cems-glofas-forecast),
Copernicus Emergency Management Service / Early Warning Data Store —
the official EU flood-forecasting system (LISFLOOD hydrological model,
0.05 deg grid), pulled with cdsapi + credentials/cdsapi.json.
UPDATE FREQUENCY: one forecast cycle per day (00 UTC), published
mid-morning UTC; this agent requests today's cycle and falls back to
yesterday's if not yet published. One NetCDF per AOI per forecast date
is cached in data/raw/ so repeated runs don't re-queue at Copernicus —
the cache never outlives the forecast date it is keyed by.
FFD flood-category bands (cusecs per station) are transcribed from
Pakistan FFD's published limits — Chenab cross-checked against Sep-2025
FFD reports; other rivers marked VERIFY in agents/basins.py because
ffd.pmd.gov.pk blocks automated fetch (must be checked in a browser).

Discharge is read at each basin's stations (agents/basins.py) and
mapped to that station's FFD flood bands (defined in cusecs, converted
to m3/s). GloFAS is a 0.05-degree model, so the grid cell nearest a
station may miss the channel — we take the max discharge within a small
window around each station to snap to the river.

Accepts a rain_context dict from the weather agent (basin-mean observed
and forecast rain) which is echoed in the output — the coordinator
passes it so downstream consumers see what the river agent knew.

Scope: major-river discharge only. GloFAS does NOT cover flash floods,
coastal flooding, or inundation extent.

KNOWN BIAS (scripts/backtest_discharge.py, 2026-07, Chenab): GloFAS
reanalysis peaks run ~2x LOW vs FFD-reported cusecs (2010 Marala:
GloFAS ~114k vs ~260k reported), so FFD absolute thresholds applied to
GloFAS values will UNDER-warn. Before operational use, either
bias-correct per station or classify against GloFAS's own return-period
climatology instead of absolute cusecs.
"""

import datetime as dt
import json
from pathlib import Path

from agents.basins import bbox, get_basin

PROJECT_ROOT = Path(__file__).resolve().parents[1]
CREDENTIALS_FILE = PROJECT_ROOT / "credentials" / "cdsapi.json"
CACHE_DIR = PROJECT_ROOT / "data" / "raw"

DATASET = "cems-glofas-forecast"
LEADTIME_HOURS = [24, 48, 72, 96, 120]
STATION_WINDOW_DEG = 0.1  # search radius for channel-snapping

CUSEC_TO_M3S = 0.0283168
CATEGORY_NAMES = ["normal", "low", "medium", "high", "very_high", "exceptional"]


def classify(discharge_m3s: float, limits_cusecs: tuple) -> str:
    """FFD category for a discharge given a station's cusec bands."""
    category = CATEGORY_NAMES[0]
    for name, cusecs in zip(CATEGORY_NAMES[1:], limits_cusecs):
        if discharge_m3s >= cusecs * CUSEC_TO_M3S:
            category = name
    return category


class RiverAgent:
    def __init__(self, credentials_file: str | None = None):
        self.credentials_file = Path(credentials_file or CREDENTIALS_FILE)

    def _client(self):
        import cdsapi

        creds = json.loads(self.credentials_file.read_text(encoding="utf-8"))
        return cdsapi.Client(url=creds["url"], key=creds["key"], quiet=True)

    def _fetch(self, basin: str, date: dt.date, area: list) -> Path:
        """Download (or reuse cached) GloFAS control forecast NetCDF."""
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        out = CACHE_DIR / f"glofas_forecast_{basin}_{date:%Y%m%d}.nc"
        if out.exists():
            return out
        self._client().retrieve(
            DATASET,
            {
                "system_version": ["operational"],
                "hydrological_model": ["lisflood"],
                "product_type": ["control_forecast"],
                "variable": ["river_discharge_in_the_last_24_hours"],
                "year": [f"{date:%Y}"],
                "month": [f"{date:%m}"],
                "day": [f"{date:%d}"],
                "leadtime_hour": [str(h) for h in LEADTIME_HOURS],
                "data_format": "netcdf",
                "area": area,
            },
            str(out),
        )
        return out

    def run(self, basin: str = "chenab", rain_context: dict | None = None,
            stations: dict | None = None, area: list | None = None) -> dict:
        """stations/area default to the registered basin's; the
        coordinator passes explicit ones for admin-unit AOIs (`basin`
        is then just the cache slug, e.g. "district_multan")."""
        import xarray as xr

        if stations is None or area is None:
            basin_def = get_basin(basin)
            stations = basin_def["stations"] if stations is None else stations
            area = area if area is not None else bbox(basin)
        if not stations:
            return {
                "agent": "river",
                "status": "error",
                "error": "no FFD stations inside this AOI — river "
                         "component skipped",
            }

        # EWDS publication can lag several days behind (observed 2 days
        # on 12 Jul 2026) — walk back from today until a cycle exists,
        # and report the forecast's age so staleness is never hidden.
        today = dt.datetime.now(dt.timezone.utc).date()
        last_error = None
        for date in (today - dt.timedelta(days=n) for n in range(5)):
            try:
                nc_path = self._fetch(basin, date, area)
                break
            except Exception as e:  # noqa: BLE001 — cdsapi raises plain Exception
                last_error = e
        else:
            return {
                "agent": "river",
                "status": "error",
                "error": str(last_error),
                "hint": (
                    "If this mentions licences, accept the CEMS-FLOODS "
                    "licence once at https://ewds.climate.copernicus.eu "
                    "(open the cems-glofas-forecast dataset > Download > "
                    "accept terms at the bottom)."
                ),
            }

        ds = xr.open_dataset(nc_path)
        # Variable name is dis24; coords are latitude/longitude and a
        # leadtime dimension whose name varies (step / forecast_period).
        dis = ds["dis24"].squeeze()

        station_results = {}
        worst = ("normal", 0.0, None)
        for name, station in stations.items():
            lon, lat = station["lonlat"]
            window = dis.sel(
                latitude=slice(lat + STATION_WINDOW_DEG, lat - STATION_WINDOW_DEG),
                longitude=slice(lon - STATION_WINDOW_DEG, lon + STATION_WINDOW_DEG),
            ).max(dim=("latitude", "longitude"))
            by_lead = {
                f"+{h}h": round(float(v), 1)
                for h, v in zip(LEADTIME_HOURS, window.values.ravel())
            }
            peak = max(by_lead.values())
            category = classify(peak, station["limits_cusecs"])
            station_results[name] = {
                "forecast_discharge_m3s": by_lead,
                "peak_m3s": peak,
                "flood_category": category,
            }
            # Rank by category, then peak discharge as tie-break
            if (CATEGORY_NAMES.index(category), peak) > (
                    CATEGORY_NAMES.index(worst[0]), worst[1]):
                worst = (category, peak, name)
        ds.close()

        return {
            "agent": "river",
            "status": "ok",
            "basin": basin,
            "forecast_date": f"{date:%Y-%m-%d}",
            "forecast_age_days": (today - date).days,
            "leadtime_hours": LEADTIME_HOURS,
            "stations": station_results,
            "worst_station": {
                "name": worst[2],
                "flood_category": worst[0],
                "peak_m3s": worst[1],
            },
            "rain_context": rain_context,
            "source": DATASET,
        }


if __name__ == "__main__":
    print(json.dumps(RiverAgent().run(), indent=2))
