# Gemini Live API – Command Line (Python)

A minimal command-line app that streams microphone audio to the Gemini Live API and plays back the response in real time.

> **Note:** Use headphones. This script uses the system default audio input and output, which often won't include echo cancellation. To prevent the model from interrupting itself, use headphones.

## Prerequisites

- Python 3.11+
- [uv](https://docs.astral.sh/uv/getting-started/installation/)
- A Gemini API key ([get one here](https://aistudio.google.com/apikey))
- PortAudio (`brew install portaudio` on macOS)

## Setup

```bash
# Create a virtual environment and activate it
uv venv
source .venv/bin/activate

# Install dependencies
  uv pip install google-genai pyaudio
```

## Run

```bash
export GEMINI_API_KEY="your-api-key"
python main.py
```

You should see **"Connected to Gemini. Start speaking!"** — talk into your mic and Gemini will respond with audio. Press `Ctrl+C` to quit.
