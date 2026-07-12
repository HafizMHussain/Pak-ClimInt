"""Shared Earth Engine plumbing: auth + basin geometry from the registry.

Used by terrain, weather and population agents — keep all EE session
setup here so credentials logic never gets duplicated. Basin AOIs are
defined in agents/basins.py; geometry = union of HydroBASINS level-6
polygons touching the basin's river points.
"""

import json
import os
from pathlib import Path

# PostgreSQL/PostGIS sets a system-wide PROJ_LIB pointing at its own,
# older proj.db, which crashes rasterio (CRSError: EPSG code is unknown).
# Clear it for this process only — before geemap/rasterio import — so
# rasterio falls back to its bundled PROJ database. PostGIS unaffected.
os.environ.pop("PROJ_LIB", None)
os.environ.pop("PROJ_DATA", None)

import ee

PROJECT_ROOT = Path(__file__).resolve().parents[1]
CREDENTIALS_DIR = PROJECT_ROOT / "credentials"

# Level 6 chosen after comparing 5/6/7: level 5 gave 161,748 km2 (~2.4x
# the real ~68,000 km2 catchment), level 7 fragments into disjoint
# polygons between the river points. Level 6 yields 88,788 km2.
BASINS_ASSET = "WWF/HydroSHEDS/v1/Basins/hybas_6"

_initialized = False


def initialize_ee(key_file: str | None = None) -> None:
    """Authenticate with a service-account key (idempotent).

    Resolution order: explicit argument, EE_SERVICE_ACCOUNT_JSON env
    var, first ee-*.json in credentials\\. The service-account email
    and Cloud project id are read from the key file itself.
    """
    global _initialized
    if _initialized:
        return
    if key_file is None:
        key_file = os.getenv("EE_SERVICE_ACCOUNT_JSON")
    if key_file is None:
        matches = sorted(CREDENTIALS_DIR.glob("ee-*.json"))
        if not matches:
            raise FileNotFoundError(
                "No Earth Engine service-account key found. Put the "
                "JSON key in credentials\\ or set EE_SERVICE_ACCOUNT_JSON."
            )
        key_file = str(matches[0])

    with open(key_file, encoding="utf-8") as f:
        key = json.load(f)

    credentials = ee.ServiceAccountCredentials(key["client_email"], key_file)
    ee.Initialize(credentials, project=key["project_id"])
    _initialized = True


def basin_geometry(basin_key: str) -> ee.Geometry:
    """AOI for a registered basin: union of HydroBASINS level-6
    polygons touching its river points (see agents/basins.py)."""
    from agents.basins import get_basin

    points = ee.FeatureCollection(
        [ee.Feature(ee.Geometry.Point(lon, lat))
         for lon, lat in get_basin(basin_key)["river_points"]]
    )
    basins = ee.FeatureCollection(BASINS_ASSET).filterBounds(points)
    return basins.geometry()
