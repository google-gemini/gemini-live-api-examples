import assert from "node:assert/strict";
import test from "node:test";

import { SpeechActivityDetector } from "../src/speech-activity-detector.mjs";

test("voice followed by sustained silence emits one automatic utterance boundary", () => {
  const events = [];
  const detector = new SpeechActivityDetector({
    onEvent: (event) => events.push(event),
    speechThreshold: 0.05,
    silenceMilliseconds: 500,
    minimumUtteranceSpanMilliseconds: 0,
  });

  detector.observe(0.01, 0);
  detector.observe(0.08, 100);
  detector.observe(0.09, 250);
  detector.observe(0.01, 600);
  detector.observe(0.01, 749);
  detector.observe(0.01, 750);
  detector.observe(0.01, 1_000);

  assert.deepEqual(events, [
    { type: "speech-start", observedAt: 100 },
    { type: "speech-end", observedAt: 750 },
  ]);
});

test("brief speech and a short pause stay in one utterance when speech resumes", () => {
  const events = [];
  const detector = new SpeechActivityDetector({
    onEvent: (event) => events.push(event),
  });

  detector.observe(0.08, 100);
  detector.observe(0.09, 700);
  detector.observe(0.01, 1_300);
  detector.observe(0.01, 2_200);
  detector.observe(0.08, 2_300);
  detector.observe(0.09, 2_900);
  detector.observe(0.01, 3_500);
  detector.observe(0.01, 4_700);

  assert.deepEqual(events, [
    { type: "speech-start", observedAt: 100 },
    { type: "speech-end", observedAt: 4_700 },
  ]);
});

test("a long utterance stays open across a natural pause when speech resumes", () => {
  const events = [];
  const detector = new SpeechActivityDetector({
    onEvent: (event) => events.push(event),
  });

  detector.observe(0.08, 100);
  detector.observe(0.09, 1_900);
  detector.observe(0.01, 2_600);
  detector.observe(0.08, 2_700);
  detector.observe(0.09, 3_500);
  detector.observe(0.01, 5_299);
  detector.observe(0.01, 5_300);

  assert.deepEqual(events, [
    { type: "speech-start", observedAt: 100 },
    { type: "speech-end", observedAt: 5_300 },
  ]);
});

test("a lone brief utterance closes after the extended silence boundary", () => {
  const events = [];
  const detector = new SpeechActivityDetector({
    onEvent: (event) => events.push(event),
  });

  detector.observe(0.08, 100);
  detector.observe(0.09, 700);
  detector.observe(0.01, 2_499);
  detector.observe(0.01, 2_500);

  assert.deepEqual(events, [
    { type: "speech-start", observedAt: 100 },
    { type: "speech-end", observedAt: 2_500 },
  ]);
});

test("stopping the detector closes a currently speaking utterance", () => {
  const events = [];
  const detector = new SpeechActivityDetector({ onEvent: (event) => events.push(event) });

  detector.observe(1, 10);
  detector.stop(20);
  detector.stop(30);

  assert.deepEqual(events, [
    { type: "speech-start", observedAt: 10 },
    { type: "speech-end", observedAt: 20 },
  ]);
});
