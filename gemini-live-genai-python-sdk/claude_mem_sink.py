"""Fail-soft sink that forwards Gemini Live conversation data into the normal
claude-mem ingestion pipeline.

Each completed turn (and each Gemini tool call) is sent to the claude-mem worker
as a tool-use observation via POST /api/sessions/observations -- the exact path a
Claude Code PostToolUse hook uses. The worker queues it, runs its LLM extraction
generator, and stores a structured observation. We invent no new storage; we just
feed the existing pipeline.

claude-mem is the point of this project, not an add-on — so the sink is ALWAYS
on. There is no enable/disable switch. It is, however, entirely fail-soft: a
missing/unreachable worker, or any error here, degrades to "no memory this
session" and must never disturb the live audio session.
"""
import asyncio
import base64
import hashlib
import json
import logging
import os
import re
import uuid
from datetime import datetime, timezone

import httpx
from google import genai
from google.genai import types

from prompts import PROMPTS

logger = logging.getLogger(__name__)

# The synthetic tool name a conversational turn is recorded under.
TURN_TOOL_NAME = "GeminiLiveTurn"
# The synthetic tool name an autonomous video-frame description is recorded under.
VISION_TOOL_NAME = "GeminiLiveVision"
PLATFORM_SOURCE = "gemini-live"

# The captioner is deliberately dumb: it turns the current frame into a plain
# textual representation (or NO_CHANGE). ALL judgement about what is worth
# remembering / what to skip lives in the observer mode (gemini-live.json).
# Both the prompt and the delta-gate token come from prompts.json.
NO_CHANGE_TOKEN = PROMPTS["vision_captioner"]["no_change_token"]
VISION_PROMPT = PROMPTS["vision_captioner"]["prompt"]


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


def make_memory_sink(api_key=None):
    """Return the MemorySink. claude-mem is core to this project, so it is always
    created — there is no opt-in/opt-out switch. The sink is internally
    fail-soft, so an unreachable worker degrades to "no memory" on its own; we
    never express that by refusing to build the sink.

    This is the only symbol gemini_live.py needs to import, keeping claude-mem
    coupling to a single call site. `api_key` is the visitor's BYO Gemini key.
    """
    return MemorySink(api_key=api_key)


class MemorySink:
    def __init__(self, api_key=None):
        self.worker_url = os.getenv("CLAUDE_MEM_WORKER_URL", "http://127.0.0.1:37777").rstrip("/")
        # BYO key: normalize the visitor's Gemini key ONCE so every downstream
        # use (vision captioner, namespace, worker init POST) sees the identical
        # value. .strip() so incidental whitespace can't fork a returning
        # visitor into a fresh namespace.
        self._user_gemini_api_key = (api_key or os.getenv("GEMINI_API_KEY") or "").strip()
        # Per-visitor isolation: derive the claude-mem project namespace from a
        # one-way hash of the key. sha256 is preimage-resistant (the namespace
        # never reveals the key) yet deterministic (the SAME key always maps to
        # the SAME namespace), so a returning visitor recovers their prior
        # observations. 12 hex (48 bits) is collision-safe at demo scale.
        self.project = (
            f"gemini-live-{hashlib.sha256(self._user_gemini_api_key.encode('utf-8')).hexdigest()[:12]}"
            if self._user_gemini_api_key
            else os.getenv("CLAUDE_MEM_PROJECT", "gemini-live-mem")
        )
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
        gemini_api_key = self._user_gemini_api_key
        self.vision_enabled = (
            os.getenv("CLAUDE_MEM_VISION_ENABLED", "true").lower() in ("1", "true", "yes", "on")
            and bool(gemini_api_key)
        )
        self.vision_model = os.getenv("CLAUDE_MEM_VISION_MODEL", "gemini-flash-latest")
        self.vision_interval = 5.0  # seconds between frame captions
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
        # Image generation can go through TokenRouter (an OpenAI-compatible
        # gateway, where the paid image quota lives) or the native google-genai
        # SDK. If TOKENROUTER_API_KEY is set we route through it; models then
        # need the "google/" prefix.
        self.tokenrouter_api_key = os.getenv("TOKENROUTER_API_KEY", "")
        self.tokenrouter_base_url = os.getenv(
            "TOKENROUTER_BASE_URL", "https://api.tokenrouter.com/v1"
        ).rstrip("/")
        # Default to Nano Banana 2 (flash, legible in-image text — best for
        # invitations). Override with CLAUDE_MEM_INVITATION_MODEL (e.g.
        # google/gemini-3-pro-image-preview for the sharpest text).
        default_invitation_model = (
            "google/gemini-3.1-flash-image-preview"
            if self.tokenrouter_api_key
            else "gemini-3.1-flash-image-preview"
        )
        self.invitation_model = os.getenv("CLAUDE_MEM_INVITATION_MODEL", default_invitation_model)
        self.invitation_aspect_ratio = os.getenv("CLAUDE_MEM_INVITATION_ASPECT_RATIO", "3:4")
        # Async callback (set by GeminiLive) that pushes an event to the frontend.
        self.emit = None
        self._recent_turns = []            # rolling conversation context
        self._invitation_task = None       # single-flight guard
        self._last_event_signature = None  # don't regenerate the same event

        # --- Live memory feed -------------------------------------------------
        # Stream the observations the worker extracts back to the frontend in
        # real time, so the user can watch the memory build as the session
        # happens. This reads back the SAME observations this pipeline already
        # stores -- it invents no new storage -- and pushes each new one through
        # `self.emit`, exactly like the invitation card. Opt-in and fail-soft.
        self.memory_feed_enabled = (
            os.getenv("CLAUDE_MEM_MEMORY_FEED_ENABLED", "true").lower()
            in ("1", "true", "yes", "on")
        )
        self.memory_feed_interval = 4.0  # seconds between memory polls
        self._memory_feed_task = None

        # --- Worker-restart recovery ------------------------------------------
        # The visitor's key lives ONLY in the worker's in-memory session, so a
        # worker restart (crash + supervisor respawn, redeploy) drops it and every
        # later observation for this in-flight session would silently fail. Watch
        # the worker's health pid; when it changes, re-send session init (which
        # re-attaches the key) so generation recovers on its own. Fail-soft.
        self.worker_guard_interval = 5.0  # seconds between worker health checks
        self._worker_guard_task = None
        self._worker_pid = None  # last-seen worker process id (restart sentinel)
        # Only stream observations created AFTER this session starts; seeded with
        # the latest existing observation id so the feed begins empty and fills
        # live as the worker extracts new memories.
        self._obs_high_water = 0

    async def on_session_start(self):
        """Create the claude-mem session row and start the background loops."""
        await self._init_session()
        # Seed the restart sentinel with the worker we just initialized against,
        # so the guard only re-inits on a genuine later restart (not at startup).
        self._worker_pid = await self._worker_health_pid()
        self._worker_guard_task = asyncio.create_task(self._worker_guard_loop())
        if self.vision_enabled:
            self._vision_task = asyncio.create_task(self._caption_loop())
            logger.info(
                f"claude-mem video captioner started "
                f"(model={self.vision_model}, every {self.vision_interval}s)"
            )
        if self.memory_feed_enabled:
            self._memory_feed_task = asyncio.create_task(self._memory_feed_loop())
            logger.info(
                f"claude-mem live memory feed started "
                f"(every {self.memory_feed_interval}s)"
            )

    async def _init_session(self):
        """POST /api/sessions/init — create/refresh this key's worker session.

        Idempotent on the (patched) worker: re-calling it for the same
        contentSessionId re-attaches the per-session key, which is exactly how we
        recover generation after a worker restart.
        """
        await self._post(
            "/api/sessions/init",
            {
                "contentSessionId": self.content_session_id,
                "project": self.project,
                "prompt": PROMPTS["session"]["init_prompt_label"],
                "platformSource": PLATFORM_SOURCE,
                # BYO key: the worker uses this per-session key to generate this
                # visitor's observations. Held in-memory only by the worker —
                # never written to disk.
                "geminiApiKey": self._user_gemini_api_key,
            },
        )

    async def _worker_health_pid(self):
        """Return the worker process id from /api/health (None if unreachable)."""
        data = await self._get_json("/api/health")
        if isinstance(data, dict) and isinstance(data.get("pid"), int):
            return data["pid"]
        return None

    async def _worker_guard_loop(self):
        """Re-attach the per-session key whenever the worker process changes.

        The key lives only in the worker's in-memory session, so a restart would
        otherwise silently kill generation for this in-flight session. Fail-soft:
        any error is swallowed and the loop continues; it never disturbs the live
        audio session. Mirrors `_caption_loop` / `_memory_feed_loop`.
        """
        try:
            while True:
                await asyncio.sleep(self.worker_guard_interval)
                pid = await self._worker_health_pid()
                if pid is None:
                    continue  # worker down; the entrypoint supervisor revives it
                if pid != self._worker_pid:
                    # New worker process (restart / first reach after a down start)
                    # — its memory has no key for this session. Re-init to recover.
                    logger.info(
                        f"claude-mem worker restart detected "
                        f"(pid {self._worker_pid} -> {pid}); re-initializing session"
                    )
                    try:
                        await self._init_session()
                    except Exception as e:
                        logger.debug(f"claude-mem session re-init failed: {e}")
                        continue
                    self._worker_pid = pid
        except asyncio.CancelledError:
            pass

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
        if self._memory_feed_task:
            self._memory_feed_task.cancel()
            try:
                await self._memory_feed_task
            except (asyncio.CancelledError, Exception):
                pass
        if self._worker_guard_task:
            self._worker_guard_task.cancel()
            try:
                await self._worker_guard_task
            except (asyncio.CancelledError, Exception):
                pass
        await self._flush_turn()
        await self._complete_session()
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
                types.Part(text=(
                    VISION_PROMPT
                    .replace("{no_change_token}", NO_CHANGE_TOKEN)
                    .replace("{prev}", self._prev_caption or "(none yet)")
                )),
            ],
        )
        return (response.text or "").strip()

    # --- Live memory feed -----------------------------------------------------
    async def _memory_feed_loop(self):
        """Poll the worker for newly-extracted observations and push each to the
        frontend as an `observation` event.

        Fail-soft: any poll/emit error is swallowed and the loop continues; it
        must never disturb the live audio session. Mirrors `_caption_loop`.
        """
        try:
            # Seed the high-water mark with the latest existing observation so we
            # only stream memories formed during THIS session.
            self._obs_high_water = await self._latest_observation_id()
            while True:
                await asyncio.sleep(self.memory_feed_interval)
                if self.emit is None:
                    continue  # frontend channel not wired yet
                try:
                    fresh = await self._fetch_new_observations()
                except Exception as e:
                    logger.debug(f"claude-mem memory feed poll failed: {e}")
                    continue
                for obs in fresh:
                    try:
                        await self.emit({
                            "type": "observation",
                            "observation": {
                                "id": obs.get("id"),
                                "obs_type": obs.get("type"),
                                "title": obs.get("title"),
                                "subtitle": obs.get("subtitle"),
                            },
                        })
                    except Exception as e:
                        logger.debug(f"claude-mem memory feed emit failed: {e}")
        except asyncio.CancelledError:
            pass

    async def _fetch_new_observations(self, limit=25):
        """Return observations newer than the high-water mark, oldest-first.

        Order-independent: filters by id > high_water and re-sorts, so it does
        not rely on the endpoint's sort order.
        """
        data = await self._get_json(
            "/api/observations", {"project": self.project, "limit": limit}
        )
        items = data.get("items") if isinstance(data, dict) else None
        if not isinstance(items, list):
            return []
        fresh = [
            obs for obs in items
            if isinstance(obs, dict)
            and isinstance(obs.get("id"), int)
            and obs["id"] > self._obs_high_water
        ]
        fresh.sort(key=lambda obs: obs["id"])
        if fresh:
            self._obs_high_water = max(self._obs_high_water, fresh[-1]["id"])
        return fresh

    async def _latest_observation_id(self):
        """Newest observation id for this project (0 if none / worker down)."""
        data = await self._get_json(
            "/api/observations", {"project": self.project, "limit": 1}
        )
        items = data.get("items") if isinstance(data, dict) else None
        if isinstance(items, list) and items and isinstance(items[0].get("id"), int):
            return items[0]["id"]
        return 0

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
        prompt = PROMPTS["event_invitation"]["extraction_prompt"].replace(
            "{conversation}", conversation
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
        render = PROMPTS["event_invitation"]["image_render"]
        labels = render["field_labels"]

        def field(key, label):
            value = (details.get(key) or "").strip()
            return f"{label}: {value}\n" if value else ""

        title = (details.get("title") or render["default_title"]).strip()
        prompt = (
            render["intro"]
            + f"\n{title}\n"
            + field("date", labels["date"])
            + field("time", labels["time"])
            + field("location", labels["location"])
            + field("host", labels["host"])
            + render["art_direction_prefix"]
            + (details.get("image_prompt") or render["default_art_direction"])
            + render["closing"]
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

    # --- claude-mem read access (session-start context + recall tools) --------
    async def fetch_session_start_context(self, limit=8):
        """Return the standard claude-mem 'recent session context' as markdown.

        This is the same recent-session summary the SessionStart hook injects;
        we feed it into the Gemini system prompt so the assistant starts each
        session already knowing what it recently saw. Fail-soft: returns "".
        """
        data = await self._get_json(
            "/api/context/recent", {"project": self.project, "limit": limit}
        )
        return self._mcp_text(data).strip()

    async def fetch_timeline(self, limit=1000):
        """Return recent session observations across this and past sessions.

        Uses /api/context/recent (limit = number of recent sessions), which
        returns the full observation text grouped by session. We deliberately
        avoid /api/timeline: that endpoint is hard-capped at a ±10 record window
        around its anchor and ignores limit, so it could only ever surface ~10
        observations no matter what the caller asked for.
        """
        data = await self._get_json(
            "/api/context/recent",
            {"project": self.project, "limit": limit},
        )
        return self._mcp_text(data).strip() or "No timeline is available yet."

    async def fetch_observations(self, ids):
        """Return readable details for the given observation IDs."""
        parsed_ids = []
        for raw_id in ids or []:
            try:
                parsed_ids.append(int(raw_id))
            except (ValueError, TypeError):
                continue
        if not parsed_ids:
            return "No valid observation IDs were provided."
        # Per-visitor isolation: scope the batch read to THIS key's namespace so a
        # prompted/hallucinated id can only ever resolve to the caller's own
        # observations. The worker filters on `project` when supplied; without it
        # the model could read any visitor's observation by id (cross-tenant leak).
        items = await self._post_json(
            "/api/observations/batch", {"ids": parsed_ids, "project": self.project}
        )
        if not isinstance(items, list) or not items:
            return "Could not find those observations."
        return self._format_observations(items)

    def live_tools(self):
        """Return (tools, tool_mapping) exposing memory recall to Gemini Live."""
        tool_prompts = PROMPTS["memory_tools"]
        timeline_decl = types.FunctionDeclaration(
            name="get_memory_timeline",
            description=tool_prompts["get_memory_timeline"]["description"],
            parameters=types.Schema(
                type=types.Type.OBJECT,
                properties={
                    "limit": types.Schema(
                        type=types.Type.INTEGER,
                        description=tool_prompts["get_memory_timeline"]["param_limit_description"],
                    ),
                },
            ),
        )
        observations_decl = types.FunctionDeclaration(
            name="get_memory_observations",
            description=tool_prompts["get_memory_observations"]["description"],
            parameters=types.Schema(
                type=types.Type.OBJECT,
                properties={
                    "ids": types.Schema(
                        type=types.Type.ARRAY,
                        items=types.Schema(type=types.Type.INTEGER),
                        description=tool_prompts["get_memory_observations"]["param_ids_description"],
                    ),
                },
                required=["ids"],
            ),
        )
        tools = [types.Tool(function_declarations=[timeline_decl, observations_decl])]
        mapping = {
            "get_memory_timeline": self._tool_get_timeline,
            "get_memory_observations": self._tool_get_observations,
        }
        return tools, mapping

    async def _tool_get_timeline(self, limit=1000):
        try:
            limit = int(limit)
        except (ValueError, TypeError):
            limit = 1000
        return await self.fetch_timeline(limit=limit)

    async def _tool_get_observations(self, ids=None):
        return await self.fetch_observations(ids)

    @staticmethod
    def _mcp_text(data):
        """Pull the text payload out of an MCP-style {content:[{text}]} response."""
        if isinstance(data, dict):
            content = data.get("content")
            if isinstance(content, list) and content:
                return content[0].get("text", "") or ""
        return ""

    @staticmethod
    def _format_observations(items):
        lines = []
        for obs in items:
            lines.append(
                f"#{obs.get('id')} [{obs.get('type', '')}] "
                f"{obs.get('title') or '(untitled)'}"
            )
            subtitle = obs.get("subtitle")
            if subtitle:
                lines.append(f"  {subtitle}")
            facts = obs.get("facts")
            if facts:
                try:
                    for fact in json.loads(facts):
                        lines.append(f"  - {fact}")
                except (json.JSONDecodeError, TypeError):
                    pass
        return "\n".join(lines) if lines else "No matching observations found."

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

    async def _complete_session(self):
        await self._post(
            "/api/sessions/complete",
            {
                "contentSessionId": self.content_session_id,
                "platformSource": PLATFORM_SOURCE,
            },
        )

    async def _get_json(self, path, params=None):
        """GET JSON from the worker, swallowing every error (returns None)."""
        try:
            response = await self._client.get(f"{self.worker_url}{path}", params=params)
            if response.status_code >= 400:
                logger.warning(f"claude-mem {path} -> {response.status_code}: {response.text[:200]}")
                return None
            return response.json()
        except Exception as e:
            logger.debug(f"claude-mem GET {path} failed: {e}")
            return None

    async def _post_json(self, path, body):
        """POST JSON to the worker and return the parsed response (or None)."""
        try:
            response = await self._client.post(f"{self.worker_url}{path}", json=body)
            if response.status_code >= 400:
                logger.warning(f"claude-mem {path} -> {response.status_code}: {response.text[:200]}")
                return None
            return response.json()
        except Exception as e:
            logger.debug(f"claude-mem POST {path} failed: {e}")
            return None

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
