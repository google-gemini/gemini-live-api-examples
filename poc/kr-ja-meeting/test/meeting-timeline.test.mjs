import assert from "node:assert/strict";
import test from "node:test";

import { BrowserMeetingService } from "../src/browser-meeting-service.mjs";
import { GeminiLiveTranslateSocket } from "../src/gemini-live-socket.mjs";
import { MeetingEventRecorder } from "../src/meeting-event-recorder.mjs";
import { LiveTranslationBridge } from "../src/live-translation-bridge.mjs";

class FakeSocket {
  static OPEN = 1;
  handlers = new Map();
  readyState = FakeSocket.OPEN;
  sent = [];
  on(type, handler) { this.handlers.set(type, handler); }
  emit(type, ...args) { this.handlers.get(type)?.(...args); }
  send(payload) { this.sent.push(JSON.parse(payload)); }
  close() { this.readyState = 3; }
}

async function waitFor(check) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition was not reached");
}

function timelineService({ bridge, overlapWarningMilliseconds } = {}) {
  let participantSequence = 0;
  let utteranceSequence = 0;
  let now = 0;
  const events = [];
  const recorder = new MeetingEventRecorder({
    meetingId: "meeting-1",
    clock: () => now,
    write(event) { events.push(event); },
  });
  const translationBridge = bridge ?? {
    async start() {},
    async stop() {},
    async handoff() {},
  };
  const service = new BrowserMeetingService({
    roomName: "meeting-1",
    livekitUrl: "ws://127.0.0.1:7880",
    participantIdFactory: () => `participant-${++participantSequence}`,
    utteranceIdFactory: () => `utterance-${++utteranceSequence}`,
    tokenIssuer: async ({ id }) => `token:${id}`,
    translationBridge,
    eventRecorder: recorder,
    overlapWarningMilliseconds,
    clock: () => now,
  });
  return { service, events, setNow(value) { now = value; } };
}

test("normal speech is correlated from join through completed utterance and cleanup", async () => {
  const { service, events, setNow } = timelineService();
  const speaker = (await service.join({ name: "Yuki", language: "ja" })).participant;
  await service.mic(speaker.id, true);
  setNow(100);
  await service.speechActivity({ participantId: speaker.id, type: "speech-start", observedAt: 100 });
  setNow(300);
  await service.speechActivity({ participantId: speaker.id, type: "speech-end", observedAt: 300 });
  setNow(400);
  await service.leave(speaker.id);

  assert.deepEqual(events.map(({ type }) => type), [
    "meeting-joined",
    "microphone-enabled",
    "speech-started",
    "translation-focus-selected",
    "speech-ended",
    "translation-focus-cleared",
    "utterance-completed",
    "meeting-left",
    "resources-closed",
  ]);
  for (const event of events.slice(0, -2)) {
    assert.equal(event.participantId, speaker.id);
    assert.equal(event.language, "ja");
  }
  const utteranceEvents = events.filter(({ utteranceId }) => utteranceId);
  assert.ok(utteranceEvents.length >= 3);
  assert.ok(utteranceEvents.every(({ utteranceId }) => utteranceId === "utterance-1"));
  assert.equal(events.find(({ type }) => type === "utterance-completed").result, "completed");
});

test("overlap warning and focus handoff retain participant and utterance correlation", async () => {
  const { service, events, setNow } = timelineService({
    overlapWarningMilliseconds: 1_000,
  });
  const first = (await service.join({ name: "Yuki", language: "ja" })).participant;
  const second = (await service.join({ name: "민준", language: "ko" })).participant;
  await service.mic(first.id, true);
  await service.mic(second.id, true);
  await service.speechActivity({ participantId: first.id, type: "speech-start", observedAt: 0 });
  setNow(100);
  await service.speechActivity({ participantId: second.id, type: "speech-start", observedAt: 100 });
  setNow(1_200);
  await service.speechActivity({ participantId: first.id, type: "speech-end", observedAt: 1_200 });
  setNow(1_400);
  await service.speechActivity({ participantId: second.id, type: "speech-end", observedAt: 1_400 });

  assert.deepEqual(events.filter(({ type }) => type.startsWith("overlap-")).map(({ type }) => type), [
    "overlap-started",
    "overlap-detected",
    "overlap-ended",
  ]);
  assert.deepEqual(
    events.find(({ type }) => type === "translation-focus-changed"),
    {
      type: "translation-focus-changed",
      meetingId: "meeting-1",
      participantId: second.id,
      utteranceId: "utterance-2",
      language: "ko",
      relatedParticipantId: first.id,
      timestamp: 1_200,
      result: "selected",
    },
  );
  assert.deepEqual(
    events.filter(({ participantId, type }) =>
      participantId === second.id && ["speech-ended", "utterance-completed"].includes(type))
      .map(({ type, utteranceId }) => ({ type, utteranceId })),
    [
      { type: "speech-ended", utteranceId: "utterance-2" },
      { type: "utterance-completed", utteranceId: "utterance-2" },
    ],
  );
});

test("overlap detection is emitted once when a server-clock snapshot crosses the threshold", async () => {
  const { service, events, setNow } = timelineService({ overlapWarningMilliseconds: 1_000 });
  const first = (await service.join({ name: "Yuki", language: "ja" })).participant;
  const second = (await service.join({ name: "Sora", language: "ja" })).participant;
  await service.mic(first.id, true);
  await service.mic(second.id, true);
  await service.speechActivity({ participantId: first.id, type: "speech-start", observedAt: 10 });
  setNow(100);
  await service.speechActivity({ participantId: second.id, type: "speech-start", observedAt: 20 });

  setNow(1_099);
  service.snapshot();
  assert.equal(events.filter(({ type }) => type === "overlap-detected").length, 0);
  setNow(1_100);
  service.snapshot();
  service.snapshot();

  assert.deepEqual(events.filter(({ type }) => type === "overlap-detected"), [{
    type: "overlap-detected",
    meetingId: "meeting-1",
    participantId: second.id,
    utteranceId: "utterance-2",
    language: "ja",
    targetLanguage: "ko",
    detectedAt: 1_100,
    result: "warning",
    timestamp: 1_100,
  }]);
});

test("listener mode and applied gains are recorded without audio content", async () => {
  const { service, events } = timelineService();
  const speaker = (await service.join({ name: "Yuki", language: "ja" })).participant;
  const listener = (await service.join({ name: "민준", language: "ko" })).participant;
  await service.mic(speaker.id, true);
  await service.speechActivity({ participantId: speaker.id, type: "speech-start", observedAt: 0 });
  await service.listeningMode(listener.id, "translation-only");

  assert.deepEqual(
    events.filter(({ type, participantId }) =>
      participantId === listener.id && ["listening-mode-changed", "listening-gain-applied"].includes(type)),
    [
      {
        type: "listening-gain-applied",
        meetingId: "meeting-1",
        participantId: listener.id,
        utteranceId: "utterance-1",
        language: "ko",
        listeningMode: "translation-focused",
        trackId: `original:${speaker.id}`,
        trackKind: "original",
        gain: 0.2,
        timestamp: 0,
        result: "applied",
      },
      {
        type: "listening-gain-applied",
        meetingId: "meeting-1",
        participantId: listener.id,
        utteranceId: "utterance-1",
        language: "ko",
        listeningMode: "translation-focused",
        trackId: "translation:ko",
        trackKind: "translation",
        gain: 1,
        timestamp: 0,
        result: "applied",
      },
      {
        type: "listening-mode-changed",
        meetingId: "meeting-1",
        participantId: listener.id,
        utteranceId: "utterance-1",
        language: "ko",
        listeningMode: "translation-only",
        timestamp: 0,
        result: "changed",
      },
      {
        type: "listening-gain-applied",
        meetingId: "meeting-1",
        participantId: listener.id,
        utteranceId: "utterance-1",
        language: "ko",
        listeningMode: "translation-only",
        trackId: "translation:ko",
        trackKind: "translation",
        gain: 1,
        timestamp: 0,
        result: "applied",
      },
    ],
  );
});

test("three failed fresh Gemini setups abort the correlated utterance and close resources", async () => {
  const sockets = [];
  const events = [];
  const recorder = new MeetingEventRecorder({
    meetingId: "meeting-1",
    clock: () => 500,
    write(event) { events.push(event); },
  });
  const bridge = new LiveTranslationBridge({
    meetingId: "meeting-1",
    eventRecorder: recorder,
    audioGateway: {
      async translationSink() { return { async capture() {} }; },
      async subscribeOriginal() { return { async close() {} }; },
    },
    geminiFactory(callbacks) {
      return new GeminiLiveTranslateSocket({
        ...callbacks,
        apiKey: "private-api-key",
        socketFactory() {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
        openState: FakeSocket.OPEN,
        automaticActivityDetection: false,
        eventRecorder: recorder,
      });
    },
  });
  const service = new BrowserMeetingService({
    roomName: "meeting-1",
    livekitUrl: "ws://127.0.0.1:7880",
    participantIdFactory: () => "participant-1",
    utteranceIdFactory: () => "utterance-1",
    tokenIssuer: async () => "private-token",
    translationBridge: bridge,
    eventRecorder: recorder,
  });
  const speaker = (await service.join({ name: "Yuki", language: "ja" })).participant;
  await service.mic(speaker.id, true);
  const speech = service.speechActivity({
    participantId: speaker.id,
    type: "speech-start",
    observedAt: 500,
  });
  await waitFor(() => sockets.length === 1);
  sockets[0].emit("open");
  sockets[0].emit("close", 1011, "provider setup failed");
  await waitFor(() => sockets.length === 2);
  sockets[1].emit("open");
  sockets[1].emit("close", 1011, "provider setup failed");
  await waitFor(() => sockets.length === 3);
  sockets[2].emit("open");
  sockets[2].emit("close", 1011, "provider setup failed");

  await assert.rejects(speech, /Gemini closed during setup/);
  assert.deepEqual(events.filter(({ type }) => [
    "gemini-setup-started",
    "gemini-retry-failed",
    "gemini-setup-failed",
    "resources-closed",
    "utterance-aborted",
  ].includes(type)).map(({ type }) => type), [
    "gemini-setup-started",
    "gemini-retry-failed",
    "gemini-retry-failed",
    "gemini-retry-failed",
    "gemini-setup-failed",
    "resources-closed",
    "utterance-aborted",
  ]);
  assert.ok(events.filter(({ utteranceId }) => utteranceId)
    .every(({ participantId, utteranceId }) =>
      participantId === speaker.id && utteranceId === "utterance-1"));
  const serialized = JSON.stringify(events);
  assert.equal(serialized.includes("private-api-key"), false);
  assert.equal(serialized.includes("private-token"), false);
});

test("Gemini input and output are correlated without claiming browser playout", async () => {
  const events = [];
  let originalFrame;
  let callbacks;
  const recorder = new MeetingEventRecorder({
    meetingId: "meeting-1",
    clock: () => 700,
    write(event) { events.push(event); },
  });
  const bridge = new LiveTranslationBridge({
    meetingId: "meeting-1",
    eventRecorder: recorder,
    drainQuietMilliseconds: 0,
    audioGateway: {
      async translationSink() {
        return {
          async capture() {
            return { queuedAfterMs: 240 };
          },
        };
      },
      async subscribeOriginal(_trackId, onFrame) {
        originalFrame = onFrame;
        return { async close() {} };
      },
    },
    geminiFactory(geminiCallbacks) {
      callbacks = geminiCallbacks;
      return {
        connect() { queueMicrotask(geminiCallbacks.onSetupComplete); },
        sendActivityStart() { return true; },
        sendActivityEnd() { return true; },
        sendPcm16() { return true; },
        close() {},
      };
    },
  });

  await bridge.start(
    { id: "participant-1", name: "Yuki", language: "ja" },
    { utteranceId: "utterance-1" },
  );
  await originalFrame(Buffer.from([0xe8, 0x03]), 16_000);
  await callbacks.onTranslatedAudio(Buffer.from([0xe8, 0x03]).toString("base64"));
  await bridge.stop({ utteranceId: "utterance-1" });

  assert.deepEqual(events.map(({ type }) => type), [
    "gemini-setup-started",
    "livekit-subscribe-started",
    "livekit-subscribe-succeeded",
    "gemini-setup-succeeded",
    "gemini-input-started",
    "gemini-input-received",
    "gemini-output-received",
    "livekit-queue-updated",
    "gemini-output-completed",
    "resources-closed",
  ]);
  assert.ok(events.every(({ participantId, utteranceId }) =>
    participantId === "participant-1" && utteranceId === "utterance-1"));
  assert.ok(events.every(({ targetLanguage }) => targetLanguage === "ko"));
});

test("browser playout failure reaches the privacy-safe meeting timeline", async () => {
  const { service, events, setNow } = timelineService();
  const speaker = (await service.join({ name: "Yuki", language: "ja" })).participant;
  const listener = (await service.join({ name: "민준", language: "ko" })).participant;
  await service.mic(speaker.id, true);
  await service.speechActivity({ participantId: speaker.id, type: "speech-start", observedAt: 0 });
  setNow(50);

  await service.playout(listener.id, {
    type: "playout-aborted",
    trackId: "translation:ko",
    utteranceId: "utterance-1",
    listeningMode: "translation-focused",
    gain: 1,
    result: "failed",
    errorCode: "browser-play-failed",
    rawAudio: "private",
  });

  assert.deepEqual(events.at(-1), {
    type: "playout-aborted",
    meetingId: "meeting-1",
    participantId: listener.id,
    utteranceId: "utterance-1",
    language: "ko",
    targetLanguage: "ko",
    listeningMode: "translation-focused",
    trackId: "translation:ko",
    trackKind: "translation",
    gain: 1,
    result: "failed",
    errorCode: "browser-play-failed",
    timestamp: 50,
  });
  assert.equal(JSON.stringify(events).includes("private"), false);
});

test("browser playout ids are validated against the authoritative listening plan", async () => {
  const { service, events, setNow } = timelineService();
  const speaker = (await service.join({ name: "Yuki", language: "ja" })).participant;
  const listener = (await service.join({ name: "민준", language: "ko" })).participant;
  await service.mic(speaker.id, true);
  await service.speechActivity({ participantId: speaker.id, type: "speech-start", observedAt: 0 });
  setNow(80);

  await assert.rejects(service.playout(listener.id, {
    type: "playout-started",
    trackId: "translation:ko",
    utteranceId: "client-invented",
    listeningMode: "translation-focused",
    gain: 1,
    result: "started",
  }), /utteranceId does not match/);

  await service.playout(listener.id, {
    type: "playout-gap",
    trackId: "translation:ko",
    utteranceId: "utterance-1",
    listeningMode: "translation-focused",
    gain: 1,
    result: "interrupted",
    errorCode: "browser-playout-gap",
  });

  assert.deepEqual(events.at(-1), {
    type: "playout-gap",
    meetingId: "meeting-1",
    participantId: listener.id,
    utteranceId: "utterance-1",
    language: "ko",
    targetLanguage: "ko",
    listeningMode: "translation-focused",
    trackId: "translation:ko",
    trackKind: "translation",
    gain: 1,
    result: "interrupted",
    errorCode: "browser-playout-gap",
    timestamp: 80,
  });
});

test("successive utterances on one translation track keep separate authoritative playout timelines", async () => {
  const { service, events, setNow } = timelineService();
  const first = (await service.join({ name: "Yuki", language: "ja" })).participant;
  const second = (await service.join({ name: "Sora", language: "ja" })).participant;
  const listener = (await service.join({ name: "민준", language: "ko" })).participant;
  await service.mic(first.id, true);
  await service.mic(second.id, true);
  await service.speechActivity({ participantId: first.id, type: "speech-start", observedAt: 0 });
  await service.playout(listener.id, {
    type: "playout-started",
    trackId: "translation:ko",
    utteranceId: "utterance-1",
  });
  setNow(100);
  await service.speechActivity({ participantId: first.id, type: "speech-end", observedAt: 100 });
  await service.speechActivity({ participantId: second.id, type: "speech-start", observedAt: 100 });

  await assert.rejects(service.playout(listener.id, {
    type: "playout-gap",
    trackId: "translation:ko",
    utteranceId: "utterance-1",
  }), /superseded/);
  await service.playout(listener.id, {
    type: "playout-completed",
    trackId: "translation:ko",
    utteranceId: "utterance-1",
    result: "superseded",
  });
  await assert.rejects(service.playout(listener.id, {
    type: "playout-completed",
    trackId: "translation:ko",
    utteranceId: "utterance-1",
    result: "superseded",
  }), /utteranceId does not match/);
  await service.playout(listener.id, {
    type: "playout-started",
    trackId: "translation:ko",
    utteranceId: "utterance-2",
  });
  await service.playout(listener.id, {
    type: "playout-completed",
    trackId: "translation:ko",
    utteranceId: "utterance-2",
    result: "ended",
  });

  assert.deepEqual(
    events.filter(({ type, trackId }) => trackId === "translation:ko" && type.startsWith("playout-"))
      .map(({ type, utteranceId, result }) => ({ type, utteranceId, result })),
    [
      { type: "playout-started", utteranceId: "utterance-1", result: "started" },
      { type: "playout-completed", utteranceId: "utterance-1", result: "superseded" },
      { type: "playout-started", utteranceId: "utterance-2", result: "started" },
      { type: "playout-completed", utteranceId: "utterance-2", result: "ended" },
    ],
  );
});
