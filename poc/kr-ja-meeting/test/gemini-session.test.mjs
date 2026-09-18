import assert from "node:assert/strict";
import test from "node:test";

import { MemoryMeetingGlossary, buildGeminiSetup } from "../src/gemini-session.mjs";

test("Gemini setup is ZDR and carries only direction plus an in-memory glossary", () => {
  const setup = buildGeminiSetup({
    targetLanguage: "ko",
    glossary: [
      { source: "入館証", target: "출입증" },
      { source: "稟議", target: "품의" },
    ],
  });

  assert.equal("sessionResumption" in setup.setup, false);
  assert.equal("clientContent" in setup, false);
  assert.equal("tools" in setup.setup, false);
  assert.equal(setup.setup.generationConfig.translationConfig.targetLanguageCode, "ko");
  assert.match(setup.setup.systemInstruction.parts[0].text, /入館証 => 출입증/);
  assert.match(setup.setup.systemInstruction.parts[0].text, /稟議 => 품의/);
});

test("meeting glossary stays in memory and can be disposed", () => {
  const glossary = new MemoryMeetingGlossary();
  glossary.replace([{ source: "申請", target: "신청" }]);
  const copy = glossary.entries();
  copy[0].target = "changed";

  assert.deepEqual(glossary.entries(), [{ source: "申請", target: "신청" }]);
  glossary.clear();
  assert.equal(glossary.size, 0);
});

test("transcription is disabled by default and enabled only for an explicit canary setup", () => {
  const product = buildGeminiSetup({ targetLanguage: "ja" });
  assert.equal("inputAudioTranscription" in product.setup, false);
  assert.equal("outputAudioTranscription" in product.setup, false);

  const canary = buildGeminiSetup({ targetLanguage: "ja", canaryTranscription: true });
  assert.deepEqual(canary.setup.inputAudioTranscription, {});
  assert.deepEqual(canary.setup.outputAudioTranscription, {});
});
