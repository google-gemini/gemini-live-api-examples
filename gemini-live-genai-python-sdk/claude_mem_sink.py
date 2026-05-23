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
import logging
import os
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
