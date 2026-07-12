"""Backtest GloFAS discharge against the 2010 and 2022 flood seasons.

Downloads GloFAS v4 historical (reanalysis) discharge for Jul-Sep of
2010, 2022 and a 2018 control, extracts the Chenab stations with the
same channel-snapping used by the live river agent, and reports each
station's peak discharge, its date, and the FFD flood category — so
the per-station STATION_FLOOD_LIMITS_CUSECS bands can be checked
against what actually happened.

Uses the same EWDS credentials/licence as the river agent (dataset:
cems-glofas-historical). NetCDFs cache in data/raw/.

Run from the project root (PowerShell):
    python scripts\\backtest_discharge.py
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agents.basins import bbox, get_basin
from agents.river_agent import (
    CACHE_DIR,
    CUSEC_TO_M3S,
    STATION_WINDOW_DEG,
    RiverAgent,
    classify,
)

DATASET = "cems-glofas-historical"
BASIN = "chenab"
YEARS = ["2010", "2018", "2022"]  # 2018 = non-flood control
MONTHS = ["07", "08", "09"]


def fetch_year(agent: RiverAgent, year: str) -> Path:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    out = CACHE_DIR / f"glofas_hist_{year}_jul_sep.nc"
    if out.exists():
        return out
    print(f"[backtest] requesting GloFAS historical {year} Jul-Sep (may queue)...")
    agent._client().retrieve(
        DATASET,
        {
            "system_version": ["version_4_0"],
            "hydrological_model": ["lisflood"],
            "product_type": ["consolidated"],
            "variable": ["river_discharge_in_the_last_24_hours"],
            "hyear": [year],
            "hmonth": MONTHS,
            "hday": [f"{d:02d}" for d in range(1, 32)],
            "data_format": "netcdf",
            "area": bbox(BASIN),
        },
        str(out),
    )
    return out


def analyse(nc_path: Path) -> dict:
    import xarray as xr

    ds = xr.open_dataset(nc_path)
    dis = ds["dis24"].squeeze()
    time_dim = next(d for d in dis.dims if d not in ("latitude", "longitude"))

    stations = {}
    for name, station in get_basin(BASIN)["stations"].items():
        lon, lat = station["lonlat"]
        series = dis.sel(
            latitude=slice(lat + STATION_WINDOW_DEG, lat - STATION_WINDOW_DEG),
            longitude=slice(lon - STATION_WINDOW_DEG, lon + STATION_WINDOW_DEG),
        ).max(dim=("latitude", "longitude"))
        peak_idx = int(series.argmax())
        peak = float(series[peak_idx])
        peak_date = str(series[time_dim].values[peak_idx])[:10]
        stations[name] = {
            "peak_m3s": round(peak, 1),
            "peak_cusecs": round(peak / CUSEC_TO_M3S),
            "peak_date": peak_date,
            "flood_category": classify(peak, station["limits_cusecs"]),
        }
    ds.close()
    return stations


def main() -> None:
    agent = RiverAgent()
    for year in YEARS:
        try:
            nc_path = fetch_year(agent, year)
        except Exception as e:  # noqa: BLE001
            print(f"[backtest] {year} failed: {e}")
            continue
        print(f"\n=== {year} Jul-Sep ===")
        print(json.dumps(analyse(nc_path), indent=2))


if __name__ == "__main__":
    main()
