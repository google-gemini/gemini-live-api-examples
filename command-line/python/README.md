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

## Real-time Audio Stream Translation

A CLI script to translate any remote audio stream URL in real-time.

### Run Translation Script

```bash
python translate.py --target es
```

- `--url`: The audio stream URL you want to translate (defaults to a sample WAV audio file: `https://storage.googleapis.com/generativeai-downloads/gemini-cookbook/audio/gemini-live-translate-sample.wav`).
- `--target`: The target translation language code (e.g., `es` for Spanish, `fr` for French, `pl` for Polish). Defaults to `es`.
- `--original-volume`: Volume level for playing the original speaker's audio in the background (float from `0.0` to `1.0`, defaults to `0.08` or 8% volume). Set to `0.0` to disable background playback.

The script will stream the audio, play the original speaker softly in the background, print both the source and translated transcripts with their language codes (e.g., `[Source (en)]` / `[Translation (es)]`), and play the translated audio stream in real-time.

