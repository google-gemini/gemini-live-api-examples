import assert from "node:assert/strict";
import test from "node:test";

import {
  dualProbeContractResult,
  scoreDualProbePlayout,
  scoreProviderBrowserPlayout,
  summarizeProviderBrowserRuns,
  waitForCanarySignal,
} from "../src/provider-browser-playout.mjs";

const FRAME_DURATION_MS = 20;

function providerFrames(rmsValues) {
  return rmsValues.map((rms) => ({ rms }));
}

function browserFrames(rmsValues, startMs = 1_000) {
  return rmsValues.map((rms, index) => ({
    atMs: startMs + index * FRAME_DURATION_MS,
    rms,
  }));
}

function healthyRtp(startMs = 1_000, endMs = 1_160) {
  return [
    {
      atMs: startMs,
      packetsReceived: 10,
      packetsLost: 0,
      concealedSamples: 0,
      concealmentEvents: 0,
    },
    {
      atMs: endMs,
      packetsReceived: 18,
      packetsLost: 0,
      concealedSamples: 0,
      concealmentEvents: 0,
    },
  ];
}

test("natural silence present in both Gemini output and Chrome playout passes", () => {
  const result = scoreProviderBrowserPlayout({
    frameDurationMs: FRAME_DURATION_MS,
    providerFrames: providerFrames([0.2, 0.2, 0, 0, 0, 0.2, 0.2, 0.2]),
    browserFrames: browserFrames([0.18, 0.17, 0, 0, 0, 0.16, 0.17, 0.16]),
    publisherQueue: [{ atMs: 1_080, queuedDurationMs: 100 }],
    rtpSamples: healthyRtp(),
  });

  assert.equal(result.ok, true);
  assert.equal(result.location, "provider_to_browser_continuous");
  assert.equal(result.providerSilentRunMs, 60);
  assert.equal(result.unexpectedSilentRunMs, 0);
});

test("Chrome-only 120ms silence with healthy upstream identifies browser playout", () => {
  const result = scoreProviderBrowserPlayout({
    frameDurationMs: FRAME_DURATION_MS,
    providerFrames: providerFrames(Array(10).fill(0.2)),
    browserFrames: browserFrames([0.2, 0.2, 0, 0, 0, 0, 0, 0, 0.2, 0.2]),
    publisherQueue: [{ atMs: 1_100, queuedDurationMs: 120 }],
    rtpSamples: healthyRtp(),
  });

  assert.equal(result.ok, false);
  assert.equal(result.location, "browser_media_element_playout");
  assert.equal(result.unexpectedSilentRunMs, 120);
});

test("the same downstream gap uses correlated queue and RTP evidence", () => {
  const common = {
    frameDurationMs: FRAME_DURATION_MS,
    providerFrames: providerFrames(Array(10).fill(0.2)),
    browserFrames: browserFrames([0.2, 0.2, 0, 0, 0, 0, 0, 0, 0.2, 0.2]),
  };
  const underflow = scoreProviderBrowserPlayout({
    ...common,
    publisherQueue: [{ atMs: 1_100, queuedDurationMs: 0 }],
    rtpSamples: healthyRtp(),
  });
  const receiveStall = scoreProviderBrowserPlayout({
    ...common,
    publisherQueue: [{ atMs: 1_100, queuedDurationMs: 120 }],
    rtpSamples: [
      { ...healthyRtp()[0], atMs: 1_040 },
      { ...healthyRtp()[0], atMs: 1_160 },
    ],
  });

  assert.equal(underflow.location, "publisher_queue_underflow");
  assert.equal(receiveStall.location, "browser_webrtc_receive_or_decode");
});

test("missing Gemini output is a provider failure, not a browser failure", () => {
  const result = scoreProviderBrowserPlayout({
    frameDurationMs: FRAME_DURATION_MS,
    providerFrames: [],
    browserFrames: [],
    publisherQueue: [],
    rtpSamples: [],
  });

  assert.deepEqual(result, {
    ok: false,
    location: "gemini_output_missing",
    providerFrameCount: 0,
    browserFrameCount: 0,
    providerSilentRunMs: 0,
    unexpectedSilentRunMs: 0,
    tailLossMs: 0,
  });
});

test("a missing Chrome tail is measured against Gemini output duration", () => {
  const result = scoreProviderBrowserPlayout({
    frameDurationMs: FRAME_DURATION_MS,
    providerFrames: providerFrames(Array(10).fill(0.2)),
    browserFrames: browserFrames(Array(5).fill(0.2)),
    publisherQueue: [{ atMs: 1_140, queuedDurationMs: 100 }],
    rtpSamples: healthyRtp(1_040, 1_180),
  });

  assert.equal(result.ok, false);
  assert.equal(result.location, "browser_media_element_playout");
  assert.equal(result.tailLossMs, 100);
});

test("a drained queue after all provider audio was published cannot cause tail underflow", () => {
  const result = scoreProviderBrowserPlayout({
    frameDurationMs: FRAME_DURATION_MS,
    providerFrames: providerFrames(Array(10).fill(0.2)),
    browserFrames: browserFrames(Array(5).fill(0.2)),
    publisherQueue: [
      { atMs: 1_080, queuedDurationMs: 100 },
      { atMs: 1_140, queuedDurationMs: 0 },
    ],
    publisherCompleteAtMs: 1_100,
    rtpSamples: healthyRtp(1_040, 1_180),
  });

  assert.equal(result.ok, false);
  assert.equal(result.location, "browser_media_element_playout");
  assert.equal(result.queueFloorAtFailure, false);
});

test("five-run latency summary reports p50 and p95 for start and end", () => {
  const summary = summarizeProviderBrowserRuns([
    { firstProviderAudioMs: 100, providerEndAfterInputEndMs: 500 },
    { firstProviderAudioMs: 200, providerEndAfterInputEndMs: 400 },
    { firstProviderAudioMs: 300, providerEndAfterInputEndMs: 300 },
    { firstProviderAudioMs: 400, providerEndAfterInputEndMs: 200 },
    { firstProviderAudioMs: 500, providerEndAfterInputEndMs: 100 },
  ]);

  assert.deepEqual(summary, {
    firstProviderAudioMs: { p50: 300, p95: 500 },
    providerEndAfterInputEndMs: { p50: 300, p95: 500 },
  });
});

test("provider errors win even when a completion signal is already true", async () => {
  const providerError = new Error("provider failed");
  await assert.rejects(
    waitForCanarySignal({
      predicate: () => true,
      readError: () => providerError,
      timeoutMs: 10,
    }),
    providerError,
  );
});

test("dual probe passes when raw track and audio element stay continuous", () => {
  const result = scoreDualProbePlayout({
    frameDurationMs: FRAME_DURATION_MS,
    providerFrames: providerFrames(Array(10).fill(0.2)),
    rawTrackFrames: browserFrames(Array(10).fill(0.18)),
    elementFrames: browserFrames(Array(10).fill(0.17)),
    publisherQueue: [{ atMs: 1_100, queuedDurationMs: 120 }],
    rtpSamples: healthyRtp(),
  });

  assert.equal(result.ok, true);
  assert.equal(result.location, "provider_to_audio_element_continuous");
});

test("dual probe locates silence added only by the audio element path", () => {
  const result = scoreDualProbePlayout({
    frameDurationMs: FRAME_DURATION_MS,
    providerFrames: providerFrames(Array(10).fill(0.2)),
    rawTrackFrames: browserFrames(Array(10).fill(0.18)),
    elementFrames: browserFrames([0.17, 0.17, 0, 0, 0, 0, 0, 0, 0.17, 0.17]),
    publisherQueue: [{ atMs: 1_100, queuedDurationMs: 120 }],
    rtpSamples: healthyRtp(),
  });

  assert.equal(result.ok, false);
  assert.equal(result.location, "browser_audio_element_playout");
  assert.equal(result.rawTrack.ok, true);
  assert.equal(result.audioElement.unexpectedSilentRunMs, 120);
});

test("dual probe locates silence shared by both browser probes", () => {
  const silent = [0.17, 0.17, 0, 0, 0, 0, 0, 0, 0.17, 0.17];
  const result = scoreDualProbePlayout({
    frameDurationMs: FRAME_DURATION_MS,
    providerFrames: providerFrames(Array(10).fill(0.2)),
    rawTrackFrames: browserFrames(silent),
    elementFrames: browserFrames(silent),
    publisherQueue: [{ atMs: 1_100, queuedDurationMs: 120 }],
    rtpSamples: healthyRtp(),
  });

  assert.equal(result.ok, false);
  assert.equal(result.location, "browser_shared_audio_render_path");
  assert.equal(result.rawTrack.unexpectedSilentRunMs, 120);
  assert.equal(result.audioElement.unexpectedSilentRunMs, 120);
});

test("dual probe does not call non-overlapping failures shared", () => {
  const result = scoreDualProbePlayout({
    frameDurationMs: FRAME_DURATION_MS,
    providerFrames: providerFrames(Array(12).fill(0.2)),
    rawTrackFrames: browserFrames([0.2, 0.2, 0, 0, 0, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2]),
    elementFrames: browserFrames([0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0, 0, 0, 0.2, 0.2]),
    publisherQueue: [
      { atMs: 1_040, queuedDurationMs: 120 },
      { atMs: 1_160, queuedDurationMs: 120 },
    ],
    rtpSamples: healthyRtp(1_000, 1_240),
  });

  assert.equal(result.ok, false);
  assert.equal(result.location, "browser_probe_disagreement");
});

test("dual probe contract retains a raw-only failure", () => {
  const result = scoreDualProbePlayout({
    frameDurationMs: FRAME_DURATION_MS,
    providerFrames: providerFrames(Array(10).fill(0.2)),
    rawTrackFrames: browserFrames([0.2, 0.2, 0, 0, 0, 0, 0, 0, 0.2, 0.2]),
    elementFrames: browserFrames(Array(10).fill(0.2)),
    publisherQueue: [{ atMs: 1_100, queuedDurationMs: 120 }],
    rtpSamples: healthyRtp(),
  });

  assert.equal(result.unexpectedSilentRunMs, 120);
  assert.deepEqual(dualProbeContractResult(result), {
    ok: false,
    location: "browser_raw_track_probe_inconsistent",
    rawTrack: {
      ok: false,
      location: "browser_media_element_playout",
      silenceExceeded: true,
      tailLossExceeded: false,
    },
    audioElement: {
      ok: true,
      location: "provider_to_browser_continuous",
      silenceExceeded: false,
      tailLossExceeded: false,
    },
  });
});

test("dual probe contract keeps incomplete evidence fail-closed", () => {
  assert.deepEqual(dualProbeContractResult({
    ok: false,
    location: "canary_evidence_incomplete",
  }), {
    ok: false,
    location: "canary_evidence_incomplete",
    evidenceIncomplete: true,
  });
});

test("dual probe does not hide an element-only gap beside a shared gap", () => {
  const result = scoreDualProbePlayout({
    frameDurationMs: FRAME_DURATION_MS,
    providerFrames: providerFrames(Array(16).fill(0.2)),
    rawTrackFrames: browserFrames([
      0.2, 0.2, 0, 0, 0, 0.2, 0.2, 0.2,
      0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2,
    ]),
    elementFrames: browserFrames([
      0.2, 0.2, 0, 0, 0, 0.2, 0.2, 0.2,
      0.2, 0.2, 0, 0, 0, 0.2, 0.2, 0.2,
    ]),
    publisherQueue: [
      { atMs: 1_040, queuedDurationMs: 120 },
      { atMs: 1_200, queuedDurationMs: 120 },
    ],
    rtpSamples: healthyRtp(1_000, 1_300),
  });

  assert.equal(result.ok, false);
  assert.equal(result.location, "browser_probe_disagreement");
});

test("dual probe does not call partially overlapping failure windows shared", () => {
  const result = scoreDualProbePlayout({
    frameDurationMs: FRAME_DURATION_MS,
    providerFrames: providerFrames(Array(12).fill(0.2)),
    rawTrackFrames: browserFrames([
      0.2, 0.2, 0, 0, 0, 0, 0, 0.2, 0.2, 0.2, 0.2, 0.2,
    ]),
    elementFrames: browserFrames([
      0.2, 0.2, 0, 0, 0, 0.2, 0, 0, 0, 0, 0.2, 0.2,
    ]),
    publisherQueue: [
      { atMs: 1_060, queuedDurationMs: 120 },
      { atMs: 1_160, queuedDurationMs: 120 },
    ],
    rtpSamples: healthyRtp(1_000, 1_240),
  });

  assert.equal(result.ok, false);
  assert.equal(result.location, "browser_probe_disagreement");
});
