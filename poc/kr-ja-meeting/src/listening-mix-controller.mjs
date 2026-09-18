const FOREGROUND_GAIN = 1;
const ORIGINAL_BACKGROUND_GAIN = 0.2;

export class ListeningMixController {
  planOriginalFallback({ listener, speakers } = {}) {
    if (!listener?.id || !listener?.language || !Array.isArray(speakers)) {
      throw new Error("listener and speakers are required");
    }
    const tracks = speakers
      .filter(({ id }) => id !== listener.id)
      .map((speaker) => {
        if (!speaker?.id || !speaker?.language) throw new Error("each speaker is required");
        return originalTrack(speaker.id, "foreground", FOREGROUND_GAIN, speaker.utteranceId);
      });
    return { mode: "original-fallback", tracks };
  }

  planFor({ listener, speakers, focusSpeaker, mode = "translation-focused" } = {}) {
    if (!listener?.id || !listener?.language || !Array.isArray(speakers) || !focusSpeaker?.id) {
      throw new Error("listener, speakers, and focusSpeaker are required");
    }
    if (!speakers.some(({ id }) => id === focusSpeaker.id)) {
      throw new Error("focusSpeaker must be speaking");
    }

    const tracks = [];
    for (const speaker of speakers) {
      if (!speaker?.id || !speaker?.language) throw new Error("each speaker is required");
      if (speaker.id === listener.id) continue;

      if (listener.language === speaker.language) {
        tracks.push(originalTrack(speaker.id, "foreground", FOREGROUND_GAIN, speaker.utteranceId));
        continue;
      }

      if (speaker.id !== focusSpeaker.id) {
        if (mode !== "translation-only") {
          tracks.push(originalTrack(speaker.id, "background", ORIGINAL_BACKGROUND_GAIN, speaker.utteranceId));
        }
        continue;
      }

      if (mode === "translation-only") {
        tracks.push(translationTrack(listener.language, speaker.utteranceId));
      } else if (mode === "original-check") {
        tracks.push(originalTrack(speaker.id, "foreground", FOREGROUND_GAIN, speaker.utteranceId));
      } else if (mode === "translation-focused") {
        tracks.push(
          originalTrack(speaker.id, "background", ORIGINAL_BACKGROUND_GAIN, speaker.utteranceId),
          translationTrack(listener.language, speaker.utteranceId),
        );
      } else {
        throw new Error(`unsupported listening mode: ${mode}`);
      }
    }

    const focusIsForeign = listener.id !== focusSpeaker.id
      && listener.language !== focusSpeaker.language;
    if (focusIsForeign) {
      return {
        mode,
        tracks,
      };
    }
    return {
      mode: listener.id === focusSpeaker.id ? "speaking" : "same-language-original",
      tracks,
    };
  }

  planWithoutFocus({ listener, speakers, mode = "translation-focused" } = {}) {
    if (!listener?.id || !listener?.language || !Array.isArray(speakers)) {
      throw new Error("listener and speakers are required");
    }
    const tracks = [];
    for (const speaker of speakers) {
      if (speaker.id === listener.id) continue;
      if (speaker.language === listener.language) {
        tracks.push(originalTrack(speaker.id, "foreground", FOREGROUND_GAIN, speaker.utteranceId));
      } else if (mode !== "translation-only") {
        tracks.push(originalTrack(speaker.id, "background", ORIGINAL_BACKGROUND_GAIN, speaker.utteranceId));
      }
    }
    return { mode: "focus-pending", tracks };
  }
}

function translationTrack(language, utteranceId) {
  return {
    trackId: `translation:${language}`,
    kind: "translation",
    role: "foreground",
    gain: FOREGROUND_GAIN,
    ...(utteranceId ? { utteranceId } : {}),
  };
}

function originalTrack(speakerId, role, gain, utteranceId) {
  return {
    trackId: `original:${speakerId}`,
    kind: "original",
    role,
    gain,
    ...(utteranceId ? { utteranceId } : {}),
  };
}
