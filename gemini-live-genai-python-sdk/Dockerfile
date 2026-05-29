# Combined image: Gemini Live FastAPI app (Python 3.11) + claude-mem worker (Bun).
# Base is Node 22 on Debian bookworm, whose apt `python3` is 3.11 — required
# because twilio_handler.py imports `audioop`, removed from CPython 3.13+.
FROM node:22-bookworm-slim

# System deps: Python 3.11 + venv/pip, build tools (native wheels), curl/unzip
# (Bun installer), tini (PID 1 init that reaps the backgrounded worker).
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-venv python3-pip build-essential curl unzip ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

# Bun — the claude-mem worker runs under Bun (uses bun:sqlite, no native build).
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

# claude-mem (pinned). Installs the CLI + bundled worker plugin globally.
RUN npm install -g claude-mem@13.3.0

WORKDIR /app

# Python deps in an isolated venv (bookworm pip is externally-managed / PEP 668).
COPY requirements.txt .
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir -r requirements.txt
ENV PATH="/opt/venv/bin:${PATH}"

# App source.
COPY . .

# Build the Next.js frontend into a static export (web/out). The base image is
# Node 22, so the toolchain is already here — no extra stage needed. main.py
# serves web/out as the whole site; web/node_modules and web/out are
# .dockerignore'd so this build is always fresh from source.
RUN cd web && npm ci && npm run build

# Register the custom "gemini-live" observer mode with claude-mem.
RUN cp claude-mem-docker/gemini-live.json \
    "$(npm root -g)/claude-mem/plugin/modes/gemini-live.json"

# Overwrite the published worker with our BYO-key patched build (vendored from a
# clean claude-mem v13.3.0 checkout + the per-session geminiApiKey override).
# A plain COPY can't expand $(npm root -g), so mirror the cp pattern above.
RUN cp claude-mem-docker/worker-service.cjs \
    "$(npm root -g)/claude-mem/plugin/scripts/worker-service.cjs"

ENV PORT=8080
EXPOSE 8080

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bash", "/app/docker-entrypoint.sh"]
