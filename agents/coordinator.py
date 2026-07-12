"""Coordinator — orchestrates the agent pipeline for a chosen basin.

Pipeline (agents genuinely pass data to each other):
  1. coordinator resolves the basin AOI once (Earth Engine geometry)
  2. terrain agent prepares static layers for that AOI
  3. weather agent measures observed + forecast rain over the AOI
  4. weather's rain outlook is handed to the river agent as context
  5. river agent classifies GloFAS discharge at the basin's stations
  6. population agent totals exposure inside the AOI
  7. coordinator fuses components -> risk score -> DECISION
  8. report agent renders the full situation report

Every hand-off is logged in `conversation` — rule-generated messages
built from the real numbers, so the inter-agent traffic is auditable.

The risk score and decision are RULE-BASED. An LLM is used ONLY to
draft the human-readable warning text from the already-computed
numbers — it never produces or alters the score or the decision.

Scoring (0-100):
  river   x0.5  worst-station FFD flood category (normal..exceptional)
  fcst    x0.3  GFS 72h forecast rainfall, basin mean (mm)
  obs     x0.2  GPM observed 72h rainfall, basin mean (mm)
If an agent fails, its component is dropped and the remaining weights
are renormalised — a degraded score is better than none, but the
"degraded" flag and failed agents are always reported.
"""

import json

from agents.weather_agent import WeatherAgent
from agents.river_agent import RiverAgent
from agents.terrain_agent import TerrainAgent
from agents.population_agent import PopulationAgent

RIVER_CATEGORY_SCORES = {
    "normal": 0,
    "low": 30,
    "medium": 50,
    "high": 70,
    "very_high": 90,
    "exceptional": 100,
}

# (mm over 72h BASIN-MEAN, score). Calibrated against IMERG backtests
# on the Chenab (scripts/backtest_rain.py): 2010 superflood peaked at
# ~100 mm basin-mean, 2022 floods ~51 mm, a non-flood monsoon (2018)
# ~34 mm. Basin-MAX was rejected as the input — a single foothill pixel
# exceeds 200 mm in any ordinary monsoon. Other basins reuse these
# steps unchanged for now; re-run the backtest per basin to refine.
RAIN_SCORE_STEPS = [(25, 20), (35, 40), (50, 60), (70, 80), (90, 100)]

WEIGHTS = {"river": 0.5, "rain_forecast": 0.3, "rain_observed": 0.2}

RISK_LEVELS = [(20, "low"), (40, "moderate"), (60, "high"), (10**9, "severe")]

# Rule-based decision per risk level — like the score, this is never
# produced by an LLM. Actions mirror the NDMA advisory->emergency ladder.
DECISIONS = {
    "low": {
        "action": "routine_monitoring",
        "description": "No alert. Continue scheduled monitoring runs.",
    },
    "moderate": {
        "action": "advisory",
        "description": "Issue advisory to PDMA/district authorities; "
        "increase monitoring to 6-hourly.",
    },
    "high": {
        "action": "alert",
        "description": "Issue flood alert; pre-position response teams and "
        "warn communities in the floodplain.",
    },
    "severe": {
        "action": "warning",
        "description": "Issue flood warning; activate emergency response "
        "and prepare evacuations in exposed areas.",
    },
    "unknown": {
        "action": "manual_review",
        "description": "No usable agent data — assess manually via FFD/PMD.",
    },
}


def rain_score(mm: float | None) -> float | None:
    if mm is None:
        return None
    score = 0
    for threshold, s in RAIN_SCORE_STEPS:
        if mm >= threshold:
            score = s
    return score


def fuse(outputs: dict) -> dict:
    """Pure fusion step: agent outputs -> risk score + decision. No
    network calls, so the threshold logic is unit-testable."""
    components: dict[str, float | None] = {
        "river": None,
        "rain_forecast": None,
        "rain_observed": None,
    }
    river = outputs.get("river", {})
    if river.get("status") == "ok":
        components["river"] = RIVER_CATEGORY_SCORES[
            river["worst_station"]["flood_category"]
        ]
    weather = outputs.get("weather", {})
    if weather.get("status") == "ok":
        components["rain_forecast"] = rain_score(
            weather["forecast_rain_mm"]["next_72h"]["basin_mean"]
        )
        components["rain_observed"] = rain_score(
            weather["observed_rain_mm"]["last_72h"]["basin_mean"]
        )

    available = {k: v for k, v in components.items() if v is not None}
    if available:
        total_weight = sum(WEIGHTS[k] for k in available)
        risk_score = round(
            sum(WEIGHTS[k] * v for k, v in available.items()) / total_weight
        )
        risk_level = next(lvl for cap, lvl in RISK_LEVELS if risk_score < cap)
    else:
        risk_score, risk_level = None, "unknown"

    basin = next(
        (out.get("basin") for out in outputs.values() if out.get("basin")),
        "unknown",
    )
    return {
        "basin": basin,
        "risk_score": risk_score,
        "risk_level": risk_level,
        "decision": DECISIONS[risk_level],
        "degraded": len(available) < len(components),
        "components": components,
        "weights": WEIGHTS,
        "failed_agents": [
            name for name, out in outputs.items() if out.get("status") != "ok"
        ],
        "agents": outputs,
    }


class Coordinator:
    def __init__(self):
        self.weather = WeatherAgent()
        self.river = RiverAgent()
        self.terrain = TerrainAgent()
        self.population = PopulationAgent()

    def assess(self, basin: str = "chenab", draft_warning: bool = True,
               generate_report: bool = True) -> dict:
        """`basin` accepts an AOI spec: a registered basin key
        ("chenab"), "province:Punjab" or "district:Multan"."""
        from agents.aoi import resolve_aoi

        conversation: list[dict] = []

        def say(sender: str, to: str, content: str) -> None:
            conversation.append({"from": sender, "to": to, "content": content})

        def run_safe(agent, label, **kwargs) -> dict:
            try:
                return agent.run(**kwargs)
            except Exception as e:  # noqa: BLE001 — one failed agent must not kill the assessment
                say(label, "coordinator", f"FAILED: {e}")
                return {"agent": label, "status": "error", "error": str(e)}

        # 1. Resolve the AOI once (basin polygon OR GAUL admin unit);
        #    every EE agent reuses the same geometry.
        say("coordinator", "all agents",
            f"New assessment for AOI '{basin}'. Resolving geometry and "
            "in-AOI FFD stations.")
        try:
            aoi_info = resolve_aoi(basin)
        except Exception as e:  # noqa: BLE001
            say("coordinator", "all agents", f"AOI resolution failed: {e}")
            aoi_info = {"kind": "unknown", "spec": basin, "slug": basin,
                        "name": basin, "geometry": None,
                        "stations": {}, "bbox": None}
        name = aoi_info["name"]
        slug = aoi_info["slug"]
        aoi = aoi_info["geometry"]
        say("coordinator", "all agents",
            f"AOI = {name} ({aoi_info['kind']}); "
            f"{len(aoi_info['stations'])} FFD station(s) inside.")

        # 2. Terrain
        say("coordinator", "terrain", f"Prepare static terrain layers for {name}.")
        terrain_out = run_safe(self.terrain, "terrain", basin=slug, geometry=aoi)
        if terrain_out.get("status") == "ok":
            say("terrain", "coordinator",
                f"Layers ready. AOI area {terrain_out['basin_area_km2']:,} km²; "
                "DEM/slope/flow-accumulation cached.")

        # 3. Weather
        say("coordinator", "weather", f"Measure observed + forecast rain over {name}.")
        weather_out = run_safe(self.weather, "weather", basin=slug, geometry=aoi)
        rain_context = None
        if weather_out.get("status") == "ok":
            obs = weather_out["observed_rain_mm"]["last_72h"]["basin_mean"]
            fcst = weather_out["forecast_rain_mm"]["next_72h"]["basin_mean"]
            rain_context = {
                "observed_72h_basin_mean_mm": obs,
                "forecast_72h_basin_mean_mm": fcst,
            }
            say("weather", "river",
                f"Rain outlook for your discharge context: {obs} mm fell "
                f"(72h basin mean, {weather_out['observed_latency_hours']}h "
                f"latency); {fcst} mm forecast next 72h.")

        # 4. River (receives weather's rain context; stations = the
        #    registered FFD stations inside this AOI)
        say("coordinator", "river",
            f"Classify GloFAS discharge at the {len(aoi_info['stations'])} "
            f"station(s) inside {name}.")
        river_out = run_safe(self.river, "river", basin=slug,
                             rain_context=rain_context,
                             stations=aoi_info["stations"],
                             area=aoi_info["bbox"])
        if river_out.get("status") == "ok":
            worst = river_out["worst_station"]
            say("river", "coordinator",
                f"Worst station {worst['name']}: {worst['flood_category']} "
                f"({worst['peak_m3s']:,.0f} m³/s peak over "
                f"{max(river_out['leadtime_hours'])}h horizon).")

        # 5. Population
        say("coordinator", "population", f"Total exposure inside the {name} AOI.")
        population_out = run_safe(self.population, "population",
                                  basin=slug, geometry=aoi)
        if population_out.get("status") == "ok":
            say("population", "coordinator",
                f"{population_out['total_population']:,} people in AOI; "
                f"{population_out['floodplain_population']:,} on the floodplain proxy.")

        # 6. Fuse -> decision
        outputs = {
            "weather": weather_out,
            "river": river_out,
            "terrain": terrain_out,
            "population": population_out,
        }
        assessment = fuse(outputs)
        assessment["aoi"] = {"kind": aoi_info["kind"],
                             "spec": aoi_info["spec"], "name": name}
        say("coordinator", "decision",
            f"Components {assessment['components']} -> score "
            f"{assessment['risk_score']}/100 ({assessment['risk_level']}).")
        say("decision", "all agents",
            f"Decision: {assessment['decision']['action'].replace('_', ' ')} — "
            f"{assessment['decision']['description']}")

        if draft_warning and assessment["risk_score"] is not None:
            assessment["warning_text"] = self._draft_warning(assessment)

        assessment["conversation"] = conversation
        if generate_report:
            # Full situation report, produced AFTER the decision — pure
            # template over the computed numbers (agents/report.py).
            from agents.report import build_report, save_report

            say("decision", "report", "Generate the situation report.")
            assessment["report_markdown"] = build_report(assessment)
            assessment["report_path"] = save_report(assessment)
            say("report", "coordinator",
                f"Situation report saved: {assessment['report_path']}")
        return assessment

    def _draft_warning(self, assessment: dict) -> str:
        """Human-readable warning. LLM drafts wording only — every number
        it may mention is computed above and passed in as fixed fact."""
        pop = assessment["agents"]["population"]
        exposed = (
            f"{pop['floodplain_population']:,}" if pop.get("status") == "ok" else "unknown"
        )
        aoi_name = assessment.get("aoi", {}).get("name") \
            or assessment["basin"]
        template = (
            f"Flood risk for {aoi_name} is "
            f"{assessment['risk_level'].upper()} "
            f"(score {assessment['risk_score']}/100). "
            f"Recommended action: {assessment['decision']['description']} "
            f"Estimated floodplain population: {exposed}. "
            "This is an automated prototype assessment — verify against "
            "FFD/PMD bulletins before acting."
        )
        try:
            import anthropic

            # Zero-arg client resolves the full credential chain
            # (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or an
            # `ant auth login` profile) — no key check needed here.
            client = anthropic.Anthropic()
            response = client.messages.create(
                model="claude-opus-4-8",
                max_tokens=500,
                system=(
                    "You draft short public flood warnings for NDMA Pakistan. "
                    "Use ONLY the numbers and the recommended action given — "
                    "never invent, change, or recompute any figure or "
                    "escalate/downgrade the action. Plain language, max 120 "
                    "words, include the advisory that this is an automated "
                    "prototype."
                ),
                messages=[{
                    "role": "user",
                    "content": "Draft a warning from these fixed facts:\n"
                    + json.dumps({k: assessment.get(k) for k in
                                  ("aoi", "risk_score", "risk_level",
                                   "decision", "components")})
                    + f"\nFloodplain population: {exposed}",
                }],
            )
            text = next((b.text for b in response.content if b.type == "text"), "")
            return text or template
        except Exception:  # noqa: BLE001 — warning text is optional, never fail the assessment
            return template


if __name__ == "__main__":
    import sys

    basin_key = sys.argv[1] if len(sys.argv) > 1 else "chenab"
    print(json.dumps(Coordinator().assess(basin_key), indent=2))
