import { performance } from "node:perf_hooks";

export class LiveTranslationBridge {
  #meetingId;
  #audioGateway;
  #geminiFactory;
  #drainQuietMilliseconds;
  #firstAudioTimeoutMilliseconds;
  #captureCleanupTimeoutMilliseconds;
  #continuousInput;
  #preRollMilliseconds;
  #replacementBufferMilliseconds;
  #fastRecoveryAttempts;
  #recoveryCooldownMilliseconds;
  #scheduleRecovery;
  #cancelRecovery;
  #onTranslationAvailability;
  #clock;
  #eventRecorder;
  #preparedInputs = new Map();
  #active = null;
  #startingProviderState = null;
  #startPromise = null;
  #abortRevision = 0;
  #translationAvailability = "available";

  constructor({
    meetingId,
    audioGateway,
    geminiFactory,
    drainQuietMilliseconds = 1_500,
    firstAudioTimeoutMilliseconds = 5_000,
    captureCleanupTimeoutMilliseconds = 200,
    continuousInput = false,
    preRollMilliseconds = 1_000,
    replacementBufferMilliseconds = 2_000,
    fastRecoveryAttempts = 3,
    recoveryCooldownMilliseconds = 30_000,
    scheduleRecovery = (callback, milliseconds) => setTimeout(callback, milliseconds),
    cancelRecovery = (timer) => clearTimeout(timer),
    onTranslationAvailability = () => {},
    clock = () => performance.now(),
    eventRecorder = { record() {} },
  }) {
    if (!meetingId || !audioGateway || !geminiFactory) {
      throw new Error("meetingId, audioGateway, and geminiFactory are required");
    }
    this.#meetingId = meetingId;
    this.#audioGateway = audioGateway;
    this.#geminiFactory = geminiFactory;
    this.#drainQuietMilliseconds = drainQuietMilliseconds;
    this.#firstAudioTimeoutMilliseconds = firstAudioTimeoutMilliseconds;
    if (!Number.isFinite(captureCleanupTimeoutMilliseconds)
      || captureCleanupTimeoutMilliseconds <= 0) {
      throw new Error("captureCleanupTimeoutMilliseconds must be a positive number");
    }
    this.#captureCleanupTimeoutMilliseconds = captureCleanupTimeoutMilliseconds;
    this.#continuousInput = continuousInput;
    if (!Number.isFinite(preRollMilliseconds) || preRollMilliseconds <= 0) {
      throw new Error("preRollMilliseconds must be a positive number");
    }
    this.#preRollMilliseconds = preRollMilliseconds;
    this.#replacementBufferMilliseconds = replacementBufferMilliseconds;
    this.#fastRecoveryAttempts = fastRecoveryAttempts;
    this.#recoveryCooldownMilliseconds = recoveryCooldownMilliseconds;
    this.#scheduleRecovery = scheduleRecovery;
    this.#cancelRecovery = cancelRecovery;
    if (typeof onTranslationAvailability !== "function") {
      throw new Error("onTranslationAvailability must be a function");
    }
    this.#onTranslationAvailability = onTranslationAvailability;
    if (typeof clock !== "function") throw new Error("translation bridge clock is required");
    this.#clock = clock;
    if (!eventRecorder || typeof eventRecorder.record !== "function") {
      throw new Error("eventRecorder.record must be a function");
    }
    this.#eventRecorder = eventRecorder;
  }

  async prepare(speaker) {
    const existing = this.#preparedInputs.get(speaker.id);
    if (existing) {
      if (existing.language !== speaker.language) {
        throw new Error("prepared speaker language cannot change");
      }
      await existing.ready;
      return;
    }

    const prepared = createPreparedInput(speaker, this.#preRollMilliseconds);
    this.#preparedInputs.set(speaker.id, prepared);
    prepared.ready = this.#audioGateway.subscribeOriginal(
      `original:${speaker.id}`,
      (pcm, sampleRate) => prepared.receive(pcm, sampleRate),
    ).then((subscription) => {
      prepared.subscription = subscription;
    });
    try {
      await prepared.ready;
    } catch (error) {
      if (this.#preparedInputs.get(speaker.id) === prepared) {
        this.#preparedInputs.delete(speaker.id);
      }
      throw error;
    }
  }

  async release(participantId) {
    if (this.#active?.context.participantId === participantId) {
      throw new Error("cannot release the active translation input");
    }
    const prepared = this.#preparedInputs.get(participantId);
    if (!prepared) return;
    this.#preparedInputs.delete(participantId);
    await settle(prepared.ready);
    await prepared.subscription?.close();
    prepared.clear();
  }

  start(speaker, { utteranceId } = {}) {
    if (this.#active || this.#startPromise) {
      return Promise.reject(new Error("translation bridge is already active"));
    }
    const startRevision = this.#abortRevision;
    const startPromise = this.#startSpeaker(speaker, utteranceId, startRevision);
    this.#startPromise = startPromise;
    return startPromise.finally(() => {
      if (this.#startPromise === startPromise) this.#startPromise = null;
    });
  }

  async #startSpeaker(speaker, utteranceId, startRevision) {
    const targetLanguage = speaker.language === "ko" ? "ja" : "ko";
    let gemini;
    const alreadyPrepared = this.#preparedInputs.has(speaker.id);
    let preparedInput;
    let captureChain = Promise.resolve();
    let lastTranslatedAudioAt = 0;
    let audibleOutputReceived = false;
    let audibleInputReceived = false;
    let acceptingInput = true;
    let acceptingOutput = true;
    let outputGeneration = 0;
    let inputRecorded = false;
    let outputRecorded = false;
    let outputCompleted = false;
    let setupSucceeded = false;
    let audioDrainGeneration = 0;
    const drainQuietMilliseconds = this.#drainQuietMilliseconds;
    const firstAudioTimeoutMilliseconds = this.#firstAudioTimeoutMilliseconds;
    const context = {
      participantId: speaker.id,
      utteranceId,
      language: speaker.language,
      targetLanguage,
    };
    this.#record("gemini-setup-started", context, { result: "started" });
    try {
      this.#record("livekit-subscribe-started", context, { result: "started" });
      try {
        await this.prepare(speaker);
        this.#record("livekit-subscribe-succeeded", context, { result: "succeeded" });
      } catch (error) {
        this.#record("livekit-subscribe-failed", context, {
          result: "failed",
          errorCode: "original-subscription-failed",
        });
        throw error;
      }
      preparedInput = this.#preparedInputs.get(speaker.id);
      const sink = await this.#audioGateway.translationSink(targetLanguage);
      const sinkGeneration = {};
      this.#throwIfAborted(startRevision);
      let active;
      let providerState;
      let recovering = false;
      let recoveryTimer = null;
      const recoveryBuffer = createDurationBuffer(this.#replacementBufferMilliseconds);
      const captureTranslatedAudio = (base64Audio, generation) => {
        if (!acceptingOutput || generation !== outputGeneration) return Promise.resolve();
        const pcm = Buffer.from(base64Audio, "base64");
        if (hasAudiblePcm(pcm)) {
          audibleOutputReceived = true;
          lastTranslatedAudioAt = Date.now();
          if (!outputRecorded) {
            outputRecorded = true;
            this.#record("gemini-output-received", context, { result: "received" });
          }
        }
        captureChain = captureChain.then(async () => {
          if (!acceptingOutput || generation !== outputGeneration) return;
          const capture = await sink.capture(pcm, sinkGeneration);
          if (!acceptingOutput || generation !== outputGeneration) return;
          if (Number.isFinite(capture?.queuedAfterMs)) {
            this.#record("livekit-queue-updated", context, {
              queueDurationMs: capture.queuedAfterMs,
              result: "queued",
            });
          }
        });
        return captureChain;
      };
      let recoveryPromise = null;
      let recoveryRevision = 0;
      let recoveryCancellation = null;
      const connectFresh = async () => {
        const setup = deferred();
        void setup.promise.catch(() => {});
        const state = {
          intentional: false,
          setupComplete: false,
          cancelled: false,
          client: null,
          cancel() {
            if (state.cancelled) return;
            state.cancelled = true;
            state.intentional = true;
            setup.reject(providerRecoveryCancelled());
            state.client?.close();
          },
        };
        const generation = ++outputGeneration;
        try {
          const client = this.#geminiFactory({
            meetingId: this.#meetingId,
            targetLanguage,
            participantId: speaker.id,
            utteranceId: context.utteranceId,
            eventRecorder: this.#eventRecorder,
            onSetupComplete() {
              if (state.cancelled) return;
              state.setupComplete = true;
              setup.resolve();
            },
            onGenerationComplete() {
              if (generation === outputGeneration) outputCompleted = true;
            },
            onTurnComplete() {
              if (generation === outputGeneration) outputCompleted = true;
            },
            onClose() {
              if (state.intentional) return;
              if (!state.setupComplete) setup.reject(new Error("Gemini closed during setup"));
              else void recoverProvider();
            },
            onError(error) {
              if (state.intentional) return;
              if (!state.setupComplete) setup.reject(error);
              else void recoverProvider();
            },
            onServerEvent(event) {
              if (!event?.goAway) return;
              void recoverProvider({
                proactive: true,
                timeLeftMilliseconds: event.timeLeftMilliseconds,
              });
            },
            onTranslatedAudio: (base64Audio) => captureTranslatedAudio(base64Audio, generation),
          });
          state.client = client;
          this.#startingProviderState = state;
          client.connect();
          await withTimeout(setup.promise, "Gemini setup", 20_000);
        } catch (error) {
          state.intentional = true;
          state.client?.close();
          throw error;
        } finally {
          if (this.#startingProviderState === state) this.#startingProviderState = null;
        }
        return state;
      };
      const replaceWithFastRetries = async () => {
        let lastError;
        for (let attempt = 1; attempt <= this.#fastRecoveryAttempts; attempt += 1) {
          try {
            return await connectFresh();
          } catch (error) {
            if (isProviderRecoveryCancelled(error)) throw error;
            lastError = error;
            this.#record("gemini-retry-failed", context, {
              result: "failed",
              errorCode: "fresh-session-setup-failed",
            });
          }
        }
        throw lastError;
      };
      const recoverProvider = ({ proactive = false, timeLeftMilliseconds } = {}) => {
        if (recovering || !acceptingInput || !active) return;
        recovering = true;
        const revision = ++recoveryRevision;
        const cancellation = deferred();
        recoveryCancellation = cancellation;
        recoveryPromise = (async () => {
          const previousProvider = providerState;
          if (!proactive) {
            previousProvider.intentional = true;
            previousProvider.client.close();
          }
          outputGeneration += 1;
          const replacementStartedAt = this.#clock();
          const reconnectReason = proactive
            ? (Number.isFinite(timeLeftMilliseconds) ? "go-away-time-left" : "go-away")
            : "provider-closed";
          this.#publishAvailability("reconnecting");
          this.#record("gemini-retry-started", context, {
            result: "started",
            reconnectReason,
          });
          try {
            await Promise.race([captureChain, cancellation.promise]);
            if (revision !== recoveryRevision || !acceptingInput || this.#active !== active) {
              throw providerRecoveryCancelled();
            }
            if (typeof sink.clearQueue !== "function") {
              throw new Error("translation sink clearQueue is required for provider recovery");
            }
            sink.clearQueue();
            const next = await replaceWithFastRetries();
            if (revision !== recoveryRevision || !acceptingInput || this.#active !== active) {
              next.cancel();
              throw providerRecoveryCancelled();
            }
            previousProvider.intentional = true;
            previousProvider.client.close();
            providerState = next;
            gemini = next.client;
            active.gemini = gemini;
            for (const frame of recoveryBuffer.take()) {
              gemini.sendPcm16(frame.pcm, frame.sampleRate);
            }
            this.#publishAvailability("available");
            this.#record("gemini-retry-succeeded", context, {
              result: "succeeded",
              reconnectReason,
              interruptionMilliseconds: Math.max(0, this.#clock() - replacementStartedAt),
            });
          } catch (error) {
            if (isProviderRecoveryCancelled(error)
              || revision !== recoveryRevision
              || !acceptingInput
              || this.#active !== active) return;
            previousProvider.intentional = true;
            previousProvider.client.close();
            this.#publishAvailability("unavailable");
            this.#record("gemini-retry-failed", context, {
              result: "unavailable",
              errorCode: "recovery-cooldown",
            });
            recoveryTimer = this.#scheduleRecovery(() => {
              recoveryTimer = null;
              recovering = false;
              void recoverProvider();
            }, this.#recoveryCooldownMilliseconds);
          } finally {
            if (recoveryCancellation === cancellation) recoveryCancellation = null;
            if (!recoveryTimer) recovering = false;
          }
        })();
        return recoveryPromise;
      };

      providerState = await replaceWithFastRetries();
      gemini = providerState.client;
      this.#publishAvailability("available");
      this.#record("gemini-setup-succeeded", context, { result: "succeeded" });
      setupSucceeded = true;
      this.#throwIfAborted(startRevision);
      if (!this.#continuousInput && !gemini.sendActivityStart()) {
        throw new Error("Gemini activityStart was not sent");
      }
      this.#record("gemini-input-started", context, { result: "started" });

      const sendInput = (pcm, sampleRate) => {
          if (!acceptingInput) return;
          if (hasAudiblePcm(pcm)) {
            audibleInputReceived = true;
            if (!inputRecorded) {
              inputRecorded = true;
              this.#record("gemini-input-received", context, { result: "received" });
            }
          }
          if (recovering) {
            recoveryBuffer.push(pcm, sampleRate);
          } else if (!gemini.sendPcm16(pcm, sampleRate)) {
            throw new Error("Gemini PCM frame was not sent");
          }
      };
      preparedInput.forwardTo(sendInput);
      this.#throwIfAborted(startRevision);
      const cancelSinkOutput = ({ requireGenerationInvalidation = false } = {}) => {
        acceptingOutput = false;
        outputGeneration += 1;
        if (requireGenerationInvalidation && typeof sink.invalidateGeneration !== "function") {
          throw new Error("translation sink invalidateGeneration is required for handoff");
        }
        sink.invalidateGeneration?.(sinkGeneration);
        sink.clearQueue?.();
      };
      active = {
        context,
        gemini,
        preparedInput,
        capture: () => captureChain,
        waitForPlayout: typeof sink.waitForPlayout === "function"
          ? () => sink.waitForPlayout()
          : async () => {},
        pauseInput() { acceptingInput = false; },
        resumeInput() { acceptingInput = true; },
        detachInput() { preparedInput.bufferInstead(); },
        interruptOutput() {
          if (typeof sink.clearQueue !== "function") {
            throw new Error("translation sink clearQueue is required for handoff");
          }
          cancelSinkOutput({ requireGenerationInvalidation: true });
          return typeof sink.queuedDurationMs === "function" ? sink.queuedDurationMs() : 0;
        },
        cancelOutput() { cancelSinkOutput(); },
        resetAudioTurn() {
          audibleInputReceived = false;
          audibleOutputReceived = false;
          outputCompleted = false;
          lastTranslatedAudioAt = 0;
        },
        hasAudibleInput() { return audibleInputReceived; },
        async waitForAudioDrain() {
          const generation = ++audioDrainGeneration;
          const startedAt = Date.now();
          while (true) {
            if (generation !== audioDrainGeneration) return;
            if (audibleOutputReceived) {
              if (outputCompleted) return;
              const quietFrom = Math.max(startedAt, lastTranslatedAudioAt);
              const remaining = drainQuietMilliseconds - (Date.now() - quietFrom);
              if (remaining <= 0) return;
              await delay(Math.min(remaining, 25));
              continue;
            }
            const remaining = firstAudioTimeoutMilliseconds - (Date.now() - startedAt);
            if (remaining <= 0) {
              throw new Error("Gemini produced no audible translation before the drain timeout");
            }
            await delay(Math.min(remaining, 25));
          }
        },
        cancelAudioDrain() { audioDrainGeneration += 1; },
        cancelRecovery: async () => {
          recoveryRevision += 1;
          recoveryCancellation?.resolve();
          if (recoveryTimer) {
            this.#cancelRecovery(recoveryTimer);
            recoveryTimer = null;
          }
          this.#startingProviderState?.cancel();
          if (recoveryPromise) await settle(recoveryPromise);
          recovering = false;
        },
        closeProvider: () => {
          providerState.intentional = true;
          providerState.client.close();
        },
      };
      this.#active = active;
    } catch (error) {
      if (!setupSucceeded) {
        this.#record("gemini-setup-failed", context, {
          result: "failed",
          errorCode: "setup-failed",
        });
      }
      if (preparedInput) preparedInput.bufferInstead();
      if (gemini) {
        if (this.#continuousInput) gemini.sendAudioStreamEnd();
        else gemini.sendActivityEnd();
      }
      gemini?.close();
      if (!alreadyPrepared) await settle(this.release(speaker.id));
      this.#record("resources-closed", context, { result: "closed" });
      throw error;
    }
  }

  async phraseBoundary() {
    const active = this.#requireActive();
    if (this.#continuousInput) {
      if (active.hasAudibleInput()) await active.waitForAudioDrain();
      await active.capture();
      active.resetAudioTurn();
      return;
    }
    active.pauseInput();
    try {
      if (!active.gemini.sendActivityEnd()) {
        throw new Error("Gemini activityEnd was not sent");
      }
      await active.waitForAudioDrain();
      await active.capture();
      if (!active.gemini.sendActivityStart()) {
        throw new Error("Gemini activityStart was not sent after the phrase boundary");
      }
      active.resetAudioTurn();
      active.resumeInput();
    } catch (error) {
      active.cancelAudioDrain();
      await settle(this.#abortActive());
      throw error;
    }
  }

  resume(speaker, { utteranceId } = {}) {
    const active = this.#requireActive();
    if (
      active.context.participantId !== speaker.id
      || active.context.language !== speaker.language
    ) {
      throw new Error("translation bridge can only resume the parked speaker");
    }
    active.context.utteranceId = utteranceId;
    active.resetAudioTurn();
    this.#record("gemini-input-started", active.context, { result: "resumed" });
  }

  async stop({ releasePrepared = true } = {}) {
    const active = this.#requireActive();
    active.pauseInput();
    active.detachInput();
    const sentInputEnd = this.#continuousInput
      ? active.gemini.sendAudioStreamEnd()
      : active.gemini.sendActivityEnd();
    const results = [];
    let geminiClosed = false;
    const closeGemini = async () => {
      if (geminiClosed) return;
      geminiClosed = true;
      await active.cancelRecovery();
      active.closeProvider();
    };
    try {
      results.push(sentInputEnd
        ? active.hasAudibleInput()
          ? await settle(active.waitForAudioDrain())
          : { status: "fulfilled", value: undefined }
        : { status: "rejected", reason: new Error(
          this.#continuousInput
            ? "Gemini audioStreamEnd was not sent"
            : "Gemini activityEnd was not sent",
        ) });
      active.cancelAudioDrain();
      await closeGemini();
      results.push(await settle(active.capture()));
      results.push(await settle(active.waitForPlayout()));
    } finally {
      await closeGemini();
      this.#active = null;
      const outputSucceeded = active.hasAudibleInput()
        && results.slice(0, 3).every(({ status }) => status === "fulfilled");
      this.#record(
        outputSucceeded ? "gemini-output-completed" : "gemini-output-aborted",
        active.context,
        {
          result: outputSucceeded ? "completed" : "aborted",
          ...(outputSucceeded ? {} : { errorCode: "translation-output-incomplete" }),
        },
      );
      this.#record("resources-closed", active.context, { result: "closed" });
    }
    if (releasePrepared) results.push(await settle(this.release(active.context.participantId)));
    const failure = results.find(({ status }) => status === "rejected");
    if (failure) throw failure.reason;
  }

  async handoff(speaker, { utteranceId } = {}) {
    const active = this.#requireActive();
    const interruptedAt = this.#clock();
    this.#active = null;
    active.pauseInput();
    active.detachInput();
    active.cancelAudioDrain();
    const queueDurationMs = active.interruptOutput();
    await active.cancelRecovery();
    active.closeProvider();
    const interruptionMilliseconds = Math.max(0, this.#clock() - interruptedAt);
    this.#record("translation-interrupted", active.context, {
      relatedParticipantId: speaker.id,
      interruptionMilliseconds,
      queueDurationMs,
      result: "interrupted",
    });
    this.#record("gemini-output-aborted", active.context, {
      result: "aborted",
      errorCode: "translation-interrupted",
    });
    this.#record("resources-closed", active.context, { result: "interrupted" });
    try {
      await this.start(speaker, { utteranceId });
    } catch (error) {
      await settle(this.abort());
      throw error;
    }
    return { interruptionMilliseconds };
  }

  async abort() {
    this.#abortRevision += 1;
    const startPromise = this.#startPromise;
    this.#startingProviderState?.cancel();
    if (startPromise) await settle(startPromise);
    const result = await settle(this.#abortActive());
    const releases = await Promise.all(
      [...this.#preparedInputs.keys()].map((participantId) => settle(this.release(participantId))),
    );
    if (result.status === "rejected") throw result.reason;
    const failedRelease = releases.find(({ status }) => status === "rejected");
    if (failedRelease) throw failedRelease.reason;
  }

  async #abortActive() {
    const active = this.#active;
    if (!active) return;
    this.#active = null;
    active.pauseInput();
    active.detachInput();
    active.cancelAudioDrain();
    active.cancelOutput();
    await active.cancelRecovery();
    active.closeProvider();
    await settle(withTimeout(
      active.capture(),
      "translation capture cleanup",
      this.#captureCleanupTimeoutMilliseconds,
    ));
    this.#record("gemini-output-aborted", active.context, {
      result: "aborted",
      errorCode: "translation-aborted",
    });
    this.#record("resources-closed", active.context, { result: "closed" });
    const results = [await settle(this.release(active.context.participantId))];
    const failure = results.find(({ status }) => status === "rejected");
    if (failure) throw failure.reason;
  }

  #requireActive() {
    if (!this.#active) throw new Error("translation bridge is not active");
    return this.#active;
  }

  #throwIfAborted(startRevision) {
    if (startRevision !== this.#abortRevision) {
      throw new Error("translation bridge start was aborted");
    }
  }

  #publishAvailability(availability) {
    if (availability === this.#translationAvailability) return;
    this.#translationAvailability = availability;
    try {
      void Promise.resolve(this.#onTranslationAvailability(availability)).catch(() => {});
    } catch {
      // Meeting state reporting cannot break provider recovery.
    }
  }

  #record(type, context, fields) {
    try {
      this.#eventRecorder.record({ type, ...context, ...fields });
    } catch {
      // Observability hooks cannot change translation.
    }
  }
}

function providerRecoveryCancelled() {
  const error = new Error("provider recovery cancelled");
  error.code = "PROVIDER_RECOVERY_CANCELLED";
  return error;
}

function isProviderRecoveryCancelled(error) {
  return error?.code === "PROVIDER_RECOVERY_CANCELLED";
}

function createPreparedInput(speaker, preRollMilliseconds) {
  let frames = [];
  let bufferedMilliseconds = 0;
  let forward = null;

  return {
    language: speaker.language,
    ready: Promise.resolve(),
    subscription: null,
    receive(pcm, sampleRate) {
      if (forward) return forward(pcm, sampleRate);
      const bytes = Buffer.isBuffer(pcm) ? Buffer.from(pcm) : Buffer.from(pcm);
      const durationMilliseconds = bytes.byteLength / 2 / sampleRate * 1_000;
      frames.push({ pcm: bytes, sampleRate, durationMilliseconds });
      bufferedMilliseconds += durationMilliseconds;
      while (frames.length > 0 && bufferedMilliseconds > preRollMilliseconds) {
        bufferedMilliseconds -= frames.shift().durationMilliseconds;
      }
    },
    forwardTo(onFrame) {
      const buffered = frames;
      frames = [];
      bufferedMilliseconds = 0;
      forward = onFrame;
      for (const frame of buffered) onFrame(frame.pcm, frame.sampleRate);
    },
    bufferInstead() {
      forward = null;
    },
    clear() {
      frames = [];
      bufferedMilliseconds = 0;
      forward = null;
    },
  };
}

function createDurationBuffer(maximumMilliseconds) {
  let frames = [];
  let bufferedMilliseconds = 0;
  return {
    push(pcm, sampleRate) {
      const bytes = Buffer.isBuffer(pcm) ? Buffer.from(pcm) : Buffer.from(pcm);
      const durationMilliseconds = bytes.byteLength / 2 / sampleRate * 1_000;
      frames.push({ pcm: bytes, sampleRate, durationMilliseconds });
      bufferedMilliseconds += durationMilliseconds;
      while (frames.length > 0 && bufferedMilliseconds > maximumMilliseconds) {
        bufferedMilliseconds -= frames.shift().durationMilliseconds;
      }
    },
    take() {
      const buffered = frames;
      frames = [];
      bufferedMilliseconds = 0;
      return buffered;
    },
  };
}

async function settle(promise) {
  try {
    return { status: "fulfilled", value: await promise };
  } catch (reason) {
    return { status: "rejected", reason };
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function hasAudiblePcm(pcm) {
  for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
    if (Math.abs(pcm.readInt16LE(offset)) > 100) return true;
  }
  return false;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function withTimeout(promise, label, milliseconds) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}
