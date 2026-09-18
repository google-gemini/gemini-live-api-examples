import { dispose } from "@livekit/rtc-node";

import {
  browserPlayoutContractResult,
  scoreBrowserPlayout,
} from "../src/browser-playout-continuity.mjs";
import {
  connectCanaryPublisher,
  openBrowserPlayout,
} from "../src/browser-playout-harness.mjs";
import { LiveKitAudioGateway } from "../src/livekit-audio-gateway.mjs";
import { sineFrame, withTimeout } from "../src/playout-continuity.mjs";

const SAMPLE_RATE = 24_000;
const FRAME_DURATION_MS = 20;
const PREFILL_FRAMES = 10;
const TOTAL_FRAMES = 300;
const NORMAL_STALL_FRAME = 100;
const NORMAL_STALL_MS = 120;
const OPERATION_TIMEOUT_MS = 15_000;
const livekitUrl = process.env.LIVEKIT_URL ?? "ws://127.0.0.1:7880";
const livekitApiKey = process.env.LIVEKIT_API_KEY ?? "devkey";
const livekitApiSecret = process.env.LIVEKIT_API_SECRET ?? "secret";
const argumentsByName = readArguments(process.argv.slice(2));
const repeat = positiveInteger(argumentsByName.get("repeat") ?? "1", "--repeat");
const seed = positiveInteger(argumentsByName.get("seed") ?? "20260826", "--seed");
const injectedMuteMs = argumentsByName.has("inject-element-mute-ms")
  ? positiveInteger(
    argumentsByName.get("inject-element-mute-ms"),
    "--inject-element-mute-ms",
  )
  : 0;
const results = [];

try {
  for (let index = 0; index < repeat; index += 1) {
    results.push(await runOnce({ run: index + 1, seed, injectedMuteMs }));
  }
  const contractResults = results.map((scorecard) => browserPlayoutContractResult(scorecard));
  const contractConsistent = new Set(contractResults.map((value) => JSON.stringify(value))).size === 1;
  const ok = results.every((scorecard) => scorecard.ok) && contractConsistent;
  process.stdout.write(`${JSON.stringify({
    ok,
    injectedMuteMilliseconds: injectedMuteMs,
    contractConsistent,
    runs: results.map((scorecard) => ({
      continuous: scorecard.ok,
      maximumGapMilliseconds: scorecard.maxBrowserFrameGapMs,
      silentRunMilliseconds: scorecard.silentRunMs,
      tailLossMilliseconds: scorecard.tailLossMs,
    })),
  })}\n`);
  if (!ok) process.exitCode = 1;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`browser playout canary failed: ${message}\n`);
  process.exitCode = 1;
} finally {
  dispose();
}

async function runOnce({ run, seed: runSeed, injectedMuteMs: muteMs }) {
  const runId = `${Date.now()}-${process.pid}-${run}`;
  const roomName = `browser-playout-${runId}`;
  let publisher;
  let gateway;
  let browserPlayout;
  const publisherEvents = [];
  const publisherQueue = [];

  try {
    publisher = await connectCanaryPublisher({
      livekitUrl,
      livekitApiKey,
      livekitApiSecret,
      roomName,
      identity: `publisher-${runId}`,
      timeoutMs: OPERATION_TIMEOUT_MS,
    });
    gateway = new LiveKitAudioGateway(publisher);
    const sink = await withTimeout(
      gateway.translationSink("ja"),
      OPERATION_TIMEOUT_MS,
      "translation track publication",
    );
    browserPlayout = await openBrowserPlayout({
      livekitUrl,
      livekitApiKey,
      livekitApiSecret,
      roomName,
      identity: `browser-${runId}`,
      trackName: "translation:ja",
      timeoutMs: OPERATION_TIMEOUT_MS,
    });

    const frame = sineFrame({ sampleOffset: runSeed % SAMPLE_RATE });
    for (let frameIndex = 0; frameIndex < PREFILL_FRAMES; frameIndex += 1) {
      await capture(sink, frame, frameIndex, publisherEvents, publisherQueue);
    }
    const streamingStartedAt = performance.now();
    let scheduleOffsetMs = 0;
    for (let frameIndex = PREFILL_FRAMES; frameIndex < TOTAL_FRAMES; frameIndex += 1) {
      if (frameIndex === NORMAL_STALL_FRAME) scheduleOffsetMs += NORMAL_STALL_MS;
      if (muteMs > 0 && frameIndex === 200) {
        const injected = await browserPlayout.startMute(muteMs);
        if (!injected) throw new Error("browser element mute injection failed");
      }
      const targetAt = streamingStartedAt +
        (frameIndex - PREFILL_FRAMES) * FRAME_DURATION_MS + scheduleOffsetMs;
      await delayUntil(targetAt);
      await capture(sink, frame, frameIndex, publisherEvents, publisherQueue);
    }
    await withTimeout(sink.waitForPlayout(), OPERATION_TIMEOUT_MS, "publisher queue drain");
    await delay(400);
    const browserState = await browserPlayout.finish();
    const browserFrames = trimLeadingSilence(browserState.frames).slice(0, TOTAL_FRAMES);
    const scorecard = {
      ...scoreBrowserPlayout({
        frameDurationMs: FRAME_DURATION_MS,
        expectedFrameCount: TOTAL_FRAMES,
        browserFrames,
        publisherQueue,
        rtpSamples: browserState.rtpSamples,
      }),
      browserFrameCount: browserFrames.length,
      rtpSampleCount: browserState.rtpSamples.length,
      mediaEventCount: browserState.mediaEvents.length,
    };
    return scorecard;
  } finally {
    if (browserPlayout) await browserPlayout.close().catch(() => {});
    if (gateway) await withTimeout(gateway.close(), OPERATION_TIMEOUT_MS, "gateway close")
      .catch(() => {});
    if (publisher) await withTimeout(
      publisher.disconnect(),
      OPERATION_TIMEOUT_MS,
      "publisher disconnect",
    ).catch(() => {});
  }
}

async function capture(sink, frame, frameIndex, events, queue) {
  const metrics = await withTimeout(
    sink.capture(frame),
    OPERATION_TIMEOUT_MS,
    `audio frame capture ${frameIndex}`,
  );
  const value = { type: "capture", atMs: Date.now(), frameIndex, ...metrics };
  events.push(value);
  queue.push({ atMs: value.atMs, queuedDurationMs: metrics.queuedBeforeMs });
}

function trimLeadingSilence(frames) {
  let start = 0;
  while (start < frames.length && frames[start].rms < 0.01) start += 1;
  return frames.slice(start);
}

function readArguments(args) {
  const values = new Map();
  for (const argument of args) {
    const match = argument.match(/^--([a-z-]+)=(\d+)$/);
    if (!match) throw new Error(`unsupported argument: ${argument}`);
    values.set(match[1], match[2]);
  }
  return values;
}

function positiveInteger(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

async function delayUntil(targetAt) {
  const remaining = targetAt - performance.now();
  if (remaining > 0) await delay(remaining);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
