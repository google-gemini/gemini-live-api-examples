const REQUIRED_EVIDENCE = new Map([
  ["participantsConnected", (value) => Number.isInteger(value) && value >= 4],
  ["originalTrackSubscribed", (value) => value === true],
  ["geminiSetupComplete", (value) => value === true],
  ["translatedFrames", (value) => Number.isInteger(value) && value > 0],
  ["translationTrackPublished", (value) => value === true],
  ["translationTrackSubscribed", (value) => value === true],
  ["listenerReceivedTranslatedAudio", (value) => value === true],
  ["phraseBoundary", (value) => value === true],
  ["freshSessionSetup", (value) => value === true],
  ["originalCheckExclusive", (value) => value === true],
  ["translationRestoredAtBoundary", (value) => value === true],
]);

export const GEMINI_INPUT_SAMPLE_RATE = 16_000;

export function publicationName(publication) {
  return publication?.name ?? publication?.trackName ?? null;
}

export class ProviderCanaryEvidence {
  #values = new Map();

  record(name, value) {
    if (!REQUIRED_EVIDENCE.has(name)) {
      throw new Error(`unknown provider evidence: ${name}`);
    }
    if (
      name === "phraseBoundary" &&
      this.#values.get("originalCheckExclusive") !== true
    ) {
      throw new Error("original check must start before the phrase boundary");
    }
    if (
      name === "translationRestoredAtBoundary" &&
      this.#values.get("phraseBoundary") !== true
    ) {
      throw new Error("translation can return only after the phrase boundary");
    }
    this.#values.set(name, value);
  }

  get complete() {
    return [...REQUIRED_EVIDENCE].every(([name, validate]) =>
      validate(this.#values.get(name)),
    );
  }

  snapshot() {
    return Object.fromEntries(
      [...REQUIRED_EVIDENCE.keys()].map((name) => [
        name,
        this.#values.get(name) ?? false,
      ]),
    );
  }
}

const SEMANTIC_DIRECTIONS = new Set(["ko-to-ja", "ja-to-ko"]);
const PROVIDER_SEMANTIC_STREAM_PLAN = Object.freeze({
  automaticActivityDetection: true,
  leadingSilenceMilliseconds: 1_000,
  trailingSilenceMilliseconds: 2_000,
  transcriptionQuietMilliseconds: 2_000,
  transcriptionTimeoutMilliseconds: 12_000,
});
const PROVIDER_SEMANTIC_FIXTURES = Object.freeze([
  semanticFixture("ko-to-ja-1", "ko-to-ja", "Yuna", "빨간 사과 과일로 시작합니다. 오늘 안건을 검토합니다. 기차로 마칩니다.", ["사과"], ["기차"], ["りんご", "リンゴ", "林檎"], ["電車"]),
  semanticFixture("ko-to-ja-2", "ko-to-ja", "Yuna", "서울로 시작합니다. 예산을 확인합니다. 밤하늘의 별로 마칩니다.", ["서울"], ["별"], ["ソウル"], ["星"]),
  semanticFixture("ko-to-ja-3", "ko-to-ja", "Yuna", "따뜻한 봄 계절로 시작합니다. 다음 일정을 논의합니다. 중요한 약속으로 마칩니다.", ["봄"], ["약속"], ["春"], ["約束"]),
  semanticFixture("ja-to-ko-1", "ja-to-ko", "Kyoko", "りんごから始めます。今日の議題を確認します。電車で終わります。", ["りんご", "リンゴ", "林檎"], ["電車"], ["사과"], ["기차", "전철", "전차"]),
  semanticFixture("ja-to-ko-2", "ja-to-ko", "Kyoko", "海から始めます。予算を確認します。星で終わります。", ["海"], ["星"], ["바다"], ["별"]),
  semanticFixture("ja-to-ko-3", "ja-to-ko", "Kyoko", "春から始めます。次の日程を話します。約束で終わります。", ["春"], ["約束"], ["봄"], ["약속"]),
]);

export function providerSemanticStreamPlan() {
  return { ...PROVIDER_SEMANTIC_STREAM_PLAN };
}

export function providerSemanticFixtures() {
  return PROVIDER_SEMANTIC_FIXTURES.map((fixture) => ({
    ...fixture,
    sourceFirst: [...fixture.sourceFirst],
    sourceLast: [...fixture.sourceLast],
    targetFirst: [...fixture.targetFirst],
    targetLast: [...fixture.targetLast],
  }));
}

export function semanticStreamSettled({
  inputEvents,
  outputEvents,
  lastTranscriptionAt,
  now,
  quietMilliseconds,
} = {}) {
  return Number.isInteger(inputEvents)
    && inputEvents > 0
    && Number.isInteger(outputEvents)
    && outputEvents > 0
    && Number.isFinite(lastTranscriptionAt)
    && lastTranscriptionAt > 0
    && Number.isFinite(now)
    && Number.isFinite(quietMilliseconds)
    && quietMilliseconds >= 0
    && now - lastTranscriptionAt >= quietMilliseconds;
}

export function evaluateProviderSemanticTrial({ fixture, input, output } = {}) {
  if (!fixture || typeof input !== "string" || typeof output !== "string") {
    throw new Error("semantic fixture, input, and output are required");
  }
  return {
    firstMeaning: containsSemanticTerm(input, fixture.sourceFirst)
      && containsSemanticTerm(output, fixture.targetFirst),
    lastMeaning: containsSemanticTerm(input, fixture.sourceLast)
      && containsSemanticTerm(output, fixture.targetLast),
  };
}

export class ProviderSemanticEvidence {
  #trialsByDirection = new Map([
    ["ko-to-ja", []],
    ["ja-to-ko", []],
  ]);
  #trialIds = new Set();

  record({ direction, trialId, firstMeaning, lastMeaning } = {}) {
    if (!SEMANTIC_DIRECTIONS.has(direction)) {
      throw new Error(`unsupported semantic direction: ${direction}`);
    }
    if (typeof trialId !== "string" || !trialId) {
      throw new Error("semantic trial id is required");
    }
    if (this.#trialIds.has(trialId)) throw new Error(`duplicate semantic trial: ${trialId}`);
    if (typeof firstMeaning !== "boolean" || typeof lastMeaning !== "boolean") {
      throw new Error("semantic meaning evidence must be boolean");
    }
    const trials = this.#trialsByDirection.get(direction);
    if (trials.length >= 3) throw new Error(`too many semantic trials: ${direction}`);
    this.#trialIds.add(trialId);
    trials.push({ firstMeaning, lastMeaning });
  }

  get complete() {
    return [...this.#trialsByDirection.values()].every((trials) =>
      trials.length === 3 && trials.every(({ firstMeaning, lastMeaning }) =>
        firstMeaning && lastMeaning));
  }

  snapshot() {
    return {
      ok: this.complete,
      "ko-to-ja": this.#trialsByDirection.get("ko-to-ja").map((trial) => ({ ...trial })),
      "ja-to-ko": this.#trialsByDirection.get("ja-to-ko").map((trial) => ({ ...trial })),
    };
  }
}

function semanticFixture(id, direction, voice, spoken, sourceFirst, sourceLast, targetFirst, targetLast) {
  return Object.freeze({
    id,
    direction,
    voice,
    spoken,
    sourceFirst: Object.freeze(sourceFirst),
    sourceLast: Object.freeze(sourceLast),
    targetFirst: Object.freeze(targetFirst),
    targetLast: Object.freeze(targetLast),
  });
}

function containsSemanticTerm(value, terms) {
  if (!Array.isArray(terms) || terms.length === 0) return false;
  const normalized = value.normalize("NFKC").toLocaleLowerCase();
  return terms.some((term) =>
    normalized.includes(term.normalize("NFKC").toLocaleLowerCase()));
}
