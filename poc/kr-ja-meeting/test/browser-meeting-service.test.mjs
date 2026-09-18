import assert from "node:assert/strict";
import test from "node:test";

import { BrowserMeetingService } from "../src/browser-meeting-service.mjs";
import { GeminiLiveTranslateSocket } from "../src/gemini-live-socket.mjs";
import { LiveTranslationBridge } from "../src/live-translation-bridge.mjs";

class FakeSocket {
  static OPEN = 1;
  handlers = new Map();
  readyState = FakeSocket.OPEN;
  sent = [];

  on(event, handler) { this.handlers.set(event, handler); }
  emit(event, ...args) { this.handlers.get(event)?.(...args); }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; }
}

async function waitFor(check) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition was not reached");
}

function createService(overrides = {}) {
  const bridgeEvents = [];
  const service = new BrowserMeetingService({
    roomName: "browser-poc",
    livekitUrl: "ws://127.0.0.1:7880",
    participantIdFactory: () => "participant-1",
    utteranceIdFactory: () => "utterance-1",
    tokenIssuer: async (participant) => `token:${participant.id}`,
    translationBridge: {
      async prepare() {},
      async start(participant, utterance) {
        bridgeEvents.push({ type: "start", participantId: participant.id, ...utterance });
      },
      async stop(utterance) {
        bridgeEvents.push({ type: "stop", ...utterance });
      },
      async phraseBoundary(utterance) {
        bridgeEvents.push({ type: "boundary", ...utterance });
      },
      async resume(participant, utterance) {
        bridgeEvents.push({ type: "resume", participantId: participant.id, ...utterance });
      },
      async handoff(participant, transition) {
        bridgeEvents.push({ type: "stop", utteranceId: transition.previousUtteranceId, observedAt: transition.observedAt });
        bridgeEvents.push({ type: "start", participantId: participant.id, utteranceId: transition.utteranceId, observedAt: transition.observedAt });
      },
      async release() {},
    },
    ...overrides,
  });
  return { service, bridgeEvents };
}

test("overlapping speech stays published while one translation focus hands off", async () => {
  let participantSequence = 0;
  let utteranceSequence = 0;
  let now = 0;
  const { service, bridgeEvents } = createService({
    participantIdFactory: () => `participant-${++participantSequence}`,
    utteranceIdFactory: () => `utterance-${++utteranceSequence}`,
    clock: () => now,
    overlapWarningMilliseconds: 1_000,
  });
  const first = (await service.join({ name: "Yuki", language: "ja" })).participant;
  const second = (await service.join({ name: "민준", language: "ko" })).participant;
  await service.mic(first.id, true);
  await service.mic(second.id, true);

  await service.speechActivity({ participantId: first.id, type: "speech-start", observedAt: now });
  now = 100;
  const overlap = await service.speechActivity({
    participantId: second.id,
    type: "speech-start",
    observedAt: now,
  });

  assert.deepEqual(overlap.speakingParticipantIds, [first.id, second.id]);
  assert.equal(overlap.translationFocusId, first.id);
  assert.equal(overlap.participants.find(({ id }) => id === second.id).speech, "speaking");
  assert.deepEqual(bridgeEvents.map(({ type, participantId }) => ({ type, participantId })), [
    { type: "start", participantId: first.id },
  ]);

  now = 1_100;
  const warned = service.snapshot();
  assert.equal(warned.overlap.detected, true);
  assert.match(warned.overlap.message, /통역이 불완전/);
  assert.deepEqual(warned.speakingParticipantIds, [first.id, second.id]);

  now = 1_200;
  const handedOff = await service.speechActivity({
    participantId: first.id,
    type: "speech-end",
    observedAt: now,
  });
  assert.equal(handedOff.translationFocusId, second.id);
  assert.equal(handedOff.activeUtteranceId, "utterance-2");
  assert.equal(handedOff.participants.find(({ id }) => id === first.id).speech, "silent");
  assert.equal(handedOff.participants.find(({ id }) => id === second.id).speech, "speaking");
  assert.deepEqual(bridgeEvents, [
    { type: "start", participantId: first.id, utteranceId: "utterance-1", observedAt: 0 },
    { type: "stop", utteranceId: "utterance-1", observedAt: 1_200 },
    { type: "start", participantId: second.id, utteranceId: "utterance-2", observedAt: 1_200 },
  ]);
});

test("browser-relative speech timestamps cannot trigger a server-clock overlap warning", async () => {
  let now = 1_000_000;
  let participantSequence = 0;
  const { service } = createService({
    clock: () => now,
    participantIdFactory: () => `participant-${++participantSequence}`,
    overlapWarningMilliseconds: 1_000,
  });
  const first = (await service.join({ name: "Yuki", language: "ja" })).participant;
  const second = (await service.join({ name: "Sora", language: "ja" })).participant;
  await service.mic(first.id, true);
  await service.mic(second.id, true);

  await service.speechActivity({ participantId: first.id, type: "speech-start", observedAt: 10 });
  now = 1_000_100;
  await service.speechActivity({ participantId: second.id, type: "speech-start", observedAt: 20 });

  assert.equal(service.snapshot().overlap.detected, false);
  now = 1_001_100;
  assert.equal(service.snapshot().overlap.detected, true);
});

test("vacated focus waits for a continuing overlap candidate to satisfy minimum hold", async () => {
  let now = 0;
  let participantSequence = 0;
  let utteranceSequence = 0;
  const { service, bridgeEvents } = createService({
    clock: () => now,
    minimumFocusHoldMilliseconds: 500,
    participantIdFactory: () => `participant-${++participantSequence}`,
    utteranceIdFactory: () => `utterance-${++utteranceSequence}`,
  });
  const first = (await service.join({ name: "Yuki", language: "ja" })).participant;
  const second = (await service.join({ name: "민준", language: "ko" })).participant;
  await service.mic(first.id, true);
  await service.mic(second.id, true);
  await service.speechActivity({ participantId: first.id, type: "speech-start", observedAt: 0 });
  now = 100;
  await service.speechActivity({ participantId: second.id, type: "speech-start", observedAt: 100 });
  now = 200;
  const waiting = await service.speechActivity({ participantId: first.id, type: "speech-end", observedAt: 200 });

  assert.equal(waiting.translationFocusId, null);
  assert.equal(waiting.speakingParticipantIds.includes(second.id), true);
  assert.deepEqual(bridgeEvents.map(({ type, participantId }) => ({ type, participantId })), [
    { type: "start", participantId: first.id },
    { type: "boundary", participantId: undefined },
  ]);

  now = 599;
  assert.equal((await service.refresh()).translationFocusId, null);
  now = 600;
  assert.equal((await service.refresh()).translationFocusId, second.id);
  assert.deepEqual(bridgeEvents.slice(-2), [{
    type: "stop",
    utteranceId: "utterance-1",
    observedAt: 600,
  }, {
    type: "start",
    participantId: second.id,
    utteranceId: "utterance-2",
    observedAt: 600,
  }]);
});

test("a failed pending-focus bridge start stays locked out until that utterance ends", async () => {
  let now = 0;
  let participantSequence = 0;
  let utteranceSequence = 0;
  let failSecondUtterance = true;
  const starts = [];
  const events = [];
  const { service } = createService({
    clock: () => now,
    minimumFocusHoldMilliseconds: 500,
    participantIdFactory: () => `participant-${++participantSequence}`,
    utteranceIdFactory: () => `utterance-${++utteranceSequence}`,
    eventRecorder: { record(event) { events.push(event); } },
    translationBridge: {
      async start(participant, utterance) {
        starts.push({ participantId: participant.id, utteranceId: utterance.utteranceId });
        if (utterance.utteranceId === "utterance-2" && failSecondUtterance) {
          throw new Error("setup retry exhausted");
        }
      },
      async stop() {},
      async handoff() {},
    },
  });
  const first = (await service.join({ name: "Yuki", language: "ja" })).participant;
  const second = (await service.join({ name: "Sora", language: "ja" })).participant;
  await service.mic(first.id, true);
  await service.mic(second.id, true);
  await service.speechActivity({ participantId: first.id, type: "speech-start", observedAt: 0 });
  now = 100;
  await service.speechActivity({ participantId: second.id, type: "speech-start", observedAt: 100 });
  now = 200;
  await service.speechActivity({ participantId: first.id, type: "speech-end", observedAt: 200 });

  now = 600;
  await assert.rejects(service.refresh(), /setup retry exhausted/);
  now = 700;
  assert.equal((await service.refresh()).translationFocusId, null);
  now = 800;
  assert.equal((await service.refresh()).translationFocusId, null);
  assert.deepEqual(starts, [
    { participantId: first.id, utteranceId: "utterance-1" },
    { participantId: second.id, utteranceId: "utterance-2" },
  ]);
  assert.deepEqual(
    events.filter(({ errorCode }) => errorCode === "translation-recovery-unavailable")
      .map(({ type, participantId, utteranceId, result, errorCode }) => ({
        type, participantId, utteranceId, result, errorCode,
      })),
    [{
      type: "utterance-aborted",
      participantId: second.id,
      utteranceId: "utterance-2",
      result: "aborted",
      errorCode: "translation-recovery-unavailable",
    }],
  );
  assert.equal(service.snapshot().participants.find(({ id }) => id === second.id).speech, "speaking");

  await service.speechActivity({ participantId: second.id, type: "speech-end", observedAt: 800 });
  failSecondUtterance = false;
  now = 900;
  await service.speechActivity({ participantId: second.id, type: "speech-start", observedAt: 900 });
  assert.deepEqual(starts.at(-1), { participantId: second.id, utteranceId: "utterance-3" });
});

test("a failed immediate handoff locks the target utterance out across refreshes", async () => {
  let now = 0;
  let participantSequence = 0;
  let utteranceSequence = 0;
  let failHandoff = true;
  const bridgeEvents = [];
  const events = [];
  const { service } = createService({
    clock: () => now,
    minimumFocusHoldMilliseconds: 0,
    participantIdFactory: () => `participant-${++participantSequence}`,
    utteranceIdFactory: () => `utterance-${++utteranceSequence}`,
    eventRecorder: { record(event) { events.push(event); } },
    translationBridge: {
      async start(participant, utterance) {
        bridgeEvents.push({ type: "start", participantId: participant.id, utteranceId: utterance.utteranceId });
      },
      async stop() {},
      async handoff(participant, transition) {
        bridgeEvents.push({ type: "handoff", participantId: participant.id, utteranceId: transition.utteranceId });
        if (failHandoff) throw new Error("setup retry exhausted");
      },
    },
  });
  const first = (await service.join({ name: "Yuki", language: "ja" })).participant;
  const second = (await service.join({ name: "Sora", language: "ja" })).participant;
  const listener = (await service.join({ name: "민준", language: "ko" })).participant;
  await service.mic(first.id, true);
  await service.mic(second.id, true);
  await service.speechActivity({ participantId: first.id, type: "speech-start", observedAt: 0 });
  now = 100;
  await service.speechActivity({ participantId: second.id, type: "speech-start", observedAt: 100 });
  now = 200;
  await assert.rejects(
    service.speechActivity({ participantId: first.id, type: "speech-end", observedAt: 200 }),
    /setup retry exhausted/,
  );

  now = 300;
  assert.equal((await service.refresh()).translationFocusId, null);
  now = 400;
  assert.equal((await service.refresh()).translationFocusId, null);
  assert.deepEqual(bridgeEvents, [
    { type: "start", participantId: first.id, utteranceId: "utterance-1" },
    { type: "handoff", participantId: second.id, utteranceId: "utterance-2" },
  ]);
  assert.deepEqual(
    events.filter(({ errorCode }) => errorCode === "translation-recovery-unavailable")
      .map(({ type, participantId, utteranceId, errorCode }) => ({
        type, participantId, utteranceId, errorCode,
      })),
    [{
      type: "utterance-aborted",
      participantId: second.id,
      utteranceId: "utterance-2",
      errorCode: "translation-recovery-unavailable",
    }],
  );
  const listenerState = service.snapshot().participants.find(({ id }) => id === listener.id);
  assert.equal(listenerState.audio.mode, "focus-pending");
  assert.deepEqual(listenerState.audio.tracks.map(({ trackId, role, gain }) => ({ trackId, role, gain })), [
    { trackId: `original:${second.id}`, role: "background", gain: 0.2 },
  ]);

  await service.speechActivity({ participantId: second.id, type: "speech-end", observedAt: 400 });
  failHandoff = false;
  now = 500;
  await service.speechActivity({ participantId: second.id, type: "speech-start", observedAt: 500 });
  assert.deepEqual(bridgeEvents.at(-1), {
    type: "start",
    participantId: second.id,
    utteranceId: "utterance-3",
  });
});

test("dynamic participant joins with a generated id and can leave", async () => {
  const { service } = createService();

  assert.deepEqual(await service.join({ name: "  Yuki  ", language: "ja" }), {
    livekitUrl: "ws://127.0.0.1:7880",
    roomName: "browser-poc",
    token: "token:participant-1",
    participant: { id: "participant-1", name: "Yuki", language: "ja" },
  });
  assert.deepEqual(service.snapshot().participants.map(({ id }) => id), ["participant-1"]);

  await service.leave("participant-1");
  assert.deepEqual(service.snapshot().participants, []);
  await assert.rejects(service.mic("participant-1", true), /unknown participant/);
});

test("microphone on remains unmuted and silent until speech activity starts", async () => {
  const { service, bridgeEvents } = createService();
  const { participant } = await service.join({ name: "Yuki", language: "ja" });

  const state = await service.mic(participant.id, true);

  assert.deepEqual(state.participants.find(({ id }) => id === participant.id), {
    ...participant,
    microphone: "unmuted",
    speech: "silent",
    utteranceId: null,
    listeningMode: "translation-focused",
    audio: { mode: "silent", tracks: [] },
  });
  assert.equal(state.activeSpeakerId, null);
  assert.equal(state.activeUtteranceId, null);
  assert.deepEqual(bridgeEvents, []);
});

test("speech start and end drive one translation lifecycle with one utterance id", async () => {
  let now = 100;
  const { service, bridgeEvents } = createService({ clock: () => now });
  const { participant } = await service.join({ name: "Yuki", language: "ja" });
  await service.mic(participant.id, true);

  const speaking = await service.speechActivity({
    participantId: participant.id,
    type: "speech-start",
    observedAt: 100,
  });
  assert.equal(speaking.activeSpeakerId, participant.id);
  assert.equal(speaking.activeUtteranceId, "utterance-1");
  assert.equal(speaking.participants[0].speech, "speaking");

  now = 350;
  const silent = await service.speechActivity({
    participantId: participant.id,
    type: "speech-end",
    observedAt: 350,
  });
  assert.equal(silent.activeSpeakerId, null);
  assert.equal(silent.activeUtteranceId, null);
  assert.equal(silent.participants[0].speech, "silent");
  assert.deepEqual(bridgeEvents, [
    { type: "start", participantId: participant.id, utteranceId: "utterance-1", observedAt: 100 },
    { type: "boundary", utteranceId: "utterance-1", observedAt: 350 },
  ]);
});

test("same speaker reuses one translation session while the microphone stays on", async () => {
  let utterance = 0;
  let now = 100;
  const { service, bridgeEvents } = createService({
    utteranceIdFactory: () => `utterance-${++utterance}`,
    clock: () => now,
  });
  const { participant } = await service.join({ name: "Yuki", language: "ja" });
  await service.mic(participant.id, true);

  await service.speechActivity({ participantId: participant.id, type: "speech-start", observedAt: 100 });
  now = 200;
  await service.speechActivity({ participantId: participant.id, type: "speech-end", observedAt: 200 });
  now = 300;
  await service.speechActivity({ participantId: participant.id, type: "speech-start", observedAt: 300 });
  now = 400;
  await service.speechActivity({ participantId: participant.id, type: "speech-end", observedAt: 400 });
  await service.mic(participant.id, false);

  assert.deepEqual(bridgeEvents, [
    { type: "start", participantId: participant.id, utteranceId: "utterance-1", observedAt: 100 },
    { type: "boundary", utteranceId: "utterance-1", observedAt: 200 },
    { type: "resume", participantId: participant.id, utteranceId: "utterance-2", observedAt: 300 },
    { type: "boundary", utteranceId: "utterance-2", observedAt: 400 },
    { type: "stop" },
  ]);
});

test("mic off and leave close an active automatic utterance", async () => {
  let nextParticipant = 0;
  let nextUtterance = 0;
  const { service, bridgeEvents } = createService({
    participantIdFactory: () => `participant-${++nextParticipant}`,
    utteranceIdFactory: () => `utterance-${++nextUtterance}`,
  });
  const first = (await service.join({ name: "Yuki", language: "ja" })).participant;
  const second = (await service.join({ name: "민준", language: "ko" })).participant;

  await service.mic(first.id, true);
  await service.speechActivity({ participantId: first.id, type: "speech-start", observedAt: 10 });
  let state = await service.mic(first.id, false);
  assert.equal(state.participants.find(({ id }) => id === first.id).microphone, "muted");
  assert.equal(state.activeSpeakerId, null);

  await service.mic(second.id, true);
  await service.speechActivity({ participantId: second.id, type: "speech-start", observedAt: 20 });
  state = await service.leave(second.id);
  assert.equal(state.participants.some(({ id }) => id === second.id), false);
  assert.equal(state.activeSpeakerId, null);
  assert.deepEqual(bridgeEvents.map(({ type, utteranceId }) => ({ type, utteranceId })), [
    { type: "start", utteranceId: "utterance-1" },
    { type: "boundary", utteranceId: "utterance-1" },
    { type: "stop", utteranceId: undefined },
    { type: "start", utteranceId: "utterance-2" },
    { type: "boundary", utteranceId: "utterance-2" },
    { type: "stop", utteranceId: undefined },
  ]);
});

test("bridge cleanup failures cannot leave a ghost participant or open microphone", async () => {
  let nextParticipant = 0;
  const { service } = createService({
    participantIdFactory: () => `participant-${++nextParticipant}`,
    translationBridge: {
      async start() {},
      async stop() { throw new Error("bridge cleanup failed"); },
    },
  });
  const first = (await service.join({ name: "Yuki", language: "ja" })).participant;
  await service.mic(first.id, true);
  await service.speechActivity({ participantId: first.id, type: "speech-start", observedAt: 10 });

  await assert.rejects(service.mic(first.id, false), /bridge cleanup failed/);
  assert.equal(service.snapshot().participants[0].microphone, "muted");
  assert.equal(service.snapshot().activeSpeakerId, null);

  const second = (await service.join({ name: "민준", language: "ko" })).participant;
  await service.mic(second.id, true);
  await service.speechActivity({ participantId: second.id, type: "speech-start", observedAt: 20 });
  await assert.rejects(service.leave(second.id), /bridge cleanup failed/);
  assert.equal(service.snapshot().participants.some(({ id }) => id === second.id), false);
});

test("manual speech actions are not part of the service contract", async () => {
  const { service } = createService();
  const { participant } = await service.join({ name: "Yuki", language: "ja" });

  for (const action of ["start-speaking", "stop-speaking", "phrase-boundary"]) {
    await assert.rejects(service.action(participant.id, action), /unsupported meeting action/);
  }
});

test("invalid join and speech activity fail closed", async () => {
  const { service } = createService();
  await assert.rejects(service.join({ name: "", language: "ja" }), /display name/);
  await assert.rejects(service.join({ name: "Yuki", language: "en" }), /unsupported language/);

  const { participant } = await service.join({ name: "Yuki", language: "ja" });
  await assert.rejects(
    service.speechActivity({ participantId: participant.id, type: "speech-start", observedAt: 1 }),
    /microphone is muted/,
  );
  await assert.rejects(
    service.speechActivity({ participantId: participant.id, type: "invented", observedAt: 1 }),
    /unsupported speech activity/,
  );
});

test("listening mode changes are participant-scoped and recorded once", async () => {
  let participantSequence = 0;
  const listeningEvents = [];
  const { service } = createService({
    participantIdFactory: () => `participant-${++participantSequence}`,
    onListeningEvent(event) { listeningEvents.push(event); },
  });
  const speaker = (await service.join({ name: "Yuki", language: "ja" })).participant;
  const first = (await service.join({ name: "민준", language: "ko" })).participant;
  const second = (await service.join({ name: "서연", language: "ko" })).participant;
  await service.mic(speaker.id, true);
  await service.speechActivity({ participantId: speaker.id, type: "speech-start", observedAt: 100 });

  await service.listeningMode(first.id, "translation-only");
  await service.listeningMode(first.id, "translation-only");
  const checked = await service.listeningMode(first.id, "original-check");

  assert.equal(checked.participants.find(({ id }) => id === first.id).audio.mode, "original-check");
  assert.equal(checked.participants.find(({ id }) => id === second.id).audio.mode, "translation-focused");
  assert.deepEqual(listeningEvents.map(({ type, participantId, previousMode, mode }) => ({
    type, participantId, previousMode, mode,
  })), [
    {
      type: "listening-mode-changed",
      participantId: first.id,
      previousMode: "translation-focused",
      mode: "translation-only",
    },
    {
      type: "listening-mode-changed",
      participantId: first.id,
      previousMode: "translation-only",
      mode: "original-check",
    },
  ]);

  const restored = await service.speechActivity({
    participantId: speaker.id,
    type: "speech-end",
    observedAt: 200,
  });
  assert.equal(restored.participants.find(({ id }) => id === first.id).listeningMode, "translation-only");
  assert.deepEqual(listeningEvents.at(-1), {
    type: "listening-mode-restored",
    participantId: first.id,
    previousMode: "original-check",
    mode: "translation-only",
    utteranceId: "utterance-1",
  });
});

test("provider reconnect hook exposes fallback immediately without disconnecting the meeting", async () => {
  let participantSequence = 0;
  let now = 900;
  const { service } = createService({
    participantIdFactory: () => `participant-${++participantSequence}`,
    utteranceIdFactory: () => "utterance-1",
    clock: () => now,
  });
  const speaker = (await service.join({ name: "Yuki", language: "ja" })).participant;
  const listener = (await service.join({ name: "민준", language: "ko" })).participant;
  await service.mic(speaker.id, true);
  await service.mic(listener.id, true);
  await service.speechActivity({ participantId: speaker.id, type: "speech-start", observedAt: now });
  await service.listeningMode(listener.id, "translation-only");

  const reconnecting = await service.translationAvailability("reconnecting");

  assert.equal(reconnecting.translationAvailability, "reconnecting");
  assert.equal(reconnecting.translationAvailabilityChangedAt, 900);
  assert.equal(reconnecting.participants.find(({ id }) => id === listener.id).listeningMode, "translation-only");
  assert.equal(reconnecting.participants.find(({ id }) => id === listener.id).microphone, "unmuted");
  assert.deepEqual(reconnecting.participants.find(({ id }) => id === listener.id).audio, {
    mode: "original-fallback",
    tracks: [{
      trackId: `original:${speaker.id}`,
      kind: "original",
      role: "foreground",
      gain: 1,
      utteranceId: "utterance-1",
    }],
  });

  now = 950;
  const repeatedReconnect = await service.translationAvailability("reconnecting");
  assert.equal(repeatedReconnect.translationAvailabilityChangedAt, 900);

  const unavailable = await service.translationAvailability("unavailable");
  assert.equal(unavailable.translationAvailability, "unavailable");
  assert.equal(unavailable.participants.find(({ id }) => id === listener.id).audio.mode, "original-fallback");

  now = 1_000;
  const recovered = await service.translationAvailability("available");

  assert.equal(recovered.translationAvailability, "available");
  assert.equal(recovered.translationAvailabilityChangedAt, 1_000);
  assert.equal(recovered.participants.find(({ id }) => id === listener.id).listeningMode, "translation-only");
  assert.equal(recovered.participants.find(({ id }) => id === listener.id).audio.mode, "translation-only");
  assert.equal(recovered.participants.find(({ id }) => id === listener.id).microphone, "unmuted");
});

test("provider availability state changes immediately while prior actions remain serialized", async () => {
  let now = 0;
  const tokenEntered = deferredForServiceTest();
  const releaseToken = deferredForServiceTest();
  const { service } = createService({
    clock: () => now,
    async tokenIssuer(participant) {
      tokenEntered.resolve();
      await releaseToken.promise;
      return `token:${participant.id}`;
    },
  });
  const joining = service.join({ name: "Yuki", language: "ja" });
  await tokenEntered.promise;
  now = 1_000;

  const transition = service.translationAvailability("reconnecting");

  assert.equal(service.snapshot().translationAvailability, "reconnecting");
  assert.equal(service.snapshot().translationAvailabilityChangedAt, 1_000);
  releaseToken.resolve();
  await joining;
  assert.equal((await transition).translationAvailability, "reconnecting");
});

test("a destructive parked handoff failure is consumed so the next utterance starts fresh", async () => {
  let participantSequence = 0;
  let utteranceSequence = 0;
  let liveSession = false;
  let failHandoff = true;
  const calls = [];
  const { service } = createService({
    minimumFocusHoldMilliseconds: 0,
    participantIdFactory: () => `participant-${++participantSequence}`,
    utteranceIdFactory: () => `utterance-${++utteranceSequence}`,
    translationBridge: {
      async prepare() {},
      async start(participant, utterance) {
        calls.push({ type: "start", participantId: participant.id, utteranceId: utterance.utteranceId });
        liveSession = true;
      },
      async phraseBoundary() { calls.push({ type: "boundary" }); },
      async handoff(participant, utterance) {
        calls.push({ type: "handoff", participantId: participant.id, utteranceId: utterance.utteranceId });
        liveSession = false;
        if (failHandoff) throw new Error("replacement setup failed");
      },
      async resume() {
        calls.push({ type: "resume" });
        if (!liveSession) throw new Error("cannot resume a closed session");
      },
      async stop() { liveSession = false; },
      async release() {},
    },
  });
  const first = (await service.join({ name: "Yuki", language: "ja" })).participant;
  const second = (await service.join({ name: "민준", language: "ko" })).participant;
  await service.mic(first.id, true);
  await service.mic(second.id, true);
  await service.speechActivity({ participantId: first.id, type: "speech-start", observedAt: 0 });
  await service.speechActivity({ participantId: first.id, type: "speech-end", observedAt: 100 });
  await assert.rejects(
    service.speechActivity({ participantId: second.id, type: "speech-start", observedAt: 200 }),
    /replacement setup failed/,
  );

  failHandoff = false;
  await service.speechActivity({ participantId: second.id, type: "speech-start", observedAt: 300 });

  assert.equal(liveSession, true);
  assert.deepEqual(calls.map(({ type }) => type), ["start", "boundary", "handoff", "start"]);
});

test("the last participant leaving disposes the meeting-only glossary hook", async () => {
  let emptyCalls = 0;
  const { service } = createService({ onMeetingEmpty() { emptyCalls += 1; } });
  const { participant } = await service.join({ name: "Yuki", language: "ja" });
  await service.leave(participant.id);
  assert.equal(emptyCalls, 1);
});

function deferredForServiceTest() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

test("automatic speech keeps its utterance id while a fresh Gemini session replaces setup failure", async () => {
  const sockets = [];
  const retryEvents = [];
  const bridge = new LiveTranslationBridge({
    meetingId: "browser-poc",
    continuousInput: true,
    audioGateway: {
      async translationSink() { return { async capture() {} }; },
      async subscribeOriginal() { return { async close() {} }; },
    },
    geminiFactory(callbacks) {
      return new GeminiLiveTranslateSocket({
        ...callbacks,
        apiKey: "test-only-key",
        socketFactory(url) {
          const socket = new FakeSocket(url);
          sockets.push(socket);
          return socket;
        },
        openState: FakeSocket.OPEN,
        automaticActivityDetection: true,
      });
    },
    eventRecorder: { record(event) { retryEvents.push(event); } },
  });
  const { service } = createService({ translationBridge: bridge });
  const { participant } = await service.join({ name: "Yuki", language: "ja" });
  await service.mic(participant.id, true);

  const speechStart = service.speechActivity({
    participantId: participant.id,
    type: "speech-start",
    observedAt: 100,
  });
  await waitFor(() => sockets.length === 1);
  sockets[0].emit("open");
  sockets[0].emit("close", 1008, "BidiGenerateContent session not found");

  await waitFor(() => sockets.length === 2);
  assert.equal(sockets.length, 2);
  assert.equal(service.snapshot().activeUtteranceId, "utterance-1");
  sockets[1].emit("open");
  sockets[1].emit("message", JSON.stringify({ setupComplete: {} }));
  const state = await speechStart;

  assert.equal(state.activeUtteranceId, "utterance-1");
  assert.equal(retryEvents.filter(({ type }) => type === "gemini-retry-failed").length, 1);
  sockets[1].emit("message", JSON.stringify({
    serverContent: {
      modelTurn: { parts: [{ inlineData: { data: Buffer.from([1, 2]).toString("base64") } }] },
      generationComplete: true,
    },
  }));
  await service.speechActivity({
    participantId: participant.id,
    type: "speech-end",
    observedAt: 200,
  });
  await service.mic(participant.id, false);
});

test("three fresh setup failures clean the automatic speech state", async () => {
  const sockets = [];
  const retryEvents = [];
  const bridge = new LiveTranslationBridge({
    meetingId: "browser-poc",
    continuousInput: true,
    audioGateway: {
      async translationSink() { return { async capture() {} }; },
      async subscribeOriginal() { return { async close() {} }; },
    },
    geminiFactory(callbacks) {
      return new GeminiLiveTranslateSocket({
        ...callbacks,
        apiKey: "test-only-key",
        socketFactory(url) {
          const socket = new FakeSocket(url);
          sockets.push(socket);
          return socket;
        },
        openState: FakeSocket.OPEN,
        automaticActivityDetection: true,
      });
    },
    eventRecorder: { record(event) { retryEvents.push(event); } },
  });
  const { service } = createService({ translationBridge: bridge });
  const { participant } = await service.join({ name: "Yuki", language: "ja" });
  await service.mic(participant.id, true);

  const speechStart = service.speechActivity({
    participantId: participant.id,
    type: "speech-start",
    observedAt: 100,
  });
  await waitFor(() => sockets.length === 1);
  sockets[0].emit("open");
  sockets[0].emit("close", 1008, "BidiGenerateContent session not found");
  await waitFor(() => sockets.length === 2);
  sockets[1].emit("open");
  sockets[1].emit("close", 1008, "BidiGenerateContent session not found");
  await waitFor(() => sockets.length === 3);
  sockets[2].emit("open");
  sockets[2].emit("close", 1008, "BidiGenerateContent session not found");

  await assert.rejects(speechStart, /Gemini closed during setup/);
  assert.equal(sockets.length, 3);
  assert.equal(service.snapshot().activeSpeakerId, null);
  assert.equal(service.snapshot().activeUtteranceId, null);
  assert.equal(service.snapshot().participants[0].speech, "silent");
  assert.equal(retryEvents.filter(({ type }) => type === "gemini-retry-failed").length, 3);
  await service.mic(participant.id, false);
});
