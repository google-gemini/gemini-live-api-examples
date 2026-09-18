import assert from "node:assert/strict";
import test from "node:test";

import { buildAutomatedCanaryEvidence } from "../src/automated-canary-evidence.mjs";

test("timing evidence keeps interruption, reconnect, and accelerated long-session proof separate", () => {
  assert.deepEqual(buildAutomatedCanaryEvidence({
    interruptionMilliseconds: 200,
    reconnectStatusMilliseconds: 1_000,
    staleOutputBlocked: true,
    handoffPendingCaptureExercised: true,
    handoffPendingCaptureDelayMilliseconds: 220,
    handoffOldMarkerQueued: false,
    handoffNewOutputAccepted: true,
    replacementGapMilliseconds: 500,
    acceleratedMeetingMinutes: 60,
    proactiveReplacement: true,
    outputContinued: true,
  }), {
    ok: true,
    interruption: { ok: true, milliseconds: 200 },
    reconnect: {
      ok: true,
      statusMilliseconds: 1_000,
      staleOutputBlocked: true,
      handoffPendingCaptureExercised: true,
      handoffPendingCaptureDelayMilliseconds: 220,
      handoffOldMarkerQueued: false,
      handoffNewOutputAccepted: true,
    },
    longSession: {
      ok: true,
      replacementGapMilliseconds: 500,
      acceleratedMeetingMinutes: 60,
      proactiveReplacement: true,
      outputContinued: true,
    },
  });
});

test("missing or over-limit automated evidence fails closed by category", () => {
  const report = buildAutomatedCanaryEvidence({
    interruptionMilliseconds: 201,
    reconnectStatusMilliseconds: Number.NaN,
    staleOutputBlocked: false,
    replacementGapMilliseconds: 501,
    acceleratedMeetingMinutes: 59,
    proactiveReplacement: true,
    outputContinued: true,
  });
  assert.equal(report.ok, false);
  assert.equal(report.interruption.ok, false);
  assert.equal(report.reconnect.ok, false);
  assert.equal(report.longSession.ok, false);
});
