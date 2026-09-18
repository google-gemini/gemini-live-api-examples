import assert from "node:assert/strict";
import test from "node:test";

import {
  GEMINI_INPUT_SAMPLE_RATE,
  ProviderCanaryEvidence,
  ProviderSemanticEvidence,
  evaluateProviderSemanticTrial,
  providerSemanticFixtures,
  providerSemanticStreamPlan,
  publicationName,
  semanticStreamSettled,
} from "../src/provider-canary.mjs";

test("the provider canary sends Live Translate audio at 16 kHz", () => {
  assert.equal(GEMINI_INPUT_SAMPLE_RATE, 16_000);
});

test("provider canary completes only after the real LiveKit and Gemini signals", () => {
  const evidence = new ProviderCanaryEvidence();

  evidence.record("participantsConnected", 4);
  evidence.record("originalTrackSubscribed", true);
  evidence.record("geminiSetupComplete", true);
  evidence.record("translatedFrames", 3);
  evidence.record("translationTrackPublished", true);
  evidence.record("translationTrackSubscribed", true);
  evidence.record("listenerReceivedTranslatedAudio", true);
  evidence.record("freshSessionSetup", true);
  evidence.record("originalCheckExclusive", true);
  assert.equal(evidence.complete, false);

  evidence.record("phraseBoundary", true);
  evidence.record("translationRestoredAtBoundary", true);
  assert.equal(evidence.complete, true);
});

test("publicationName supports the rtc-node and browser LiveKit publication shapes", () => {
  assert.equal(publicationName({ name: "translation:ko" }), "translation:ko");
  assert.equal(
    publicationName({ trackName: "original:ja-1" }),
    "original:ja-1",
  );
  assert.equal(publicationName({}), null);
});

test("the original check must start before the phrase boundary and restore after it", () => {
  const evidence = new ProviderCanaryEvidence();

  assert.throws(
    () => evidence.record("phraseBoundary", true),
    /original check must start before the phrase boundary/,
  );
  evidence.record("originalCheckExclusive", true);
  evidence.record("phraseBoundary", true);
  evidence.record("translationRestoredAtBoundary", true);
});

test("bidirectional provider semantics require three distinct first and last meaning passes", () => {
  const evidence = new ProviderSemanticEvidence();
  for (const direction of ["ko-to-ja", "ja-to-ko"]) {
    for (let trial = 1; trial <= 3; trial += 1) {
      evidence.record({
        direction,
        trialId: `${direction}-${trial}`,
        firstMeaning: true,
        lastMeaning: true,
      });
    }
  }

  assert.equal(evidence.complete, true);
  assert.deepEqual(evidence.snapshot(), {
    ok: true,
    "ko-to-ja": [
      { firstMeaning: true, lastMeaning: true },
      { firstMeaning: true, lastMeaning: true },
      { firstMeaning: true, lastMeaning: true },
    ],
    "ja-to-ko": [
      { firstMeaning: true, lastMeaning: true },
      { firstMeaning: true, lastMeaning: true },
      { firstMeaning: true, lastMeaning: true },
    ],
  });
  assert.doesNotMatch(
    JSON.stringify(evidence.snapshot()),
    /audio|pcm|transcript|translation|glossary|api.?key|token|handle|text/i,
  );
});

test("provider semantic evidence fails closed for duplicates, missing trials, or lost meaning", () => {
  const evidence = new ProviderSemanticEvidence();
  evidence.record({
    direction: "ko-to-ja",
    trialId: "ko-to-ja-1",
    firstMeaning: true,
    lastMeaning: false,
  });
  assert.equal(evidence.complete, false);
  assert.throws(() => evidence.record({
    direction: "ko-to-ja",
    trialId: "ko-to-ja-1",
    firstMeaning: true,
    lastMeaning: true,
  }), /duplicate semantic trial/);
  assert.throws(() => evidence.record({
    direction: "en-to-ko",
    trialId: "unsupported",
    firstMeaning: true,
    lastMeaning: true,
  }), /unsupported semantic direction/);
});

test("provider semantic canary uses continuous streaming and a quiet transcription boundary", () => {
  assert.deepEqual(providerSemanticStreamPlan(), {
    automaticActivityDetection: true,
    leadingSilenceMilliseconds: 1_000,
    trailingSilenceMilliseconds: 2_000,
    transcriptionQuietMilliseconds: 2_000,
    transcriptionTimeoutMilliseconds: 12_000,
  });
  assert.equal(semanticStreamSettled({
    inputEvents: 1,
    outputEvents: 1,
    lastTranscriptionAt: 1_000,
    now: 2_999,
    quietMilliseconds: 2_000,
  }), false);
  assert.equal(semanticStreamSettled({
    inputEvents: 1,
    outputEvents: 1,
    lastTranscriptionAt: 1_000,
    now: 3_000,
    quietMilliseconds: 2_000,
  }), true);
});

test("provider semantic fixtures disambiguate source meaning and accept equivalent target wording", () => {
  const fixtures = providerSemanticFixtures();
  const koToJa = fixtures.find(({ id }) => id === "ko-to-ja-1");
  const koToJaSeoul = fixtures.find(({ id }) => id === "ko-to-ja-2");
  const koToJaSpring = fixtures.find(({ id }) => id === "ko-to-ja-3");
  const jaToKo = fixtures.find(({ id }) => id === "ja-to-ko-1");

  assert.match(koToJa.spoken, /사과 과일/);
  assert.match(koToJaSeoul.spoken, /서울.*밤하늘의 별/);
  assert.match(koToJaSpring.spoken, /봄 계절/);
  assert.deepEqual(evaluateProviderSemanticTrial({
    fixture: koToJa,
    input: "빨간 사과 과일로 시작합니다. 기차로 마칩니다.",
    output: "赤い林檎から始めます。電車で終わります。",
  }), { firstMeaning: true, lastMeaning: true });
  assert.deepEqual(evaluateProviderSemanticTrial({
    fixture: jaToKo,
    input: "りんごから始めます。電車で終わります。",
    output: "사과로 시작합니다. 전철로 마칩니다.",
  }), { firstMeaning: true, lastMeaning: true });
});
