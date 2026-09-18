import assert from "node:assert/strict";
import test from "node:test";

import {
  browserPlayoutContractResult,
  scoreBrowserPlayout as scoreBrowserPlayoutRaw,
} from "../src/browser-playout-continuity.mjs";

function framesAt(timestamps, rms = 0.25) {
  return timestamps.map((atMs) => ({ atMs, rms }));
}

function scoreBrowserPlayout(input) {
  return scoreBrowserPlayoutRaw({
    ...input,
    rtpSamples: input.rtpSamples.map((sample, index) => ({
      packetsReceived: index * 5,
      ...sample,
    })),
  });
}

test("continuous audio element capture passes the browser playout contract", () => {
  const result = scoreBrowserPlayout({
    frameDurationMs: 20,
    expectedFrameCount: 100,
    browserFrames: framesAt(Array.from({ length: 100 }, (_, index) => 1_000 + index * 20)),
    publisherQueue: [{ atMs: 1_500, queuedDurationMs: 200 }],
    rtpSamples: [
      { atMs: 1_000, packetsLost: 0, concealedSamples: 0, concealmentEvents: 0 },
      { atMs: 3_000, packetsLost: 0, concealedSamples: 0, concealmentEvents: 0 },
    ],
  });

  assert.deepEqual(result, {
    ok: true,
    location: "browser_element_continuous",
    maxBrowserFrameGapMs: 20,
    silentRunMs: 0,
    tailLossMs: 0,
    queueFloorAtFailure: false,
    rtpDisruptionAtFailure: false,
    failureWindows: [],
  });
});

test("browser silence correlated with a publisher queue floor identifies underflow", () => {
  const result = scoreBrowserPlayout({
    frameDurationMs: 20,
    expectedFrameCount: 8,
    browserFrames: [
      ...framesAt([1_000, 1_020], 0.25),
      ...framesAt([1_040, 1_060, 1_080, 1_100], 0),
      ...framesAt([1_120, 1_140], 0.25),
    ],
    publisherQueue: [{ atMs: 1_060, queuedDurationMs: 0 }],
    rtpSamples: [
      { atMs: 1_020, packetsLost: 0, concealedSamples: 0, concealmentEvents: 0 },
      { atMs: 1_120, packetsLost: 0, concealedSamples: 0, concealmentEvents: 0 },
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(result.location, "publisher_queue_underflow");
  assert.equal(result.silentRunMs, 80);
});

test("browser silence correlated with RTP concealment identifies receive or decode", () => {
  const result = scoreBrowserPlayout({
    frameDurationMs: 20,
    expectedFrameCount: 8,
    browserFrames: [
      ...framesAt([1_000, 1_020], 0.25),
      ...framesAt([1_040, 1_060, 1_080, 1_100], 0),
      ...framesAt([1_120, 1_140], 0.25),
    ],
    publisherQueue: [{ atMs: 1_060, queuedDurationMs: 100 }],
    rtpSamples: [
      { atMs: 1_020, packetsLost: 0, concealedSamples: 0, concealmentEvents: 0 },
      { atMs: 1_080, packetsLost: 0, concealedSamples: 960, concealmentEvents: 1 },
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(result.location, "browser_webrtc_receive_or_decode");
});

test("browser silence with healthy publisher and RTP identifies media element playout", () => {
  const result = scoreBrowserPlayout({
    frameDurationMs: 20,
    expectedFrameCount: 8,
    browserFrames: [
      ...framesAt([1_000, 1_020], 0.25),
      ...framesAt([1_040, 1_060, 1_080, 1_100], 0),
      ...framesAt([1_120, 1_140], 0.25),
    ],
    publisherQueue: [{ atMs: 1_060, queuedDurationMs: 100 }],
    rtpSamples: [
      { atMs: 1_020, packetsLost: 0, concealedSamples: 0, concealmentEvents: 0 },
      { atMs: 1_080, packetsLost: 0, concealedSamples: 0, concealmentEvents: 0 },
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(result.location, "browser_media_element_playout");
});

test("unrelated earlier queue and RTP changes do not classify a later browser failure", () => {
  const result = scoreBrowserPlayout({
    frameDurationMs: 20,
    expectedFrameCount: 6,
    browserFrames: [
      ...framesAt([2_000, 2_020], 0.25),
      ...framesAt([2_040, 2_060, 2_080, 2_100], 0),
    ],
    publisherQueue: [
      { atMs: 1_000, queuedDurationMs: 0 },
      { atMs: 2_060, queuedDurationMs: 100 },
    ],
    rtpSamples: [
      { atMs: 900, packetsLost: 0, concealedSamples: 0, concealmentEvents: 0 },
      { atMs: 1_000, packetsLost: 1, concealedSamples: 960, concealmentEvents: 1 },
      { atMs: 2_020, packetsLost: 1, concealedSamples: 960, concealmentEvents: 1 },
      { atMs: 2_100, packetsLost: 1, concealedSamples: 960, concealmentEvents: 1 },
    ],
  });

  assert.equal(result.location, "browser_media_element_playout");
});

test("non-finite browser evidence fails closed", () => {
  assert.throws(() => scoreBrowserPlayout({
    frameDurationMs: 20,
    expectedFrameCount: 1,
    browserFrames: [{ atMs: Number.NaN, rms: 0.25 }],
    publisherQueue: [],
    rtpSamples: [],
  }), /finite/);
});

test("missing browser audio evidence fails closed", () => {
  assert.throws(() => scoreBrowserPlayout({
    frameDurationMs: 20,
    expectedFrameCount: 1,
    browserFrames: [],
    publisherQueue: [],
    rtpSamples: [],
  }), /browser audio evidence/);
});

test("truncated browser playout fails the expected duration contract", () => {
  const result = scoreBrowserPlayout({
    frameDurationMs: 20,
    expectedFrameCount: 8,
    browserFrames: framesAt([1_000, 1_020, 1_040, 1_060]),
    publisherQueue: [{ atMs: 1_100, queuedDurationMs: 100 }],
    rtpSamples: [
      { atMs: 1_000, packetsLost: 0, concealedSamples: 0, concealmentEvents: 0 },
      { atMs: 1_140, packetsLost: 0, concealedSamples: 0, concealmentEvents: 0 },
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(result.location, "browser_media_element_playout");
  assert.equal(result.tailLossMs, 80);
});

test("missing publisher or RTP attribution evidence fails closed", () => {
  const browserFrames = framesAt([1_000, 1_020, 1_040]);
  const healthyRtp = [
    { atMs: 1_000, packetsLost: 0, concealedSamples: 0, concealmentEvents: 0 },
    { atMs: 1_040, packetsLost: 0, concealedSamples: 0, concealmentEvents: 0 },
  ];
  assert.throws(() => scoreBrowserPlayout({
    frameDurationMs: 20,
    expectedFrameCount: 3,
    browserFrames,
    publisherQueue: [],
    rtpSamples: healthyRtp,
  }), /publisher queue evidence/);
  assert.throws(() => scoreBrowserPlayout({
    frameDurationMs: 20,
    expectedFrameCount: 3,
    browserFrames,
    publisherQueue: [{ atMs: 1_020, queuedDurationMs: 100 }],
    rtpSamples: healthyRtp.slice(0, 1),
  }), /RTP evidence/);
});

test("repeat contract normalization includes tail loss", () => {
  const base = {
    ok: false,
    location: "browser_media_element_playout",
    maxBrowserFrameGapMs: 20,
    silentRunMs: 0,
    queueFloorAtFailure: false,
    rtpDisruptionAtFailure: false,
  };

  assert.notDeepEqual(
    browserPlayoutContractResult({ ...base, tailLossMs: 0 }),
    browserPlayoutContractResult({ ...base, tailLossMs: 80 }),
  );
});

test("attribution evidence must cover the browser failure window", () => {
  const browserFrames = [
    ...framesAt([2_000, 2_020], 0.25),
    ...framesAt([2_040, 2_060, 2_080, 2_100], 0),
  ];
  const oldRtp = [
    { atMs: 900, packetsLost: 0, concealedSamples: 0, concealmentEvents: 0 },
    { atMs: 1_000, packetsLost: 0, concealedSamples: 0, concealmentEvents: 0 },
  ];
  assert.throws(() => scoreBrowserPlayout({
    frameDurationMs: 20,
    expectedFrameCount: 6,
    browserFrames,
    publisherQueue: [{ atMs: 2_060, queuedDurationMs: 100 }],
    rtpSamples: oldRtp,
  }), /RTP evidence does not cover/);
  assert.throws(() => scoreBrowserPlayout({
    frameDurationMs: 20,
    expectedFrameCount: 6,
    browserFrames,
    publisherQueue: [{ atMs: 1_000, queuedDurationMs: 100 }],
    rtpSamples: [
      ...oldRtp,
      { atMs: 2_020, packetsLost: 0, concealedSamples: 0, concealmentEvents: 0 },
      { atMs: 2_100, packetsLost: 0, concealedSamples: 0, concealmentEvents: 0 },
    ],
  }), /publisher queue evidence does not cover/);
});

test("a bounded RTP interval must bracket the failure and prove receive progress", () => {
  const browserFrames = [
    ...framesAt([2_000, 2_020], 0.25),
    ...framesAt([2_040, 2_060, 2_080, 2_100], 0),
  ];
  const base = {
    frameDurationMs: 20,
    expectedFrameCount: 6,
    browserFrames,
    publisherQueue: [{ atMs: 2_060, queuedDurationMs: 100 }],
  };
  assert.throws(() => scoreBrowserPlayout({
    ...base,
    rtpSamples: [
      { atMs: 1_000, packetsReceived: 0, packetsLost: 0, concealedSamples: 0, concealmentEvents: 0 },
      { atMs: 2_060, packetsReceived: 10, packetsLost: 0, concealedSamples: 0, concealmentEvents: 0 },
    ],
  }), /RTP evidence does not cover/);

  const stalled = scoreBrowserPlayout({
    ...base,
    rtpSamples: [
      { atMs: 2_020, packetsReceived: 10, packetsLost: 0, concealedSamples: 0, concealmentEvents: 0 },
      { atMs: 2_100, packetsReceived: 10, packetsLost: 0, concealedSamples: 0, concealmentEvents: 0 },
    ],
  });
  assert.equal(stalled.location, "browser_webrtc_receive_or_decode");
});

test("missing RTP receive counters fail closed", () => {
  assert.throws(() => scoreBrowserPlayoutRaw({
    frameDurationMs: 20,
    expectedFrameCount: 3,
    browserFrames: framesAt([1_000, 1_020, 1_040]),
    publisherQueue: [{ atMs: 1_020, queuedDurationMs: 100 }],
    rtpSamples: [
      { atMs: 1_000, packetsLost: 0, concealedSamples: 0, concealmentEvents: 0 },
      { atMs: 1_040, packetsLost: 0, concealedSamples: 0, concealmentEvents: 0 },
    ],
  }), /packetsReceived/);
});
