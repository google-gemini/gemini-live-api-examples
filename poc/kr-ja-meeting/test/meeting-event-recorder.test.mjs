import assert from "node:assert/strict";
import test from "node:test";

import {
  MeetingEventRecorder,
  MemoryMeetingSegmentTraceStore,
  SEGMENT_TRACE_RETENTION_MILLISECONDS,
} from "../src/meeting-event-recorder.mjs";

test("record emits the privacy-safe allowlist with an injected timestamp", () => {
  const written = [];
  const recorder = new MeetingEventRecorder({
    meetingId: "meeting-1",
    clock: () => 1_234,
    write(event) { written.push(event); },
  });

  recorder.record({
    type: "speech-started",
    participantId: "participant-1",
    utteranceId: "utterance-1",
    language: "ja",
    targetLanguage: "ko",
    result: "started",
  });

  assert.deepEqual(written, [{
    type: "speech-started",
    meetingId: "meeting-1",
    participantId: "participant-1",
    utteranceId: "utterance-1",
    language: "ja",
    targetLanguage: "ko",
    timestamp: 1_234,
    result: "started",
  }]);
});

test("record rejects forbidden content and credential fields instead of silently logging them", () => {
  const recorder = new MeetingEventRecorder({ meetingId: "meeting-1", write() {} });
  const forbiddenFields = [
    "rawAudio",
    "pcm",
    "transcript",
    "translation",
    "glossary",
    "apiKey",
    "token",
    "resumptionHandle",
    "providerPayload",
  ];

  for (const field of forbiddenFields) {
    assert.throws(
      () => recorder.record({ type: "speech-started", [field]: "private" }),
      new RegExp(`unsupported meeting event field: ${field}`),
    );
  }
});

test("record rejects unknown event types and invalid allowlisted values", () => {
  const recorder = new MeetingEventRecorder({ meetingId: "meeting-1", write() {} });

  assert.throws(() => recorder.record({ type: "raw-transcript", result: "ok" }), /event type/);
  assert.throws(
    () => recorder.record({ type: "speech-started", participantId: { raw: "participant-1" } }),
    /participantId/,
  );
});

test("record stores interruption timing without translation content", () => {
  const written = [];
  const recorder = new MeetingEventRecorder({
    meetingId: "meeting-1",
    clock: () => 1_200,
    write(event) { written.push(event); },
  });

  recorder.record({
    type: "translation-interrupted",
    participantId: "participant-1",
    relatedParticipantId: "participant-2",
    utteranceId: "utterance-1",
    targetLanguage: "ko",
    interruptionMilliseconds: 0,
    queueDurationMs: 0,
    result: "interrupted",
  });

  assert.deepEqual(written, [{
    type: "translation-interrupted",
    meetingId: "meeting-1",
    participantId: "participant-1",
    utteranceId: "utterance-1",
    targetLanguage: "ko",
    result: "interrupted",
    relatedParticipantId: "participant-2",
    queueDurationMs: 0,
    interruptionMilliseconds: 0,
    timestamp: 1_200,
  }]);
});

test("segment trace separates browser, focus, Gemini, LiveKit, reconnect, and playout stages", () => {
  let now = 1_000;
  const store = new MemoryMeetingSegmentTraceStore({ clock: () => now });
  const recorder = new MeetingEventRecorder({
    meetingId: "meeting-1",
    clock: () => now,
    write: (event) => store.write(event),
  });
  const context = {
    participantId: "participant-1",
    utteranceId: "utterance-1",
    targetLanguage: "ko",
    result: "succeeded",
  };

  recorder.record({ type: "speech-started", ...context });
  recorder.record({ type: "translation-focus-selected", ...context });
  recorder.record({ type: "gemini-output-received", ...context });
  recorder.record({
    type: "gemini-retry-started",
    ...context,
    reconnectReason: "provider-session-missing",
  });
  recorder.record({ type: "livekit-queue-updated", ...context, queueDurationMs: 240 });
  recorder.record({ type: "playout-started", ...context });

  assert.deepEqual(
    store.query({ role: "operator", meetingId: "meeting-1" })
      .map(({ stage, utteranceId, queueDurationMs, reconnectReason }) => ({
        stage,
        utteranceId,
        ...(queueDurationMs === undefined ? {} : { queueDurationMs }),
        ...(reconnectReason === undefined ? {} : { reconnectReason }),
      })),
    [
      { stage: "browser-input", utteranceId: "utterance-1" },
      { stage: "focus-control", utteranceId: "utterance-1" },
      { stage: "gemini-provider", utteranceId: "utterance-1" },
      {
        stage: "provider-reconnect",
        utteranceId: "utterance-1",
        reconnectReason: "provider-session-missing",
      },
      { stage: "livekit-webrtc", utteranceId: "utterance-1", queueDurationMs: 240 },
      { stage: "browser-playout", utteranceId: "utterance-1" },
    ],
  );
});

test("segment trace is role-gated and expires records after seven days", () => {
  let now = 10_000;
  let scheduledExpiry;
  let scheduledDelay;
  const store = new MemoryMeetingSegmentTraceStore({
    clock: () => now,
    scheduleExpiry(callback, delay) {
      scheduledExpiry = callback;
      scheduledDelay = delay;
      return { unref() {} };
    },
    cancelExpiry() {},
  });
  const recorder = new MeetingEventRecorder({
    meetingId: "meeting-1",
    clock: () => 123,
    write: (event) => store.write(event),
  });
  recorder.record({
    type: "gemini-input-received",
    participantId: "participant-1",
    utteranceId: "utterance-1",
    result: "received",
  });

  assert.equal(store.query({ role: "developer" }).length, 1);
  assert.throws(() => store.query({ role: "participant" }), /not authorized/);
  assert.equal(scheduledDelay, SEGMENT_TRACE_RETENTION_MILLISECONDS);

  now += SEGMENT_TRACE_RETENTION_MILLISECONDS - 1;
  assert.equal(store.query({ role: "operator" }).length, 1);
  now += 1;
  scheduledExpiry();
  assert.equal(store.query({ role: "operator" }).length, 0);
});

test("segment trace store cannot be used to bypass the recorder allowlist", () => {
  const store = new MemoryMeetingSegmentTraceStore();

  assert.throws(() => store.write({
    type: "gemini-output-received",
    meetingId: "meeting-1",
    timestamp: 123,
    providerPayload: { transcript: "private" },
  }), /unsupported meeting event field: providerPayload/);
});

test("segment trace caps records and coalesces consecutive queue telemetry", () => {
  let now = 1_000;
  const store = new MemoryMeetingSegmentTraceStore({
    clock: () => now,
    maxRecords: 3,
  });
  const write = (type, fields = {}) => {
    store.write({
      type,
      meetingId: "meeting-1",
      participantId: "participant-1",
      utteranceId: "utterance-1",
      timestamp: now,
      result: "observed",
      ...fields,
    });
    now += 1;
  };

  write("speech-started");
  write("livekit-queue-updated", { queueDurationMs: 100 });
  write("livekit-queue-updated", { queueDurationMs: 200 });
  assert.deepEqual(
    store.query({ role: "operator" }).map(({ type, queueDurationMs }) => ({
      type,
      ...(queueDurationMs === undefined ? {} : { queueDurationMs }),
    })),
    [
      { type: "speech-started" },
      { type: "livekit-queue-updated", queueDurationMs: 200 },
    ],
  );

  write("gemini-output-received");
  write("playout-started");

  assert.deepEqual(
    store.query({ role: "operator" }).map(({ type, queueDurationMs }) => ({
      type,
      ...(queueDurationMs === undefined ? {} : { queueDurationMs }),
    })),
    [
      { type: "livekit-queue-updated", queueDurationMs: 200 },
      { type: "gemini-output-received" },
      { type: "playout-started" },
    ],
  );
});
