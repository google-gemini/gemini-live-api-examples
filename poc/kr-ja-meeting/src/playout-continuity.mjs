export const PLAYOUT_CONTRACT = Object.freeze({
  maxReceiveGapMs: 80,
  maxSilentRunMs: 40,
  maxTailLossMs: 60,
  maxExtraAudioMs: 60,
});

export function scoreContinuity({
  frameDurationMs,
  expectedDurationMs,
  received,
  queue,
}) {
  if (!(frameDurationMs > 0) || !(expectedDurationMs >= 0)) {
    throw new Error("positive frame duration and non-negative expected duration are required");
  }
  if (!Array.isArray(received) || !Array.isArray(queue)) {
    throw new Error("received and queue samples are required");
  }
  assertFiniteSamples(received, ["receivedAtMs", "rms"], "received");
  assertFiniteSamples(queue, ["atMs", "queuedDurationMs"], "queue");
  for (let index = 1; index < received.length; index += 1) {
    if (received[index].receivedAtMs < received[index - 1].receivedAtMs) {
      throw new Error("received timestamps must be ordered");
    }
  }

  const gaps = received.slice(1).map((frame, index) =>
    frame.receivedAtMs - received[index].receivedAtMs);
  const maxReceiveGapMs = Math.max(0, ...gaps);
  const silentRunMs = longestRun(received, (frame) => frame.rms < 200) * frameDurationMs;
  const receivedDurationMs = received.length * frameDurationMs;
  const tailLossMs = Math.max(0, expectedDurationMs - receivedDurationMs);
  const extraAudioMs = Math.max(0, receivedDurationMs - expectedDurationMs);
  const continuityFailed =
    maxReceiveGapMs > PLAYOUT_CONTRACT.maxReceiveGapMs ||
    silentRunMs > PLAYOUT_CONTRACT.maxSilentRunMs ||
    tailLossMs > PLAYOUT_CONTRACT.maxTailLossMs ||
    extraAudioMs > PLAYOUT_CONTRACT.maxExtraAudioMs;
  const failureWindows = continuityFailureWindows({
    frameDurationMs,
    expectedDurationMs,
    received,
  });
  const queueFloors = queue.filter((sample) =>
    sample.queuedDurationMs < frameDurationMs &&
    failureWindows.some(({ startMs, endMs }) =>
      sample.atMs >= startMs - frameDurationMs &&
      sample.atMs <= endMs + frameDurationMs));

  return {
    ok: !continuityFailed,
    location: continuityFailed
      ? queueFloors.length > 0
        ? "publisher_queue_underflow"
        : "livekit_transport_or_decode"
      : "node_loopback_continuous",
    maxReceiveGapMs,
    silentRunMs,
    tailLossMs,
    extraAudioMs,
    queueFloorCount: queueFloors.length,
  };
}

export function contractResult(scorecard) {
  return {
    ok: scorecard.ok,
    location: scorecard.location,
    gapExceeded: scorecard.maxReceiveGapMs > PLAYOUT_CONTRACT.maxReceiveGapMs,
    silenceExceeded: scorecard.silentRunMs > PLAYOUT_CONTRACT.maxSilentRunMs,
    tailLossExceeded: scorecard.tailLossMs > PLAYOUT_CONTRACT.maxTailLossMs,
    extraAudioExceeded: scorecard.extraAudioMs > PLAYOUT_CONTRACT.maxExtraAudioMs,
    queueUnderflowObserved: scorecard.queueFloorCount > 0,
  };
}

export function withTimeout(promise, timeoutMs, label) {
  let timeout;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`timed out after ${timeoutMs}ms: ${label}`)),
      timeoutMs,
    );
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timeout));
}

export function gapFrameCount(gapMs, frameDurationMs) {
  if (!Number.isSafeInteger(gapMs) || gapMs <= 0 || gapMs % frameDurationMs !== 0) {
    throw new Error(`injected gap must be a positive multiple of ${frameDurationMs}ms`);
  }
  return gapMs / frameDurationMs;
}

export function sineFrame({
  sampleRate = 24_000,
  durationMs = 20,
  frequencyHz = 1_000,
  amplitude = 8_000,
  sampleOffset = 0,
} = {}) {
  const sampleCount = Math.round(sampleRate * durationMs / 1_000);
  const pcm = Buffer.alloc(sampleCount * 2);
  for (let index = 0; index < sampleCount; index += 1) {
    const phase = 2 * Math.PI * frequencyHz * (sampleOffset + index) / sampleRate;
    pcm.writeInt16LE(Math.round(amplitude * Math.sin(phase)), index * 2);
  }
  return pcm;
}

export function pcm16Rms(pcm) {
  if (!Buffer.isBuffer(pcm) || pcm.length % 2 !== 0) {
    throw new Error("PCM16 buffer with an even byte length is required");
  }
  if (pcm.length === 0) return 0;
  let sumSquares = 0;
  const sampleCount = pcm.length / 2;
  for (let offset = 0; offset < pcm.length; offset += 2) {
    const sample = pcm.readInt16LE(offset);
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / sampleCount);
}

function longestRun(values, predicate) {
  let longest = 0;
  let current = 0;
  for (const value of values) {
    current = predicate(value) ? current + 1 : 0;
    longest = Math.max(longest, current);
  }
  return longest;
}

function continuityFailureWindows({ frameDurationMs, expectedDurationMs, received }) {
  const windows = [];
  for (let index = 1; index < received.length; index += 1) {
    const previousAtMs = received[index - 1].receivedAtMs;
    const currentAtMs = received[index].receivedAtMs;
    if (currentAtMs - previousAtMs > PLAYOUT_CONTRACT.maxReceiveGapMs) {
      windows.push({ startMs: previousAtMs, endMs: currentAtMs });
    }
  }

  let silentStartMs;
  for (let index = 0; index <= received.length; index += 1) {
    const frame = received[index];
    if (frame?.rms < 200 && silentStartMs === undefined) {
      silentStartMs = frame.receivedAtMs;
    }
    if ((!frame || frame.rms >= 200) && silentStartMs !== undefined) {
      const previousAtMs = received[index - 1].receivedAtMs;
      if (previousAtMs + frameDurationMs - silentStartMs > PLAYOUT_CONTRACT.maxSilentRunMs) {
        windows.push({ startMs: silentStartMs, endMs: previousAtMs + frameDurationMs });
      }
      silentStartMs = undefined;
    }
  }

  const receivedDurationMs = received.length * frameDurationMs;
  const tailLossMs = Math.max(0, expectedDurationMs - receivedDurationMs);
  if (tailLossMs > PLAYOUT_CONTRACT.maxTailLossMs) {
    const startMs = received.length > 0
      ? received[received.length - 1].receivedAtMs + frameDurationMs
      : 0;
    windows.push({ startMs, endMs: startMs + tailLossMs });
  }
  const extraAudioMs = Math.max(0, receivedDurationMs - expectedDurationMs);
  if (extraAudioMs > PLAYOUT_CONTRACT.maxExtraAudioMs) {
    const expectedEndMs = received.length > 0
      ? received[0].receivedAtMs + expectedDurationMs
      : expectedDurationMs;
    windows.push({ startMs: expectedEndMs, endMs: expectedEndMs + extraAudioMs });
  }
  return windows;
}

function assertFiniteSamples(samples, fields, label) {
  for (const sample of samples) {
    if (!sample || fields.some((field) => !Number.isFinite(sample[field]))) {
      throw new Error(`${label} samples require finite ${fields.join(" and ")}`);
    }
  }
}
