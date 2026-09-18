import assert from "node:assert/strict";
import test from "node:test";

import { GeminiLiveTranslateSocket } from "../src/gemini-live-socket.mjs";

class FakeSocket {
  static OPEN = 1;
  constructor(url) {
    this.url = url;
    this.readyState = FakeSocket.OPEN;
    this.handlers = new Map();
    this.sent = [];
  }
  on(event, handler) { this.handlers.set(event, handler); }
  emit(event, ...data) { this.handlers.get(event)?.(...data); }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; }
}

test("Gemini socket sends a fresh ZDR setup and streams audio", () => {
  const sockets = [];
  const audio = [];
  const lifecycle = [];
  const client = new GeminiLiveTranslateSocket({
    apiKey: "test-only-key",
    meetingId: "meeting-1",
    targetLanguage: "ko",
    glossary: [{ source: "入館証", target: "출입증" }],
    socketFactory(url) {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    openState: FakeSocket.OPEN,
    onTranslatedAudio(value) { audio.push(value); },
    onSetupComplete() { lifecycle.push("setup"); },
    onGenerationComplete() { lifecycle.push("generation"); },
    onTurnComplete() { lifecycle.push("turn"); },
  });

  client.connect();
  const socket = sockets[0];
  socket.emit("open");
  assert.equal("sessionResumption" in socket.sent[0].setup, false);
  assert.match(socket.sent[0].setup.systemInstruction.parts[0].text, /入館証 => 출입증/);
  socket.emit("message", JSON.stringify({ setupComplete: {} }));
  assert.equal(client.sendPcm16(Buffer.from([1, 2, 3, 4]), 48_000), true);
  assert.equal(client.sendAudioStreamEnd(), true);

  socket.emit("message", JSON.stringify({
    serverContent: {
      modelTurn: { parts: [{ inlineData: { data: "translated-pcm" } }] },
      generationComplete: true,
      turnComplete: true,
    },
  }));
  assert.deepEqual(audio, ["translated-pcm"]);
  assert.deepEqual(lifecycle, ["setup", "generation", "turn"]);
});

test("closure is surfaced for bridge-level fresh-session recovery", () => {
  let closed;
  const socket = new FakeSocket("unused");
  const client = new GeminiLiveTranslateSocket({
    apiKey: "test-only-key",
    meetingId: "meeting-1",
    targetLanguage: "ja",
    socketFactory: () => socket,
    onClose(code, reason) { closed = { code, reason: String(reason) }; },
  });
  client.connect();
  socket.emit("open");
  socket.emit("close", 1011, "provider unavailable");
  assert.deepEqual(closed, { code: 1011, reason: "provider unavailable" });
});

test("goAway remaining time is surfaced in milliseconds before provider closure", () => {
  const events = [];
  const socket = new FakeSocket("unused");
  const client = new GeminiLiveTranslateSocket({
    apiKey: "test-only-key",
    meetingId: "meeting-1",
    targetLanguage: "ja",
    socketFactory: () => socket,
    onServerEvent(event) { events.push(event); },
  });
  client.connect();
  socket.emit("open");
  socket.emit("message", JSON.stringify({ goAway: { timeLeft: "0.45s" } }));

  assert.deepEqual(events, [{ goAway: true, timeLeftMilliseconds: 450 }]);
});

test("events from a closed socket cannot contaminate a fresh connection", () => {
  const sockets = [];
  const audio = [];
  const client = new GeminiLiveTranslateSocket({
    apiKey: "test-only-key",
    meetingId: "meeting-1",
    targetLanguage: "ko",
    socketFactory(url) {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    onTranslatedAudio(value) { audio.push(value); },
  });
  client.connect();
  const stale = sockets[0];
  client.close();
  client.connect();
  stale.emit("open");
  stale.emit("message", JSON.stringify({ serverContent: {
    modelTurn: { parts: [{ inlineData: { data: "stale-audio" } }] },
  } }));
  assert.equal(stale.sent.length, 0);
  assert.deepEqual(audio, []);
});

test("canary-only transcription stays in callback memory and is absent from normal setup", () => {
  const input = [];
  const output = [];
  const socket = new FakeSocket("unused");
  const client = new GeminiLiveTranslateSocket({
    apiKey: "test-only-key",
    meetingId: "meeting-1",
    targetLanguage: "ja",
    canaryTranscription: true,
    socketFactory: () => socket,
    onInputTranscription(value) { input.push(value); },
    onOutputTranscription(value) { output.push(value); },
  });
  client.connect();
  socket.emit("open");
  assert.deepEqual(socket.sent[0].setup.inputAudioTranscription, {});
  assert.deepEqual(socket.sent[0].setup.outputAudioTranscription, {});

  socket.emit("message", JSON.stringify({ serverContent: {
    inputTranscription: { text: "memory input" },
    outputTranscription: { text: "memory output" },
  } }));
  assert.deepEqual(input, ["memory input"]);
  assert.deepEqual(output, ["memory output"]);
});
