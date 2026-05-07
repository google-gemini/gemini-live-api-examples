# GoogLive — Multimodal AI-Led Interview Platform

GoogLive is a full-stack React + TypeScript web application that showcases the cutting-edge capabilities of **Gemini Multimodal Live API**. It is designed to conduct natural, low-latency, conversational user interviews, job mock interviews, and children's tutoring sessions, incorporating advanced client-side media orchestration and post-session structured REST analysis.

![React Frontend](https://img.shields.io/badge/Frontend-React%20%2B%20TypeScript%20%2B%20Tailwind-blue)
![Backend Protocol](https://img.shields.io/badge/Protocol-Stateful%20WebSocket%20(WSS)-green)
![Model Compatibility](https://img.shields.io/badge/Model-Gemini%202.5%20Live%20%26%202.0%20REST-purple)

---

## 🚀 Key Engineering Highlights

This project represents a state-of-the-art implementation of Gemini Live, addressing the core challenges of real-time audio/video applications:

### 1. Thread-Isolated Audio Capture (`AudioWorkletNode`)
* **The Problem:** Traditional voice capture relies on `ScriptProcessorNode`, which runs on the browser's Main UI Thread. Heavy React rendering or CSS animations can interrupt input streams, creating audio stutters.
* **The Solution:** Captured voice is routed to a modern **AudioWorkletNode** running inside a dedicated background audio worker thread. PCM downsampling from Float32 (browser native) to 16kHz monophonic Int16 (Gemini native) occurs in complete thread-isolation, keeping the UI 100% responsive.

### 2. Client-Side Voice Activity Detection (VAD) for 0ms Barge-In
* **The Problem:** Waiting for the Gemini Live server to process user speech and return a `content.interrupted` signal creates a 200ms–500ms network roundtrip lag, during which the model continues speaking.
* **The Solution:** The background AudioWorklet computes the **Root Mean Square (RMS) amplitude** of user mic input. If active speech energy is detected locally (threshold `0.015` for ~100ms), the worklet signals the main thread to **instantly silence model playback locally (0ms reaction)**.

### 3. Asynchronous Canvas Capture Loop
* **The Problem:** Pushing video frames at 1-FPS using synchronous `canvas.toDataURL()` blocks the UI thread during JPEG compression, creating micro-jank.
* **The Solution:** Frames are scaled (max 640px) and drawn onto a persistent, cached `<canvas>` instance to avoid memory allocations. Compression is converted to asynchronous `canvas.toBlob` and `FileReader` streams, letting browser background tasks manage JPEG rendering.

### 4. Local Media Recording & Web Audio Mixing
* **The Solution:** Both the user's microphone input and Gemini's output streams are routed and mixed inside a custom `MediaStreamAudioDestinationNode`. The combined audio track is bundled with the camera video track into a single, high-quality, perfectly synchronized `.webm` file recorded client-side.

### 5. Stateful Reconnections & Exponential Backoff
* **The Solution:** The client tracks explicit disconnects and network drops. In case of network failures, it initiates an **Exponential Backoff Reconnection State Machine** (up to 3 attempts) to seamlessly reconstruct the conversation flow.

### 6. Dual-Modality REST Analysis
* **The Solution:** As the live voice WebSocket ends, the compiled transcript is securely dispatched to `gemini-2.0-flash` REST API with `responseMimeType: "application/json"` to synthesize a structured JSON report containing key insights, customer sentiment, satisfaction scores, and question-to-answer maps.

---

## 🛠️ Local Setup & Run Guide

Follow these steps to run this example locally in your development environment:

### Prerequisites
Ensure you have [Node.js (v18+)](https://nodejs.org/) or [Bun](https://bun.sh/) installed on your machine.

### 1. Install Dependencies
In the project folder, run:
```bash
npm install
# or using bun
bun install
```

### 2. Add API Key
Open your browser and navigate to the local application Settings once started to paste your Gemini API Key.

### 3. Start the Development Server
Start the local Vite dev server:
```bash
npm run dev
# or using bun
bun run dev
```

The server will start locally, typically at **[http://localhost:8080/](http://localhost:8080/)**.

---

## 📖 Developer & Architecture Guide (Google Cloud Medium Publication)
For a comprehensive deep-dive walkthrough of the entire codebase, client-side media orchestration, design patterns, Web Audio graphs, and secure Node.js proxy setups, read the official developer article on **Google Cloud** publication:
👉 **[Building the Ultimate Real-Time AI Interviewer with Gemini Live WebSocket API](https://medium.com/google-cloud/05c7a4d5355a)**
