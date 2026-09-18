import { ListeningMixController } from "./listening-mix-controller.mjs";

const SUPPORTED_LANGUAGES = new Set(["ko", "ja"]);
const PERSISTENT_LISTENING_MODES = new Set(["translation-focused", "translation-only"]);
const TRANSLATION_AVAILABILITIES = new Set(["available", "reconnecting", "unavailable"]);

export class MeetingSession {
  #participantById = new Map();
  #translationFocusId = null;
  #persistentListeningModeById = new Map();
  #originalCheckByListenerId = new Map();
  #listeningMixController = new ListeningMixController();
  #translationAvailability = "available";

  constructor(participants = []) {
    if (!Array.isArray(participants)) throw new Error("participants must be an array");
    for (const participant of participants) this.join(participant);
  }

  get participants() {
    return [...this.#participantById.values()].map(({ microphone, speech, utteranceId, ...participant }) => ({
      ...participant,
      microphone,
      speech,
      utteranceId,
      listeningMode: this.listeningModeFor(participant.id),
    }));
  }

  get activeSpeakerId() {
    return this.#translationFocusId;
  }

  get activeUtteranceId() {
    return this.#translationFocusId
      ? this.#participantById.get(this.#translationFocusId)?.utteranceId ?? null
      : null;
  }

  get translationFocusId() {
    return this.#translationFocusId;
  }

  get speakingParticipantIds() {
    return this.participants.filter(({ speech }) => speech === "speaking").map(({ id }) => id);
  }

  join(participant) {
    validateParticipant(participant);
    if (this.#participantById.has(participant.id)) {
      throw new Error(`duplicate participant: ${participant.id}`);
    }
    this.#participantById.set(participant.id, {
      ...participant,
      microphone: "muted",
      speech: "silent",
      utteranceId: null,
    });
    this.#persistentListeningModeById.set(participant.id, "translation-focused");
  }

  leave(participantId) {
    this.#requireParticipant(participantId);
    if (this.isSpeaking(participantId)) this.endSpeech(participantId);
    this.#persistentListeningModeById.delete(participantId);
    this.#originalCheckByListenerId.delete(participantId);
    this.#participantById.delete(participantId);
  }

  setMicrophone(participantId, enabled) {
    const participant = this.#requireParticipant(participantId);
    participant.microphone = enabled ? "unmuted" : "muted";
    if (!enabled && participant.speech === "speaking") this.endSpeech(participantId);
  }

  startSpeech(participantId, utteranceId) {
    const participant = this.#requireParticipant(participantId);
    if (participant.microphone !== "unmuted") {
      throw new Error(`${participantId} microphone is muted`);
    }
    if (!utteranceId) throw new Error("utteranceId is required");
    if (participant.speech === "speaking") return participant.utteranceId;
    participant.speech = "speaking";
    participant.utteranceId = utteranceId;
    if (!this.#translationFocusId) this.#translationFocusId = participantId;
    return utteranceId;
  }

  endSpeech(participantId = this.#translationFocusId) {
    const participant = this.#requireParticipant(participantId);
    if (participant.speech !== "speaking") throw new Error(`${participantId} is not speaking`);
    const utteranceId = participant.utteranceId;
    participant.speech = "silent";
    participant.utteranceId = null;
    if (this.#translationFocusId === participantId) this.#translationFocusId = null;
    return this.#restoreOriginalChecks(participantId, utteranceId);
  }

  setTranslationFocus(participantId) {
    if (participantId === null) {
      this.#translationFocusId = null;
      return;
    }
    const participant = this.#requireParticipant(participantId);
    if (participant.speech !== "speaking") throw new Error(`${participantId} is not speaking`);
    this.#translationFocusId = participantId;
  }

  isSpeaking(participantId) {
    return this.#requireParticipant(participantId).speech === "speaking";
  }

  setListeningMode(listenerId, mode) {
    const listener = this.#requireParticipant(listenerId);
    const previousMode = this.listeningModeFor(listenerId);
    if (mode === "original-check") {
      const speaker = this.#activeSpeaker();
      if (listener.id === speaker.id || listener.language === speaker.language) {
        throw new Error("original check is only available for foreign speech");
      }
      const current = this.#originalCheckByListenerId.get(listenerId);
      if (current?.speakerId === speaker.id && current?.utteranceId === speaker.utteranceId) {
        return { changed: false, previousMode, mode };
      }
      this.#originalCheckByListenerId.set(listenerId, {
        returnMode: this.#persistentListeningModeById.get(listenerId),
        speakerId: speaker.id,
        utteranceId: speaker.utteranceId,
      });
      return { changed: previousMode !== mode, previousMode, mode };
    }

    if (!PERSISTENT_LISTENING_MODES.has(mode)) throw new Error(`unsupported listening mode: ${mode}`);
    this.#originalCheckByListenerId.delete(listenerId);
    this.#persistentListeningModeById.set(listenerId, mode);
    return { changed: previousMode !== mode, previousMode, mode };
  }

  listeningModeFor(listenerId) {
    this.#requireParticipant(listenerId);
    return this.#originalCheckByListenerId.has(listenerId)
      ? "original-check"
      : this.#persistentListeningModeById.get(listenerId);
  }

  setTranslationAvailability(availability) {
    if (!TRANSLATION_AVAILABILITIES.has(availability)) {
      throw new Error(`unsupported translation availability: ${availability}`);
    }
    if (this.#translationAvailability === availability) return false;
    this.#translationAvailability = availability;
    return true;
  }

  audioPlanFor(listenerId) {
    const listener = this.#requireParticipant(listenerId);
    const speakers = [...this.#participantById.values()]
      .filter(({ speech }) => speech === "speaking");
    if (this.#translationAvailability !== "available" && speakers.length > 0) {
      return this.#listeningMixController.planOriginalFallback({ listener, speakers });
    }
    if (!this.#translationFocusId) {
      if (speakers.length === 0) return { mode: "silent", tracks: [] };
      return this.#listeningMixController.planWithoutFocus({
        listener,
        speakers,
        mode: this.listeningModeFor(listenerId),
      });
    }

    const focusSpeaker = this.#activeSpeaker();
    return this.#listeningMixController.planFor({
      listener,
      speakers,
      focusSpeaker,
      mode: this.listeningModeFor(listenerId),
    });
  }

  snapshot() {
    return {
      translationAvailability: this.#translationAvailability,
      activeSpeakerId: this.#translationFocusId,
      translationFocusId: this.#translationFocusId,
      activeUtteranceId: this.activeUtteranceId,
      speakingParticipantIds: this.speakingParticipantIds,
      participants: this.participants.map((participant) => ({
        ...participant,
        audio: this.audioPlanFor(participant.id),
      })),
    };
  }

  participant(participantId) {
    const { microphone, speech, utteranceId, ...participant } = this.#requireParticipant(participantId);
    return { ...participant };
  }

  #requireParticipant(participantId) {
    const participant = this.#participantById.get(participantId);
    if (!participant) throw new Error(`unknown participant: ${participantId}`);
    return participant;
  }

  #activeSpeaker() {
    if (!this.#translationFocusId) throw new Error("no participant has translation focus");
    return this.#participantById.get(this.#translationFocusId);
  }

  #restoreOriginalChecks(speakerId, utteranceId) {
    const restored = [];
    for (const [listenerId, check] of this.#originalCheckByListenerId) {
      if (check.speakerId !== speakerId || check.utteranceId !== utteranceId) continue;
      this.#originalCheckByListenerId.delete(listenerId);
      restored.push({
        participantId: listenerId,
        previousMode: "original-check",
        mode: check.returnMode,
        utteranceId,
      });
    }
    return restored;
  }
}

function validateParticipant(participant) {
  if (!participant?.id || !participant?.name) throw new Error("each participant requires id and name");
  if (!SUPPORTED_LANGUAGES.has(participant.language)) {
    throw new Error(`unsupported language: ${participant.language}`);
  }
}
