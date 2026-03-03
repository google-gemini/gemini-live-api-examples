# Gemini Live API – Command Line (Node.js)

A minimal command-line app that streams microphone audio to the Gemini Live API and plays back the response in real time. This example is intended for local testing only, not for production use cases.

> **Note:** Use headphones. This script uses the system default audio input and output, which often won't include echo cancellation. To prevent the model from interrupting itself, use headphones.

## Prerequisites

- Node.js 20+
- A Gemini API key ([get one here](https://aistudio.google.com/apikey))
- SoX (`brew install sox` on macOS) — required by the `mic` package

## Setup

Install helpers for audio streaming. Additional system-level dependencies might be required (`sox` for Mac/Windows or ALSA for Linux). Refer to the [speaker](https://www.npmjs.com/package/speaker) and [mic](https://www.npmjs.com/package/mic) docs for detailed installation steps.

```bash
npm install @google/genai mic speaker
```

## Run

```bash
export GEMINI_API_KEY="your-api-key"
npx tsx main.mts
```

You should see **"Connected to Gemini Live API"** and **"Microphone started. Speak now..."** — talk into your mic and Gemini will respond with audio. Press `Ctrl+C` to quit.
