import {
  BROWSER_PLAYOUT_CONTRACT,
  scoreBrowserPlayout,
} from "./browser-playout-continuity.mjs";

const SILENT_RMS_THRESHOLD = 0.01;

export function scoreProviderBrowserPlayout({
  frameDurationMs,
  providerFrames,
  browserFrames,
  publisherQueue,
  publisherCompleteAtMs,
  rtpSamples,
}) {
  if (!(frameDurationMs > 0)) throw new Error("positive frame duration is required");
  assertRmsFrames(providerFrames, "provider");
  assertRmsFrames(browserFrames, "browser", true);

  const normalizedProvider = trimSilentEdges(providerFrames);
  const normalizedBrowser = trimLeadingSilence(browserFrames);
  if (normalizedProvider.length === 0) {
    return {
      ok: false,
      location: "gemini_output_missing",
      providerFrameCount: 0,
      browserFrameCount: normalizedBrowser.length,
      providerSilentRunMs: 0,
      unexpectedSilentRunMs: 0,
      tailLossMs: 0,
    };
  }

  const comparedBrowser = normalizedBrowser
    .slice(0, normalizedProvider.length)
    .map((frame, index) => ({
      ...frame,
      rms: normalizedProvider[index].rms < SILENT_RMS_THRESHOLD ? 1 : frame.rms,
    }));
  const downstream = scoreBrowserPlayout({
    frameDurationMs,
    expectedFrameCount: normalizedProvider.length,
    browserFrames: comparedBrowser,
    publisherQueue,
    publisherCompleteAtMs,
    rtpSamples,
  });

  return {
    ...downstream,
    location: downstream.ok ? "provider_to_browser_continuous" : downstream.location,
    providerFrameCount: normalizedProvider.length,
    browserFrameCount: normalizedBrowser.length,
    providerSilentRunMs: longestRun(
      normalizedProvider,
      (frame) => frame.rms < SILENT_RMS_THRESHOLD,
    ) * frameDurationMs,
    unexpectedSilentRunMs: downstream.silentRunMs,
    failureWindows: downstream.failureWindows,
  };
}

export function dualProbeContractResult(scorecard) {
  if (!scorecard.rawTrack || !scorecard.audioElement) {
    return {
      ok: false,
      location: scorecard.location,
      evidenceIncomplete: true,
    };
  }
  return {
    ok: scorecard.ok,
    location: scorecard.location,
    rawTrack: probeContractResult(scorecard.rawTrack),
    audioElement: probeContractResult(scorecard.audioElement),
  };
}

export function scoreDualProbePlayout({
  frameDurationMs,
  providerFrames,
  rawTrackFrames,
  elementFrames,
  publisherQueue,
  publisherCompleteAtMs,
  rtpSamples,
}) {
  const common = {
    frameDurationMs,
    providerFrames,
    publisherQueue,
    publisherCompleteAtMs,
    rtpSamples,
  };
  const rawTrack = scoreProviderBrowserPlayout({
    ...common,
    browserFrames: rawTrackFrames,
  });
  const audioElement = scoreProviderBrowserPlayout({
    ...common,
    browserFrames: elementFrames,
  });

  let location;
  if (rawTrack.ok && audioElement.ok) {
    location = "provider_to_audio_element_continuous";
  } else if (rawTrack.ok) {
    location = "browser_audio_element_playout";
  } else if (audioElement.ok) {
    location = "browser_raw_track_probe_inconsistent";
  } else if (rawTrack.location === "browser_media_element_playout" &&
      audioElement.location === "browser_media_element_playout" &&
      windowsFullyCorrelated(rawTrack.failureWindows, audioElement.failureWindows)) {
    location = "browser_shared_audio_render_path";
  } else if (rawTrack.location === audioElement.location &&
      rawTrack.location !== "browser_media_element_playout") {
    location = rawTrack.location;
  } else {
    location = "browser_probe_disagreement";
  }

  return {
    ...audioElement,
    ok: rawTrack.ok && audioElement.ok,
    location,
    maxBrowserFrameGapMs: Math.max(
      rawTrack.maxBrowserFrameGapMs,
      audioElement.maxBrowserFrameGapMs,
    ),
    silentRunMs: Math.max(rawTrack.silentRunMs, audioElement.silentRunMs),
    tailLossMs: Math.max(rawTrack.tailLossMs, audioElement.tailLossMs),
    unexpectedSilentRunMs: Math.max(
      rawTrack.unexpectedSilentRunMs,
      audioElement.unexpectedSilentRunMs,
    ),
    rawTrack,
    audioElement,
  };
}

export function summarizeProviderBrowserRuns(scorecards) {
  if (!Array.isArray(scorecards) || scorecards.length === 0) {
    throw new Error("provider browser scorecards are required");
  }
  return {
    firstProviderAudioMs: summarizePercentiles(
      scorecards.map((scorecard) => scorecard.firstProviderAudioMs),
    ),
    providerEndAfterInputEndMs: summarizePercentiles(
      scorecards.map((scorecard) => scorecard.providerEndAfterInputEndMs),
    ),
  };
}

export async function waitForCanarySignal({
  predicate,
  readError,
  timeoutMs,
  label = "canary signal",
  pollMs = 20,
}) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const error = readError?.();
    if (error) throw error;
    if (predicate()) return;
    if (Date.now() >= deadline) throw new Error(`${label} timed out after ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

function trimSilentEdges(frames) {
  let start = 0;
  let end = frames.length;
  while (start < end && frames[start].rms < SILENT_RMS_THRESHOLD) start += 1;
  while (end > start && frames[end - 1].rms < SILENT_RMS_THRESHOLD) end -= 1;
  return frames.slice(start, end);
}

function trimLeadingSilence(frames) {
  let start = 0;
  while (start < frames.length && frames[start].rms < SILENT_RMS_THRESHOLD) start += 1;
  return frames.slice(start);
}

function assertRmsFrames(frames, label, withTimestamp = false) {
  if (!Array.isArray(frames)) throw new Error(`${label} frames are required`);
  for (const frame of frames) {
    if (!frame || !Number.isFinite(frame.rms) ||
        (withTimestamp && !Number.isFinite(frame.atMs))) {
      throw new Error(`${label} frames require finite RMS${withTimestamp ? " and time" : ""}`);
    }
  }
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

function probeContractResult(scorecard) {
  return {
    ok: scorecard.ok,
    location: scorecard.location,
    silenceExceeded:
      scorecard.unexpectedSilentRunMs > BROWSER_PLAYOUT_CONTRACT.maxSilentRunMs,
    tailLossExceeded:
      scorecard.tailLossMs > BROWSER_PLAYOUT_CONTRACT.maxSilentRunMs,
  };
}

function windowsFullyCorrelated(left, right) {
  return left.every((window) => windowCoveredBy(window, right)) &&
    right.every((window) => windowCoveredBy(window, left));
}

function windowCoveredBy(window, candidates) {
  let coveredUntilMs = window.startMs;
  for (const candidate of [...candidates].sort((left, right) =>
    left.startMs - right.startMs)) {
    if (candidate.endMs <= coveredUntilMs) continue;
    if (candidate.startMs > coveredUntilMs) return false;
    coveredUntilMs = candidate.endMs;
    if (coveredUntilMs >= window.endMs) return true;
  }
  return false;
}

function summarizePercentiles(values) {
  if (values.some((value) => !Number.isFinite(value))) {
    throw new Error("provider browser latency values must be finite");
  }
  const sorted = [...values].sort((left, right) => left - right);
  return {
    p50: nearestRank(sorted, 0.5),
    p95: nearestRank(sorted, 0.95),
  };
}

function nearestRank(sorted, percentile) {
  return sorted[Math.max(0, Math.ceil(sorted.length * percentile) - 1)];
}
