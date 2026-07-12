"""Offline unit tests — threshold and fusion logic only, no network.

Run from the project root (PowerShell):
    python -m pytest tests -q
"""

from agents.basins import BASINS, bbox, get_basin
from agents.coordinator import fuse, rain_score
from agents.river_agent import classify

CHENAB = get_basin("chenab")["stations"]


def test_rain_score_thresholds():
    assert rain_score(None) is None
    assert rain_score(0) == 0
    assert rain_score(24.9) == 0    # 2018 non-flood control median ~18 mm
    assert rain_score(25) == 20
    assert rain_score(50) == 60     # ~2022 flood peak basin-mean
    assert rain_score(100) == 100   # ~2010 superflood peak basin-mean


def test_river_classify_ffd_bands():
    marala = CHENAB["Marala"]["limits_cusecs"]
    qadirabad = CHENAB["Qadirabad"]["limits_cusecs"]
    assert classify(0, marala) == "normal"
    assert classify(2831, marala) == "normal"   # just under 100k cusecs
    assert classify(2832, marala) == "low"
    assert classify(7080, marala) == "high"     # 250k cusecs = 7079.2 m3/s
    assert classify(20000, marala) == "exceptional"
    # Qadirabad's high band starts at 200k cusecs (FFD, Sep 2025 floods)
    assert classify(6145, qadirabad) == "high"  # 217k cusecs
    assert classify(6145, marala) == "medium"


def test_basin_registry_consistency():
    for key, basin in BASINS.items():
        assert basin["river_points"], key
        assert basin["stations"], key
        for station in basin["stations"].values():
            assert len(station["limits_cusecs"]) == 5, key
            assert list(station["limits_cusecs"]) == sorted(station["limits_cusecs"]), key
        n, w, s, e = bbox(key)
        assert n > s and e > w, key


WEATHER_OK = {
    "status": "ok",
    "forecast_rain_mm": {"next_72h": {"basin_mean": 72.0}},   # -> score 80
    "observed_rain_mm": {"last_72h": {"basin_mean": 27.0}},   # -> score 20
}
RIVER_OK = {"status": "ok", "worst_station": {"flood_category": "high"}}
FAILED = {"status": "error", "error": "boom"}


def test_fuse_all_components():
    result = fuse({"weather": WEATHER_OK, "river": RIVER_OK,
                   "terrain": {"status": "ok"}, "population": {"status": "ok"}})
    # river 70*0.5 + fcst 80*0.3 + obs 20*0.2 = 63
    assert result["risk_score"] == 63
    assert result["risk_level"] == "severe"
    assert result["decision"]["action"] == "warning"
    assert result["degraded"] is False


def test_fuse_degraded_renormalises():
    result = fuse({"weather": WEATHER_OK, "river": FAILED,
                   "terrain": {"status": "ok"}, "population": {"status": "ok"}})
    # (80*0.3 + 20*0.2) / 0.5 = 56
    assert result["risk_score"] == 56
    assert result["degraded"] is True
    assert result["failed_agents"] == ["river"]


def test_report_builds_from_assessment():
    from agents.report import build_report

    assessment = fuse({"weather": FAILED, "river": RIVER_OK,
                       "terrain": FAILED, "population": FAILED})
    md = build_report(assessment)
    assert "# NDMA Flood Early Warning — Situation Report" in md
    assert "DEGRADED ASSESSMENT" in md
    assert "Recommended action:" in md
    assert "Caveats" in md


def test_fuse_nothing_available():
    result = fuse({"weather": FAILED, "river": FAILED,
                   "terrain": FAILED, "population": FAILED})
    assert result["risk_score"] is None
    assert result["risk_level"] == "unknown"
    assert result["decision"]["action"] == "manual_review"
