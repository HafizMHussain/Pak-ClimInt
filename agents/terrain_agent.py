"""Terrain agent — static terrain layers for a registered basin.

DATA SOURCES (via Google Earth Engine):
  - USGS/SRTMGL1_003 — NASA/USGS Shuttle Radar Topography Mission DEM,
    30 m, void-filled. UPDATE FREQUENCY: static (Feb 2000 acquisition);
    terrain does not change, so outputs are cached indefinitely.
  - Slope in degrees, derived from the DEM by ee.Terrain.slope.
  - WWF/HydroSHEDS/15ACC — flow accumulation at 15 arc-sec (~460 m),
    derived from SRTM by WWF HydroSHEDS. Static dataset.
clipped to the basin AOI (agents/basins.py registry) and saved as
GeoTIFFs in data/processed/, prefixed with the basin key.

Terrain does not change between pipeline runs, so existing output files
are reused instead of re-downloaded. NOTE: if a download crashes
mid-write, delete the partial .tif before re-running — the cache check
only tests existence, not validity.
"""

import json

from agents.ee_common import PROJECT_ROOT, basin_geometry, initialize_ee

import ee
import geemap

OUTPUT_DIR = PROJECT_ROOT / "data" / "processed"

DEM_ASSET = "USGS/SRTMGL1_003"           # SRTM void-filled, 30 m
FLOW_ACC_ASSET = "WWF/HydroSHEDS/15ACC"  # flow accumulation, 15 arc-sec


class TerrainAgent:
    """Fetches and caches static terrain layers for the coordinator."""

    def __init__(self, key_file: str | None = None):
        initialize_ee(key_file)

    def run(self, basin: str = "chenab", geometry: ee.Geometry | None = None,
            dem_scale: int = 90, force: bool = False) -> dict:
        """Export DEM, slope and flow accumulation as GeoTIFFs.

        geometry: pass the AOI computed upstream (coordinator) to avoid
        recomputing it; falls back to building it from the registry.
        dem_scale: 90 m keeps a basin to a few tens of MB; only drop to
        30 m for small test areas. Flow accumulation exports at its
        ~460 m native resolution.
        """
        # `basin` may be a registered key OR an AOI slug (e.g.
        # "district_multan") when the geometry is passed in explicitly.
        OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        aoi = geometry if geometry is not None else basin_geometry(basin)

        dem = ee.Image(DEM_ASSET)
        # Slope is computed before clipping so pixels at the basin edge
        # still have neighbours; the clip happens at download time.
        slope = ee.Terrain.slope(dem)
        flow_acc = ee.Image(FLOW_ACC_ASSET)

        layers = {
            f"{basin}_dem": (dem, dem_scale, "int16"),
            f"{basin}_slope": (slope, dem_scale, "float32"),
            f"{basin}_flow_acc": (flow_acc, 463, "uint32"),
        }

        paths = {}
        for name, (image, scale, dtype) in layers.items():
            out_path = OUTPUT_DIR / f"{name}.tif"
            paths[name] = str(out_path)
            if out_path.exists() and not force:
                print(f"[terrain] {out_path.name} already exists, skipping")
                continue
            print(f"[terrain] downloading {out_path.name} at {scale} m ...")
            geemap.download_ee_image(
                image.clip(aoi),
                filename=str(out_path),
                region=aoi,
                scale=scale,
                crs="EPSG:4326",
                dtype=dtype,
            )

        basin_area_km2 = aoi.area(maxError=1000).divide(1e6).getInfo()
        return {
            "agent": "terrain",
            "status": "ok",
            "basin": basin,
            "basin_area_km2": round(basin_area_km2),
            "layers": paths,
        }


if __name__ == "__main__":
    print(json.dumps(TerrainAgent().run(), indent=2))
