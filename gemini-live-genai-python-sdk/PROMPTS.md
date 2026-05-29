# Prompt Architecture & System Outline — `gemini-live-mem`

This document is the map of **every prompt the app sends to a model**, what each
one does during a live interaction, and the full stack/model lineup underneath
it. As of this audit all of the app's prompts are centralized in one file:
[`prompts.json`](./prompts.json), loaded by [`prompts.py`](./prompts.py).

> **One exception, by design:** the claude-mem *observer mode* file
> [`claude-mem-docker/gemini-live.json`](./claude-mem-docker/gemini-live.json) is
> **not** centralized here. It is owned and consumed by the **claude-mem worker**
> (a separate process/container), not by this app, and it configures how the
> worker's extraction LLM turns raw session data into structured observations.
> It is documented at the bottom for completeness.

---

## 1. What this app is

A real-time **voice + video assistant** built on **Google Gemini Live**, with an
optional **persistent memory** layer powered by **claude-mem**. A user talks to
the assistant in the browser (or over the phone via Twilio) while sharing camera
or screen. In the background the app:

1. Streams mic audio + video frames to Gemini Live and plays back Gemini's voice.
2. **Remembers** the session — every spoken turn and an autonomous video caption
   stream are fed into claude-mem, which extracts durable observations about the
   people present.
3. **Recalls** the past — the assistant is given memory-search tools so it can
   answer "what did we talk about last time / who was here."
4. **Reacts** — when people discuss planning an event, it auto-generates an
   invitation image and pushes it to the UI.

---

## 2. The stack

| Layer | Technology |
|---|---|
| **Live model API** | Google **Gemini Live** (bidirectional audio/video streaming) via the `google-genai` Python SDK (`client.aio.live.connect`) |
| **Backend** | Python 3.12, **FastAPI**, **Uvicorn**, WebSockets, `httpx` (async), `python-dotenv` |
| **Frontend** | Vanilla JS + **AudioWorklet** (`frontend/pcm-processor.js`); WebSocket carries **binary = audio**, **JSON = events/images** |
| **Audio** | 16 kHz PCM in / 24 kHz PCM out; `audioop` resampling + μ-law transcode for Twilio (8 kHz) |
| **Telephony (optional)** | **Twilio Media Streams** over WebSocket, driven by TwiML |
| **Memory** | **claude-mem** worker (Docker, port `37777`) — REST ingestion + retrieval; **ChromaDB** (local mode) for vector search |
| **Image generation** | **Nano Banana** image models, routed either through **TokenRouter** (OpenAI-compatible gateway) or the native `google-genai` SDK |
| **Prompt config** | `prompts.json` (this app) + `gemini-live.json` (claude-mem worker mode) |

Process topology:

```
Browser ──WS──┐
              ├─▶ FastAPI (main.py) ──▶ GeminiLive (gemini_live.py) ──▶ Gemini Live API
Twilio  ──WS──┘                              │
                                             ├─▶ MemorySink (claude_mem_sink.py)
                                             │       ├─ POST observations ─▶ claude-mem worker :37777
                                             │       ├─ autonomous vision captioner ─▶ Gemini
                                             │       └─ event-invitation image gen ─▶ TokenRouter / Gemini
                                             └─▶ memory-recall tools ◀─ claude-mem worker :37777
```

---

## 3. The models

Every model is overridable via environment variable. Defaults shown.

| Role | Default model | Env var | Where |
|---|---|---|---|
| **Live conversation** (voice in/out, sees video) | `gemini-3.1-flash-live-preview` | `MODEL` | `main.py` |
| **Voice** | `Puck` | — (`prompts.json` → `live_assistant.voice_name`) | `gemini_live.py` |
| **Autonomous video captioner** | `gemini-flash-latest` | `CLAUDE_MEM_VISION_MODEL` | `claude_mem_sink.py` |
| **Event-detail extraction** | (reuses captioner model) | `CLAUDE_MEM_VISION_MODEL` | `claude_mem_sink.py` |
| **Invitation image generation** | `gemini-3.1-flash-image-preview` (Nano Banana 2; prefixed `google/` when via TokenRouter) | `CLAUDE_MEM_INVITATION_MODEL` | `claude_mem_sink.py` |
| **Observation extraction** (worker side) | `gemini-2.5-flash` | `CLAUDE_MEM_GEMINI_MODEL` | `claude-mem-docker/settings.json` |

---

## 4. Prompt inventory — in interaction order

Each entry below is a prompt now sourced from `prompts.json`. The key path
(e.g. `live_assistant.system_instruction_base`) is where to edit it.

### 4.1 Session start — the assistant's system instruction
- **Key:** `live_assistant.system_instruction_base`
- **Used by:** `gemini_live.py` → `start_session`
- **Does:** the base persona for the live assistant ("helpful, concise, can see
  your camera/screen"). Sent as the Gemini Live `system_instruction`.

- **Key:** `live_assistant.memory_context_section` (placeholder `{session_start_context}`)
- **Used by:** `gemini_live.py` (whenever recent context exists for the session)
- **Does:** prepends the assistant's "memory of past sessions." The
  `{session_start_context}` slot is filled at runtime with the recent claude-mem
  summary fetched from `GET /api/context/recent` — so the assistant *starts each
  session already remembering* what it recently saw.

- **Key:** `live_assistant.memory_recall_instructions`
- **Used by:** `gemini_live.py` (the memory-recall tools are always registered)
- **Does:** teaches the assistant the two-step recall protocol — call
  `get_memory_timeline` first, then `get_memory_observations` for detail. Appended
  to the system instruction.

### 4.2 Memory-recall tools (function declarations)
- **Keys:** `memory_tools.get_memory_timeline.{description, param_limit_description}`,
  `memory_tools.get_memory_observations.{description, param_ids_description}`
- **Used by:** `claude_mem_sink.py` → `live_tools()`
- **Does:** the tool descriptions Gemini reads to decide when/how to call the
  two memory functions. `get_memory_timeline` → `GET /api/context/recent`,
  `get_memory_observations` → `POST /api/observations/batch`.

### 4.3 Autonomous video captioner
- **Keys:** `vision_captioner.prompt` (placeholders `{prev}`, `{no_change_token}`),
  `vision_captioner.no_change_token`
- **Used by:** `claude_mem_sink.py` → `_caption_frame`, on a timer
  (`CLAUDE_MEM_VISION_INTERVAL_SECONDS`, default 5s)
- **Does:** turns the latest JPEG frame into a 1–3 sentence plain description, or
  the literal `NO_CHANGE` token if the scene hasn't materially changed (the delta
  gate). Output is posted to claude-mem as a `GeminiLiveVision` observation. The
  captioner is deliberately "dumb" — all judgement about what's worth keeping
  lives in the worker's observer mode (`gemini-live.json`).

### 4.4 Event-invitation trigger
- **Key:** `event_invitation.extraction_prompt` (placeholder `{conversation}`)
- **Used by:** `claude_mem_sink.py` → `_extract_event_details`, fired when the
  `EVENT_PLANNING_PATTERN` regex matches a turn
- **Does:** extracts a structured JSON event object (title/date/time/location/
  host/guests/description/image_prompt) from the recent transcript.

- **Keys:** `event_invitation.image_render.{intro, default_title, field_labels,
  art_direction_prefix, default_art_direction, closing}`
- **Used by:** `claude_mem_sink.py` → `_render_invitation_image`
- **Does:** assembles the image-generation prompt (legible in-image text + art
  direction) sent to the Nano Banana image model; the resulting image is pushed
  to the frontend as an `event_invitation` event.

### 4.5 Session bookkeeping
- **Key:** `session.init_prompt_label`
- **Used by:** `claude_mem_sink.py` → `on_session_start` (`POST /api/sessions/init`)
- **Does:** the human-readable label stored on the claude-mem session row.

### 4.6 Telephony (Twilio)
- **Key:** `telephony.greeting_prompt`
- **Used by:** `twilio_handler.py`, on call connect
- **Does:** the first text turn injected so the assistant greets a phone caller.

- **Key:** `telephony.connect_say`
- **Used by:** `main.py` → `/twilio/inbound` and `/twilio/outbound` TwiML `<Say>`
- **Does:** the spoken line Twilio plays while bridging the call.

---

## 5. `prompts.json` structure & how to edit

```
_meta              → description, version, and the list of {placeholders}
live_assistant     → voice_name, system_instruction_base,
                     memory_context_section, memory_recall_instructions
memory_tools       → get_memory_timeline / get_memory_observations
                     (description + parameter descriptions)
vision_captioner   → no_change_token, prompt
event_invitation   → extraction_prompt, image_render{...}
telephony          → greeting_prompt, connect_say
session            → init_prompt_label
```

**Rules of the road:**
- Edit text freely. **Keep the `{placeholder}` tokens** (`{session_start_context}`,
  `{prev}`, `{no_change_token}`, `{conversation}`) — the code fills them with
  `str.format(...)`, so removing one or adding a stray `{`/`}` will raise at runtime.
- `prompts.py` loads the file **once at import** and **fails fast** — a missing or
  malformed `prompts.json` is a startup error, not a silent fallback.
- No Python changes are needed to retune any prompt.

---

## 6. Out of scope: the claude-mem observer mode (`gemini-live.json`)

`claude-mem-docker/gemini-live.json` ("Gemini Live Presence", v2.2.0) is the
**worker-side** prompt pack. It is intentionally *not* in `prompts.json` because a
different process consumes it: the claude-mem worker's extraction LLM
(`gemini-2.5-flash`). It defines the observation **types** (person, companion,
behavior, appearance, environment, conversation, security_alert, security_note,
tool-call), **concepts**, and the full set of observer prompts
(`system_identity`, `spatial_awareness`, `observer_role`, `recording_focus`,
`skip_guidance`, the XML output format, summary/checkpoint prompts, etc.).

In short: **`prompts.json` controls what the *assistant* says and does;
`gemini-live.json` controls how the *memory worker* writes observations.** They
sit on opposite sides of the `:37777` REST boundary.

---

## 7. Appendix: prompts in the reference subprojects (not centralized)

The repo also contains two standalone Gemini Live reference variants that are
**not** part of the running app and don't share `prompts.json` (different
language/runtime, kept as independent examples):

| File | Prompt | Notes |
|---|---|---|
| `command-line/python/main.py` | `system_instruction`: *"You are a helpful and friendly AI assistant."* | Minimal terminal PyAudio demo. Model `gemini-3.1-flash-live-preview`. |
| `gemini-live-ephemeral-tokens-websocket/frontend/index.html` | System-instructions `<textarea>` default: *"You are a helpful assistant. Be concise and friendly."* | **User-editable at runtime** in the browser UI; model entered in an input (default `gemini-3.1-flash-live-preview`). |
| `gemini-live-ephemeral-tokens-websocket/frontend/tools.js` | Browser tool descriptions: `show_alert`, `add_css_style` | Client-side function-calling demo tools. |

If these examples are ever promoted into the product, fold their prompts into
`prompts.json` at that point (YAGNI until then).
