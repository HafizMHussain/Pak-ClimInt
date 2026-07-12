# NDMA Flood Early-Warning Portal — production image.
# Serves the Flask app under gunicorn (a real WSGI server), NOT the
# Flask development server. Secrets are never baked into the image:
# credentials/ and .env are provided at runtime (see docker-compose.yml).
FROM python:3.13-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# Dependencies first — cached unless requirements change
COPY requirements-docker.txt .
RUN pip install -r requirements-docker.txt

# Application code only (see .dockerignore: no credentials, .env,
# data caches, docs, notebooks, or the dev-only Streamlit webapp)
COPY agents/ agents/
COPY backend/ backend/
COPY frontend/ frontend/
COPY config/ config/

EXPOSE 5000

# Long --timeout: terrain/population first runs on a new AOI legitimately
# take minutes (Earth Engine downloads). Threads suit the workload —
# handlers are I/O-bound (EE, GloFAS, Meteoblue round-trips).
CMD ["gunicorn", \
     "--bind", "0.0.0.0:5000", \
     "--workers", "2", \
     "--threads", "8", \
     "--timeout", "900", \
     "--graceful-timeout", "60", \
     "--access-logfile", "-", \
     "--error-logfile", "-", \
     "backend.app:app"]
