"""JSON API routes. Thin wrappers over agents\\ — no agent logic here."""

import re
import time

from flask import Blueprint, jsonify, request

from agents.basins import BASINS
from agents.terrain_agent import TerrainAgent
from agents.coordinator import Coordinator

api = Blueprint("api", __name__)

# Small TTL cache for expensive EE aggregations (per basin+level)
_ADMIN_CACHE: dict[tuple, tuple[float, dict]] = {}
_ADMIN_TTL = 1800  # 30 min — IMERG only updates every few hours anyway


def _basin_arg():
    """AOI spec from ?basin=: a basin key, "province:<Name>",
    "district:<Name>" or "bbox:W,S,E,N" (validated on resolve)."""
    spec = request.args.get("basin", "chenab")
    if spec in BASINS or spec == "pakistan" \
            or spec.partition(":")[0] in ("province", "district", "bbox"):
        return spec  # "pakistan" is valid for the nationwide urban scan
    return None


@api.route("/health")
def health():
    return jsonify({"status": "ok"})


@api.route("/basins")
def basins():
    """Available areas of interest for the frontend dropdown."""
    return jsonify([
        {"key": key, "name": b["name"],
         "stations": [
             {"name": sname, "lon": s["lonlat"][0], "lat": s["lonlat"][1]}
             for sname, s in b["stations"].items()
         ]}
        for key, b in BASINS.items()
    ])


@api.route("/admin_units")
def admin_units():
    """Pakistan provinces + districts (GAUL 2015) for the AOI dropdown."""
    from agents.aoi import list_admin_units

    try:
        return jsonify({
            "provinces": list_admin_units("province"),
            "districts": list_admin_units("district"),
        })
    except Exception as e:  # noqa: BLE001
        return jsonify({"error": str(e)}), 500


@api.route("/layers")
def layers():
    """Earth Engine tile layers for the WebGIS, grouped by agent."""
    basin = _basin_arg()
    if basin is None:
        return jsonify({"error": "unknown basin"}), 400
    from agents.map_layers import layer_definitions

    return jsonify(layer_definitions(basin))


@api.route("/weather_admin")
def weather_admin():
    """Observed + forecast 72h rain per province or district (GeoJSON)."""
    basin = _basin_arg()
    if basin is None:
        return jsonify({"error": "unknown basin"}), 400
    level = request.args.get("level", "district")
    if level not in ("province", "district"):
        return jsonify({"error": "level must be province or district"}), 400

    key = (basin, level)
    cached = _ADMIN_CACHE.get(key)
    if cached and time.time() - cached[0] < _ADMIN_TTL:
        return jsonify(cached[1])

    from agents.aoi import resolve_aoi
    from agents.weather_agent import WeatherAgent

    info = resolve_aoi(basin)
    data = WeatherAgent().admin_breakdown(
        basin=info["slug"], level=level, geometry=info["geometry"])
    _ADMIN_CACHE[key] = (time.time(), data)
    return jsonify(data)


# --- Separately runnable pipelines -----------------------------------
# Dispatch lives once in agents/pipelines.py (shared with the chat
# assistant). "risk" is the full orchestrated assessment.
@api.route("/pipeline/<name>")
def pipeline(name):
    """Run one pipeline on its own: weather | disaster | river |
    terrain | population | risk (full assessment)."""
    from agents.pipelines import PIPELINE_NAMES, run as run_pipeline

    basin = _basin_arg()
    if basin is None:
        return jsonify({"error": "unknown basin"}), 400
    if name not in PIPELINE_NAMES:
        return jsonify({"error": f"unknown pipeline; use one of {sorted(PIPELINE_NAMES)}"}), 404
    try:
        return jsonify(run_pipeline(name, basin))
    except Exception as e:  # noqa: BLE001 — surface agent errors as JSON
        return jsonify({"pipeline": name, "status": "error", "error": str(e)}), 500


@api.route("/chat", methods=["POST"])
def chat_endpoint():
    """Chat assistant: natural-language orchestration of the pipelines.
    Body: {"messages": [{"role": "user"|"assistant", "content": str}]}.
    The assistant can RUN pipelines and READ results — it can never
    write or alter data (see agents/chatbot.py)."""
    from agents.chatbot import chat

    body = request.get_json(silent=True) or {}
    history = body.get("messages")
    if not history:
        return jsonify({"error": "messages[] required"}), 400
    try:
        return jsonify(chat(history))
    except Exception as e:  # noqa: BLE001
        return jsonify({"error": str(e)}), 500


@api.route("/basin_outline")
def basin_outline():
    """Basin AOI polygon as GeoJSON."""
    basin = _basin_arg()
    if basin is None:
        return jsonify({"error": "unknown basin"}), 400
    from agents.map_layers import basin_outline_geojson

    return jsonify(basin_outline_geojson(basin))


@api.route("/terrain")
def terrain():
    """Static terrain layers (cached GeoTIFFs after first run)."""
    basin = _basin_arg()
    if basin is None:
        return jsonify({"error": "unknown basin"}), 400
    from agents.aoi import resolve_aoi

    info = resolve_aoi(basin)
    return jsonify(TerrainAgent().run(basin=info["slug"],
                                      geometry=info["geometry"]))


@api.route("/risk")
def risk():
    """Full multi-agent risk assessment for the selected basin."""
    basin = _basin_arg()
    if basin is None:
        return jsonify({"error": "unknown basin"}), 400
    return jsonify(Coordinator().assess(basin))


@api.route("/report")
def report():
    """Latest saved situation report as Markdown text."""
    from agents.report import REPORTS_DIR

    reports = sorted(REPORTS_DIR.glob("sitrep_*.md"))
    if not reports:
        return jsonify({"error": "No report yet — run /api/risk first."}), 404
    return reports[-1].read_text(encoding="utf-8"), 200, {
        "Content-Type": "text/markdown; charset=utf-8"
    }


# --- Report history + on-demand save ---------------------------------
_REPORT_NAME = re.compile(r"sitrep_[A-Za-z0-9_\-]+\.(md|json)")


@api.route("/reports")
def reports_list():
    """History of saved situation reports (newest first)."""
    from agents.report import list_reports

    return jsonify(list_reports())


@api.route("/reports/<name>")
def report_file(name):
    """One saved report by filename (Markdown or JSON)."""
    from agents.report import REPORTS_DIR

    if not _REPORT_NAME.fullmatch(name):  # no paths, only sitrep files
        return jsonify({"error": "bad report name"}), 400
    path = REPORTS_DIR / name
    if not path.exists():
        return jsonify({"error": "not found"}), 404
    mime = "application/json" if name.endswith(".json") else \
        "text/markdown; charset=utf-8"
    return path.read_text(encoding="utf-8"), 200, {"Content-Type": mime}


@api.route("/save_report", methods=["POST"])
def save_report_endpoint():
    """Save the assessment currently displayed in the frontend WITHOUT
    re-running the coordinator: the browser posts back the assessment
    JSON it already holds, and the same report generator renders and
    persists it (Markdown + JSON)."""
    from agents.report import save_report

    assessment = request.get_json(silent=True)
    if not assessment or "risk_level" not in assessment:
        return jsonify({"error": "body must be an assessment JSON "
                                 "(run a risk assessment first)"}), 400
    md_path = save_report(assessment)
    return jsonify({
        "saved": True,
        "markdown_path": md_path,
        "json_path": md_path[:-3] + ".json",
    })
