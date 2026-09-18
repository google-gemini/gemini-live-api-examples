const TARGET_LANGUAGES = new Set(["ko", "ja"]);

export function buildGeminiSetup({
  targetLanguage,
  glossary = [],
  automaticActivityDetection = true,
  canaryTranscription = false,
}) {
  if (!TARGET_LANGUAGES.has(targetLanguage)) {
    throw new Error(`unsupported target language: ${targetLanguage}`);
  }

  const terms = validateGlossary(glossary);
  const setup = {
      model: "models/gemini-3.5-live-translate-preview",
      generationConfig: {
        responseModalities: ["AUDIO"],
        translationConfig: {
          targetLanguageCode: targetLanguage,
          echoTargetLanguage: true,
        },
      },
      realtimeInputConfig: {
        automaticActivityDetection: { disabled: !automaticActivityDetection },
      },
  };
  if (canaryTranscription === true) {
    setup.inputAudioTranscription = {};
    setup.outputAudioTranscription = {};
  }
  if (terms.length > 0) {
    setup.systemInstruction = {
      parts: [{
        text: [
          "Use these meeting glossary pairs when translating. Do not add conversation history:",
          ...terms.map(({ source, target }) => `${source} => ${target}`),
        ].join("\n"),
      }],
    };
  }
  return { setup };
}

export class MemoryMeetingGlossary {
  #entries = [];

  get size() {
    return this.#entries.length;
  }

  replace(entries) {
    this.#entries = validateGlossary(entries);
  }

  entries() {
    return this.#entries.map((entry) => ({ ...entry }));
  }

  clear() {
    this.#entries = [];
  }
}

function validateGlossary(entries) {
  if (!Array.isArray(entries)) throw new Error("glossary must be an array");
  return entries.map((entry) => {
    if (typeof entry?.source !== "string" || !entry.source.trim()) {
      throw new Error("glossary source is required");
    }
    if (typeof entry?.target !== "string" || !entry.target.trim()) {
      throw new Error("glossary target is required");
    }
    return { source: entry.source.trim(), target: entry.target.trim() };
  });
}
