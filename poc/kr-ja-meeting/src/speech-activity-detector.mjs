export class SpeechActivityDetector {
  #onEvent;
  #speechThreshold;
  #silenceMilliseconds;
  #minimumUtteranceSpanMilliseconds;
  #shortUtteranceSilenceMilliseconds;
  #speaking = false;
  #firstVoiceAt = null;
  #lastVoiceAt = null;

  constructor({
    onEvent,
    speechThreshold = 0.05,
    silenceMilliseconds = 1_800,
    minimumUtteranceSpanMilliseconds = 1_800,
    shortUtteranceSilenceMilliseconds = 1_800,
  }) {
    if (typeof onEvent !== "function") throw new Error("onEvent is required");
    if (!(speechThreshold > 0)) throw new Error("speechThreshold must be positive");
    if (!(silenceMilliseconds >= 0)) throw new Error("silenceMilliseconds must be non-negative");
    if (!(minimumUtteranceSpanMilliseconds >= 0)) {
      throw new Error("minimumUtteranceSpanMilliseconds must be non-negative");
    }
    if (!(shortUtteranceSilenceMilliseconds >= silenceMilliseconds)) {
      throw new Error("shortUtteranceSilenceMilliseconds must cover regular silence");
    }
    this.#onEvent = onEvent;
    this.#speechThreshold = speechThreshold;
    this.#silenceMilliseconds = silenceMilliseconds;
    this.#minimumUtteranceSpanMilliseconds = minimumUtteranceSpanMilliseconds;
    this.#shortUtteranceSilenceMilliseconds = shortUtteranceSilenceMilliseconds;
  }

  observe(level, observedAt) {
    if (!Number.isFinite(level) || !Number.isFinite(observedAt)) {
      throw new Error("finite level and observedAt are required");
    }
    if (level >= this.#speechThreshold) {
      this.#lastVoiceAt = observedAt;
      if (!this.#speaking) {
        this.#speaking = true;
        this.#firstVoiceAt = observedAt;
        this.#onEvent({ type: "speech-start", observedAt });
      }
      return;
    }
    const utteranceSpanMilliseconds = this.#lastVoiceAt - this.#firstVoiceAt;
    const requiredSilenceMilliseconds =
      utteranceSpanMilliseconds < this.#minimumUtteranceSpanMilliseconds
      ? this.#shortUtteranceSilenceMilliseconds
      : this.#silenceMilliseconds;
    if (
      this.#speaking &&
      observedAt - this.#lastVoiceAt >= requiredSilenceMilliseconds
    ) {
      this.#speaking = false;
      this.#firstVoiceAt = null;
      this.#lastVoiceAt = null;
      this.#onEvent({ type: "speech-end", observedAt });
    }
  }

  stop(observedAt) {
    if (!this.#speaking) return;
    if (!Number.isFinite(observedAt)) throw new Error("finite observedAt is required");
    this.#speaking = false;
    this.#firstVoiceAt = null;
    this.#lastVoiceAt = null;
    this.#onEvent({ type: "speech-end", observedAt });
  }
}
