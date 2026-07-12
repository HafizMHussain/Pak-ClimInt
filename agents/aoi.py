"""AOI resolver — one place that turns an AOI spec into geometry,
stations and metadata, so every pipeline runs on a river basin OR an
administrative unit (province/district).

Spec formats (the string the frontend sends as ?basin=):
  "chenab"                    -> registered basin (agents/basins.py)
  "province:Punjab"           -> GAUL level-1 unit inside Pakistan
  "district:Multan"           -> GAUL level-2 unit inside Pakistan
  "bbox:W,S,E,N"              -> user-drawn box (degrees, lon/lat)

GAUL 2015 predates Pakistan's current administrative map: it still says
"North-West Frontier" (now Khyber Pakhtunkhwa) and blanks out
Gilgit-Baltistan / Azad Kashmir as disputed. We display modern names
(PROVINCE_RENAME) and source GB + AJK geometry from geoBoundaries CGAZ,
which carries Pakistan's de-facto units.

For admin units the FFD stations are whichever registered stations
(across ALL basins) fall inside the unit's polygon — a unit with no
station simply runs without the river component (degraded fusion).
Resolving an admin AOI costs one getInfo (bounds + station membership,
batched); basins resolve without any server round-trip.
"""

import re

import ee

from agents.basins import BASINS, bbox, get_basin
from agents.ee_common import basin_geometry, initialize_ee

GAUL_LEVELS = {
    "province": ("FAO/GAUL_SIMPLIFIED_500m/2015/level1", "ADM1_NAME"),
    "district": ("FAO/GAUL_SIMPLIFIED_500m/2015/level2", "ADM2_NAME"),
}
COUNTRY = "Pakistan"  # GAUL keeps disputed Kashmir under a separate ADM0
ADMIN_BBOX_MARGIN_DEG = 0.3  # margin for the GloFAS download window

# GAUL 2015 name -> current official name (and back, for the EE filter)
PROVINCE_RENAME = {"North-West Frontier": "Khyber Pakhtunkhwa"}
_MODERN_TO_GAUL = {v: k for k, v in PROVINCE_RENAME.items()}

# Territories missing from GAUL's Pakistan ADM0 — geometry from
# geoBoundaries CGAZ (shapeGroup PAK carries the de-facto admin map).
GEOBOUNDARIES_ADM1 = "projects/sat-io/open-datasets/geoboundaries/CGAZ_ADM1"
EXTRA_PROVINCES = ("Gilgit-Baltistan", "Azad Kashmir")

_UNITS_CACHE: dict[str, list] = {}  # static 2015 data — cache per process


def parse_spec(spec: str) -> tuple[str, str]:
    """"chenab" -> ("basin", "chenab"); "province:Punjab" -> (...)."""
    if ":" in spec:
        kind, _, name = spec.partition(":")
        kind = kind.strip().lower()
        if kind not in (*GAUL_LEVELS, "bbox") or not name.strip():
            raise ValueError(f"bad AOI spec {spec!r}; use basin key, "
                             "province:<Name>, district:<Name> or "
                             "bbox:W,S,E,N")
        return kind, name.strip()
    return "basin", spec


def _parse_bbox(name: str) -> tuple[float, float, float, float]:
    """"66.5,24.1,68.0,25.9" -> (w, s, e, n), validated."""
    try:
        w, s, e, n = (float(x) for x in name.split(","))
    except ValueError:
        raise ValueError(f"bad bbox {name!r}; use bbox:W,S,E,N in degrees")
    if not (w < e and s < n and -180 <= w and e <= 180
            and -90 <= s and n <= 90):
        raise ValueError(f"bad bbox {name!r}: need W<E, S<N, valid degrees")
    if (e - w) * (n - s) > 64:  # ~ whole-Pakistan sized cap
        raise ValueError("drawn box too large — keep it under ~8°x8°")
    return w, s, e, n


def slugify(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")


def list_admin_units(level: str) -> list[dict]:
    """All Pakistan units at a level: [{"name", "province"}], sorted.
    One getInfo per level per process (results are static)."""
    if level in _UNITS_CACHE:
        return _UNITS_CACHE[level]
    if level not in GAUL_LEVELS:
        raise ValueError(f"level must be one of {list(GAUL_LEVELS)}")
    initialize_ee()
    asset, name_prop = GAUL_LEVELS[level]
    fc = ee.FeatureCollection(asset).filter(
        ee.Filter.eq("ADM0_NAME", COUNTRY))
    raw = ee.Dictionary({
        "names": fc.aggregate_array(name_prop),
        "provinces": fc.aggregate_array("ADM1_NAME"),
    }).getInfo()
    rename = PROVINCE_RENAME.get  # show current names, not GAUL 2015's
    units = sorted(
        {(rename(n, n) if level == "province" else n, rename(p, p))
         for n, p in zip(raw["names"], raw["provinces"])
         if n and n != "Administrative unit not available"}
    )
    if level == "province":
        units = sorted(units + [(n, n) for n in EXTRA_PROVINCES])
    _UNITS_CACHE[level] = [{"name": n, "province": p} for n, p in units]
    return _UNITS_CACHE[level]


def _admin_unit_name(level: str, name: str) -> str:
    """Exact GAUL spelling for a (case-insensitively given) unit name."""
    for unit in list_admin_units(level):
        if unit["name"].lower() == name.lower():
            return unit["name"]
    raise ValueError(f"unknown {level} {name!r} — see /api/admin_units")


def resolve_aoi(spec: str) -> dict:
    """Spec -> dict(kind, spec, slug, name, geometry, stations, bbox).

    stations: {station_name: station_def} usable by the river agent.
    bbox: [N, W, S, E] for the GloFAS download window.
    """
    initialize_ee()
    kind, name = parse_spec(spec)

    if kind == "bbox":
        w, s, e, n = _parse_bbox(name)
        m = ADMIN_BBOX_MARGIN_DEG
        coord = lambda v: f"{v:.3f}".replace(".", "p").replace("-", "m")  # noqa: E731
        stations = {  # registered stations inside the box — no getInfo
            sname: st
            for b in BASINS.values() for sname, st in b["stations"].items()
            if w <= st["lonlat"][0] <= e and s <= st["lonlat"][1] <= n
        }
        return {
            "kind": "bbox",
            "spec": f"bbox:{name}",
            "slug": f"bbox_{coord(w)}_{coord(s)}_{coord(e)}_{coord(n)}",
            "name": f"drawn area ({w:.2f}–{e:.2f}°E, {s:.2f}–{n:.2f}°N)",
            "geometry": ee.Geometry.Rectangle([w, s, e, n]),
            "stations": stations,
            "bbox": [n + m, w - m, s - m, e + m],
        }

    if kind == "basin":
        basin_def = get_basin(name)
        return {
            "kind": "basin",
            "spec": name,
            "slug": name,
            "name": f"{basin_def['name']} basin",
            "geometry": basin_geometry(name),
            "stations": basin_def["stations"],
            "bbox": bbox(name),
        }

    unit_name = _admin_unit_name(kind, name)  # modern display spelling
    if kind == "province" and unit_name in EXTRA_PROVINCES:
        # not in GAUL's Pakistan ADM0 — geometry from geoBoundaries
        unit = (ee.FeatureCollection(GEOBOUNDARIES_ADM1)
                .filter(ee.Filter.eq("shapeGroup", "PAK"))
                .filter(ee.Filter.eq("shapeName", unit_name)))
    else:
        asset, name_prop = GAUL_LEVELS[kind]
        gaul_name = _MODERN_TO_GAUL.get(unit_name, unit_name)
        unit = (
            ee.FeatureCollection(asset)
            .filter(ee.Filter.eq("ADM0_NAME", COUNTRY))
            .filter(ee.Filter.eq(name_prop, gaul_name))
        )
    geometry = unit.geometry()

    # One batched round-trip: unit bounds + which registered stations
    # (from any basin) fall inside the polygon.
    station_points = ee.FeatureCollection([
        ee.Feature(ee.Geometry.Point(s["lonlat"]), {"sname": sname})
        for b in BASINS.values() for sname, s in b["stations"].items()
    ])
    info = ee.Dictionary({
        "bounds": geometry.bounds(maxError=1000).coordinates(),
        "inside": station_points.filterBounds(geometry)
                                .aggregate_array("sname"),
    }).getInfo()
    if not info["bounds"]:
        raise ValueError(f"no geometry found for {kind} {unit_name!r}")

    ring = info["bounds"][0]
    lons = [pt[0] for pt in ring]
    lats = [pt[1] for pt in ring]
    m = ADMIN_BBOX_MARGIN_DEG
    aoi_bbox = [max(lats) + m, min(lons) - m, min(lats) - m, max(lons) + m]

    inside = set(info["inside"])
    stations = {
        sname: s
        for b in BASINS.values() for sname, s in b["stations"].items()
        if sname in inside
    }
    return {
        "kind": kind,
        "spec": f"{kind}:{unit_name}",
        "slug": f"{kind}_{slugify(unit_name)}",
        "name": f"{unit_name} {kind}",
        "geometry": geometry,
        "stations": stations,
        "bbox": aoi_bbox,
    }
