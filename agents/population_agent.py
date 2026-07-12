"""Population agent — exposure inside a registered basin.

DATA SOURCE: WorldPop/GP/100m/pop via Google Earth Engine — WorldPop
(University of Southampton) top-down constrained population counts,
100 m grid, year 2020 (most recent year available in EE). Mosaicked
across country tiles since basins span Pakistan and India.
UPDATE FREQUENCY: annual releases upstream, but 2020 is the latest in
EE — so exposure figures are a 2020 baseline, stated as such in the
report. Totals are cached per AOI (data/processed/population_*.json)
because a census raster does not change between runs; delete the cache
file to force a recount.

Two numbers for the coordinator:
  - total_population: everyone in the basin AOI
  - floodplain_population: people on land with slope < 2 degrees — a
    crude riverine-floodplain proxy until Sentinel-1 inundation mapping
    lands. Good enough to scale risk, not for evacuation planning.

Counts are summed at WorldPop's native ~100 m grid (people-per-pixel
rasters must not be resampled before summing) with tileScale=16 so the
basin-wide aggregation stays inside Earth Engine's memory limits.
Results cache per basin in data/processed/population_<basin>.json.
"""

import json

from agents.ee_common import PROJECT_ROOT, basin_geometry, initialize_ee

import ee

WORLDPOP_ASSET = "WorldPop/GP/100m/pop"
WORLDPOP_YEAR = 2020
DEM_ASSET = "USGS/SRTMGL1_003"
FLOODPLAIN_MAX_SLOPE_DEG = 2
CACHE_DIR = PROJECT_ROOT / "data" / "processed"


class PopulationAgent:
    def __init__(self, key_file: str | None = None):
        initialize_ee(key_file)

    def run(self, basin: str = "chenab", geometry: ee.Geometry | None = None,
            force: bool = False) -> dict:
        # `basin` may be a registered key OR an AOI slug when geometry
        # is passed in explicitly (province/district runs).
        cache_file = CACHE_DIR / f"population_{basin}.json"
        # Exposure is static (2020 census rasters) — cache the totals so
        # the coordinator doesn't redo a multi-minute EE sum every run.
        if cache_file.exists() and not force:
            return json.loads(cache_file.read_text(encoding="utf-8"))

        aoi = geometry if geometry is not None else basin_geometry(basin)

        coll = (
            ee.ImageCollection(WORLDPOP_ASSET)
            .filter(ee.Filter.eq("year", WORLDPOP_YEAR))
            .filterBounds(aoi)
        )
        native_proj = coll.first().projection()
        pop = coll.mosaic().setDefaultProjection(native_proj)

        floodplain = ee.Terrain.slope(ee.Image(DEM_ASSET)).lt(
            FLOODPLAIN_MAX_SLOPE_DEG
        )

        native_scale = native_proj.nominalScale()

        def basin_sum(image: ee.Image) -> ee.Number:
            return image.reduceRegion(
                reducer=ee.Reducer.sum(),
                geometry=aoi,
                scale=native_scale,
                maxPixels=1e11,
                tileScale=16,
            ).get("population")

        totals = ee.Dictionary(
            {
                "total": basin_sum(pop),
                "floodplain": basin_sum(pop.updateMask(floodplain)),
            }
        ).getInfo()

        result = {
            "agent": "population",
            "status": "ok",
            "basin": basin,
            "year": WORLDPOP_YEAR,
            "total_population": int(totals["total"]),
            "floodplain_population": int(totals["floodplain"]),
            "floodplain_definition": f"slope < {FLOODPLAIN_MAX_SLOPE_DEG} deg (proxy)",
            "source": WORLDPOP_ASSET,
        }
        cache_file.parent.mkdir(parents=True, exist_ok=True)
        cache_file.write_text(json.dumps(result, indent=2), encoding="utf-8")
        return result


if __name__ == "__main__":
    print(json.dumps(PopulationAgent().run(), indent=2))
