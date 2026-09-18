const COMPONENTS = [
  "node scripts/dynamic-mic-browser-canary.mjs",
  "node scripts/listening-mix-browser-canary.mjs",
  "node scripts/listening-mode-browser-canary.mjs",
];

export async function runNaturalConversationCanary({ run } = {}) {
  if (typeof run !== "function") throw new Error("browser canary command runner is required");
  const [dynamic, mix, modes] = await Promise.all(COMPONENTS.map((command) => run(command)));

  if (
    dynamic?.participantGenerated !== true ||
    dynamic?.microphone !== "unmuted" ||
    dynamic?.speech !== "silent" ||
    dynamic?.manualSpeechControls !== 0 ||
    dynamic?.privacySafeTimeline !== true
  ) {
    throw new Error("dynamic participant evidence is incomplete");
  }
  if (
    mix?.attachedAudioElements !== 2 ||
    mix?.gainRelation !== "original < translation"
  ) {
    throw new Error("dual audio relative-gain evidence is incomplete");
  }
  if (
    modes?.translationOnly !== true ||
    modes?.automaticRestore !== "translation-only" ||
    modes?.audioNodesMatchPlans !== true
  ) {
    throw new Error("listener mode evidence is incomplete");
  }

  return {
    ok: true,
    dynamicJoin: true,
    micOnSilent: true,
    manualSpeechControlsAbsent: true,
    dualAudioRelativeGain: true,
    translationOnly: true,
    automaticOriginalCheckRestore: true,
    privacySafeTimeline: true,
  };
}
