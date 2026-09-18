import assert from "node:assert/strict";
import test from "node:test";

import { runNaturalConversationCanary } from "../src/natural-conversation-canary.mjs";

test("natural conversation browser evidence composes existing thin canaries", async () => {
  const commands = [];
  const report = await runNaturalConversationCanary({
    run: async (command) => {
      commands.push(command);
      if (command.includes("dynamic-mic")) return {
        participantGenerated: true,
        microphone: "unmuted",
        speech: "silent",
        manualSpeechControls: 0,
        privacySafeTimeline: true,
      };
      if (command.includes("listening-mix")) return {
        attachedAudioElements: 2,
        gainRelation: "original < translation",
      };
      return {
        translationOnly: true,
        automaticRestore: "translation-only",
        audioNodesMatchPlans: true,
      };
    },
  });

  assert.deepEqual(commands, [
    "node scripts/dynamic-mic-browser-canary.mjs",
    "node scripts/listening-mix-browser-canary.mjs",
    "node scripts/listening-mode-browser-canary.mjs",
  ]);
  assert.deepEqual(report, {
    ok: true,
    dynamicJoin: true,
    micOnSilent: true,
    manualSpeechControlsAbsent: true,
    dualAudioRelativeGain: true,
    translationOnly: true,
    automaticOriginalCheckRestore: true,
    privacySafeTimeline: true,
  });
});

test("natural conversation browser evidence fails closed when a component is incomplete", async () => {
  await assert.rejects(
    runNaturalConversationCanary({ run: async () => ({}) }),
    /dynamic participant evidence is incomplete/,
  );
});
