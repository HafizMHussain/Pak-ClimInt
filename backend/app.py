"""Flask backend — the version to harden for real NDMA use.

Run from the project root (PowerShell):
    python backend\\app.py

Serves the vanilla JS/Leaflet frontend from frontend\\ and exposes the
JSON API defined in backend\\api\\routes.py. All agent logic lives in
agents\\ — this layer only routes and serialises.
"""

import sys
from pathlib import Path

from flask import Flask, render_template

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

# Load .env (KEY=VALUE lines) so ANTHROPIC_API_KEY etc. reach the
# agents without a system-wide environment variable. No dependency —
# plain parse; real env vars always win.
_env = PROJECT_ROOT / ".env"
if _env.exists():
    import os

    for line in _env.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))

from backend.api.routes import api

app = Flask(
    __name__,
    template_folder=str(PROJECT_ROOT / "frontend" / "templates"),
    static_folder=str(PROJECT_ROOT / "frontend" / "static"),
)
app.register_blueprint(api, url_prefix="/api")

# --- Authentication (single-operator session login) -------------------
# Credentials live in .env (PORTAL_EMAIL / PORTAL_PASSWORD); the session
# cookie is signed with FLASK_SECRET_KEY. Every page and API route is
# protected except the login flow, health check, and static assets.
import datetime as _dt
import hmac
import os as _os

from flask import jsonify, redirect, request, session, url_for

app.secret_key = _os.environ.get("FLASK_SECRET_KEY", "insecure-dev-key")
app.permanent_session_lifetime = _dt.timedelta(days=30)  # "Remember me"

_OPEN_PREFIXES = ("/login", "/api/login", "/api/signup", "/api/google",
                  "/api/health", "/static/", "/favicon.ico")


@app.before_request
def _require_login():
    if request.path.startswith(_OPEN_PREFIXES):
        return None
    if session.get("user"):
        return None
    if request.path.startswith("/api/"):
        return jsonify({"error": "authentication required"}), 401
    return redirect(url_for("login_page"))


@app.route("/login")
def login_page():
    if session.get("user"):
        return redirect(url_for("index"))
    return render_template(
        "login.html",
        google_client_id=_os.environ.get("GOOGLE_CLIENT_ID", ""))


# --- user store: data/users.json, PBKDF2-hashed passwords -------------
import hashlib as _hashlib
import json as _json
import re as _re
import secrets as _secrets

_USERS_FILE = PROJECT_ROOT / "data" / "users.json"
_EMAIL_RE = _re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _load_users() -> dict:
    try:
        return _json.loads(_USERS_FILE.read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError):
        return {}


def _hash_pw(password: str, salt: str) -> str:
    return _hashlib.pbkdf2_hmac(
        "sha256", password.encode(), bytes.fromhex(salt), 200_000).hex()


@app.route("/api/login", methods=["POST"])
def api_login():
    body = request.get_json(silent=True) or {}
    email = (body.get("email") or "").strip().lower()
    password = body.get("password") or ""

    # operator account from .env
    want_email = (_os.environ.get("PORTAL_EMAIL") or "").strip().lower()
    want_pw = _os.environ.get("PORTAL_PASSWORD") or ""
    if want_email and want_pw and \
            hmac.compare_digest(email, want_email) & \
            hmac.compare_digest(password, want_pw):
        session["user"] = email
        session.permanent = bool(body.get("remember"))
        return jsonify({"ok": True})

    # self-registered accounts (hashed, data/users.json)
    user = _load_users().get(email)
    if user and hmac.compare_digest(
            _hash_pw(password, user["salt"]), user["hash"]):
        session["user"] = email
        session.permanent = bool(body.get("remember"))
        return jsonify({"ok": True})

    return jsonify({"error": "invalid email or password"}), 401


@app.route("/api/signup", methods=["POST"])
def api_signup():
    body = request.get_json(silent=True) or {}
    name = (body.get("name") or "").strip()
    email = (body.get("email") or "").strip().lower()
    password = body.get("password") or ""
    if not _EMAIL_RE.match(email):
        return jsonify({"error": "enter a valid email address"}), 400
    if len(password) < 8:
        return jsonify({"error": "password must be at least 8 characters"}), 400
    operator = (_os.environ.get("PORTAL_EMAIL") or "").strip().lower()
    users = _load_users()
    if email == operator or email in users:
        return jsonify({"error": "an account with this email already exists"}), 409
    salt = _secrets.token_hex(16)
    users[email] = {
        "name": name,
        "salt": salt,
        "hash": _hash_pw(password, salt),
        "created_utc": _dt.datetime.now(_dt.timezone.utc)
                          .isoformat(timespec="seconds"),
    }
    _USERS_FILE.parent.mkdir(parents=True, exist_ok=True)
    _USERS_FILE.write_text(_json.dumps(users, indent=1), encoding="utf-8")
    session["user"] = email
    session.permanent = True
    return jsonify({"ok": True})


@app.route("/api/google", methods=["POST"])
def api_google():
    """Sign in / up with Google: the browser sends the Google Identity
    Services ID token; we verify it against Google's tokeninfo endpoint
    (no extra dependency) and check it was issued for OUR client id."""
    client_id = _os.environ.get("GOOGLE_CLIENT_ID")
    if not client_id:
        return jsonify({"error": "Google sign-in is not configured "
                                 "(set GOOGLE_CLIENT_ID)"}), 501
    token = (request.get_json(silent=True) or {}).get("credential")
    if not token:
        return jsonify({"error": "missing Google credential"}), 400
    import requests as _requests
    try:
        r = _requests.get("https://oauth2.googleapis.com/tokeninfo",
                          params={"id_token": token}, timeout=8)
        info = r.json()
    except _requests.RequestException:
        return jsonify({"error": "could not verify with Google"}), 502
    if not r.ok or info.get("aud") != client_id \
            or info.get("email_verified") not in ("true", True):
        return jsonify({"error": "Google token rejected"}), 401
    email = info["email"].lower()
    users = _load_users()
    if email not in users:  # first Google sign-in = sign-up
        users[email] = {
            "name": info.get("name", ""),
            "google": True,
            "created_utc": _dt.datetime.now(_dt.timezone.utc)
                              .isoformat(timespec="seconds"),
        }
        _USERS_FILE.parent.mkdir(parents=True, exist_ok=True)
        _USERS_FILE.write_text(_json.dumps(users, indent=1),
                               encoding="utf-8")
    session["user"] = email
    session.permanent = True
    return jsonify({"ok": True})


@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("login_page"))


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/risk")
def risk_dashboard():
    return render_template("risk.html")


@app.route("/agent")
def agent_dashboard():
    return render_template("agent.html")


if __name__ == "__main__":
    # use_reloader=False: the reloader restarts the whole process on any
    # detected file change, which kills in-flight requests — and some
    # of our pipeline runs (terrain/population downloads, GloFAS fetch)
    # take minutes. Debug error pages still work; just no autoreload.
    app.run(debug=True, use_reloader=False, port=5000)
