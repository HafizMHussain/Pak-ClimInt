"""Basin (AOI) registry — every agent is parameterised by a basin key.

Each basin defines:
  - river_points: (lon, lat) along the main stem. The AOI is the union
    of HydroBASINS level-6 polygons touching these points (a corridor
    of sub-basins along the river, not the full hydrological catchment
    for the very large rivers like the Indus).
  - stations: gauge/barrage sites with (lon, lat) and FFD flood limits
    in cusecs — thresholds where (low, medium, high, very_high,
    exceptional) begin.

THRESHOLD STATUS: Chenab bands are cross-checked against 2025 FFD
classification reports; other rivers use widely cited approximations.
VERIFY all bands against the official FFD table
(https://ffd.pmd.gov.pk/ffd_limits/floodlimits.htm — open in a
browser; it blocks automated fetch) before operational use.

Rain-score thresholds in the coordinator were calibrated on the Chenab
(2010/2022/2018 IMERG backtests) and are applied to other basins
unchanged — re-run scripts/backtest_rain.py per basin to refine.
"""

# Generic FFD-style bands (thousand cusecs -> cusecs)
_K = 1000
CHENAB_BANDS = (100 * _K, 150 * _K, 250 * _K, 400 * _K, 600 * _K)
JHELUM_BANDS = (75 * _K, 110 * _K, 150 * _K, 225 * _K, 300 * _K)
RAVI_BANDS = (40 * _K, 60 * _K, 90 * _K, 150 * _K, 250 * _K)
SUTLEJ_BANDS = (50 * _K, 75 * _K, 100 * _K, 150 * _K, 225 * _K)
INDUS_BANDS = (250 * _K, 350 * _K, 500 * _K, 650 * _K, 800 * _K)

BASINS = {
    "chenab": {
        "name": "Chenab",
        "river_points": [
            (76.9, 33.0),   # upper Chenab, Himachal Pradesh
            (75.2, 32.9),   # near Akhnoor, Jammu
            (74.1, 32.3),   # near Marala headworks
            (72.9, 31.7),   # near Chiniot
            (72.1, 31.0),   # near Trimmu barrage
        ],
        "stations": {
            "Marala": {"lonlat": (74.46, 32.67), "limits_cusecs": CHENAB_BANDS},
            "Khanki": {"lonlat": (73.97, 32.40), "limits_cusecs": CHENAB_BANDS},
            # High band 200k: FFD classified 217k cusecs as HIGH (Sep 2025)
            "Qadirabad": {"lonlat": (73.73, 32.32),
                          "limits_cusecs": (100 * _K, 150 * _K, 200 * _K, 400 * _K, 600 * _K)},
            "Trimmu": {"lonlat": (72.15, 31.14), "limits_cusecs": CHENAB_BANDS},
        },
    },
    "jhelum": {
        "name": "Jhelum",
        "river_points": [
            (74.8, 34.0),   # Kashmir valley
            (73.9, 33.7),   # near Muzaffarabad
            (73.64, 33.13), # Mangla
            (73.52, 32.68), # Rasul
        ],
        "stations": {
            "Mangla": {"lonlat": (73.64, 33.13), "limits_cusecs": JHELUM_BANDS},
            "Rasul": {"lonlat": (73.52, 32.68), "limits_cusecs": JHELUM_BANDS},
        },
    },
    "ravi": {
        "name": "Ravi",
        "river_points": [
            (75.9, 32.35),  # upstream, Himachal
            (75.05, 32.17), # Jassar
            (74.28, 31.62), # Shahdara (Lahore)
            (73.86, 31.22), # Balloki
            (72.42, 30.57), # Sidhnai
        ],
        "stations": {
            "Jassar": {"lonlat": (75.05, 32.17), "limits_cusecs": RAVI_BANDS},
            "Shahdara": {"lonlat": (74.28, 31.62), "limits_cusecs": RAVI_BANDS},
            "Balloki": {"lonlat": (73.86, 31.22), "limits_cusecs": RAVI_BANDS},
            "Sidhnai": {"lonlat": (72.42, 30.57), "limits_cusecs": RAVI_BANDS},
        },
    },
    "sutlej": {
        "name": "Sutlej",
        "river_points": [
            (76.4, 31.4),   # upstream of Bhakra
            (74.57, 31.05), # Ganda Singh Wala
            (73.87, 30.38), # Sulemanki
            (72.55, 29.83), # Islam headworks
        ],
        "stations": {
            "Ganda Singh Wala": {"lonlat": (74.57, 31.05), "limits_cusecs": SUTLEJ_BANDS},
            "Sulemanki": {"lonlat": (73.87, 30.38), "limits_cusecs": SUTLEJ_BANDS},
            "Islam": {"lonlat": (72.55, 29.83), "limits_cusecs": SUTLEJ_BANDS},
        },
    },
    "indus": {
        "name": "Indus (main stem)",
        "river_points": [
            (72.88, 34.92), # Besham
            (72.70, 34.09), # Tarbela
            (71.55, 32.96), # Kalabagh
            (70.85, 30.51), # Taunsa
            (69.72, 28.42), # Guddu
            (68.85, 27.72), # Sukkur
            (68.31, 25.44), # Kotri
        ],
        "stations": {
            "Tarbela": {"lonlat": (72.70, 34.09), "limits_cusecs": INDUS_BANDS},
            "Kalabagh": {"lonlat": (71.55, 32.96), "limits_cusecs": INDUS_BANDS},
            "Taunsa": {"lonlat": (70.85, 30.51), "limits_cusecs": INDUS_BANDS},
            "Guddu": {"lonlat": (69.72, 28.42), "limits_cusecs": INDUS_BANDS},
            "Sukkur": {"lonlat": (68.85, 27.72), "limits_cusecs": INDUS_BANDS},
            "Kotri": {"lonlat": (68.31, 25.44), "limits_cusecs": INDUS_BANDS},
        },
    },
}


def get_basin(key: str) -> dict:
    if key not in BASINS:
        raise KeyError(f"Unknown basin '{key}'. Available: {', '.join(BASINS)}")
    return BASINS[key]


def bbox(key: str, margin_deg: float = 1.0) -> list[float]:
    """[N, W, S, E] bounding box around river points (for GloFAS area)."""
    pts = BASINS[key]["river_points"]
    lons = [p[0] for p in pts]
    lats = [p[1] for p in pts]
    return [
        max(lats) + margin_deg,
        min(lons) - margin_deg,
        min(lats) - margin_deg,
        max(lons) + margin_deg,
    ]
