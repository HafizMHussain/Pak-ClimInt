"""Backtest the rainfall component against the 2010 and 2022 floods.

For each day in an event window, computes the trailing-72h GPM IMERG
rainfall over the Chenab basin (mean + max) and the coordinator's
rain_score for it, so the RAIN_SCORE_STEPS thresholds can be sanity-
checked: peak flood days should score high, quiet days low.

Scope notes:
  - Observed rainfall only. GFS forecasts in Earth Engine start
    2015-07-01, so no forecast backtest is possible for 2010.
  - GloFAS discharge backtesting is a separate job (needs the
    cems-glofas-historical dataset + accepted CEMS licence).

Run from the project root (PowerShell):
    python scripts\\backtest_rain.py

Writes data/processed/backtest_rain_<year>.csv and prints a summary.
One Earth Engine round-trip per event window (batched via toList).
"""

import csv
import datetime as dt
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agents.ee_common import PROJECT_ROOT, basin_geometry, initialize_ee
from agents.coordinator import rain_score

import ee

IMERG_ASSET = "NASA/GPM_L3/IMERG_V07"
IMERG_SCALE_M = 11000
OUT_DIR = PROJECT_ROOT / "data" / "processed"

EVENTS = {
    # Late-July 2010 Indus-system superflood (heaviest rain 27-30 Jul)
    "2010": (dt.date(2010, 7, 15), dt.date(2010, 8, 15)),
    # 2022 monsoon floods (Chenab less central than Indus/Swat, but the
    # basin still saw heavy spells through Aug)
    "2022": (dt.date(2022, 7, 20), dt.date(2022, 9, 5)),
}


def daily_72h_rain(start: dt.date, end: dt.date, basin_key: str = "chenab") -> list[dict]:
    basin = basin_geometry(basin_key)
    imerg = ee.ImageCollection(IMERG_ASSET).select("precipitation")
    reducer = ee.Reducer.mean().combine(ee.Reducer.max(), sharedInputs=True)

    def day_feature(days_offset):
        day_end = ee.Date(start.isoformat()).advance(days_offset, "day")
        total = (
            imerg.filterDate(day_end.advance(-72, "hour"), day_end)
            .sum()
            .multiply(0.5)  # half-hourly mm/hr -> mm
            .rename("mm")
        )
        stats = total.reduceRegion(
            reducer=reducer, geometry=basin, scale=IMERG_SCALE_M, bestEffort=True
        )
        return ee.Feature(None, stats.set("date", day_end.format("YYYY-MM-dd")))

    n_days = (end - start).days + 1
    features = ee.FeatureCollection(
        ee.List.sequence(1, n_days).map(day_feature)
    ).getInfo()

    rows = []
    for f in features["features"]:
        p = f["properties"]
        mm_mean = p.get("mm_mean")
        rows.append(
            {
                "date": p["date"],
                "rain72h_mean_mm": round(mm_mean or 0, 1),
                "rain72h_max_mm": round(p.get("mm_max") or 0, 1),
                "rain_score": rain_score(mm_mean),
            }
        )
    return rows


def main() -> None:
    initialize_ee()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for year, (start, end) in EVENTS.items():
        print(f"\n=== {year} event: {start} to {end} ===")
        rows = daily_72h_rain(start, end)
        out = OUT_DIR / f"backtest_rain_{year}.csv"
        with open(out, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=rows[0].keys())
            writer.writeheader()
            writer.writerows(rows)
        peak = max(rows, key=lambda r: r["rain72h_mean_mm"])
        high_days = sum(1 for r in rows if (r["rain_score"] or 0) >= 60)
        print(f"peak 72h basin-mean: {peak['rain72h_mean_mm']} mm on {peak['date']} "
              f"(score {peak['rain_score']})")
        print(f"days scoring >=60: {high_days} of {len(rows)}")
        print(f"saved {out.name}")


if __name__ == "__main__":
    main()
