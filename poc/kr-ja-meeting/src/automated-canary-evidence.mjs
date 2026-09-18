const INTERRUPTION_LIMIT_MILLISECONDS = 200;
const RECONNECT_STATUS_LIMIT_MILLISECONDS = 1_000;
const REPLACEMENT_GAP_LIMIT_MILLISECONDS = 500;
const REQUIRED_MEETING_MINUTES = 60;
const REQUIRED_PENDING_CAPTURE_MILLISECONDS = 220;

export function buildAutomatedCanaryEvidence({
  interruptionMilliseconds,
  reconnectStatusMilliseconds,
  staleOutputBlocked,
  handoffPendingCaptureExercised,
  handoffPendingCaptureDelayMilliseconds,
  handoffOldMarkerQueued,
  handoffNewOutputAccepted,
  replacementGapMilliseconds,
  acceleratedMeetingMinutes,
  proactiveReplacement,
  outputContinued,
} = {}) {
  const interruption = {
    ok: finiteWithin(interruptionMilliseconds, INTERRUPTION_LIMIT_MILLISECONDS)
      && interruptionMilliseconds > 0,
    milliseconds: interruptionMilliseconds,
  };
  const reconnect = {
    ok: finiteWithin(reconnectStatusMilliseconds, RECONNECT_STATUS_LIMIT_MILLISECONDS)
      && staleOutputBlocked === true
      && handoffPendingCaptureExercised === true
      && Number.isFinite(handoffPendingCaptureDelayMilliseconds)
      && handoffPendingCaptureDelayMilliseconds >= REQUIRED_PENDING_CAPTURE_MILLISECONDS
      && handoffOldMarkerQueued === false
      && handoffNewOutputAccepted === true,
    statusMilliseconds: reconnectStatusMilliseconds,
    staleOutputBlocked: staleOutputBlocked === true,
    handoffPendingCaptureExercised: handoffPendingCaptureExercised === true,
    handoffPendingCaptureDelayMilliseconds,
    handoffOldMarkerQueued: handoffOldMarkerQueued === true,
    handoffNewOutputAccepted: handoffNewOutputAccepted === true,
  };
  const longSession = {
    ok: finiteWithin(replacementGapMilliseconds, REPLACEMENT_GAP_LIMIT_MILLISECONDS)
      && Number.isFinite(acceleratedMeetingMinutes)
      && acceleratedMeetingMinutes >= REQUIRED_MEETING_MINUTES
      && proactiveReplacement === true
      && outputContinued === true,
    replacementGapMilliseconds,
    acceleratedMeetingMinutes,
    proactiveReplacement: proactiveReplacement === true,
    outputContinued: outputContinued === true,
  };
  return {
    ok: interruption.ok && reconnect.ok && longSession.ok,
    interruption,
    reconnect,
    longSession,
  };
}

function finiteWithin(value, limit) {
  return Number.isFinite(value) && value >= 0 && value <= limit;
}
