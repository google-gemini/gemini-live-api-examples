import {
  AudioStream,
  dispose,
  Room,
} from "@livekit/rtc-node";
import { AccessToken } from "livekit-server-sdk";

import {
  LiveKitAudioGateway,
  subscribe,
  waitForPublication,
} from "../src/livekit-audio-gateway.mjs";
import {
  contractResult,
  gapFrameCount,
  pcm16Rms,
  scoreContinuity,
  sineFrame,
  withTimeout,
} from "../src/playout-continuity.mjs";

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
const seed = positiveInteger(argumentsByName.get("seed") ?? "20260825", "--seed");
const injectedGapMs = argumentsByName.has("inject-gap-ms")
  ? positiveInteger(argumentsByName.get("inject-gap-ms"), "--inject-gap-ms")
  : 0;
if (injectedGapMs > 0) gapFrameCount(injectedGapMs, FRAME_DURATION_MS);
const results = [];

try {
  for (let index = 0; index < repeat; index += 1) {
    results.push(await runOnce({ run: index + 1, seed, injectedGapMs }));
  }
  const contractResults = results.map((scorecard) => contractResult(scorecard));
  const contractConsistent = new Set(contractResults.map((result) => JSON.stringify(result))).size === 1;
  process.stdout.write(`${JSON.stringify({
    ok: results.every((scorecard) => scorecard.ok) && contractConsistent,
    injectedGapMilliseconds: injectedGapMs,
    contractConsistent,
    runs: results.map((scorecard) => ({
      continuous: scorecard.ok,
      maximumGapMilliseconds: scorecard.maxReceiveGapMs,
      silentRunMilliseconds: scorecard.silentRunMs,
      tailLossMilliseconds: scorecard.tailLossMs,
      captureWaitP95Milliseconds: scorecard.captureWaitP95Ms,
    })),
  })}\n`);
  if (results.some((scorecard) => !scorecard.ok) || !contractConsistent) process.exitCode = 1;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`playout continuity canary failed: ${message}\n`);
  process.exitCode = 1;
} finally {
  dispose();
}

async function runOnce({ run, seed: runSeed, injectedGapMs: gapMs }) {
  const runId = `${Date.now()}-${process.pid}-${run}`;
  const roomName = `playout-continuity-${runId}`;
  let publisher;
  let listener;
  let gateway;
  let reader;
  let pump;
  const events = [];
  const received = [];
  const queue = [];
  const startedAt = performance.now();

  try {
    publisher = await connectRoom(roomName, `publisher-${runId}`);
    listener = await connectRoom(roomName, `listener-${runId}`);
    gateway = new LiveKitAudioGateway(publisher);
    const sink = await withTimeout(
      gateway.translationSink("ja"),
      OPERATION_TIMEOUT_MS,
      "translation track publication",
    );
    const publication = await waitForPublication(listener, "translation:ja");
    const track = await subscribe(listener, publication);
    reader = new AudioStream(track, {
      sampleRate: SAMPLE_RATE,
      numChannels: 1,
      frameSizeMs: FRAME_DURATION_MS,
    }).getReader();
    pump = pumpReceivedAudio(reader, { events, received, startedAt });

    const frame = sineFrame({ sampleOffset: runSeed % SAMPLE_RATE });
    for (let frameIndex = 0; frameIndex < PREFILL_FRAMES; frameIndex += 1) {
      await capture(sink, frame, frameIndex, startedAt, events, queue, false);
    }

    const streamingStartedAt = performance.now();
    let scheduleOffsetMs = 0;
    const injectedGapFrames = gapMs > 0 ? gapFrameCount(gapMs, FRAME_DURATION_MS) : 0;
    for (let frameIndex = PREFILL_FRAMES; frameIndex < TOTAL_FRAMES; frameIndex += 1) {
      if (frameIndex === NORMAL_STALL_FRAME) scheduleOffsetMs += NORMAL_STALL_MS;
      if (gapMs > 0 && frameIndex === 200) {
        const drainMs = Math.ceil(sink.queuedDurationMs());
        scheduleOffsetMs += drainMs - FRAME_DURATION_MS;
        await delay(drainMs);
      }
      if (gapMs > 0 && frameIndex >= 200 && frameIndex < 200 + injectedGapFrames) {
        const targetAt = streamingStartedAt +
          (frameIndex - PREFILL_FRAMES) * FRAME_DURATION_MS + scheduleOffsetMs;
        await delayUntil(targetAt);
        const value = event("omitted-frame", startedAt, {
          frameIndex,
          queuedDurationMs: sink.queuedDurationMs(),
        });
        events.push(value);
        queue.push({ atMs: value.atMs, queuedDurationMs: value.queuedDurationMs });
        continue;
      }
      const targetAt = streamingStartedAt +
        (frameIndex - PREFILL_FRAMES) * FRAME_DURATION_MS + scheduleOffsetMs;
      await delayUntil(targetAt);
      await capture(sink, frame, frameIndex, startedAt, events, queue, true);
    }

    events.push(event("drain-start", startedAt, {
      queuedDurationMs: sink.queuedDurationMs(),
    }));
    await withTimeout(sink.waitForPlayout(), OPERATION_TIMEOUT_MS, "publisher queue drain");
    events.push(event("drain-end", startedAt, {
      queuedDurationMs: sink.queuedDurationMs(),
    }));
    await delay(300);
    await withTimeout(reader.cancel(), OPERATION_TIMEOUT_MS, "audio reader cancellation");
    await withTimeout(pump, OPERATION_TIMEOUT_MS, "audio receive pump completion");

    const audibleReceived = trimSilentEdges(received);
    const audibleFrameCount = audibleReceived.length;
    const scorecard = {
      ...scoreContinuity({
        frameDurationMs: FRAME_DURATION_MS,
        expectedDurationMs: TOTAL_FRAMES * FRAME_DURATION_MS,
        received: audibleReceived,
        queue,
      }),
      audibleFrameCount,
      captureWaitP95Ms: percentile(
        events.filter(({ type }) => type === "capture").map(({ captureWaitMs }) => captureWaitMs),
        0.95,
      ),
    };
    return scorecard;
  } finally {
    if (reader) await withTimeout(
      reader.cancel(),
      OPERATION_TIMEOUT_MS,
      "audio reader cleanup",
    ).catch(() => {});
    if (pump) await withTimeout(
      pump,
      OPERATION_TIMEOUT_MS,
      "audio pump cleanup",
    ).catch(() => {});
    if (gateway) await withTimeout(
      gateway.close(),
      OPERATION_TIMEOUT_MS,
      "gateway cleanup",
    ).catch(() => {});
    await Promise.allSettled([
      publisher && withTimeout(publisher.disconnect(), OPERATION_TIMEOUT_MS, "publisher disconnect"),
      listener && withTimeout(listener.disconnect(), OPERATION_TIMEOUT_MS, "listener disconnect"),
    ]);
  }
}

async function capture(sink, frame, frameIndex, startedAt, events, queue, observeQueue) {
  const metrics = await withTimeout(
    sink.capture(frame),
    OPERATION_TIMEOUT_MS,
    `audio frame capture ${frameIndex}`,
  );
  const value = event("capture", startedAt, { frameIndex, ...metrics });
  events.push(value);
  if (observeQueue) {
    queue.push({ atMs: value.atMs, queuedDurationMs: metrics.queuedBeforeMs });
  }
}

async function pumpReceivedAudio(reader, { events, received, startedAt }) {
  let audibleStarted = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) return;
    const pcm = Buffer.from(value.data.buffer, value.data.byteOffset, value.data.byteLength);
    const rms = pcm16Rms(pcm);
    if (rms >= 200) audibleStarted = true;
    if (!audibleStarted) continue;
    const valueEvent = event("receive", startedAt, { rms });
    events.push(valueEvent);
    received.push({ receivedAtMs: valueEvent.atMs, rms });
  }
}

async function connectRoom(roomName, identity) {
  const token = new AccessToken(livekitApiKey, livekitApiSecret, { identity });
  token.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });
  const room = new Room();
  try {
    await withTimeout(room.connect(livekitUrl, await token.toJwt(), {
      autoSubscribe: false,
      dynacast: false,
    }), OPERATION_TIMEOUT_MS, `${identity} connection`);
    return room;
  } catch (error) {
    await withTimeout(room.disconnect(), OPERATION_TIMEOUT_MS, `${identity} failed connection cleanup`)
      .catch(() => {});
    throw error;
  }
}

function trimSilentEdges(frames) {
  let end = frames.length;
  while (end > 0 && frames[end - 1].rms < 200) end -= 1;
  return frames.slice(0, end);
}

function event(type, startedAt, fields) {
  return { type, atMs: performance.now() - startedAt, ...fields };
}

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil((sorted.length - 1) * fraction)];
}

function readArguments(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const match = args[index].match(/^--([a-z-]+)=(\d+)$/);
    if (!match) throw new Error(`unsupported argument: ${args[index]}`);
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
