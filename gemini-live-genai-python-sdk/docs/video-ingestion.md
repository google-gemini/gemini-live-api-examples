# Video Ingestion — How to Run and Test

How the app captures video (camera or screen) in the browser and streams it into
the Gemini Live session, and how to verify each hop is working.

## What "video ingestion" means here

The frontend grabs frames from your **camera** or a **shared screen**, encodes each
as a JPEG, and sends them to the backend over the same `/ws` WebSocket used for
audio and text. The backend forwards each frame to Gemini as realtime video input,
so the model can "see" what you show it and talk about it.

Frames are **not** stored locally and are **not** sent to claude-mem — only the
conversation transcript is (see [Relationship to claude-mem](#relationship-to-claude-mem-ingestion)).

## The pipeline (exact path)

```
[camera / screen]
   │  navigator.mediaDevices.getUserMedia({video:true})        media-handler.js:86  (camera)
   │  navigator.mediaDevices.getDisplayMedia({video:true})     media-handler.js:102 (screen)
   ▼
captureFrame()  — every 1000 ms (1 FPS)                        media-handler.js:91,113,136
   │  draw to 640×480 canvas, toDataURL("image/jpeg", 0.7)     media-handler.js:138-141
   ▼
GeminiClient.sendImage(base64)                                 main.js:153,183 → gemini-client.js:47
   │  WS text frame: {"type":"image","mime_type":"image/jpeg","data":"<base64>"}
   ▼
server receive_from_client()                                   main.py:82-90
   │  json parse → base64 decode → video_input_queue.put(bytes)
   │  logs: "Received image chunk from client: N base64 chars"
   ▼
GeminiLive.send_video()                                        gemini_live.py:68-79
   │  session.send_realtime_input(video=Blob(data, "image/jpeg"))
   │  logs: "Sending video frame to Gemini: N bytes"
   ▼
[ Gemini Live model ]  →  spoken/transcribed response about what it sees
```

Frame specs (in `captureFrame`, `media-handler.js:136-143`): **640×480**, **JPEG quality 0.7**, **1 frame/second**. The 1 FPS rate is intentional (keeps token/cost low); it is not real-time motion.

## Prerequisites

- A `GEMINI_API_KEY` (Google AI Studio). Set in `.env` or the shell — see the
  [README](../README.md#configuration).
- A **vision-capable** live model. Default `MODEL=gemini-3.1-flash-live-preview`
  (set in `main.py:26`) supports image input.
- A browser with camera/screen permission (Chrome recommended for `getDisplayMedia`).
- **Secure context**: `getUserMedia`/`getDisplayMedia` only work over HTTPS *or* on
  `localhost`. `http://localhost:8000` is fine; visiting via a LAN IP like
  `http://192.168.x.x:8000` will silently fail camera access.

## Run it

```bash
cd gemini-live-genai-python-sdk

# one-time setup
uv venv && source .venv/bin/activate
uv pip install -r requirements.txt

# start the server (INFO logging; gemini_live + main are DEBUG)
uv run main.py
```

Then open <http://localhost:8000> and click **Connect**.

## Test the camera

1. Click **Connect**, then **Start Mic** (so you can ask questions by voice — or use
   the text box).
2. Click **Start Camera**. Approve the browser permission prompt. The live preview
   should appear and the placeholder disappears (`main.js:137-163`).
3. Hold an object up to the camera and ask: *"What am I holding?"* (voice or text).
4. Gemini should describe it — audio plays back and the transcript appears in the
   chat log.
5. Click **Stop Camera** to end the video stream (audio/session stay open).

## Test screen share

1. While connected, click **Share Screen** and pick a window/tab/display
   (`main.js:165-199` → `media-handler.js:100`).
2. Ask: *"What's on my screen?"*
3. Gemini describes the shared content.
4. Stop via the **Stop Sharing** button or the browser's native "Stop sharing"
   control — the `onended` handler resets the UI (`media-handler.js:108-111`,
   `main.js:186-190`).

> Camera and screen are mutually exclusive: starting one stops the other
> (`main.js:144-148, 172-176`).

## Verify each hop

Run the server in one terminal and watch its logs while you exercise the UI.

**1. Frames leave the browser** — DevTools Console/Network: no errors; the WS
connection shows outgoing text frames ~once per second when camera/screen is on.

**2. Frames reach the server** — server log prints once per frame:

```
INFO ... Received image chunk from client: <N> base64 chars
```

(emitted at `main.py:87`)

**3. Frames are forwarded to Gemini** — server log prints once per frame:

```
INFO gemini_live Sending video frame to Gemini: <N> bytes
```

(emitted at `gemini_live.py:72`)

To isolate these two lines:

```bash
uv run main.py 2>&1 | grep -E "Received image chunk|Sending video frame"
```

Seeing both lines tick ~1×/second confirms the full ingestion path. Each
"Received … base64 chars" is roughly 1.33× the corresponding "Sending … bytes"
(base64 overhead), which is a quick sanity check that decoding worked.

**4. The model actually used the frame** — behavioral: Gemini's answer references
what you showed. This is the real end-to-end proof; the logs only prove transport.

## Relationship to claude-mem ingestion

The claude-mem integration (`claude_mem_sink.py`) ingests the **conversation
transcript and tool calls**, not raw video frames. So when you show Gemini
something and it answers, Gemini's transcribed description is captured as a
`gemini` turn and flows into claude-mem like any other turn.

To test that path, run the app (the memory sink is always on) and converse over video:

```bash
CLAUDE_MEM_PROJECT=gemini-live-mem uv run main.py
```

After a turn completes, the model's spoken description of the video appears as a
claude-mem observation under the configured project. (Search via the claude-mem
tools / `get_observations`.) Raw frames are never written to memory.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Permission prompt never appears / "Could not access camera" | Page not in a secure context — use `http://localhost:8000`, not a LAN IP. |
| Preview shows but no "Received image chunk" logs | WebSocket not open when frames fire; click **Connect** before **Start Camera** (`isConnected()` gate, `main.js:152`). |
| "Received image chunk" logs but no "Sending video frame" | The `send_video` task isn't draining the queue — check for a `send_video error` traceback in logs (`gemini_live.py:78`). |
| Frames flow but Gemini ignores the video | Model isn't vision-capable — confirm `MODEL` is a vision-capable live model (`main.py:26`). |
| Black/blank frames | The `<video>` element hadn't rendered a frame yet when `captureFrame` ran; give it a second after starting. |
| Want higher frame rate / resolution | Adjust the `setInterval` 1000 ms and the `640×480` / `0.7` quality in `media-handler.js:91,113,136-141`. Higher values increase token cost. |
```
