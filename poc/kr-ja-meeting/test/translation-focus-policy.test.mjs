import assert from "node:assert/strict";
import test from "node:test";

import { TranslationFocusPolicy } from "../src/translation-focus-policy.mjs";

test("first speaker keeps focus through a short overlap and hands off after ending", () => {
  let now = 0;
  const policy = new TranslationFocusPolicy({
    clock: () => now,
    minimumFocusHoldMilliseconds: 500,
    overlapWarningMilliseconds: 1_000,
  });

  policy.speechStarted("ja-1");
  now = 100;
  policy.speechStarted("ko-1");

  now = 499;
  assert.deepEqual(policy.snapshot(), {
    speakingParticipantIds: ["ja-1", "ko-1"],
    translationFocusId: "ja-1",
    focusSelectedAt: 0,
    overlap: {
      active: true,
      detected: false,
      participantIds: ["ja-1", "ko-1"],
      startedAt: 100,
      detectedAt: null,
      message: null,
    },
  });

  now = 600;
  policy.speechEnded("ja-1");
  assert.equal(policy.snapshot().translationFocusId, "ko-1");
  assert.deepEqual(policy.snapshot().speakingParticipantIds, ["ko-1"]);
});

test("an overlap candidate must outlast the minimum hold before receiving vacated focus", () => {
  let now = 0;
  const policy = new TranslationFocusPolicy({
    clock: () => now,
    minimumFocusHoldMilliseconds: 500,
  });

  policy.speechStarted("main-speaker");
  now = 100;
  policy.speechStarted("acknowledgment");
  now = 200;
  assert.equal(policy.speechEnded("main-speaker").translationFocusId, null);

  now = 599;
  assert.equal(policy.advance().translationFocusId, null);
  now = 600;
  assert.equal(policy.advance().translationFocusId, "acknowledgment");
});

test("a short acknowledgment that ends before the minimum hold never receives focus", () => {
  let now = 0;
  const policy = new TranslationFocusPolicy({
    clock: () => now,
    minimumFocusHoldMilliseconds: 500,
  });

  policy.speechStarted("main-speaker");
  now = 100;
  policy.speechStarted("acknowledgment");
  now = 200;
  policy.speechEnded("main-speaker");
  now = 300;
  policy.speechEnded("acknowledgment");
  now = 600;

  assert.equal(policy.advance().translationFocusId, null);
  assert.deepEqual(policy.snapshot().speakingParticipantIds, []);
});

test("long overlap becomes a warning without removing either speaker", () => {
  let now = 10;
  const policy = new TranslationFocusPolicy({
    clock: () => now,
    overlapWarningMilliseconds: 1_000,
  });
  policy.speechStarted("ja-1");
  now = 30;
  policy.speechStarted("ko-1");

  now = 1_030;
  assert.deepEqual(policy.snapshot().overlap, {
    active: true,
    detected: true,
    participantIds: ["ja-1", "ko-1"],
    startedAt: 30,
    detectedAt: 1_030,
    message: "동시에 말하고 있어 일부 통역이 불완전할 수 있습니다.",
  });
});
