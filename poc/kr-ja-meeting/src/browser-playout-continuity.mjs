export const BROWSER_PLAYOUT_CONTRACT = Object.freeze({
  maxFrameGapMs: 80,
  maxSilentRunMs: 40,
  silentRmsThreshold: 0.01,
  rtpCorrelationMarginMs: 100,
  maxRtpSampleIntervalMs: 300,
});

export function browserPlayoutContractResult(scorecard) {
  return {
    ok: scorecard.ok,
    location: scorecard.location,
    gapExceeded: scorecard.maxBrowserFrameGapMs > BROWSER_PLAYOUT_CONTRACT.maxFrameGapMs,
    silenceExceeded: scorecard.silentRunMs > BROWSER_PLAYOUT_CONTRACT.maxSilentRunMs,
    tailLossExceeded: scorecard.tailLossMs > BROWSER_PLAYOUT_CONTRACT.maxSilentRunMs,
    queueFloorAtFailure: scorecard.queueFloorAtFailure,
    rtpDisruptionAtFailure: scorecard.rtpDisruptionAtFailure,
  };
}

export function scoreBrowserPlayout({
  frameDurationMs,
  expectedFrameCount,
  browserFrames,
  publisherQueue,
  publisherCompleteAtMs,
  rtpSamples,
}) {
  if (!(frameDurationMs > 0)) throw new Error("positive frame duration is required");
  if (!Number.isSafeInteger(expectedFrameCount) || expectedFrameCount <= 0) {
    throw new Error("positive expected browser frame count is required");
  }
  for (const [label, samples, fields] of [
    ["browser", browserFrames, ["atMs", "rms"]],
    ["publisher queue", publisherQueue, ["atMs", "queuedDurationMs"]],
    ["RTP", rtpSamples, [
      "atMs",
      "packetsReceived",
      "packetsLost",
      "concealedSamples",
      "concealmentEvents",
    ]],
  ]) {
    if (!Array.isArray(samples)) throw new Error(`${label} samples are required`);
    assertFiniteSamples(samples, fields, label);
    assertOrdered(samples, label);
  }
  if (browserFrames.length === 0) {
    throw new Error("browser audio evidence is required");
  }
  if (publisherQueue.length === 0) {
    throw new Error("publisher queue evidence is required");
  }
  if (rtpSamples.length < 2) {
    throw new Error("at least two RTP evidence samples are required");
  }
  if (publisherCompleteAtMs !== undefined && !Number.isFinite(publisherCompleteAtMs)) {
    throw new Error("publisher completion time must be finite");
  }

  const gaps = browserFrames.slice(1).map((frame, index) =>
    frame.atMs - browserFrames[index].atMs);
  const maxBrowserFrameGapMs = Math.max(0, ...gaps);
  const silentRunMs = longestRun(
    browserFrames,
    (frame) => frame.rms < BROWSER_PLAYOUT_CONTRACT.silentRmsThreshold,
  ) * frameDurationMs;
  const tailLossMs = Math.max(0, expectedFrameCount - browserFrames.length) * frameDurationMs;
  const failureWindows = browserFailureWindows(
    browserFrames,
    frameDurationMs,
    tailLossMs,
  );
  const rtpIntervals = rtpChanges(rtpSamples);
  const publisherFailureWindows = failureWindows.filter((window) =>
    publisherCompleteAtMs === undefined || window.startMs < publisherCompleteAtMs);
  if (!publisherFailureWindows.every((window) => publisherQueue.some((sample) =>
    sample.atMs <= (publisherCompleteAtMs ?? Number.POSITIVE_INFINITY) &&
    overlapsFailure(sample.atMs, [window], frameDurationMs)))) {
    throw new Error("publisher queue evidence does not cover browser failure");
  }
  if (failureWindows.length > 0 && !failureWindows.every((window) =>
    rtpIntervals.some((interval) => rtpIntervalCoversFailure(interval, window)))) {
    throw new Error("RTP evidence does not cover browser failure");
  }
  const queueFloorAtFailure = publisherQueue.some((sample) =>
    sample.atMs <= (publisherCompleteAtMs ?? Number.POSITIVE_INFINITY) &&
    sample.queuedDurationMs < frameDurationMs &&
    overlapsFailure(sample.atMs, publisherFailureWindows, frameDurationMs));
  const rtpDisruptionAtFailure = rtpIntervals.some((interval) =>
    failureWindows.some((window) => rtpIntervalCoversFailure(interval, window)) &&
    (interval.packetsReceived <= 0 || interval.packetsLost > 0 ||
      interval.concealedSamples > 0 || interval.concealmentEvents > 0));
  const failed =
    maxBrowserFrameGapMs > BROWSER_PLAYOUT_CONTRACT.maxFrameGapMs ||
    silentRunMs > BROWSER_PLAYOUT_CONTRACT.maxSilentRunMs ||
    tailLossMs > BROWSER_PLAYOUT_CONTRACT.maxSilentRunMs;

  return {
    ok: !failed,
    location: failed
      ? queueFloorAtFailure
        ? "publisher_queue_underflow"
        : rtpDisruptionAtFailure
          ? "browser_webrtc_receive_or_decode"
          : "browser_media_element_playout"
      : "browser_element_continuous",
    maxBrowserFrameGapMs,
    silentRunMs,
    tailLossMs,
    queueFloorAtFailure,
    rtpDisruptionAtFailure,
    failureWindows,
  };
}

function browserFailureWindows(frames, frameDurationMs, tailLossMs) {
  const windows = [];
  for (let index = 1; index < frames.length; index += 1) {
    if (frames[index].atMs - frames[index - 1].atMs > BROWSER_PLAYOUT_CONTRACT.maxFrameGapMs) {
      windows.push({ startMs: frames[index - 1].atMs, endMs: frames[index].atMs });
    }
  }

  let silentStart;
  for (let index = 0; index <= frames.length; index += 1) {
    const frame = frames[index];
    if (frame?.rms < BROWSER_PLAYOUT_CONTRACT.silentRmsThreshold && silentStart === undefined) {
      silentStart = frame.atMs;
    }
    if ((!frame || frame.rms >= BROWSER_PLAYOUT_CONTRACT.silentRmsThreshold) &&
        silentStart !== undefined) {
      const previousAt = frames[index - 1].atMs;
      if (previousAt + frameDurationMs - silentStart >
          BROWSER_PLAYOUT_CONTRACT.maxSilentRunMs) {
        windows.push({ startMs: silentStart, endMs: previousAt + frameDurationMs });
      }
      silentStart = undefined;
    }
  }
  if (tailLossMs > BROWSER_PLAYOUT_CONTRACT.maxSilentRunMs) {
    const startMs = frames.at(-1).atMs + frameDurationMs;
    windows.push({ startMs, endMs: startMs + tailLossMs });
  }
  return windows;
}

function rtpChanges(samples) {
  return samples.slice(1).map((sample, index) => {
    const previous = samples[index];
    return {
      startAtMs: previous.atMs,
      atMs: sample.atMs,
      durationMs: sample.atMs - previous.atMs,
      packetsReceived: counterDelta(sample, previous, "packetsReceived"),
      packetsLost: counterDelta(sample, previous, "packetsLost"),
      concealedSamples: counterDelta(sample, previous, "concealedSamples"),
      concealmentEvents: counterDelta(sample, previous, "concealmentEvents"),
    };
  });
}

function counterDelta(sample, previous, field) {
  const delta = sample[field] - previous[field];
  if (delta < 0) throw new Error(`RTP ${field} counter must be monotonic`);
  return delta;
}

function rtpIntervalCoversFailure(interval, window) {
  const margin = BROWSER_PLAYOUT_CONTRACT.rtpCorrelationMarginMs;
  return interval.durationMs <= BROWSER_PLAYOUT_CONTRACT.maxRtpSampleIntervalMs &&
    interval.startAtMs <= window.startMs + margin &&
    interval.atMs >= window.endMs - margin;
}

function overlapsFailure(atMs, windows, marginMs) {
  return windows.some(({ startMs, endMs }) =>
    atMs >= startMs - marginMs && atMs <= endMs + marginMs);
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

function assertFiniteSamples(samples, fields, label) {
  for (const sample of samples) {
    if (!sample || fields.some((field) => !Number.isFinite(sample[field]))) {
      throw new Error(`${label} samples require finite ${fields.join(" and ")}`);
    }
  }
}

function assertOrdered(samples, label) {
  for (let index = 1; index < samples.length; index += 1) {
    if (samples[index].atMs < samples[index - 1].atMs) {
      throw new Error(`${label} sample timestamps must be ordered`);
    }
  }
}
