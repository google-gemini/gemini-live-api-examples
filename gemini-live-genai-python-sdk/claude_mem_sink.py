"""Fail-soft sink that forwards Gemini Live conversation data into the normal
claude-mem ingestion pipeline.

Each completed turn (and each Gemini tool call) is sent to the claude-mem worker
as a tool-use observation via POST /api/sessions/observations -- the exact path a
Claude Code PostToolUse hook uses. The worker queues it, runs its LLM extraction
generator, and stores a structured observation. We invent no new storage; we just
feed the existing pipeline.

Entirely opt-in (CLAUDE_MEM_ENABLED) and entirely fail-soft: a missing/unreachable
worker, or any error here, must never disturb the live audio session.
"""
import asyncio
import base64
import hashlib
import json
import logging
import os
import re
import uuid

import httpx
from google import genai
from google.genai import types

logger = logging.getLogger(__name__)

# The synthetic tool name a conversational turn is recorded under.
TURN_TOOL_NAME = "GeminiLiveTurn"
# The synthetic tool name an autonomous video-frame description is recorded under.
VISION_TOOL_NAME = "GeminiLiveVision"
PLATFORM_SOURCE = "gemini-live"

# The captioner is deliberately dumb: it turns the current frame into a plain
# textual representation (or NO_CHANGE). ALL judgement about what is worth
# remembering / what to skip lives in the observer mode (gemini-live.json).
NO_CHANGE_TOKEN = "NO_CHANGE"
VISION_PROMPT = (
    "You are an automatic camera feed for a memory system. Describe what is "
    "currently visible in this frame in 1-3 concise, plain sentences — who is "
    "present, what they are doing, and the setting around them. Report only "
    "what you can see; do not editorialize.\n"
    'Previous description: "{prev}"\n'
    "If this frame is materially the same as the previous description (same "
    "people, same activity, same setting), reply with exactly: " + NO_CHANGE_TOKEN
)


# Talk of planning an event (party, wedding, dinner, gathering...) triggers an
# automatic invitation image. Deliberately broad: any "plan/organize/throw/host
# ... event/party/..." phrasing, plus common named party types.
EVENT_PLANNING_PATTERN = re.compile(
    r"\b(?:plan(?:ning)?|organi[sz](?:e|ing)|throw(?:ing)?|host(?:ing)?|"
    r"arrang(?:e|ing)|put(?:ting)?\s+together|set(?:ting)?\s+up)\b"
    r".{0,40}\b(?:event|party|wedding|birthday|anniversary|gathering|"
    r"meet[- ]?up|celebration|dinner|get[- ]?together|reunion|shower|bbq|"
    r"barbecue|cookout|ceremony|festival|gala|launch|fundraiser|housewarming|"
    r"picnic|brunch)\b"
    r"|\b(?:birthday|surprise|dinner|house|launch|garden|block|costume|holiday|"
    r"viewing|watch)\s+part(?:y|ies)\b"
    r"|\bbaby\s+shower\b|\bbridal\s+shower\b|\bbachelor(?:ette)?\s+party\b",
    re.IGNORECASE | re.DOTALL,
)


def make_memory_sink_if_enabled():
    """Return a MemorySink when CLAUDE_MEM_ENABLED is truthy, else None.

    This is the only symbol gemini_live.py needs to import, keeping claude-mem
    coupling to a single call site.
    """
    if os.getenv("CLAUDE_MEM_ENABLED", "false").lower() not in ("1", "true", "yes", "on"):
        return None
    return MemorySink()


class MemorySink:
    def __init__(self):
        self.worker_url = os.getenv("CLAUDE_MEM_WORKER_URL", "http://127.0.0.1:37777").rstrip("/")
        self.project = os.getenv("CLAUDE_MEM_PROJECT", "gemini-live-mem")
        self.cwd = os.getcwd()
        self.content_session_id = f"gemini-live-{uuid.uuid4()}"
        self._client = httpx.AsyncClient(timeout=10.0)
        # Per-turn transcript buffers; flushed on turn_complete / interrupted.
        self._user_text = []
        self._gemini_text = []

        # --- Autonomous video captioner ---------------------------------------
        # Turns the live video into a steady stream of textual frame
        # descriptions even when the user is silent, so the observer keeps
        # building presence observations without any user intervention.
        gemini_api_key = os.getenv("GEMINI_API_KEY")
        self.vision_enabled = (
            os.getenv("CLAUDE_MEM_VISION_ENABLED", "true").lower() in ("1", "true", "yes", "on")
            and bool(gemini_api_key)
        )
        self.vision_model = os.getenv("CLAUDE_MEM_VISION_MODEL", "gemini-flash-latest")
        self.vision_interval = float(os.getenv("CLAUDE_MEM_VISION_INTERVAL_SECONDS", "5"))
        self._genai = genai.Client(api_key=gemini_api_key) if self.vision_enabled else None
        self._latest_frame = None       # most-recent JPEG bytes (overwritten, never queued)
        self._frame_seq = 0             # bumped on every new frame
        self._last_captioned_seq = 0    # last frame seq we sent to the captioner
        self._prev_caption = ""         # context for the NO_CHANGE delta gate
        self._vision_task = None

        # --- Event-invitation trigger -----------------------------------------
        # When the people in the session talk about planning an event, generate
        # an invitation image (details they spoke about + themed imagery) and
        # push it to the frontend. Opt-in and fail-soft like the captioner.
        self.invitation_enabled = (
            os.getenv("CLAUDE_MEM_INVITATION_ENABLED", "true").lower() in ("1", "true", "yes", "on")
            and bool(gemini_api_key)
        )
        # Default to Nano Banana 2 (flash, legible in-image text — best for
        # invitations). Needs a paid image-gen quota. Override with
        # CLAUDE_MEM_INVITATION_MODEL (e.g. gemini-3-pro-image-preview for the
        # sharpest text, or gemini-2.5-flash-image as a validated fallback).
        self.invitation_model = os.getenv(
            "CLAUDE_MEM_INVITATION_MODEL", "gemini-3.1-flash-image-preview"
        )
        self.invitation_aspect_ratio = os.getenv("CLAUDE_MEM_INVITATION_ASPECT_RATIO", "3:4")
        # Async callback (set by GeminiLive) that pushes an event to the frontend.
        self.emit = None
        self._recent_turns = []            # rolling conversation context
        self._invitation_task = None       # single-flight guard
        self._last_event_signature = None  # don't regenerate the same event

    async def on_session_start(self):
        """Create the claude-mem session row (POST /api/sessions/init)."""
        await self._post(
            "/api/sessions/init",
            {
                "contentSessionId": self.content_session_id,
                "project": self.project,
                "prompt": "Gemini Live session",
                "platformSource": PLATFORM_SOURCE,
            },
        )
        if self.vision_enabled:
            self._vision_task = asyncio.create_task(self._caption_loop())
            logger.info(
                f"claude-mem video captioner started "
                f"(model={self.vision_model}, every {self.vision_interval}s)"
            )

    def note_latest_frame(self, jpeg_bytes):
        """Record the most-recent video frame (the exact bytes sent to Gemini).

        Cheap and non-blocking: only keeps the latest frame. Safe to call when
        vision is disabled (no-op). Called from GeminiLive.send_video.
        """
        if not self.vision_enabled or not jpeg_bytes:
            return
        self._latest_frame = jpeg_bytes
        self._frame_seq += 1

    async def on_event(self, event):
        """Consume one event from the GeminiLive drain loop."""
        if not isinstance(event, dict):
            return
        event_type = event.get("type")
        if event_type == "user":
            self._user_text.append(event.get("text", ""))
        elif event_type == "gemini":
            self._gemini_text.append(event.get("text", ""))
        elif event_type in ("turn_complete", "interrupted"):
            await self._flush_turn()
        elif event_type == "tool_call":
            # Flush pending transcript first so observations stay in chronological order.
            await self._flush_turn()
            # A real Gemini tool use maps 1:1 onto a claude-mem tool-use observation.
            await self._post_observation(
                tool_name=event.get("name", "tool_call"),
                tool_input=event.get("args", {}),
                tool_response={"result": event.get("result")},
            )

    async def on_session_end(self):
        """Stop the captioner, flush any trailing partial turn, close the client."""
        if self._vision_task:
            self._vision_task.cancel()
            try:
                await self._vision_task
            except (asyncio.CancelledError, Exception):
                pass
        if self._invitation_task:
            self._invitation_task.cancel()
            try:
                await self._invitation_task
            except (asyncio.CancelledError, Exception):
                pass
        await self._flush_turn()
        try:
            await self._client.aclose()
        except Exception as e:
            logger.debug(f"claude-mem sink close failed: {e}")

    async def _caption_loop(self):
        """Periodically caption the latest frame and feed it to the observer.

        Fail-soft: any captioning/posting error is swallowed and the loop
        continues. Skips when no new frame has arrived (camera off/paused) and
        when the captioner reports NO_CHANGE.
        """
        try:
            while True:
                await asyncio.sleep(self.vision_interval)
                if self._latest_frame is None or self._frame_seq == self._last_captioned_seq:
                    continue  # nothing new to look at
                frame = self._latest_frame
                self._last_captioned_seq = self._frame_seq
                try:
                    caption = await self._caption_frame(frame)
                except Exception as e:
                    logger.debug(f"claude-mem vision caption failed: {e}")
                    continue
                if not caption or caption.upper().startswith(NO_CHANGE_TOKEN):
                    continue
                self._prev_caption = caption
                await self._post_observation(
                    tool_name=VISION_TOOL_NAME,
                    tool_input={"frame": "current camera/screen frame"},
                    tool_response={"description": caption},
                )
        except asyncio.CancelledError:
            pass

    async def _caption_frame(self, jpeg_bytes):
        """Turn one JPEG frame into a plain textual description (or NO_CHANGE)."""
        response = await self._genai.aio.models.generate_content(
            model=self.vision_model,
            contents=[
                types.Part.from_bytes(data=jpeg_bytes, mime_type="image/jpeg"),
                types.Part(text=VISION_PROMPT.format(prev=self._prev_caption or "(none yet)")),
            ],
        )
        return (response.text or "").strip()

    async def _flush_turn(self):
        user_text = "".join(self._user_text).strip()
        gemini_text = "".join(self._gemini_text).strip()
        self._user_text = []
        self._gemini_text = []
        if not user_text and not gemini_text:
            return
        await self._post_observation(
            tool_name=TURN_TOOL_NAME,
            tool_input={"user": user_text},
            tool_response={"gemini": gemini_text},
        )
        combined = f"User: {user_text}\nAssistant: {gemini_text}".strip()
        self._recent_turns.append(combined)
        self._recent_turns = self._recent_turns[-12:]
        self._maybe_trigger_invitation(combined)

    def _maybe_trigger_invitation(self, turn_text):
        """If this turn talks about planning an event, kick off invitation gen."""
        if not self.invitation_enabled or self.emit is None or not turn_text:
            return
        if not EVENT_PLANNING_PATTERN.search(turn_text):
            return
        if self._invitation_task and not self._invitation_task.done():
            return  # one invitation in flight at a time
        conversation = "\n".join(self._recent_turns[-8:])
        self._invitation_task = asyncio.create_task(
            self._generate_and_emit_invitation(conversation)
        )
        logger.info("claude-mem event-planning detected -> generating invitation")

    async def _generate_and_emit_invitation(self, conversation):
        """Extract event details, render an invitation image, push it to the UI.

        Fail-soft end to end: any error is swallowed and the session continues.
        """
        try:
            details = await self._extract_event_details(conversation)
        except Exception as e:
            logger.debug(f"claude-mem invitation extraction failed: {e}")
            return
        if not isinstance(details, dict):
            return
        signature = hashlib.sha1(
            json.dumps(details, sort_keys=True).encode("utf-8")
        ).hexdigest()
        if signature == self._last_event_signature:
            return  # already made an invitation for this same event
        try:
            image_base64, mime_type = await self._render_invitation_image(details)
        except Exception as e:
            logger.debug(f"claude-mem invitation image failed: {e}")
            return
        if not image_base64:
            return
        self._last_event_signature = signature
        try:
            await self.emit({
                "type": "event_invitation",
                "details": details,
                "mime_type": mime_type,
                "image_base64": image_base64,
            })
        except Exception as e:
            logger.debug(f"claude-mem invitation emit failed: {e}")
        # Record that we generated an invitation (fail-soft; shows up in memory).
        await self._post_observation(
            tool_name="EventInvitationGenerated",
            tool_input={"event": details},
            tool_response={"status": "invitation image generated and shown to the user"},
        )

    async def _extract_event_details(self, conversation):
        """Pull structured event details + an art-direction prompt from the talk."""
        prompt = (
            "The people in this conversation are planning an event. Extract the "
            "event into a JSON object with EXACTLY these string keys: title, date, "
            "time, location, host, guests, description, image_prompt. Use an empty "
            "string for anything not mentioned. 'image_prompt' must be a vivid, "
            "concrete art-direction description for a beautiful, themed event "
            "invitation image. Respond with ONLY the JSON object, no prose.\n\n"
            "Conversation:\n" + conversation
        )
        response = await self._genai.aio.models.generate_content(
            model=self.vision_model,
            contents=[types.Part(text=prompt)],
        )
        text = (response.text or "").strip()
        # Strip ```json fences if the model added them.
        text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.IGNORECASE).strip()
        return json.loads(text)

    async def _render_invitation_image(self, details):
        """Render the invitation as an image; return (base64_str, mime_type).

        Per the google-genai image API, the returned part.inline_data.data is
        base64-encoded text (NOT raw bytes), so we pass it straight to the
        browser as a data URL; if a future SDK returns raw bytes we b64-encode.
        """
        def field(key, label):
            value = (details.get(key) or "").strip()
            return f"{label}: {value}\n" if value else ""

        title = (details.get("title") or "You are invited!").strip()
        prompt = (
            "Design a single, finished event invitation graphic in portrait "
            "orientation. Render this text legibly and beautifully integrated into "
            "the artwork (spell everything correctly):\n"
            f"{title}\n"
            + field("date", "Date")
            + field("time", "Time")
            + field("location", "Location")
            + field("host", "Hosted by")
            + "\nArt direction: "
            + (details.get("image_prompt") or "warm, festive, inviting, tasteful")
            + ". Include themed decorative imagery. Polished invitation/poster layout."
        )
        response = await self._genai.aio.models.generate_content(
            model=self.invitation_model,
            contents=[types.Part(text=prompt)],
            config=types.GenerateContentConfig(
                response_modalities=["TEXT", "IMAGE"],
                image_config=types.ImageConfig(aspect_ratio=self.invitation_aspect_ratio),
            ),
        )
        for candidate in (response.candidates or []):
            content = getattr(candidate, "content", None)
            for part in (getattr(content, "parts", None) or []):
                inline = getattr(part, "inline_data", None)
                data = getattr(inline, "data", None) if inline else None
                if not data:
                    continue
                mime_type = getattr(inline, "mime_type", None) or "image/png"
                if isinstance(data, bytes):
                    data = base64.b64encode(data).decode("ascii")
                return data, mime_type
        return None, None

    async def _post_observation(self, tool_name, tool_input, tool_response):
        await self._post(
            "/api/sessions/observations",
            {
                "contentSessionId": self.content_session_id,
                "tool_name": tool_name,
                "tool_input": tool_input,
                "tool_response": tool_response,
                "cwd": self.cwd,
                "platformSource": PLATFORM_SOURCE,
            },
        )

    async def _post(self, path, body):
        """POST to the worker, swallowing every error. Never disturbs the session."""
        try:
            response = await self._client.post(f"{self.worker_url}{path}", json=body)
            if response.status_code >= 400:
                logger.warning(f"claude-mem {path} -> {response.status_code}: {response.text[:200]}")
            else:
                logger.debug(f"claude-mem {path} -> {response.status_code}")
        except Exception as e:
            logger.debug(f"claude-mem {path} failed: {e}")
