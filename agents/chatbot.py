"""Chat assistant — the natural-language front door to the platform.

An LLM with TOOL USE: the model can list AOIs, run any of the five
pipelines, and read saved reports. That is the entire integration
surface — the tools only ORCHESTRATE the existing deterministic agents
and READ their outputs. The model cannot write, edit or delete any
dataset, and the system prompt forbids it from inventing or altering
numbers: every figure in a reply is quoted from a tool result produced
by the rule-based agents. (Same platform rule as everywhere else: the
LLM speaks, the rules decide.)

PROVIDERS (first available wins) — open-source models preferred:
  1. Any OpenAI-compatible endpoint:  CHATBOT_BASE_URL + CHATBOT_API_KEY
     (+ optional CHATBOT_MODEL) in .env
  2. Groq free tier (hosted open-weights Llama 3.3 70B, tool-capable):
     GROQ_API_KEY in .env — free key from console.groq.com, no card
  3. Ollama running locally (fully offline):  http://localhost:11434
     — e.g. `ollama pull llama3.1` (default model llama3.1)
  4. Anthropic (ANTHROPIC_API_KEY) — used only if none of the above
"""

import json
import os

MAX_TOOL_TURNS = 8
MAX_TOKENS = 1200
GROQ_URL = "https://api.groq.com/openai/v1"
GROQ_MODEL = "llama-3.3-70b-versatile"
# Groq rate limits are PER MODEL — when the 70B daily quota is hit,
# retry on the 8B model (separate, much larger free quota).
GROQ_FALLBACK_MODELS = ["llama-3.1-8b-instant"]
# Overridable for Docker: the container reaches the host's Ollama via
# http://host.docker.internal:11434/v1 (set in docker-compose.yml).
OLLAMA_URL = os.environ.get("CHATBOT_OLLAMA_URL", "http://localhost:11434/v1")
OLLAMA_MODEL = "llama3.1"
ANTHROPIC_MODEL = "claude-opus-4-8"

SYSTEM = """You are Alpha, the operations assistant inside Pak-ClimInt \
(Multi Agentic Climate Intelligence) — NDMA Pakistan's multi-agent \
flood early-warning WebGIS. If asked your name, say Alpha; if asked \
what platform this is, say Pak-ClimInt. You orchestrate the platform's \
deterministic analysis pipelines via tools and explain their results.

Hard rules:
- Every number you state MUST come verbatim from a tool result (exact \
values + units). NEVER invent, estimate, recompute, round differently, \
or extrapolate any figure.
- The risk score and decision come from the rule-based coordinator — \
repeat them exactly; never second-guess, escalate or downgrade them.
- If a pipeline returns status "error" or the assessment is degraded, \
say plainly that the DATA IS UNAVAILABLE and name the failed \
component. NEVER phrase a failure as a hazard (do not say a river \
"has discharge issues" when the truth is the discharge data could not \
be fetched) — a data gap is not a flood signal. If the river result \
has forecast_age_days > 0, mention the forecast is that many days old \
(Copernicus publication lag).
- When discussing observed rain, mention the data latency (hours) that \
the weather agent reports.
- Keep replies short and operational (bullets over prose). You are \
talking to a duty forecaster, not writing a report.
- You cannot modify any data or setting; if asked to, explain that the \
platform is read-only through chat by design.
- Data boundaries: rainfall AREA statistics (used for risk scoring) \
cover last 24 h / last 72 h observed (GPM) and next 72 h forecast \
(GFS). The weather pipeline ALSO returns forecast_daily — a 7-DAY \
daily outlook at the AOI centre point (Meteoblue): per day temp \
max/min, rain mm + probability, mean humidity, max wind. Use it for \
any multi-day / weekly / "next N days" weather question and present \
it day by day. conditions_now gives the CURRENT hour at the AOI \
centre: feels-like °C, humidity %, wind m/s + direction, pressure, UV \
index, rain probability — use it for humidity/wind/feels-like \
questions. Current air temperature: quote temperature_c.point.value \
as THE current temperature when present (station-quality Meteoblue \
reading at the AOI centre — matches weather apps); temperature_c.now \
(GFS 2 m model AOI mean/max) is area context and the fallback — if \
only that is available, say it is a model area value that can run a \
few degrees hot. Nothing beyond 7 days. If asked for something \
outside these, say so in one sentence and offer the closest available \
product instead of running an unrelated tool.

AOI specs for tools: river basins by key (chenab, jhelum, ravi, \
sutlej, indus); provinces as "province:<Name>" (e.g. province:Punjab, \
province:Khyber Pakhtunkhwa, province:Gilgit-Baltistan, province:Azad \
Kashmir); districts as "district:<GAUL name>" — GAUL district names \
usually end with " District" (e.g. "district:Multan District"); a \
rectangle as "bbox:W,S,E,N" in degrees (e.g. bbox:67.0,24.5,68.5,25.8) \
when the user gives coordinates or refers to the box they drew on the \
map. Use list_aois when unsure of a name. For CITY questions use the \
SMALLEST matching AOI, never a whole other province: Islamabad is \
"province:Islamabad" (the capital territory); for other cities search \
list_aois for their district (e.g. Lahore -> district:Lahore District, \
Karachi -> a Karachi district). Point values (temperature, 7-day \
outlook) are taken at the AOI centre, so a too-big AOI gives the wrong \
city's weather.

Pipelines: weather (GPM observed + GFS forecast rain), disaster \
(GloFAS river discharge classified into FFD flood categories), terrain \
(DEM/slope/flow accumulation), population (exposure), urban \
(URBAN-FLOOD indicator: 24 h observed + forecast rain over Pakistan's \
17 major cities, classified none/watch/likely/severe — use it whenever \
the user asks about urban/city/street flooding; aoi is ignored except \
"province:<Name>" which filters cities, so pass aoi="pakistan" for a \
national scan), risk (full multi-agent assessment -> score, decision, \
report). "Run everything" means the risk pipeline — it runs all agents \
in one orchestrated pass. Warn that first runs on a brand-new AOI can \
take minutes (terrain download).

You can also drive the live map with control_map (zoom, show/hide \
layers, switch basemap, fly to an AOI). When the user asks to SEE \
something (e.g. "show me the rain over Punjab"), combine tools: \
zoom_to_aoi + show_layer for the relevant layer, and run the matching \
pipeline if they also want numbers. Pipeline results you run are \
automatically displayed on the user's map panel as well (with a \
button to the full dashboard page).

More map/portal commands via control_map:
- globe_view / flat_view — switch the main map between the 3D globe \
and the flat 2D map. Use globe_view when the user says globe/3D/earth, \
flat_view for flat/2D (drawing and measuring only work on the flat map).
- open_dashboard with dashboard = one of risk, weather, disaster, \
terrain, population, urban — opens that full-page dashboard in the \
user's browser (pass aoi too when the user named an area). Use it when \
the user asks to open/see a dashboard, full report, charts page, or \
the visual page of an agent. Each dashboard page also has a "Summary" \
button that explains its results in plain language — you may mention \
it. Prefer running the pipeline first so the dashboard opens with \
fresh data."""

TOOLS = [
    {
        "name": "list_aois",
        "description": "Find selectable AOIs. Give `search` (part of a "
        "district/province name, e.g. 'tharparkar') to get exact GAUL "
        "spec names; without it you get basins + provinces only.",
        "input_schema": {
            "type": "object",
            "properties": {
                "search": {"type": "string",
                           "description": "Substring to match district/"
                           "province names (case-insensitive)."},
            },
        },
    },
    {
        "name": "run_pipeline",
        "description": "Run one analysis pipeline for an AOI and return "
        "its JSON result — the same result the dashboard buttons produce. "
        "Use pipeline='risk' for the full multi-agent assessment "
        "(score + decision + auto-saved report).",
        "input_schema": {
            "type": "object",
            "properties": {
                "pipeline": {"type": "string",
                             "enum": ["weather", "disaster", "terrain",
                                      "population", "urban", "risk"]},
                "aoi": {"type": "string",
                        "description": "AOI spec: 'chenab', "
                        "'province:Sindh', 'district:Multan District', …"},
            },
            "required": ["pipeline", "aoi"],
        },
    },
    {
        "name": "control_map",
        "description": "Control the live GIS map / portal in the user's "
        "browser. Commands: zoom_in, zoom_out, set_zoom (give zoom 3-14), "
        "zoom_to_aoi (give aoi spec), show_layer / hide_layer (give "
        "layer_id), toggle_basemap (dark <-> satellite), globe_view / "
        "flat_view (3D globe <-> flat 2D map), open_dashboard (give "
        "dashboard = risk|weather|disaster|terrain|population|urban, "
        "plus aoi when known — opens that full-page dashboard). "
        "layer_id must be one of: dem, slope, "
        "rivers, rain72 (observed rain raster), rain_fcst72 (forecast "
        "rain raster), temp_now (GFS 2 m temperature raster), "
        "rain_fcst_province, rain_fcst_district, rain_obs_province, "
        "rain_obs_district, population, urban_cities (urban flood "
        "indicator city markers — enabling it runs the nationwide "
        "scan), provinces, districts.",
        "input_schema": {
            "type": "object",
            "properties": {
                "command": {"type": "string",
                            "enum": ["zoom_in", "zoom_out", "set_zoom",
                                     "zoom_to_aoi", "show_layer",
                                     "hide_layer", "toggle_basemap",
                                     "globe_view", "flat_view",
                                     "open_dashboard"]},
                "layer_id": {"type": "string"},
                "zoom": {"type": "number"},
                "aoi": {"type": "string"},
                "dashboard": {"type": "string",
                              "enum": ["risk", "weather", "disaster",
                                       "terrain", "population", "urban"]},
            },
            "required": ["command"],
        },
    },
    {
        "name": "get_reports",
        "description": "List saved situation reports (newest first), or "
        "fetch one report's Markdown by filename.",
        "input_schema": {
            "type": "object",
            "properties": {
                "name": {"type": "string",
                         "description": "Optional filename (from the "
                         "list) to fetch its content."},
            },
        },
    },
]


def _slim(pipeline: str, result: dict) -> dict:
    """Trim bulky fields before handing a result to the model — the
    numbers stay intact; only redundant bulk (full report markdown,
    per-message conversation) is dropped. The FULL result is still
    returned to the frontend in `actions`."""
    if pipeline != "risk":
        return result
    slim = {k: v for k, v in result.items()
            if k not in ("report_markdown", "conversation", "agents")}
    agents = result.get("agents", {})
    slim["agents_summary"] = {
        name: (out if out.get("status") != "ok" else {
            k: v for k, v in out.items()
            if k not in ("layers", "stations")  # keep the headline numbers
        })
        for name, out in agents.items()
    }
    river = agents.get("river", {})
    if river.get("status") == "ok":
        slim["stations"] = {
            n: {"peak_m3s": s["peak_m3s"], "flood_category": s["flood_category"]}
            for n, s in river.get("stations", {}).items()
        }
    return slim


def _execute(name: str, args: dict, actions: list) -> dict:
    if name == "list_aois":
        from agents.aoi import list_admin_units
        from agents.basins import BASINS

        out = {
            "basins": {k: {"name": b["name"],
                           "stations": list(b["stations"])}
                       for k, b in BASINS.items()},
            "provinces": [u["name"] for u in list_admin_units("province")],
        }
        q = (args.get("search") or "").strip().lower()
        if q:  # only ship matching district names — 119 of them is a token hog
            out["matching_districts"] = [
                f"district:{u['name']}"
                for u in list_admin_units("district")
                if q in u["name"].lower() or q in u["province"].lower()
            ][:25]
        else:
            out["districts_note"] = ("119 districts available — call again "
                                     "with `search` to find exact names.")
        return out

    if name == "run_pipeline":
        from agents.pipelines import run

        pipeline, aoi = args.get("pipeline"), args.get("aoi")
        if not pipeline or not aoi:
            return {"error": "run_pipeline needs both 'pipeline' and 'aoi'"}
        try:
            result = run(pipeline, aoi)
        except Exception as e:  # noqa: BLE001 — feed the failure back to the model
            result = {"status": "error", "error": str(e)}
        actions.append({"tool": "run_pipeline", "pipeline": pipeline,
                        "aoi": aoi,
                        "status": result.get("status",
                                             "ok" if "risk_level" in result else "error"),
                        "result": result})
        return _slim(pipeline, result)

    if name == "control_map":
        # No server-side effect — the command is queued in `actions` and
        # the frontend executes it on the live Leaflet map.
        actions.append({"tool": "control_map", "status": "sent", **args})
        return {"ok": True, "note": "command sent to the user's map"}

    if name == "get_reports":
        from agents.report import REPORTS_DIR, list_reports

        fname = args.get("name")
        if fname:
            path = REPORTS_DIR / fname
            if not path.exists() or "/" in fname or "\\" in fname:
                return {"error": "report not found"}
            return {"name": fname, "markdown": path.read_text(encoding="utf-8")}
        return {"reports": list_reports()[:15]}

    return {"error": f"unknown tool {name}"}


def _provider_chain() -> list[tuple[str, str, str]]:
    """Ordered (base_url, api_key, model) candidates. The chat tries
    them in turn — so a Groq rate limit automatically fails over to
    local Ollama instead of erroring out. Explicit CHATBOT_* config
    always goes first; Anthropic is the last resort."""
    chain: list[tuple[str, str, str]] = []
    if os.getenv("CHATBOT_BASE_URL") and os.getenv("CHATBOT_API_KEY"):
        chain.append((os.environ["CHATBOT_BASE_URL"].rstrip("/"),
                      os.environ["CHATBOT_API_KEY"],
                      os.getenv("CHATBOT_MODEL", GROQ_MODEL)))
    if os.getenv("GROQ_API_KEY"):
        chain.append((GROQ_URL, os.environ["GROQ_API_KEY"], GROQ_MODEL))
    try:  # local Ollama — unlimited/offline, but slow on CPU
        import requests

        if requests.get(OLLAMA_URL.replace("/v1", "/api/tags"), timeout=1).ok:
            chain.append((OLLAMA_URL, "ollama", OLLAMA_MODEL))
    except Exception:  # noqa: BLE001 — not running
        pass
    if os.getenv("ANTHROPIC_API_KEY") or os.getenv("ANTHROPIC_AUTH_TOKEN"):
        chain.append(("anthropic", "", ANTHROPIC_MODEL))
    return chain


def _openai_tools() -> list[dict]:
    """Convert the tool schemas to OpenAI function-calling format."""
    return [{"type": "function",
             "function": {"name": t["name"], "description": t["description"],
                          "parameters": t["input_schema"]}}
            for t in TOOLS]


def _parse_text_tool_calls(content: str) -> list[tuple[str, dict]]:
    """Llama models sometimes emit tool calls as TEXT instead of the
    structured tool_calls array, e.g.
        <function/run_pipeline>{"aoi": "chenab", ...}</function>
        <function=run_pipeline>{"aoi": ...}</function>
    Parse those so the call still executes."""
    import re

    calls = []
    for m in re.finditer(r"<function[=/]([\w-]+)>\s*(\{.*?\})\s*</function>",
                         content or "", re.DOTALL):
        try:
            calls.append((m.group(1), json.loads(m.group(2))))
        except json.JSONDecodeError:
            continue
    if not calls:  # variant without a closing tag (Groq failed_generation)
        m = re.search(r"<function[=/]([\w-]+)>?\s*(\{[^<]*\})",
                      content or "", re.DOTALL)
        if m:
            try:
                calls.append((m.group(1), json.loads(m.group(2))))
            except json.JSONDecodeError:
                pass
    if not calls:  # bare {"name": ..., "parameters"/"arguments": ...}
        try:
            obj = json.loads((content or "").strip())
            if isinstance(obj, dict) and obj.get("name"):
                calls.append((obj["name"],
                              obj.get("parameters") or obj.get("arguments") or {}))
        except json.JSONDecodeError:
            pass
    if not calls:  # same JSON shape embedded inside prose text
        m = re.search(r"\{\s*\"name\"\s*:\s*\"([\w-]+)\"\s*,\s*"
                      r"\"(?:parameters|arguments)\"\s*:\s*(\{.*?\})\s*\}",
                      content or "", re.DOTALL)
        if m:
            try:
                calls.append((m.group(1), json.loads(m.group(2))))
            except json.JSONDecodeError:
                pass
    return calls


def _chat_openai_compat(base_url, api_key, model, history, actions) -> dict:
    """Tool loop against any OpenAI-compatible endpoint (Groq, Ollama,
    vLLM, …) — all serve open-weights models like Llama 3.3."""
    import requests

    messages = ([{"role": "system", "content": SYSTEM}] +
                [{"role": m["role"], "content": m["content"]}
                 for m in history if m.get("content")])
    tools = _openai_tools()
    # per-model rate limits: fall through the list on 429
    models = [model] + (GROQ_FALLBACK_MODELS if "groq" in base_url else [])
    model_i = 0

    for _ in range(MAX_TOOL_TURNS):
        r = requests.post(
            f"{base_url}/chat/completions",
            headers={"Authorization": f"Bearer {api_key}",
                     "Content-Type": "application/json"},
            json={"model": models[model_i], "messages": messages,
                  "tools": tools, "tool_choice": "auto",
                  "max_tokens": MAX_TOKENS, "temperature": 0.2},
            timeout=600,
        )
        if r.status_code == 429:
            import re as _re
            import time as _time

            wait = _re.search(r"try again in ([\d.]+)s?[\"',}]", r.text)
            secs = float(wait.group(1)) if wait else None
            if secs is not None and secs <= 20:
                _time.sleep(secs + 0.5)  # burst limit — just wait it out
                continue
            if model_i + 1 < len(models):
                model_i += 1  # daily quota hit — retry on the next model
                continue
            wait_h = _re.search(r"try again in ([\dhms.]+)", r.text)
            raise RuntimeError(
                "Free-tier daily limit reached on all Groq models"
                + (f" — resets in {wait_h.group(1)}" if wait_h else "")
                + ". Try later, or add another provider in .env "
                  "(CHATBOT_BASE_URL/CHATBOT_API_KEY, or install Ollama "
                  "for unlimited local chat).")
        if r.status_code == 400 and "tool_use_failed" in r.text:
            # Groq rejected the model's own malformed tool call — the
            # attempted call text is in failed_generation; recover it.
            try:
                failed = r.json()["error"].get("failed_generation", "")
            except Exception:  # noqa: BLE001
                failed = ""
            recovered = _parse_text_tool_calls(failed)
            if recovered:
                tool_calls = [
                    {"id": f"call_r{i}", "type": "function",
                     "function": {"name": n, "arguments": json.dumps(a)}}
                    for i, (n, a) in enumerate(recovered)
                ]
                messages.append({"role": "assistant", "content": None,
                                 "tool_calls": tool_calls})
                for tc in tool_calls:
                    args = json.loads(tc["function"]["arguments"])
                    out = _execute(tc["function"]["name"], args, actions)
                    messages.append({"role": "tool",
                                     "tool_call_id": tc["id"],
                                     "content": json.dumps(out, default=str)[:50000]})
                continue
            messages.append({"role": "user", "content":
                             "(system: your tool call was malformed — call "
                             "the tool again with valid JSON arguments)"})
            continue
        if not r.ok:
            raise RuntimeError(f"{base_url} -> {r.status_code}: {r.text[:300]}")
        msg = (r.json().get("choices") or [{}])[0].get("message") or {}

        tool_calls = msg.get("tool_calls")
        if not tool_calls:
            # Llama sometimes writes the call as text — recover it
            text_calls = _parse_text_tool_calls(msg.get("content"))
            if text_calls:
                tool_calls = [
                    {"id": f"call_{i}", "type": "function",
                     "function": {"name": name,
                                  "arguments": json.dumps(args)}}
                    for i, (name, args) in enumerate(text_calls)
                ]
                msg = {"role": "assistant", "content": None,
                       "tool_calls": tool_calls}

        if tool_calls:
            messages.append(msg)
            for tc in tool_calls:
                fn = tc.get("function") or {}
                raw_args = fn.get("arguments") or "{}"
                try:
                    args = raw_args if isinstance(raw_args, dict) \
                        else json.loads(raw_args)
                except json.JSONDecodeError:
                    args = {}
                out = (_execute(fn["name"], args or {}, actions)
                       if fn.get("name") else {"error": "malformed tool call"})
                messages.append({"role": "tool",
                                 "tool_call_id": tc.get("id") or "call_0",
                                 "content": json.dumps(out, default=str)[:50000]})
            continue
        return {"reply": msg.get("content") or "(no reply)", "actions": actions}

    return {"reply": "Stopped after too many tool steps — try a narrower "
                     "request.", "actions": actions}


def _chat_anthropic(model, history, actions) -> dict:
    import anthropic

    client = anthropic.Anthropic()
    messages = [{"role": m["role"], "content": m["content"]}
                for m in history if m.get("content")]
    for _ in range(MAX_TOOL_TURNS):
        response = client.messages.create(
            model=model, max_tokens=MAX_TOKENS,
            system=SYSTEM, tools=TOOLS, messages=messages,
        )
        if response.stop_reason == "tool_use":
            messages.append({"role": "assistant", "content": response.content})
            results = []
            for block in response.content:
                if block.type == "tool_use":
                    out = _execute(block.name, dict(block.input), actions)
                    results.append({
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": json.dumps(out, default=str)[:50000],
                    })
            messages.append({"role": "user", "content": results})
            continue
        text = "".join(b.text for b in response.content if b.type == "text")
        return {"reply": text or "(no reply)", "actions": actions}
    return {"reply": "Stopped after too many tool steps — try a narrower "
                     "request.", "actions": actions}


def chat(history: list[dict]) -> dict:
    """history: [{"role": "user"|"assistant", "content": str}, ...]
    Returns {"reply": str, "actions": [...]} — actions carry the FULL
    pipeline results so the frontend can update the map/panels with
    exactly what the agents produced."""
    chain = _provider_chain()
    if not chain:
        raise RuntimeError(
            "No chat model configured. Easiest (free, no card): get a key "
            "at console.groq.com and add GROQ_API_KEY=gsk_... to the "
            "project's .env, then restart the server. Fully offline "
            "alternative: install Ollama (ollama.com) and run "
            "`ollama pull llama3.1`."
        )
    last_error: Exception | None = None
    for base_url, api_key, model in chain:
        actions: list = []
        try:
            if base_url == "anthropic":
                return _chat_anthropic(model, history, actions)
            return _chat_openai_compat(base_url, api_key, model,
                                       history, actions)
        except Exception as e:  # noqa: BLE001 — fail over to the next provider
            last_error = e
    raise RuntimeError(f"All chat providers failed. Last error: {last_error}")
