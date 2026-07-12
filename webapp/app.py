"""Streamlit webapp — INTERNAL iteration/testing only, not for demos.

Run from the project root (PowerShell):
    streamlit run webapp\\app.py

Prototype features here first, then port working logic into the Flask
API (backend\\api\\routes.py). Both must call the same agents\\ modules —
never reimplement agent logic in this file.
"""

import sys
from pathlib import Path

import streamlit as st

# Make agents\ importable when Streamlit runs this file directly
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agents.basins import BASINS
from agents.coordinator import Coordinator

st.set_page_config(page_title="NDMA Flood Warning — internal", layout="wide")
st.title("NDMA Flood Early Warning — internal testbed")
st.caption("Multi-basin prototype. Internal iteration only.")

LEVEL_COLORS = {"low": "green", "moderate": "orange", "high": "red", "severe": "red"}
AGENT_ICONS = {"coordinator": "🎛️", "terrain": "⛰️", "weather": "🌧️",
               "river": "🌊", "population": "👥", "decision": "⚖️", "report": "📄"}

col_sel, col_btn = st.columns([2, 1])
basin_key = col_sel.selectbox(
    "Area of interest (basin)",
    options=list(BASINS),
    format_func=lambda k: BASINS[k]["name"],
)
run = col_btn.button("Run risk assessment", type="primary")

if run:
    with st.spinner(f"Running agent pipeline for the {BASINS[basin_key]['name']} "
                    "basin — first run on a new basin takes several minutes..."):
        st.session_state["assessment"] = Coordinator().assess(basin_key)

result = st.session_state.get("assessment")
if result:
    level = result["risk_level"]
    score = result["risk_score"]
    color = LEVEL_COLORS.get(level, "gray")
    st.markdown(f"## {BASINS.get(result['basin'], {}).get('name', result['basin'])} "
                f"— Risk: :{color}[{level.upper()}] — {score}/100")
    decision = result.get("decision", {})
    st.markdown(f"**Decision: {decision.get('action', 'n/a').replace('_', ' ')}** — "
                f"{decision.get('description', '')}")
    if result["degraded"]:
        st.warning(f"Degraded assessment — failed agents: {', '.join(result['failed_agents'])}")
    if "warning_text" in result:
        st.info(result["warning_text"])

    c1, c2, c3 = st.columns(3)
    comp = result["components"]
    c1.metric("River component", comp["river"] if comp["river"] is not None else "n/a")
    c2.metric("Forecast rain", comp["rain_forecast"] if comp["rain_forecast"] is not None else "n/a")
    c3.metric("Observed rain", comp["rain_observed"] if comp["rain_observed"] is not None else "n/a")

    tab_chat, tab_agents, tab_report = st.tabs(
        ["Agent conversation", "Agent outputs", "Situation report"])

    with tab_chat:
        for msg in result.get("conversation", []):
            icon = AGENT_ICONS.get(msg["from"], "🤖")
            with st.chat_message(msg["from"], avatar=icon):
                st.markdown(f"**{msg['from']} → {msg['to']}**: {msg['content']}")

    with tab_agents:
        for name, output in result["agents"].items():
            ok = output.get("status") == "ok"
            with st.expander(f"{'✅' if ok else '❌'} {name} agent", expanded=not ok):
                st.json(output)

    with tab_report:
        if "report_markdown" in result:
            st.caption(f"Saved to {result.get('report_path', '')}")
            st.download_button("Download report (.md)", result["report_markdown"],
                               file_name=f"sitrep_{result['basin']}.md")
            st.markdown(result["report_markdown"])
        else:
            st.info("No report generated.")
else:
    st.info("Choose a basin and press the button to run the agent pipeline.")
