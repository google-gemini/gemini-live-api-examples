import assert from "node:assert/strict";
import test from "node:test";

import { BrowserMeetingService } from "../src/browser-meeting-service.mjs";
import { LiveTranslationBridge } from "../src/live-translation-bridge.mjs";

test("default simultaneous listening keeps pre-roll, final output, and one persistent session", async () => {
  let originalFrame;
  let geminiCallbacks;
  let participantSequence = 0;
  let utteranceSequence = 0;
  let geminiClientCount = 0;
  let originalSubscriptionCount = 0;
  const sentInputMarkers = [];
  const capturedTranslationMarkers = [];
  const bridge = new LiveTranslationBridge({
    meetingId: "meeting-1",
    continuousInput: true,
    preRollMilliseconds: 1_000,
    audioGateway: {
      async subscribeOriginal(_trackId, onFrame) {
        originalSubscriptionCount += 1;
        originalFrame = onFrame;
        return { async close() {} };
      },
      async translationSink() {
        return {
          async capture(pcm) {
            capturedTranslationMarkers.push(pcm.readInt16LE(0));
          },
        };
      },
    },
    geminiFactory(callbacks) {
      geminiClientCount += 1;
      geminiCallbacks = callbacks;
      return {
        connect() { callbacks.onSetupComplete(); },
        sendPcm16(pcm) {
          sentInputMarkers.push(pcm.readInt16LE(0));
          return true;
        },
        sendAudioStreamEnd() { return true; },
        close() {},
      };
    },
  });
  const service = new BrowserMeetingService({
    roomName: "meeting-1",
    livekitUrl: "ws://127.0.0.1:7880",
    tokenIssuer: async ({ id }) => `token:${id}`,
    participantIdFactory: () => `participant-${++participantSequence}`,
    utteranceIdFactory: () => `utterance-${++utteranceSequence}`,
    translationBridge: bridge,
  });

  const speaker = (await service.join({ name: "Yuki", language: "ja" })).participant;
  const listener = (await service.join({ name: "민준", language: "ko" })).participant;
  const microphoneOn = await service.mic(speaker.id, true);
  assert.equal(microphoneOn.participants.find(({ id }) => id === speaker.id).speech, "silent");
  assert.deepEqual(microphoneOn.participants.find(({ id }) => id === listener.id).audio, {
    mode: "silent",
    tracks: [],
  });

  for (let marker = 1_001; marker <= 1_012; marker += 1) {
    originalFrame(audioFrame(marker), 16_000);
  }
  const firstSpeech = await service.speechActivity({
    participantId: speaker.id,
    type: "speech-start",
    observedAt: 100,
  });
  originalFrame(audioFrame(1_013), 16_000);

  const firstPlan = firstSpeech.participants.find(({ id }) => id === listener.id).audio;
  assert.equal(firstPlan.mode, "translation-focused");
  assert.deepEqual(firstPlan.tracks.map(({ kind, role, utteranceId }) => ({
    kind,
    role,
    utteranceId,
  })), [
    { kind: "original", role: "background", utteranceId: "utterance-1" },
    { kind: "translation", role: "foreground", utteranceId: "utterance-1" },
  ]);
  const original = firstPlan.tracks.find(({ kind }) => kind === "original");
  const translation = firstPlan.tracks.find(({ kind }) => kind === "translation");
  assert.ok(original.gain > 0);
  assert.ok(original.gain < translation.gain);

  await geminiCallbacks.onTranslatedAudio(audioFrame(2_001).toString("base64"));
  const endingFirstSpeech = service.speechActivity({
    participantId: speaker.id,
    type: "speech-end",
    observedAt: 200,
  });
  await new Promise((resolve) => setImmediate(resolve));
  await geminiCallbacks.onTranslatedAudio(audioFrame(2_002).toString("base64"));
  geminiCallbacks.onGenerationComplete();
  const firstSilent = await endingFirstSpeech;

  assert.deepEqual(sentInputMarkers, [
    1_003, 1_004, 1_005, 1_006, 1_007, 1_008, 1_009, 1_010, 1_011, 1_012, 1_013,
  ]);
  assert.deepEqual(capturedTranslationMarkers, [2_001, 2_002]);
  assert.equal(firstSilent.participants.find(({ id }) => id === speaker.id).microphone, "unmuted");

  const secondSpeech = await service.speechActivity({
    participantId: speaker.id,
    type: "speech-start",
    observedAt: 300,
  });
  const secondPlan = secondSpeech.participants.find(({ id }) => id === listener.id).audio;
  assert.equal(secondPlan.mode, "translation-focused");
  assert.deepEqual(
    secondPlan.tracks.map(({ utteranceId }) => utteranceId),
    ["utterance-2", "utterance-2"],
  );
  assert.equal(geminiClientCount, 1);
  assert.equal(originalSubscriptionCount, 1);

  await service.mic(speaker.id, false);
});

function audioFrame(marker) {
  const frame = Buffer.alloc(3_200);
  frame.writeInt16LE(marker);
  return frame;
}
