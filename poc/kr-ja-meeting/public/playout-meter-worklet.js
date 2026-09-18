class PlayoutMeterProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frameSamples = Math.round(sampleRate * 0.02);
    this.sumSquares = 0;
    this.sampleCount = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (let index = 0; index < channel.length; index += 1) {
      const sample = channel[index];
      this.sumSquares += sample * sample;
      this.sampleCount += 1;
      if (this.sampleCount !== this.frameSamples) continue;
      this.port.postMessage({
        audioTimeMs: currentTime * 1_000 + index * 1_000 / sampleRate,
        rms: Math.sqrt(this.sumSquares / this.sampleCount),
      });
      this.sumSquares = 0;
      this.sampleCount = 0;
    }
    return true;
  }
}

registerProcessor("playout-meter", PlayoutMeterProcessor);
