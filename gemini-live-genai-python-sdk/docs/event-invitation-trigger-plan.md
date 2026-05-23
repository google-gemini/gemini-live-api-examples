# Event-Invitation Trigger — Plan & Design

When the people in a Gemini Live session talk about **planning an event**, the app
auto-generates an **invitation image** (the details they spoke about + themed
imagery) and shows it in the chat panel. Plus the observer config now captures the
observation targets the assistant itself proposed during the live demo.

Status: **implemented** on branch `gemini-live-event-invitation-trigger`. Parses
clean; verified against installed `google-genai 2.6.0`.

## Phase 0 — API facts (sourced from claude-mem mem-search, not assumed)

These come from the hackathon research observations (#87256–#87260, #87212):

- **`part.inline_data.data` is base64-encoded text, NOT raw bytes** (#87259) — pass
  it straight to the browser as a data URL; only `b64encode` if a future SDK
  returns raw `bytes`. (We handle both.)
- **Async path is fine**: `client.aio.models.generate_content(...)` supports image
  output — no `run_in_executor` needed (#87258). Same client already in the sink.
- **Config**: `types.GenerateContentConfig(response_modalities=["TEXT","IMAGE"],
  image_config=types.ImageConfig(aspect_ratio="3:4"))` (#87256, #87258). Confirmed
  present in google-genai 2.6.0.
- **Model for legible in-image text** (names/dates/venue) (#87256, #87260):
  - `gemini-3.1-flash-image-preview` — Nano Banana 2, flash, sharp text → **default**
  - `gemini-3-pro-image-preview` — Nano Banana Pro, best text (override for quality)
  - `gemini-2.5-flash-image` — original Nano Banana, **poor text**; validated-working fallback
  - There is **no** `gemini-3.5-flash` / "Flash 3.5" model (#87194).
- **⚠️ Quota gotcha** (#87212): image generation needs a **paid** API key. A
  free-tier key returns `429 limit:0` and silently produces no image. Make sure
  `GEMINI_API_KEY` has paid image access.

## Part 1 — Observer config (`claude-mem-docker/gemini-live.json`, v2.0.0 → 2.1.0)

Enriched `recording_focus` to capture what the assistant suggested on the demo:
name introductions, headcount, facial expressions/gestures, accessories
(hats/headphones/glasses), notable environment features (murals, arched windows),
activity level & atmosphere, activity types (typing/talking/listening), returning
people — and an explicit **EVENT PLANNING** instruction (capture occasion, who,
date, time, location, guests, theme as a `conversation` observation).

No schema change to the 7 types / 6 concepts — fail-safe with the existing worker.
Requires the docker worker to reload the config (restart) to take effect.

## Part 2 — Real-time invitation generation (`claude_mem_sink.py`)

1. **Detect** — `EVENT_PLANNING_PATTERN` regex over each completed turn's
   user+assistant transcript (broad: plan/organize/throw/host … event/party/…,
   plus named party types). Cheap gate, no extra LLM call per turn.
2. **Extract** — one `gemini-flash-latest` call returns JSON: `title, date, time,
   location, host, guests, description, image_prompt`.
3. **Render** — `_render_invitation_image` calls the image model and returns
   `(base64_str, mime_type)`.
4. **Emit** — pushes `{"type":"event_invitation", details, mime_type,
   image_base64}` through the new `emit` channel.
5. **Record** — posts an `EventInvitationGenerated` observation (fail-soft).

Guards: opt-in (`CLAUDE_MEM_INVITATION_ENABLED`, default on when a key is present),
single-flight (one in-flight at a time), and a per-event signature so the same
event isn't regenerated. Every step is wrapped fail-soft — image failure never
disturbs the live audio session.

### Emit-back channel (`gemini_live.py`)

The sink was consume-only. After `event_queue` is created we set
`memory_sink.emit = event_queue.put`, so the sink can push events onto the same
queue the receive loop drains → `websocket.send_json(event)` → frontend. The drain
loop's `on_event` ignores the `event_invitation` type (no recursion).

### Frontend (`frontend/main.js`, `frontend/style.css`)

`handleJsonMessage` gains an `event_invitation` branch → `appendInvitation(msg)`
renders an image card (`data:<mime>;base64,<image_base64>`) with a caption
(title • date time • location). Styled `.message.invitation` with a pop animation.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `CLAUDE_MEM_INVITATION_ENABLED` | `true` | Master switch (needs `GEMINI_API_KEY`) |
| `CLAUDE_MEM_INVITATION_MODEL` | `gemini-3.1-flash-image-preview` | Image model |
| `CLAUDE_MEM_INVITATION_ASPECT_RATIO` | `3:4` | Invitation aspect ratio |

## How to test

1. Ensure `GEMINI_API_KEY` has **paid image quota** (else 429, no image).
2. Restart the docker worker so it picks up `gemini-live.json` v2.1.0.
3. Run the app; in the live session say e.g. *"let's plan a birthday party for
   Spencer next Friday at the rooftop café."*
4. Within a couple of turns an invitation card should appear in the chat panel,
   and an `EventInvitationGenerated` observation should land in the worker DB.

## Verification checklist

- [x] `python3 -m py_compile claude_mem_sink.py gemini_live.py`
- [x] `node --check frontend/main.js`
- [x] `gemini-live.json` valid JSON, version 2.1.0
- [x] `google-genai 2.6.0` exposes `types.ImageConfig` + config fields
- [ ] Live run with a paid key produces a visible invitation (needs hackathon key)
