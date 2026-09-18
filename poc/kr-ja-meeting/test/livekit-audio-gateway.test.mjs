import assert from "node:assert/strict";
import test from "node:test";

import { dispose, RoomEvent } from "@livekit/rtc-node";

import { LiveKitAudioGateway } from "../src/livekit-audio-gateway.mjs";
import { MeetingEventRecorder } from "../src/meeting-event-recorder.mjs";
import { sineFrame } from "../src/playout-continuity.mjs";

test("translation sink exposes queue state and explicit playout lifecycle", async () => {
  const published = [];
  const gateway = new LiveKitAudioGateway({
    localParticipant: {
      async publishTrack(track, options) {
        published.push({ track, options });
      },
    },
  });

  try {
    const sink = await gateway.translationSink("ja");

    assert.equal(typeof sink.queuedDurationMs, "function");
    assert.equal(typeof sink.waitForPlayout, "function");
    assert.equal(typeof sink.clearQueue, "function");
    assert.equal(sink.queuedDurationMs(), 0);

    const capture = await sink.capture(sineFrame());
    assert.equal(capture.queuedBeforeMs, 0);
    assert.ok(capture.queuedAfterMs > 0);
    assert.ok(capture.captureWaitMs >= 0);

    await sink.waitForPlayout();
    assert.equal(sink.queuedDurationMs(), 0);

    const staleGeneration = {};
    sink.invalidateGeneration(staleGeneration);
    const stale = await sink.capture(sineFrame(), staleGeneration);
    assert.equal(stale.committed, false);
    assert.equal(sink.queuedDurationMs(), 0);

    const fresh = await sink.capture(sineFrame(), {});
    assert.equal(fresh.committed, true);
    assert.ok(sink.queuedDurationMs() > 0);
    await sink.waitForPlayout();
    sink.clearQueue();
    assert.equal(published.length, 1);
  } finally {
    await gateway.close();
    dispose();
  }
});

test("publish and disconnect cleanup use privacy-safe lifecycle events", async () => {
  const events = [];
  const handlers = new Map();
  const recorder = new MeetingEventRecorder({
    meetingId: "meeting-1",
    clock: () => 900,
    write(event) { events.push(event); },
  });
  const room = {
    localParticipant: { async publishTrack() {} },
    on(type, handler) { handlers.set(type, handler); },
    off(type) { handlers.delete(type); },
  };
  const gateway = new LiveKitAudioGateway(room, { eventRecorder: recorder });

  try {
    await gateway.translationSink("ja");
    handlers.get(RoomEvent.Disconnected)();
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(events, [
      {
        type: "livekit-publish-started",
        meetingId: "meeting-1",
        language: "ja",
        trackId: "translation:ja",
        trackKind: "translation",
        timestamp: 900,
        result: "started",
      },
      {
        type: "livekit-publish-succeeded",
        meetingId: "meeting-1",
        language: "ja",
        trackId: "translation:ja",
        trackKind: "translation",
        timestamp: 900,
        result: "succeeded",
      },
      {
        type: "resources-closed",
        meetingId: "meeting-1",
        timestamp: 900,
        result: "disconnected",
      },
    ]);
  } finally {
    await gateway.close();
    dispose();
  }
});
