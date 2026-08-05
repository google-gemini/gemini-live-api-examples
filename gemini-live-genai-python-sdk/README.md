# Gemini Live API - Python SDK & Vanilla JS

A demonstration of the Gemini Live API using the [Google Gen AI Python SDK](https://github.com/googleapis/python-genai) for the backend and vanilla JavaScript for the frontend. This example shows how to build a real-time multimodal application with a robust Python backend handling the API connection.

## Quick Start

### 1. Backend Setup

Install dependencies and start the FastAPI server using `uv`:

```bash
# Create a virtual environment and install dependencies
uv venv
source .venv/bin/activate
uv pip install -r requirements.txt

# Start the server
uv run main.py
```

### 2. Frontend

Open your browser and navigate to:

[http://localhost:8000](http://localhost:8000)

## Features

- **Google Gen AI SDK**: Uses the official Python SDK (`google-genai`) for simplified API interaction.
- **FastAPI Backend**: Robust, async-ready web server handling WebSocket connections.
- **Real-time Streaming**: Bi-directional audio and video streaming.
- **Tool Use**: Demonstrates how to register and handle server-side tools.
- **Async Reasoning & Interaction Status**: Manages `interaction_status` (`IN_PROGRESS`, `REQUIRES_ACTION`) for models with asynchronous reasoning (e.g., clever-chatter).
- **Vanilla JS Frontend**: Lightweight frontend with no build steps or framework dependencies.

## Project Structure

```
/
├── main.py             # FastAPI server & WebSocket endpoint
├── gemini_live.py      # Gemini Live API wrapper using Gen AI SDK
├── requirements.txt    # Python dependencies
└── frontend/
    ├── index.html      # User Interface
    ├── main.js         # Application logic
    ├── gemini-client.js # WebSocket client for backend communication
    ├── media-handler.js # Audio/Video capture and playback
    └── pcm-processor.js # AudioWorklet for PCM processing
```

## Configuration

You can configure the application by setting environment variables or by using a `.env` file.

**Important:** You must set the `GEMINI_API_KEY` to your Google AI Studio API key.

1.  Create a `.env` file in the root directory.
2.  Add your API key:

```env
GEMINI_API_KEY=your_api_key_here
```

Alternatively, you can set it in your shell:

```bash
export GEMINI_API_KEY=your_api_key_here
```

## Core Components

### Backend (`gemini_live.py`)

The `GeminiLive` class wraps the `genai.Client` to manage the session:

```python
# Connects using the SDK
async with self.client.aio.live.connect(model=self.model, config=config) as session:
    # Manages input/output queues
    await asyncio.gather(
        send_audio(),
        send_video(),
        receive_responses()
    )
```

### Frontend (`gemini-client.js`)

The frontend communicates with the FastAPI backend via WebSockets, sending base64-encoded media chunks and receiving audio responses.

## Interaction Status & State Management (EAP)

When working with models that use background/asynchronous reasoning (such as `clever-chatter`), `turn_complete: true` is no longer a reliable indicator that the model has finished its turn.

Instead, monitor `server_content.interaction_status`:

- **`IN_PROGRESS`**: The server is actively processing user input or performing background reasoning. Further model output (audio frames, transcriptions, or tool calls) may follow.
- **`REQUIRES_ACTION`**: The server has completed processing and reasoning. The session is idle and awaiting user input.

