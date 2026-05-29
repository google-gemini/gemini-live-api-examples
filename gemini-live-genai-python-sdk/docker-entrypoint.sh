#!/usr/bin/env bash
# Boot both services in one container:
#   1. the claude-mem worker (localhost:37777) — the memory pipeline
#   2. the FastAPI / Gemini Live app (0.0.0.0:$PORT) — what the phone connects to
#
# BYO key: the public web demo runs entirely on each VISITOR's own Gemini key
# (sent as the first WebSocket frame) — for both the live session and the memory
# observations. No server key is used, so our quota can never be spent.
set -euo pipefail

# GEMINI_API_KEY is OPTIONAL now. It is only consumed by the Twilio phone path
# (out of scope for the web demo); the web demo never uses it. Default it empty
# so `set -u` doesn't trip when the Fly secret is unset.
export GEMINI_API_KEY="${GEMINI_API_KEY:-}"

# --- claude-mem worker configuration -----------------------------------------
export CLAUDE_MEM_DATA_DIR="${CLAUDE_MEM_DATA_DIR:-/data/claude-mem}"
export CLAUDE_MEM_PROVIDER="${CLAUDE_MEM_PROVIDER:-gemini}"
# BYO key: boot the worker with a clearly-fake PLACEHOLDER (not a real key) —
# NOT empty. The worker's provider selector gates on isGeminiAvailable(), which
# only checks this boot key (it doesn't see the per-session key). An EMPTY boot
# key makes isGeminiAvailable() false, so the worker silently falls back to the
# Claude SDK — which has no credentials in this image and would generate nothing.
# A non-empty placeholder keeps the Gemini provider selected; the patched worker
# then overrides it with each session's own key at generation time
# (getGeminiConfig(session.geminiApiKey)). A session that arrives without a key
# falls back to this placeholder, which Gemini rejects (400) — so it fails safe
# and our real quota is never spent (verified locally 2026-05-28).
export CLAUDE_MEM_GEMINI_API_KEY="byo-no-server-key-placeholder"
export CLAUDE_MEM_GEMINI_MODEL="${CLAUDE_MEM_GEMINI_MODEL:-gemini-2.5-flash}"
export CLAUDE_MEM_MODE="${CLAUDE_MEM_MODE:-gemini-live}"
# Chroma (semantic search) is intentionally off: the live sink only reads back
# chronological context (recent + batch-by-id), which is SQLite-backed. This
# keeps the image lean and the worker boot deterministic. Flip to enable later.
export CLAUDE_MEM_CHROMA_ENABLED="${CLAUDE_MEM_CHROMA_ENABLED:-false}"
export CLAUDE_MEM_WORKER_HOST="${CLAUDE_MEM_WORKER_HOST:-127.0.0.1}"
export CLAUDE_MEM_WORKER_PORT="${CLAUDE_MEM_WORKER_PORT:-37777}"
export CLAUDE_MEM_LOG_LEVEL="${CLAUDE_MEM_LOG_LEVEL:-INFO}"

mkdir -p "$CLAUDE_MEM_DATA_DIR"
# A persisted volume keeps a stale worker.pid (recorded pid=1, always "alive" in
# a fresh container) which would make the worker's duplicate-guard refuse to
# boot. start_worker() below clears it before every (re)spawn.

WORKER="$(npm root -g)/claude-mem/plugin/scripts/worker-service.cjs"
WORKER_HEALTH="http://127.0.0.1:${CLAUDE_MEM_WORKER_PORT}/api/health"

# `bun worker start` spawns a detached daemon and returns immediately; it is
# idempotent (it skips the spawn when a live worker pid is already present), so
# it is safe to call both at boot and on every failed health probe. Clear the
# stale pid first so a dead worker is always respawned.
start_worker() {
  rm -f "$CLAUDE_MEM_DATA_DIR/worker.pid"
  bun "$WORKER" start || true
}

echo "[entrypoint] starting claude-mem worker (provider=$CLAUDE_MEM_PROVIDER, mode=$CLAUDE_MEM_MODE)"
start_worker

echo "[entrypoint] waiting for claude-mem worker health on :${CLAUDE_MEM_WORKER_PORT} ..."
worker_ok=0
for _ in $(seq 1 60); do
  if curl -sf -m 2 "$WORKER_HEALTH" >/dev/null 2>&1; then
    worker_ok=1
    echo "[entrypoint] claude-mem worker healthy"
    break
  fi
  sleep 1
done
if [[ "$worker_ok" -ne 1 ]]; then
  # Fail-soft: the app must still serve even if memory never came up.
  echo "[entrypoint] WARNING: claude-mem worker not healthy after 60s; app will run without memory" >&2
fi

# Supervisor: the worker daemon never restarts itself, so a crash would silently
# kill memory for the whole machine while the app keeps serving. Poll health and
# respawn on failure so the worker self-heals. Runs for the life of the container
# (reparented to tini once the app exec's below). The Python sink notices the new
# worker pid and re-attaches each live session's key, so in-flight sessions
# recover within a few seconds of a respawn.
supervise_worker() {
  while true; do
    sleep 5
    if ! curl -sf -m 2 "$WORKER_HEALTH" >/dev/null 2>&1; then
      echo "[entrypoint] claude-mem worker unhealthy; respawning" >&2
      start_worker
    fi
  done
}
supervise_worker &

# --- app -> worker wiring -----------------------------------------------------
# (No enable switch: claude-mem is always on. The app's sink is fail-soft if the
# worker above never came up — it never needs to be told to turn memory off.)
export CLAUDE_MEM_WORKER_URL="http://127.0.0.1:${CLAUDE_MEM_WORKER_PORT}"
export CLAUDE_MEM_PROJECT="${CLAUDE_MEM_PROJECT:-gemini-live-mem}"

echo "[entrypoint] starting Gemini Live app on :${PORT:-8080}"
exec python3 main.py
