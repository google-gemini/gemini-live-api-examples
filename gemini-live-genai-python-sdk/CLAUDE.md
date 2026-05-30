# gemini-live-mem — the app

This is the real project (see the repo-root `CLAUDE.md` for what the rest of the repo is). A Gemini Live voice/video app fused with claude-mem: a live audio/video stream is cheaply turned into text, POSTed into claude-mem's existing tool-use observation API, and stored as structured memory of the people in the session.

## This project IS claude-mem — memory is never optional

Read this before touching anything. claude-mem is not a feature of this app; it is the entire reason the app exists. The memory pipeline is **always on**. There is **no enable/disable switch**, and there must never be one — a switch only ever tempts a shortcut (turning memory off to "make it run") instead of running it correctly.

- **Never disable the sink, never gate it behind a flag, never run the app "without memory" as a workaround.** If the worker isn't up, boot the worker — don't bypass memory.
- The sink is **always created** (`make_memory_sink()` in `claude_mem_sink.py`) and is **fail-soft internally**: if the worker is unreachable, the live session keeps working and that session simply records nothing. Fail-soft ≠ a toggle. Degradation is automatic, never a thing you choose.
- The old `CLAUDE_MEM_ENABLED` env var has been deleted on purpose. Do not reintroduce it or anything like it.
- "Run it so I can see it" means **run it with the worker live and observations flowing** — not a stubbed/disabled run.

## Architecture

```
Browser (web/, Next static export) ──WebSocket──► FastAPI (main.py, :8080)
  mic/cam/screen + BYOK key                          ├─ gemini_live.py ──► Gemini Live API
                                                      └─ claude_mem_sink.py ──HTTP──► claude-mem worker (:37777)
                                                                                       SQLite on Fly volume /data
```

- `web/` — the frontend: a `create-next-app` (Next 16 + React 19 + Tailwind v4, App Router) built as a **static export** (`output: 'export'` → `web/out/`). `main.py` serves `web/out` as the whole site; there is no Next server process. Client logic: `web/hooks/useGeminiSession.ts` (owns the WebSocket + `web/lib/media-handler.ts`), `web/components/*`, AudioWorklet at `web/public/pcm-processor.js`. Dev: `cd web && npm run dev` (:3000) with `NEXT_PUBLIC_WS_URL` pointing at FastAPI (:8080); prod leaves it unset → same-origin `/ws`. The old vanilla-JS `frontend/` dir is a legacy fallback `main.py` serves only when `web/out` hasn't been built.
- `main.py` — FastAPI + WebSocket. Reads the visitor's Gemini key from the first frame (`{"type":"setup","api_key":"..."}`) and requires it. Serves the static export via an `html=True` mount at `/`, registered **after** `/ws` and `/twilio/*` so those aren't shadowed.
- `gemini_live.py` — Gemini Live session lifecycle; calls the sink at `on_session_start` / `note_latest_frame` / `on_event` / `on_session_end`.
- `claude_mem_sink.py` — **the whole claude-mem integration** (start here). Posts observations, reads memory back, and hosts the extras below.
- `claude-mem-docker/gemini-live.json` — the observer "mode": the memory taxonomy (person / companion / behavior / appearance / environment / conversation / security). Change *what gets remembered* here.
- `prompts.json` (+ `prompts.py`) — every prompt/string. Edit prompts here, not inline.

Extras hanging off the sink's `emit()` channel (all opt-in, fail-soft): live memory feed to the UI, autonomous video captioner (~5s), event-invitation image generation, and memory-recall tools (`get_memory_timeline`, `get_memory_observations`) the live model can call.

## Things that will bite you

- **Memory must never break the session.** Every claude-mem call is fail-soft; a missing/unhealthy worker degrades to "no memory," never a broken session. Keep it that way.
- **Per-key namespace partition.** Project namespace = `gemini-live-<sha256(key)[:12]>`. A keyed session only sees memory created with that exact key; pre-BYOK observations under the flat `gemini-live-mem` project are unreachable. Want one shared pool? Pin the project string and use the key only for generation.
- **Worker boot key is a placeholder, not empty.** Empty makes `isGeminiAvailable()` false → silent fallback to the Claude SDK (no creds here) → nothing generated. BYOK is a patched worker (`claude-mem-docker/worker-byo-key.patch`, prebuilt as `worker-service.cjs`), not stock claude-mem.
- **Can't scale horizontally.** One Fly machine: the memory volume attaches to one machine and the worker + app share localhost. `docker-entrypoint.sh` boots the worker first, waits for health, then the app.
- **Summaries come ONLY from `POST /api/sessions/summarize`.** That is the worker's Stop-hook-equivalent; it's what fills the per-session Request / Learned / Completed / Next-Steps that `/api/context/recent` (the SessionStart context injected into the live model) and the recall timeline render. There is **no** `/api/sessions/complete` route — posting there 404s silently (fail-soft), which is exactly the bug that left every session summary-less and labeled with the bare init prompt. The sink calls `summarize` on session end and on a periodic checkpoint (`_summarize_session`); re-summarizing a session is normal (the worker keeps the latest). `memory_session_id` is NULL until the generator runs, so a session only appears in recall once at least one observation has been generated.

## Env vars (set in `docker-entrypoint.sh` / `fly.toml`)

| Var | Meaning |
| --- | --- |
| `CLAUDE_MEM_WORKER_URL` | worker address (`http://127.0.0.1:37777`) |
| `CLAUDE_MEM_PROVIDER` | `gemini` |
| `CLAUDE_MEM_GEMINI_API_KEY` | worker boot key — the placeholder, not a real key |
| `CLAUDE_MEM_MODE` | `gemini-live` (selects `gemini-live.json`) |
| `CLAUDE_MEM_PROJECT` | fallback namespace only; BYOK overrides per-key |
| `CLAUDE_MEM_VISION_ENABLED` / `_MODEL` | autonomous frame captioner |
| `CLAUDE_MEM_INVITATION_ENABLED` / `_MODEL` | event-invitation images |
| `CLAUDE_MEM_MEMORY_FEED_ENABLED` | live memory feed to the UI |
| `CLAUDE_MEM_SUMMARY_INTERVAL` | seconds between mid-session checkpoint summaries (default 120; ≤0 disables checkpoints, end-of-session summary still fires) |
| `TOKENROUTER_API_KEY` / `_BASE_URL` | optional gateway for image quota |
| `GEMINI_API_KEY` | optional; only the Twilio phone path uses it, never the web demo |

Feature design docs are in `docs/`.
