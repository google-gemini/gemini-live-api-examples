import asyncio
import base64
import json
import logging
import os

from dotenv import load_dotenv
from fastapi import FastAPI, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from gemini_live import GeminiLive
from prompts import PROMPTS
from twilio_handler import TwilioHandler

# Load environment variables
load_dotenv()

# Configure logging - DEBUG for our modules, INFO for everything else
logging.basicConfig(level=logging.INFO)
logging.getLogger("gemini_live").setLevel(logging.DEBUG)
logging.getLogger(__name__).setLevel(logging.DEBUG)
logger = logging.getLogger(__name__)

# Configuration
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
MODEL = os.getenv("MODEL", "gemini-3.1-flash-live-preview")

# Twilio config (optional — only needed for phone call integration)
TWILIO_ACCOUNT_SID = os.getenv("TWILIO_ACCOUNT_SID")
TWILIO_AUTH_TOKEN = os.getenv("TWILIO_AUTH_TOKEN")
TWILIO_APP_HOST = os.getenv("TWILIO_APP_HOST")

# Initialize FastAPI
app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve static files
app.mount("/static", StaticFiles(directory="frontend"), name="static")


@app.get("/")
async def root():
    return FileResponse("frontend/index.html")


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """WebSocket endpoint for Gemini Live."""
    await websocket.accept()

    logger.info("WebSocket connection accepted")

    # BYO key: the visitor's Gemini API key arrives as the FIRST WebSocket frame
    # ({"type":"setup","api_key":"..."}). It is mandatory — the public demo never
    # uses a server key for the live session or the memory observations. We read
    # it as a body frame (not a query param) so the key never lands in access logs.
    try:
        setup_message = await websocket.receive()
    except (WebSocketDisconnect, RuntimeError):
        return
    setup_text = setup_message.get("text") if isinstance(setup_message, dict) else None
    visitor_api_key = ""
    if setup_text:
        try:
            setup_payload = json.loads(setup_text)
            if isinstance(setup_payload, dict) and setup_payload.get("type") == "setup":
                visitor_api_key = (setup_payload.get("api_key") or "").strip()
        except json.JSONDecodeError:
            pass
    if not visitor_api_key:
        await websocket.send_json({
            "type": "error",
            "error": "A Gemini API key is required. Paste your key to start a session.",
        })
        await websocket.close()
        return

    audio_input_queue = asyncio.Queue()
    video_input_queue = asyncio.Queue()
    text_input_queue = asyncio.Queue()
    client_disconnected = asyncio.Event()

    async def audio_output_callback(data):
        if client_disconnected.is_set():
            raise asyncio.CancelledError()
        try:
            await websocket.send_bytes(data)
        except (WebSocketDisconnect, RuntimeError) as e:
            client_disconnected.set()
            logger.info(f"WebSocket audio send stopped after client disconnect: {e}")
            raise asyncio.CancelledError()

    async def audio_interrupt_callback():
        # The event queue handles the JSON message, but we might want to do something else here
        pass

    gemini_client = GeminiLive(
        api_key=visitor_api_key, model=MODEL, input_sample_rate=16000
    )

    async def receive_from_client():
        try:
            while True:
                message = await websocket.receive()

                if message.get("type") == "websocket.disconnect":
                    logger.info("WebSocket disconnected")
                    return

                if message.get("bytes"):
                    await audio_input_queue.put(message["bytes"])
                elif message.get("text"):
                    text = message["text"]
                    try:
                        payload = json.loads(text)
                        if isinstance(payload, dict) and payload.get("type") == "image":
                            logger.info(f"Received image chunk from client: {len(payload['data'])} base64 chars")
                            image_data = base64.b64decode(payload["data"])
                            await video_input_queue.put(image_data)
                            continue
                    except json.JSONDecodeError:
                        pass

                    await text_input_queue.put(text)
        except WebSocketDisconnect:
            logger.info("WebSocket disconnected")
        except RuntimeError as e:
            if "disconnect message" in str(e):
                logger.info("WebSocket disconnected")
            else:
                logger.error(f"Error receiving from client: {e}")
        except Exception as e:
            logger.error(f"Error receiving from client: {e}")
        finally:
            client_disconnected.set()

    async def run_session():
        async for event in gemini_client.start_session(
            audio_input_queue=audio_input_queue,
            video_input_queue=video_input_queue,
            text_input_queue=text_input_queue,
            audio_output_callback=audio_output_callback,
            audio_interrupt_callback=audio_interrupt_callback,
        ):
            if event:
                if client_disconnected.is_set():
                    break
                # Forward events (transcriptions, etc) to client
                try:
                    await websocket.send_json(event)
                except (WebSocketDisconnect, RuntimeError) as e:
                    client_disconnected.set()
                    logger.info(f"WebSocket JSON send stopped after client disconnect: {e}")
                    break

    receive_task = asyncio.create_task(receive_from_client())
    session_task = asyncio.create_task(run_session())

    try:
        done, pending = await asyncio.wait(
            {receive_task, session_task},
            return_when=asyncio.FIRST_COMPLETED,
        )
        for task in done:
            if task.cancelled():
                continue
            exc = task.exception()
            if exc:
                raise exc
    except Exception as e:
        import traceback
        logger.error(f"Error in Gemini session: {type(e).__name__}: {e}\n{traceback.format_exc()}")
        # BYO key: surface the failure to the visitor instead of a silent dead
        # session. The most common cause is a key that passes the REST API but
        # lacks Gemini Live access (obs 87664). Best-effort — skip if the client
        # already went away.
        if not client_disconnected.is_set():
            try:
                await websocket.send_json({
                    "type": "error",
                    "error": "The live session failed to start. Your API key may not have Gemini Live access — try a different key.",
                })
            except Exception:
                pass
    finally:
        client_disconnected.set()
        for task in (receive_task, session_task):
            if not task.done():
                task.cancel()
        await asyncio.gather(receive_task, session_task, return_exceptions=True)
        # Ensure websocket is closed if not already
        try:
            await websocket.close()
        except Exception:
            pass


# ─── Twilio Endpoints ─────────────────────────────────────────────────────────

@app.post("/twilio/inbound")
async def twilio_inbound():
    """Handles inbound Twilio calls. Returns TwiML to open a media stream."""
    host = TWILIO_APP_HOST or "localhost:8000"
    twiml = f"""<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say>{PROMPTS["telephony"]["connect_say"]}</Say>
    <Connect>
        <Stream url="wss://{host}/twilio/stream" />
    </Connect>
</Response>"""
    return Response(content=twiml, media_type="application/xml")


@app.post("/twilio/outbound")
async def twilio_outbound(
    to_number: str = Query(..., description="Destination phone number (E.164 format)"),
    from_number: str = Query(..., description="Your Twilio phone number (E.164 format)"),
):
    """Initiates an outbound Twilio call that connects to Gemini Live."""
    if not TWILIO_ACCOUNT_SID or not TWILIO_AUTH_TOKEN:
        return {"error": "TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set in environment"}
    if not TWILIO_APP_HOST:
        return {"error": "TWILIO_APP_HOST must be set in environment"}

    from twilio.rest import Client as TwilioClient

    client = TwilioClient(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    twiml = f"""<Response>
    <Say>{PROMPTS["telephony"]["connect_say"]}</Say>
    <Connect>
        <Stream url="wss://{TWILIO_APP_HOST}/twilio/stream" />
    </Connect>
</Response>"""

    call = client.calls.create(
        to=to_number,
        from_=from_number,
        twiml=twiml,
    )
    logger.info(f"Outbound call initiated: {call.sid}")
    return {"callSid": call.sid, "status": call.status}


@app.websocket("/twilio/stream")
async def twilio_stream(websocket: WebSocket):
    """WebSocket endpoint for Twilio Media Streams."""
    await websocket.accept()
    logger.info("Twilio media stream WebSocket connected")

    handler = TwilioHandler(gemini_api_key=GEMINI_API_KEY, model=MODEL)
    try:
        await handler.handle_media_stream(websocket)
    except Exception as e:
        logger.error(f"Twilio stream error: {e}", exc_info=True)
    finally:
        try:
            await websocket.close()
        except Exception:
            pass
        logger.info("Twilio media stream WebSocket closed")


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)
