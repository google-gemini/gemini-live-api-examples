import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import { MeetingSession } from "./meeting-session.mjs";
import { TranslationFocusPolicy } from "./translation-focus-policy.mjs";

const SUPPORTED_LANGUAGES = new Set(["ko", "ja"]);
const SPEECH_ACTIVITY_TYPES = new Set(["speech-start", "speech-end"]);
const PLAYOUT_EVENT_TYPES = new Set([
  "playout-attached",
  "playout-started",
  "playout-gap",
  "playout-completed",
  "playout-aborted",
]);

export class BrowserMeetingService {
  #roomName;
  #livekitUrl;
  #tokenIssuer;
  #translationBridge;
  #participantIdFactory;
  #utteranceIdFactory;
  #session = new MeetingSession();
  #translationFocusPolicy;
  #onListeningEvent;
  #eventRecorder;
  #onMeetingEmpty;
  #clock;
  #listeningPlanKeyByParticipantId = new Map();
  #issuedPlayoutContextByParticipantId = new Map();
  #translationStartLockouts = new Set();
  #parkedTranslation = null;
  #translationAvailabilityChangedAt = null;
  #actionChain = Promise.resolve();

  constructor({
    roomName,
    livekitUrl,
    tokenIssuer,
    translationBridge,
    participantIdFactory = () => `participant-${randomUUID()}`,
    utteranceIdFactory = () => `utterance-${randomUUID()}`,
    clock = () => performance.now(),
    minimumFocusHoldMilliseconds,
    overlapWarningMilliseconds,
    onListeningEvent = () => {},
    eventRecorder = { record() {} },
    onMeetingEmpty = () => {},
  }) {
    if (!roomName || !livekitUrl || !tokenIssuer || !translationBridge) {
      throw new Error("roomName, livekitUrl, tokenIssuer, and translationBridge are required");
    }
    this.#roomName = roomName;
    this.#livekitUrl = livekitUrl;
    this.#tokenIssuer = tokenIssuer;
    this.#translationBridge = translationBridge;
    this.#participantIdFactory = participantIdFactory;
    this.#utteranceIdFactory = utteranceIdFactory;
    this.#clock = clock;
    this.#translationFocusPolicy = new TranslationFocusPolicy({
      clock,
      minimumFocusHoldMilliseconds,
      overlapWarningMilliseconds,
    });
    if (typeof onListeningEvent !== "function") throw new Error("onListeningEvent must be a function");
    if (!eventRecorder || typeof eventRecorder.record !== "function") {
      throw new Error("eventRecorder.record must be a function");
    }
    this.#onListeningEvent = onListeningEvent;
    this.#eventRecorder = eventRecorder;
    if (typeof onMeetingEmpty !== "function") throw new Error("onMeetingEmpty must be a function");
    this.#onMeetingEmpty = onMeetingEmpty;
  }

  join({ name, language } = {}) {
    return this.#enqueue(async () => {
      const participant = this.#newParticipant(name, language);
      this.#session.join(participant);
      try {
        const joined = {
          livekitUrl: this.#livekitUrl,
          roomName: this.#roomName,
          token: await this.#tokenIssuer(participant),
          participant: { ...participant },
        };
        this.#recordParticipant("meeting-joined", participant, { result: "joined" });
        return joined;
      } catch (error) {
        this.#session.leave(participant.id);
        throw error;
      }
    });
  }

  leave(participantId) {
    return this.#enqueue(async () => {
      const participant = this.#session.participant(participantId);
      try {
        if (this.#session.isSpeaking(participantId)) {
          await this.#endSpeech(participantId, undefined);
        }
        await this.#releaseParticipantTranslation(participantId);
      } finally {
        this.#session.leave(participantId);
        if (this.#session.participants.length === 0) this.#onMeetingEmpty();
      }
      this.#recordParticipant("meeting-left", participant, { result: "left" });
      this.#recordParticipant("resources-closed", participant, { result: "closed" });
      this.#listeningPlanKeyByParticipantId.delete(participantId);
      this.#issuedPlayoutContextByParticipantId.delete(participantId);
      return this.snapshot();
    });
  }

  mic(participantId, enabled) {
    return this.#enqueue(async () => {
      if (typeof enabled !== "boolean") throw new Error("microphone enabled must be a boolean");
      const participant = this.#session.participant(participantId);
      if (enabled) {
        await this.#translationBridge.prepare?.(participant);
      }
      try {
        if (!enabled && this.#session.isSpeaking(participantId)) {
          await this.#endSpeech(participantId, undefined);
        }
        if (!enabled) await this.#releaseParticipantTranslation(participantId);
      } finally {
        this.#session.setMicrophone(participantId, enabled);
      }
      this.#recordParticipant(enabled ? "microphone-enabled" : "microphone-disabled", participant, {
        result: enabled ? "enabled" : "disabled",
      });
      return this.snapshot();
    });
  }

  speechActivity({ participantId, type, observedAt } = {}) {
    return this.#enqueue(async () => {
      if (!SPEECH_ACTIVITY_TYPES.has(type)) {
        throw new Error(`unsupported speech activity: ${type}`);
      }
      if (!Number.isFinite(observedAt)) throw new Error("speech activity observedAt is required");
      const eventAt = this.#eventTimestamp();
      const participant = this.#session.participant(participantId);
      if (type === "speech-start") {
        if (this.#session.isSpeaking(participantId)) return this.snapshot();
        const utteranceId = this.#utteranceIdFactory();
        const beforeFocus = this.#translationFocusPolicy.snapshot(eventAt);
        const previousFocusId = this.#session.translationFocusId;
        this.#session.startSpeech(participantId, utteranceId);
        const focus = this.#translationFocusPolicy.speechStarted(participantId, eventAt);
        this.#session.setTranslationFocus(focus.translationFocusId);
        try {
          if (!previousFocusId && focus.translationFocusId) {
            const focusedParticipant = this.#session.participant(focus.translationFocusId);
            const nextUtteranceId = this.#utteranceIdFor(focus.translationFocusId);
            const parkedTranslation = this.#parkedTranslation;
            this.#parkedTranslation = null;
            if (parkedTranslation) {
              if (
                parkedTranslation.participantId === focusedParticipant.id
                && typeof this.#translationBridge.resume === "function"
              ) {
                await this.#translationBridge.resume(focusedParticipant, {
                  utteranceId: nextUtteranceId,
                  observedAt: eventAt,
                });
              } else {
                await this.#translationBridge.handoff(focusedParticipant, {
                  previousUtteranceId: parkedTranslation.utteranceId,
                  utteranceId: nextUtteranceId,
                  observedAt: eventAt,
                });
              }
            } else {
              await this.#translationBridge.start(focusedParticipant, {
                utteranceId: nextUtteranceId,
                observedAt: eventAt,
              });
            }
          }
          this.#recordParticipant("speech-started", participant, {
            utteranceId,
            result: "started",
          });
          this.#recordFocusTransition(beforeFocus, focus, participant, utteranceId);
          this.#recordListeningPlans();
        } catch (error) {
          this.#session.endSpeech(participantId);
          this.#translationFocusPolicy.speechEnded(participantId, eventAt);
          this.#recordParticipant("utterance-aborted", participant, {
            utteranceId,
            result: "aborted",
            errorCode: "translation-start-failed",
          });
          throw error;
        }
      } else {
        if (!this.#session.isSpeaking(participantId)) return this.snapshot();
        await this.#endSpeech(participantId, eventAt);
      }
      return this.snapshot();
    });
  }

  snapshot() {
    const focus = this.#translationFocusPolicy.snapshot(this.#eventTimestamp());
    this.#recordPendingOverlapTransitions();
    const snapshot = {
      ...this.#session.snapshot(),
      translationAvailabilityChangedAt: this.#translationAvailabilityChangedAt,
      speakingParticipantIds: focus.speakingParticipantIds,
      translationFocusId: focus.translationFocusId,
      focus: {
        selectedAt: focus.focusSelectedAt,
      },
      overlap: focus.overlap,
    };
    this.#rememberPlayoutContexts(snapshot);
    return snapshot;
  }

  refresh() {
    return this.#enqueue(async () => {
      const eventAt = this.#eventTimestamp();
      const beforeFocus = this.#translationFocusPolicy.snapshot(eventAt);
      const focus = this.#translationFocusPolicy.advance(eventAt);
      if (beforeFocus.translationFocusId !== focus.translationFocusId) {
        const participant = this.#session.participant(focus.translationFocusId);
        const utteranceId = this.#utteranceIdFor(participant.id);
        const lockoutKey = this.#translationStartLockoutKey(participant.id, utteranceId);
        if (this.#translationStartLockouts.has(lockoutKey)) {
          this.#translationFocusPolicy.clearFocus();
          this.#session.setTranslationFocus(null);
          return this.snapshot();
        }
        try {
          const parkedTranslation = this.#parkedTranslation;
          this.#parkedTranslation = null;
          if (parkedTranslation) {
            await this.#translationBridge.handoff(participant, {
              previousUtteranceId: parkedTranslation.utteranceId,
              utteranceId,
              observedAt: eventAt,
            });
          } else {
            await this.#translationBridge.start(participant, { utteranceId, observedAt: eventAt });
          }
          this.#translationStartLockouts.delete(lockoutKey);
          this.#session.setTranslationFocus(participant.id);
          this.#recordFocusTransition(beforeFocus, focus, participant, utteranceId);
          this.#recordListeningPlans();
        } catch (error) {
          this.#lockOutTranslationStart(participant, utteranceId);
          throw error;
        }
      }
      return this.snapshot();
    });
  }

  playout(participantId, event = {}) {
    return this.#enqueue(async () => {
      const participant = this.#session.participant(participantId);
      if (!PLAYOUT_EVENT_TYPES.has(event.type)) {
        throw new Error(`unsupported playout event: ${event.type}`);
      }
      if (typeof event.trackId !== "string" || !event.trackId) {
        throw new Error("playout trackId is required");
      }
      if (typeof event.utteranceId !== "string" || !event.utteranceId) {
        throw new Error("playout utteranceId is required");
      }
      const key = `${event.trackId}:${event.utteranceId}`;
      const contexts = this.#issuedPlayoutContextByParticipantId.get(participantId);
      const context = contexts?.get(key);
      if (!context) throw new Error("playout utteranceId does not match an issued listening plan");
      if (context.status === "superseded" && !["playout-completed", "playout-aborted"].includes(event.type)) {
        throw new Error("playout utterance context is superseded");
      }
      const outcome = playoutOutcome(event);
      this.#recordParticipant(event.type, participant, {
        utteranceId: context.utteranceId,
        targetLanguage: context.targetLanguage,
        listeningMode: context.listeningMode,
        trackId: context.trackId,
        trackKind: context.trackKind,
        gain: context.gain,
        ...outcome,
      });
      if (["playout-completed", "playout-aborted"].includes(event.type)) contexts.delete(key);
      return { recorded: true };
    });
  }

  listeningMode(participantId, mode) {
    return this.#enqueue(async () => {
      const change = this.#session.setListeningMode(participantId, mode);
      if (change.changed) {
        this.#emitListeningEvent({
          type: "listening-mode-changed",
          participantId,
          previousMode: change.previousMode,
          mode: change.mode,
        });
      }
      return this.snapshot();
    });
  }

  translationAvailability(availability) {
    const changed = this.#session.setTranslationAvailability(availability);
    if (changed) this.#translationAvailabilityChangedAt = this.#eventTimestamp();
    const sessionSnapshot = this.#session.snapshot();
    const utteranceId = this.#session.activeUtteranceId ?? undefined;
    return this.#enqueue(async () => {
      if (changed) this.#recordListeningPlans(sessionSnapshot, utteranceId);
      return this.snapshot();
    });
  }

  action(participantId, action) {
    return this.#enqueue(async () => {
      this.#session.participant(participantId);
      throw new Error(`unsupported meeting action: ${action}`);
    });
  }

  async #endSpeech(participantId, observedAt) {
    const participant = this.#session.participant(participantId);
    const endedUtteranceId = this.#utteranceIdFor(participantId);
    this.#translationStartLockouts.delete(
      this.#translationStartLockoutKey(participantId, endedUtteranceId),
    );
    const eventAt = Number.isFinite(observedAt) ? observedAt : this.#eventTimestamp();
    const beforeFocus = this.#translationFocusPolicy.snapshot(eventAt);
    const wasFocused = this.#session.translationFocusId === participantId;
    const previousUtteranceId = wasFocused ? endedUtteranceId : null;
    const restoredListeningModes = this.#session.endSpeech(participantId);
    for (const restored of restoredListeningModes) {
      this.#emitListeningEvent({ type: "listening-mode-restored", ...restored });
    }
    const focus = this.#translationFocusPolicy.speechEnded(participantId, eventAt);
    this.#recordParticipant("speech-ended", participant, {
      utteranceId: endedUtteranceId,
      result: "ended",
    });
    this.#recordFocusTransition(beforeFocus, focus, participant, endedUtteranceId);
    if (!wasFocused) {
      this.#recordParticipant("utterance-completed", participant, {
        utteranceId: endedUtteranceId,
        result: "completed-without-focus",
      });
      return;
    }
    let handoffTarget = null;
    try {
      if (focus.translationFocusId) {
        const nextParticipant = this.#session.participant(focus.translationFocusId);
        const nextState = this.#session.participants.find(({ id }) => id === focus.translationFocusId);
        handoffTarget = { participant: nextParticipant, utteranceId: nextState.utteranceId };
        await this.#translationBridge.handoff(nextParticipant, {
          previousUtteranceId,
          utteranceId: nextState.utteranceId,
          observedAt: eventAt,
        });
        this.#parkedTranslation = null;
        this.#session.setTranslationFocus(focus.translationFocusId);
      } else {
        if (typeof this.#translationBridge.phraseBoundary === "function") {
          await this.#translationBridge.phraseBoundary({
            utteranceId: previousUtteranceId,
            observedAt: eventAt,
          });
          this.#parkedTranslation = {
            participantId: participant.id,
            utteranceId: previousUtteranceId,
          };
        } else {
          await this.#translationBridge.stop({
            utteranceId: previousUtteranceId,
            observedAt: eventAt,
          });
        }
      }
      this.#recordParticipant("utterance-completed", participant, {
        utteranceId: previousUtteranceId,
        result: "completed",
      });
      this.#recordListeningPlans();
    } catch (error) {
      if (handoffTarget) {
        this.#lockOutTranslationStart(handoffTarget.participant, handoffTarget.utteranceId);
      } else {
        this.#translationFocusPolicy.clearFocus();
        this.#session.setTranslationFocus(null);
      }
      this.#recordParticipant("utterance-aborted", participant, {
        utteranceId: previousUtteranceId,
        result: "aborted",
        errorCode: "translation-cleanup-failed",
      });
      throw error;
    }
  }

  #newParticipant(name, language) {
    const normalizedName = typeof name === "string" ? name.trim() : "";
    if (!normalizedName) throw new Error("display name is required");
    if (!SUPPORTED_LANGUAGES.has(language)) throw new Error(`unsupported language: ${language}`);
    const id = this.#participantIdFactory();
    if (!id || typeof id !== "string") throw new Error("participant id factory returned an invalid id");
    return { id, name: normalizedName, language };
  }

  async #releaseParticipantTranslation(participantId) {
    if (this.#parkedTranslation?.participantId === participantId) {
      this.#parkedTranslation = null;
      await this.#translationBridge.stop();
    }
    await this.#translationBridge.release?.(participantId);
  }

  #enqueue(operation) {
    const execution = this.#actionChain.then(operation);
    this.#actionChain = execution.catch(() => {});
    return execution;
  }

  #emitListeningEvent(event) {
    try {
      this.#onListeningEvent(event);
    } catch {
      // Observability hooks cannot change the meeting contract.
    }
    const participant = this.#session.participant(event.participantId);
    this.#recordParticipant(event.type, participant, {
      utteranceId: event.utteranceId ?? this.#session.activeUtteranceId ?? undefined,
      listeningMode: event.mode,
      result: event.type === "listening-mode-restored" ? "restored" : "changed",
    });
    this.#recordListeningPlans();
  }

  #recordListeningPlans(
    sessionSnapshot = this.#session.snapshot(),
    utteranceId = this.#session.activeUtteranceId ?? undefined,
  ) {
    for (const participant of sessionSnapshot.participants) {
      const planKey = JSON.stringify(participant.audio);
      if (this.#listeningPlanKeyByParticipantId.get(participant.id) === planKey) continue;
      this.#listeningPlanKeyByParticipantId.set(participant.id, planKey);
      for (const track of participant.audio.tracks) {
        this.#recordParticipant("listening-gain-applied", participant, {
          utteranceId,
          listeningMode: participant.audio.mode,
          trackId: track.trackId,
          trackKind: track.kind,
          gain: track.gain,
          result: "applied",
        });
      }
    }
  }

  #recordFocusTransition(before, after, participant, utteranceId) {
    if (!before.overlap.active && after.overlap.active) {
      this.#recordParticipant("overlap-started", participant, { utteranceId, result: "active" });
    }
    this.#recordPendingOverlapTransitions();
    if (before.overlap.active && !after.overlap.active) {
      this.#recordParticipant("overlap-ended", participant, { utteranceId, result: "ended" });
    }

    if (before.translationFocusId === after.translationFocusId) return;
    if (!before.translationFocusId && after.translationFocusId) {
      const focused = this.#session.participant(after.translationFocusId);
      this.#recordParticipant("translation-focus-selected", focused, {
        utteranceId: this.#utteranceIdFor(after.translationFocusId),
        result: "selected",
      });
      return;
    }
    if (after.translationFocusId) {
      const focused = this.#session.participant(after.translationFocusId);
      this.#recordParticipant("translation-focus-changed", focused, {
        utteranceId: this.#utteranceIdFor(after.translationFocusId),
        relatedParticipantId: before.translationFocusId,
        result: "selected",
      });
      return;
    }
    this.#recordParticipant("translation-focus-cleared", participant, {
      utteranceId,
      result: "cleared",
    });
  }

  #utteranceIdFor(participantId) {
    return this.#session.participants.find(({ id }) => id === participantId)?.utteranceId;
  }

  #translationStartLockoutKey(participantId, utteranceId) {
    return `${participantId}:${utteranceId}`;
  }

  #lockOutTranslationStart(participant, utteranceId) {
    const key = this.#translationStartLockoutKey(participant.id, utteranceId);
    const newlyLocked = !this.#translationStartLockouts.has(key);
    this.#translationStartLockouts.add(key);
    this.#translationFocusPolicy.clearFocus();
    this.#session.setTranslationFocus(null);
    if (!newlyLocked) return;
    this.#recordParticipant("utterance-aborted", participant, {
      utteranceId,
      result: "aborted",
      errorCode: "translation-recovery-unavailable",
    });
  }

  #recordParticipant(type, participant, fields = {}) {
    try {
      this.#eventRecorder.record({
        type,
        participantId: participant.id,
        language: participant.language,
        ...fields,
      });
    } catch {
      // Observability hooks cannot change the meeting contract.
    }
  }

  #recordPendingOverlapTransitions() {
    for (const transition of this.#translationFocusPolicy.takeTransitions()) {
      const participantId = transition.participantIds.at(-1);
      const participant = this.#session.participant(participantId);
      this.#recordParticipant(transition.type, participant, {
        utteranceId: this.#utteranceIdFor(participantId),
        targetLanguage: participant.language === "ko" ? "ja" : "ko",
        detectedAt: transition.observedAt,
        result: "warning",
      });
    }
  }

  #rememberPlayoutContexts(snapshot) {
    for (const participant of snapshot.participants) {
      let contexts = this.#issuedPlayoutContextByParticipantId.get(participant.id);
      if (!contexts) {
        contexts = new Map();
        this.#issuedPlayoutContextByParticipantId.set(participant.id, contexts);
      }
      for (const track of participant.audio.tracks) {
        if (!track.utteranceId) continue;
        const key = `${track.trackId}:${track.utteranceId}`;
        const current = contexts.get(key);
        if (!current) {
          for (const [issuedKey, issued] of contexts) {
            if (issued.trackId !== track.trackId) continue;
            if (issued.status === "superseded") contexts.delete(issuedKey);
            else issued.status = "superseded";
          }
        }
        const targetLanguage = track.kind === "translation"
          ? track.trackId.slice("translation:".length)
          : participant.language;
        contexts.set(key, {
          utteranceId: track.utteranceId,
          targetLanguage,
          listeningMode: participant.audio.mode,
          trackId: track.trackId,
          trackKind: track.kind,
          gain: track.gain,
          status: "current",
        });
      }
    }
  }

  #eventTimestamp() {
    const timestamp = this.#clock();
    if (!Number.isFinite(timestamp)) throw new Error("meeting clock must return a finite timestamp");
    return timestamp;
  }
}

function playoutOutcome(event) {
  if (event.type === "playout-attached") return { result: "attached" };
  if (event.type === "playout-started") return { result: "started" };
  if (event.type === "playout-gap") {
    return { result: "interrupted", errorCode: "browser-playout-gap" };
  }
  if (event.type === "playout-completed") {
    const allowedResults = new Set(["ended", "detached", "superseded"]);
    return { result: allowedResults.has(event.result) ? event.result : "detached" };
  }
  const allowedErrorCodes = new Set(["browser-attach-failed", "browser-play-failed"]);
  return {
    result: "failed",
    errorCode: allowedErrorCodes.has(event.errorCode) ? event.errorCode : "browser-playout-failed",
  };
}
