"""Map layer definitions for the WebGIS frontend.

Builds Earth Engine tile-service URLs (getMapId) for each displayable
layer, grouped by the agent that owns the data, plus administrative
boundaries. Pure presentation — no analysis logic here; the layers
visualise exactly the datasets the agents compute from (the rain
rasters are literally the weather agent's own images, so map and
statistics can never disagree).

DATA SOURCES per layer (all official archives mirrored in EE):
  dem/slope   USGS/SRTMGL1_003 (static)
  rivers      WWF/HydroSHEDS/15ACC, flow accumulation > 1000 cells (static)
  rain72      NASA/GPM_L3/IMERG_V07, weather agent's 72 h window (~30 min
              cadence upstream, 1-3 day publish latency)
  rain_fcst72 NOAA/GFS0P25, latest run summed to +72 h (4 runs/day)
  temp_now    NOAA/GFS0P25 2 m temperature, weather agent's own image
              (latest run at the current hour — a model raster; the
              stat card's Meteoblue point reading stays authoritative)
  population  WorldPop/GP/100m/pop 2020 (annual upstream, 2020 in EE)
  urban_cities  the urban-flood agent's own nationwide scan (client-
              side marker layer, lazy: runs the pipeline on enable)
  provinces/  FAO GAUL_SIMPLIFIED_500m 2015 L1/L2 (static admin
  districts   boundaries; GAUL marks disputed Kashmir specially)

EE map IDs expire after ~4 h, so results are cached per AOI with a 2 h
TTL and re-minted on demand — the cache holds tile URLs, never data.
"""

import datetime as dt
import time
from urllib.parse import quote

from agents.ee_common import initialize_ee

import ee

_CACHE: dict[str, tuple[float, list]] = {}
_TTL_SECONDS = 2 * 3600  # EE tile URLs live ~4h; refresh well before


def _tile_url(image: ee.Image, vis: dict) -> str:
    return image.getMapId(vis)["tile_fetcher"].url_format


def _gradient_legend(min_val, max_val, unit, palette) -> dict:
    return {"type": "gradient", "min": min_val, "max": max_val,
            "unit": unit, "palette": palette}


def layer_definitions(basin: str) -> list[dict]:
    """List of layer dicts: id, name, group, url, legend, default_on.
    `basin` is an AOI spec: basin key, province:<Name> or district:<Name>."""
    cached = _CACHE.get(basin)
    if cached and time.time() - cached[0] < _TTL_SECONDS:
        return cached[1]

    from agents.aoi import resolve_aoi

    initialize_ee()
    aoi = resolve_aoi(basin)["geometry"]

    dem = ee.Image("USGS/SRTMGL1_003")
    slope = ee.Terrain.slope(dem)
    flow_acc = ee.Image("WWF/HydroSHEDS/15ACC")
    # Rain rasters come from the weather agent's own image builders, so
    # the map shows EXACTLY the windows its statistics are computed on
    # (obs 72h anchored to the latest IMERG image; latest GFS run).
    from agents.weather_agent import WeatherAgent

    _, rain72, fcst72, _obs_end, _latency = WeatherAgent()._rain_images()
    temp_now, _temp_fh = WeatherAgent()._temperature_now(
        dt.datetime.now(dt.timezone.utc))
    pop = (
        ee.ImageCollection("WorldPop/GP/100m/pop")
        .filter(ee.Filter.eq("year", 2020))
        .mosaic()
    )
    districts = ee.FeatureCollection("FAO/GAUL_SIMPLIFIED_500m/2015/level2")
    provinces = ee.FeatureCollection("FAO/GAUL_SIMPLIFIED_500m/2015/level1")

    dem_palette = ["0b6623", "aadd66", "e8d9a0", "b0764a", "eeeeee", "ffffff"]
    slope_palette = ["f7fcf5", "a1d99b", "fd8d3c", "bd0026"]
    rain_palette = ["ffffff", "a6d8f0", "3690c0", "0570b0", "6a51a3", "d0006f"]
    temp_palette = ["313695", "74add1", "e0f3f8", "fee090", "f46d43", "a50026"]
    pop_palette = ["fff7ec", "fdbb84", "ef6548", "b30000", "600000"]

    layers = [
        {
            "id": "dem",
            "name": "Elevation (SRTM 30 m)",
            "group": "Terrain agent",
            "url": _tile_url(dem.clip(aoi), {"min": 0, "max": 6000, "palette": dem_palette}),
            "legend": _gradient_legend(0, 6000, "m", dem_palette),
            "default_on": False,
        },
        {
            "id": "slope",
            "name": "Slope",
            "group": "Terrain agent",
            "url": _tile_url(slope.clip(aoi), {"min": 0, "max": 45, "palette": slope_palette}),
            "legend": _gradient_legend(0, 45, "°", slope_palette),
            "default_on": False,
        },
        {
            "id": "rivers",
            "name": "River network (HydroSHEDS)",
            "group": "River agent",
            "url": _tile_url(
                flow_acc.gt(1000).selfMask().clip(aoi),
                {"palette": ["1565c0"]},
            ),
            "legend": {"type": "swatch", "color": "#1565c0",
                       "label": "flow accumulation > 1000 cells"},
            "default_on": True,
        },
        {
            "id": "rain72",
            "name": "Observed rain, last 72 h (GPM)",
            "group": "Weather agent",
            "url": _tile_url(
                rain72.updateMask(rain72.gt(1)).clip(aoi),
                {"min": 0, "max": 150, "palette": rain_palette},
            ),
            "legend": _gradient_legend(0, 150, "mm", rain_palette),
            "default_on": True,
        },
        {
            "id": "rain_fcst72",
            "name": "Forecast rain, next 72 h (GFS)",
            "group": "Weather agent",
            "url": _tile_url(
                fcst72.updateMask(fcst72.gt(1)).clip(aoi),
                {"min": 0, "max": 150, "palette": rain_palette},
            ),
            "legend": _gradient_legend(0, 150, "mm", rain_palette),
            "default_on": False,
        },
        {
            "id": "temp_now",
            "name": "Temperature now (GFS 2 m)",
            "group": "Weather agent",
            "url": _tile_url(
                temp_now.clip(aoi),
                {"min": 0, "max": 50, "palette": temp_palette},
            ),
            "legend": _gradient_legend(0, 50, "°C", temp_palette),
            "default_on": False,
        },
        {
            "id": "rain_fcst_province",
            "name": "Forecast rain by province, next 72 h (GFS)",
            "group": "Weather agent",
            "type": "geojson",
            "data_url": f"/api/weather_admin?basin={quote(basin)}&level=province",
            "value_field": "fcst72_mm",
            "legend": _gradient_legend(0, 100, " mm", rain_palette),
            "default_on": False,
        },
        {
            "id": "rain_fcst_district",
            "name": "Forecast rain by district, next 72 h (GFS)",
            "group": "Weather agent",
            "type": "geojson",
            "data_url": f"/api/weather_admin?basin={quote(basin)}&level=district",
            "value_field": "fcst72_mm",
            "legend": _gradient_legend(0, 100, " mm", rain_palette),
            "default_on": False,
        },
        {
            "id": "rain_obs_province",
            "name": "Observed rain by province, last 72 h (GPM)",
            "group": "Weather agent",
            "type": "geojson",
            "data_url": f"/api/weather_admin?basin={quote(basin)}&level=province",
            "value_field": "obs72_mm",
            "legend": _gradient_legend(0, 100, " mm", rain_palette),
            "default_on": False,
        },
        {
            "id": "rain_obs_district",
            "name": "Observed rain by district, last 72 h (GPM)",
            "group": "Weather agent",
            "type": "geojson",
            "data_url": f"/api/weather_admin?basin={quote(basin)}&level=district",
            "value_field": "obs72_mm",
            "legend": _gradient_legend(0, 100, " mm", rain_palette),
            "default_on": False,
        },
        {
            "id": "population",
            "name": "Population (WorldPop 2020)",
            "group": "Population agent",
            "url": _tile_url(
                pop.updateMask(pop.gt(1)).clip(aoi),
                {"min": 0, "max": 300, "palette": pop_palette},
            ),
            "legend": _gradient_legend(0, 300, "ppl/px", pop_palette),
            "default_on": False,
        },
        {
            "id": "urban_cities",
            "name": "Urban flood indicator (17 cities)",
            "group": "Urban flood agent",
            # client-side marker layer; enabling it runs the nationwide
            # urban scan (a few seconds) and colours cities by category
            "type": "urban",
            "data_url": "/api/pipeline/urban?basin=pakistan",
            "legend": {"type": "categories", "items": [
                ["#35c48d", "none"], ["#f0c53f", "watch"],
                ["#ef6c00", "likely"], ["#c62828", "severe"]]},
            "default_on": False,
        },
        {
            "id": "provinces",
            "name": "Provinces (GAUL L1)",
            "group": "Administrative boundaries",
            "url": _tile_url(
                provinces.style(color="ffffff", fillColor="00000000", width=2),
                {},
            ),
            "legend": {"type": "swatch", "color": "#ffffff", "label": "province boundary"},
            "default_on": False,
        },
        {
            "id": "districts",
            "name": "Districts (GAUL L2)",
            "group": "Administrative boundaries",
            "url": _tile_url(
                districts.style(color="cccccc", fillColor="00000000", width=1),
                {},
            ),
            "legend": {"type": "swatch", "color": "#cccccc", "label": "district boundary"},
            "default_on": False,
        },
    ]
    _CACHE[basin] = (time.time(), layers)
    return layers


def basin_outline_geojson(basin: str) -> dict:
    """AOI outline (basin or admin unit) as simplified GeoJSON.

    Simplifying a jagged coastline (tidal creeks/mudflat slivers near
    Karachi, Turbat) can collapse tiny fragments into degenerate Point
    or 2-vertex LineString pieces, which Leaflet renders as stray pin
    markers. Drop anything that isn't a polygon — the AOI is an area,
    those fragments carry no information.
    """
    from agents.aoi import resolve_aoi

    initialize_ee()
    gj = resolve_aoi(basin)["geometry"].simplify(maxError=500).getInfo()
    if gj.get("type") == "GeometryCollection":
        gj["geometries"] = [
            g for g in gj["geometries"]
            if g.get("type") in ("Polygon", "MultiPolygon")
        ]
    return gj
