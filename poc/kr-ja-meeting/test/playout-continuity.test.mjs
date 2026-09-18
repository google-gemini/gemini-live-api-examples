import assert from "node:assert/strict";
import test from "node:test";

import {
  contractResult,
  gapFrameCount,
  pcm16Rms,
  scoreContinuity,
  sineFrame,
  withTimeout,
} from "../src/playout-continuity.mjs";

function framesAt(timestamps, rms = 4_000) {
  return timestamps.map((receivedAtMs) => ({ receivedAtMs, rms }));
}

test("continuous 20ms receive frames pass the playout contract", () => {
  const received = framesAt(Array.from({ length: 100 }, (_, index) => index * 20));
  const result = scoreContinuity({
    frameDurationMs: 20,
    expectedDurationMs: 2_000,
    received,
    queue: [{ atMs: 0, queuedDurationMs: 200 }],
  });

  assert.deepEqual(result, {
    ok: true,
    location: "node_loopback_continuous",
    maxReceiveGapMs: 20,
    silentRunMs: 0,
    tailLossMs: 0,
    extraAudioMs: 0,
    queueFloorCount: 0,
  });
});

test("120ms receive gap with an empty queue identifies publisher underflow", () => {
  const result = scoreContinuity({
    frameDurationMs: 20,
    expectedDurationMs: 120,
    received: framesAt([0, 20, 40, 160, 180, 200]),
    queue: [{ atMs: 150, queuedDurationMs: 0 }],
  });

  assert.equal(result.ok, false);
  assert.equal(result.location, "publisher_queue_underflow");
  assert.equal(result.maxReceiveGapMs, 120);
});

test("120ms receive gap with audio still queued identifies LiveKit transport or decode", () => {
  const result = scoreContinuity({
    frameDurationMs: 20,
    expectedDurationMs: 120,
    received: framesAt([0, 20, 40, 160, 180, 200]),
    queue: [{ atMs: 150, queuedDurationMs: 100 }],
  });

  assert.equal(result.ok, false);
  assert.equal(result.location, "livekit_transport_or_decode");
});

test("an unrelated earlier queue floor does not classify a later receive gap as underflow", () => {
  const result = scoreContinuity({
    frameDurationMs: 20,
    expectedDurationMs: 120,
    received: framesAt([100, 120, 140, 260, 280, 300]),
    queue: [
      { atMs: 0, queuedDurationMs: 0 },
      { atMs: 250, queuedDurationMs: 100 },
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(result.location, "livekit_transport_or_decode");
  assert.equal(result.queueFloorCount, 0);
});

test("non-finite receive and queue evidence is rejected", () => {
  assert.throws(() => scoreContinuity({
    frameDurationMs: 20,
    expectedDurationMs: 100,
    received: [{ receivedAtMs: Number.NaN, rms: 4_000 }],
    queue: [],
  }), /finite/);
  assert.throws(() => scoreContinuity({
    frameDurationMs: 20,
    expectedDurationMs: 100,
    received: framesAt([0]),
    queue: [{ atMs: 0, queuedDurationMs: Number.NaN }],
  }), /finite/);
});

test("consecutive silent PCM and tail loss fail independently of receive timing", () => {
  const silent = scoreContinuity({
    frameDurationMs: 20,
    expectedDurationMs: 100,
    received: [
      ...framesAt([0, 20], 4_000),
      ...framesAt([40, 60, 80], 0),
    ],
    queue: [{ atMs: 0, queuedDurationMs: 100 }],
  });
  const tail = scoreContinuity({
    frameDurationMs: 20,
    expectedDurationMs: 200,
    received: framesAt([0, 20, 40, 60, 80]),
    queue: [{ atMs: 0, queuedDurationMs: 200 }],
  });

  assert.equal(silent.silentRunMs, 60);
  assert.equal(silent.ok, false);
  assert.equal(tail.tailLossMs, 100);
  assert.equal(tail.ok, false);
});

test("more than 60ms of extra received audio fails the contract", () => {
  const result = scoreContinuity({
    frameDurationMs: 20,
    expectedDurationMs: 100,
    received: framesAt(Array.from({ length: 10 }, (_, index) => index * 20)),
    queue: [{ atMs: 100, queuedDurationMs: 100 }],
  });

  assert.equal(result.extraAudioMs, 100);
  assert.equal(result.ok, false);
  assert.equal(result.location, "livekit_transport_or_decode");
});

test("sine fixture is deterministic 24kHz PCM16 with measurable energy", () => {
  const first = sineFrame();
  const second = sineFrame();

  assert.equal(first.length, 960);
  assert.deepEqual(first, second);
  assert.ok(pcm16Rms(first) > 5_000);
});

test("contract result ignores volatile runtime measurements but retains contract evidence", () => {
  const first = contractResult({
    ok: true,
    location: "node_loopback_continuous",
    maxReceiveGapMs: 21.2,
    silentRunMs: 20,
    tailLossMs: 20,
    extraAudioMs: 20,
    queueFloorCount: 0,
    audibleFrameCount: 301,
    captureWaitP95Ms: 0.4,
  });
  const second = contractResult({
    ok: true,
    location: "node_loopback_continuous",
    maxReceiveGapMs: 34.8,
    silentRunMs: 0,
    tailLossMs: 0,
    extraAudioMs: 60,
    queueFloorCount: 0,
    audibleFrameCount: 301,
    captureWaitP95Ms: 1.1,
  });

  assert.deepEqual(first, second);
  assert.equal(first.silenceExceeded, false);
  assert.equal(first.tailLossExceeded, false);
  assert.equal(first.extraAudioExceeded, false);
});

test("contract result treats correlated queue floor counts as one underflow signal", () => {
  const base = {
    ok: false,
    location: "publisher_queue_underflow",
    maxReceiveGapMs: 120,
    silentRunMs: 80,
    tailLossMs: 0,
    extraAudioMs: 20,
    audibleFrameCount: 301,
    captureWaitP95Ms: 0.5,
  };

  assert.deepEqual(
    contractResult({ ...base, queueFloorCount: 5 }),
    contractResult({ ...base, queueFloorCount: 6 }),
  );
});

test("withTimeout rejects a stalled operation", async () => {
  await assert.rejects(
    withTimeout(new Promise(() => {}), 5, "stalled operation"),
    /timed out.*stalled operation/,
  );
});

test("injected gaps must align to the 20ms audio frame contract", () => {
  assert.equal(gapFrameCount(120, 20), 6);
  assert.throws(() => gapFrameCount(1, 20), /multiple of 20ms/);
});
