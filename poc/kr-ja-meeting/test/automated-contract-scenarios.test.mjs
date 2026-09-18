import assert from "node:assert/strict";
import test from "node:test";

import { runAutomatedContractCanary } from "../src/automated-contract-canary.mjs";
import { runAutomatedContractScenarios } from "../src/automated-contract-scenarios.mjs";

test("automated contract scenarios measure the real bridge transitions", async () => {
  const measurements = await runAutomatedContractScenarios();
  const report = await runAutomatedContractCanary({
    runScenarios: async () => measurements,
  });

  assert.equal(report.ok, true);
  assert.equal(measurements.interruptionMilliseconds > 0, true);
  assert.equal(measurements.handoffPendingCaptureDelayMilliseconds, 220);
  assert.equal(measurements.handoffNewOutputAccepted, true);
  assert.equal(measurements.interruptionMilliseconds <= 200, true);
  assert.equal(measurements.handoffPendingCaptureExercised, true);
  assert.equal(measurements.handoffOldMarkerQueued, false);
  assert.equal(measurements.reconnectStatusMilliseconds <= 1_000, true);
  assert.equal(measurements.staleOutputBlocked, true);
  assert.equal(measurements.replacementGapMilliseconds <= 500, true);
  assert.equal(measurements.acceleratedMeetingMinutes >= 60, true);
  assert.equal(measurements.proactiveReplacement, true);
  assert.equal(measurements.outputContinued, true);
});

test("automated contract canary fails closed when measured evidence is missing or over limit", async () => {
  const oldConstantFalsePositive = await runAutomatedContractCanary({
    runScenarios: async () => ({
      interruptionMilliseconds: 0,
      reconnectStatusMilliseconds: 500,
      staleOutputBlocked: true,
      replacementGapMilliseconds: 400,
      acceleratedMeetingMinutes: 60,
      proactiveReplacement: true,
      outputContinued: true,
    }),
  });
  assert.equal(oldConstantFalsePositive.ok, false);
  assert.equal(oldConstantFalsePositive.reconnect.ok, false);

  const missing = await runAutomatedContractCanary({
    runScenarios: async () => ({ staleOutputBlocked: true }),
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.interruption.ok, false);
  assert.equal(missing.reconnect.ok, false);
  assert.equal(missing.longSession.ok, false);

  const overLimit = await runAutomatedContractCanary({
    runScenarios: async () => ({
      interruptionMilliseconds: 201,
      reconnectStatusMilliseconds: 1_001,
      staleOutputBlocked: true,
      replacementGapMilliseconds: 501,
      acceleratedMeetingMinutes: 60,
      proactiveReplacement: true,
      outputContinued: true,
    }),
  });
  assert.equal(overLimit.ok, false);
  assert.equal(overLimit.interruption.ok, false);
  assert.equal(overLimit.reconnect.ok, false);
  assert.equal(overLimit.longSession.ok, false);
});
