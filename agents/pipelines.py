"""Single dispatch table for the runnable pipelines.

Used by BOTH the HTTP API (backend/api/routes.py) and the chat
assistant (agents/chatbot.py), so orchestration logic exists exactly
once. Every pipeline accepts any AOI spec (basin key / province:<Name>
/ district:<Name> / bbox:W,S,E,N drawn on the map) — the resolver
hands the agents geometry, cache slug and in-AOI stations.
"""

PIPELINE_NAMES = ("weather", "disaster", "river", "terrain", "population",
                  "urban", "risk")


def run(name: str, spec: str) -> dict:
    """Run one pipeline for an AOI spec and return its JSON-able dict."""
    if name not in PIPELINE_NAMES:
        raise ValueError(f"unknown pipeline {name!r}; use one of {PIPELINE_NAMES}")

    if name == "risk":
        from agents.coordinator import Coordinator

        return Coordinator().assess(spec)

    if name == "urban":
        # nationwide city scan — AOI ignored except province:<Name>
        from agents.urban_agent import UrbanFloodAgent

        return UrbanFloodAgent().run(spec)

    from agents.aoi import resolve_aoi

    info = resolve_aoi(spec)
    if name in ("disaster", "river"):
        from agents.river_agent import RiverAgent

        return RiverAgent().run(basin=info["slug"], stations=info["stations"],
                                area=info["bbox"])
    if name == "weather":
        from agents.weather_agent import WeatherAgent

        return WeatherAgent().run(basin=info["slug"], geometry=info["geometry"])
    if name == "terrain":
        from agents.terrain_agent import TerrainAgent

        return TerrainAgent().run(basin=info["slug"], geometry=info["geometry"])
    from agents.population_agent import PopulationAgent

    return PopulationAgent().run(basin=info["slug"], geometry=info["geometry"])
