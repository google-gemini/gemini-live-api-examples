export class BrowserAudioPlayout {
  #container;
  #gainByTrackId = new Map();
  #utteranceIdByTrackId = new Map();
  #entryByTrackId = new Map();
  #onPlanApplied;
  #onPlayoutEvent;
  #mode = "silent";
  #planKey = null;

  constructor(container, { onPlanApplied = () => {}, onPlayoutEvent = () => {} } = {}) {
    if (!container || typeof container.append !== "function") {
      throw new Error("audio output container is required");
    }
    if (typeof onPlanApplied !== "function") throw new Error("onPlanApplied must be a function");
    if (typeof onPlayoutEvent !== "function") throw new Error("onPlayoutEvent must be a function");
    this.#container = container;
    this.#onPlanApplied = onPlanApplied;
    this.#onPlayoutEvent = onPlayoutEvent;
  }

  setPlan(listeningPlan) {
    const tracks = listeningPlan?.tracks ?? [];
    if (!Array.isArray(tracks)) throw new Error("audio plan tracks must be an array");
    const nextGains = new Map();
    const nextUtteranceIds = new Map();
    for (const { trackId, gain, utteranceId } of tracks) {
      if (!trackId || nextGains.has(trackId)) throw new Error("audio plan track ids must be unique");
      if (!Number.isFinite(gain) || gain < 0 || gain > 1) {
        throw new Error(`invalid audio gain for ${trackId}`);
      }
      nextGains.set(trackId, gain);
      if (utteranceId !== undefined) {
        if (typeof utteranceId !== "string" || !utteranceId) {
          throw new Error(`invalid utterance id for ${trackId}`);
        }
        nextUtteranceIds.set(trackId, utteranceId);
      }
    }

    for (const [trackId, entry] of this.#entryByTrackId) {
      if (!nextGains.has(trackId)) this.#removeEntry(trackId, entry);
    }
    for (const [trackId, entry] of this.#entryByTrackId) {
      const nextUtteranceId = nextUtteranceIds.get(trackId);
      if (entry.utteranceId === nextUtteranceId) continue;
      this.#complete(trackId, entry, "superseded");
      entry.utteranceId = nextUtteranceId;
      entry.gapActive = false;
      entry.playbackStarted = false;
      entry.lifecycleEnded = false;
    }
    this.#gainByTrackId = nextGains;
    this.#utteranceIdByTrackId = nextUtteranceIds;
    this.#mode = listeningPlan?.mode ?? "silent";
    for (const [trackId, entry] of this.#entryByTrackId) {
      entry.element.volume = nextGains.get(trackId);
    }
    const event = {
      type: "listening-plan-applied",
      mode: listeningPlan?.mode ?? "silent",
      tracks: tracks.map(({ trackId, kind, role, gain, utteranceId }) => ({
        trackId,
        kind,
        role,
        gain,
        ...(utteranceId ? { utteranceId } : {}),
      })),
    };
    const planKey = JSON.stringify(event);
    if (planKey !== this.#planKey) {
      this.#planKey = planKey;
      try {
        this.#onPlanApplied(event);
      } catch {
        // Event hooks cannot interrupt browser audio playback.
      }
    }
  }

  attach(track, publication) {
    const trackId = publication?.trackName ?? publication?.name;
    if (!trackId || !this.#gainByTrackId.has(trackId)) return false;
    if (track?.kind && track.kind !== "audio") return false;

    const existing = this.#entryByTrackId.get(trackId);
    if (existing?.track === track) {
      existing.element.volume = this.#gainByTrackId.get(trackId);
      return true;
    }
    if (existing) this.#removeEntry(trackId, existing);

    let element;
    try {
      element = track.attach();
    } catch {
      this.#emitPlayout({
        type: "playout-aborted",
        trackId,
        listeningMode: this.#mode,
        gain: this.#gainByTrackId.get(trackId),
        result: "failed",
        errorCode: "browser-attach-failed",
        ...this.#utteranceContext(trackId),
      });
      return false;
    }
    element.volume = this.#gainByTrackId.get(trackId);
    element.dataset.trackId = trackId;
    this.#container.append(element);
    const entry = {
      track,
      element,
      gapActive: false,
      playbackStarted: false,
      lifecycleEnded: false,
      utteranceId: this.#utteranceIdByTrackId.get(trackId),
      listeners: [],
    };
    this.#entryByTrackId.set(trackId, entry);
    this.#listen(entry, "waiting", () => this.#reportGap(trackId, entry));
    this.#listen(entry, "stalled", () => this.#reportGap(trackId, entry));
    this.#listen(entry, "playing", () => this.#startPlayback(trackId, entry));
    this.#listen(entry, "timeupdate", () => this.#startPlayback(trackId, entry));
    this.#listen(entry, "ended", () => this.#complete(trackId, entry, "ended"));
    this.#emitPlayout({
      type: "playout-attached",
      trackId,
      listeningMode: this.#mode,
      gain: element.volume,
      result: "attached",
      ...this.#utteranceContext(entry),
    });
    if (typeof element.play === "function") {
      let playResult;
      try {
        playResult = element.play();
      } catch {
        this.#emitPlayout({
          type: "playout-aborted",
          trackId,
          listeningMode: this.#mode,
          gain: element.volume,
          result: "failed",
          errorCode: "browser-play-failed",
          ...this.#utteranceContext(trackId),
        });
        entry.lifecycleEnded = true;
        return true;
      }
      Promise.resolve(playResult).then(() => {
        if (this.#entryByTrackId.get(trackId)?.element !== element || entry.lifecycleEnded) return;
        this.#startPlayback(trackId, entry);
      }, () => {
        if (this.#entryByTrackId.get(trackId)?.element !== element) return;
        this.#emitPlayout({
          type: "playout-aborted",
          trackId,
          listeningMode: this.#mode,
          gain: element.volume,
          result: "failed",
          errorCode: "browser-play-failed",
          ...this.#utteranceContext(entry),
        });
        entry.lifecycleEnded = true;
      });
    }
    return true;
  }

  detach(track) {
    for (const [trackId, entry] of this.#entryByTrackId) {
      if (entry.track === track) this.#removeEntry(trackId, entry);
    }
  }

  clear() {
    for (const [trackId, entry] of this.#entryByTrackId) {
      this.#removeEntry(trackId, entry);
    }
    this.#gainByTrackId.clear();
    this.#utteranceIdByTrackId.clear();
    this.#planKey = null;
    this.#mode = "silent";
  }

  #removeEntry(trackId, entry) {
    for (const [type, listener] of entry.listeners) {
      entry.element.removeEventListener?.(type, listener);
    }
    for (const element of entry.track.detach()) element.remove();
    entry.element.remove();
    this.#entryByTrackId.delete(trackId);
    if (entry.lifecycleEnded) return;
    this.#complete(trackId, entry, "detached");
  }

  #listen(entry, type, listener) {
    if (typeof entry.element.addEventListener !== "function") return;
    entry.element.addEventListener(type, listener);
    entry.listeners.push([type, listener]);
  }

  #reportGap(trackId, entry) {
    if (!entry.playbackStarted || entry.lifecycleEnded || entry.gapActive) return;
    entry.gapActive = true;
    this.#emitPlayout({
      type: "playout-gap",
      trackId,
      listeningMode: this.#mode,
      gain: entry.element.volume,
      result: "interrupted",
      errorCode: "browser-playout-gap",
      ...this.#utteranceContext(entry),
    });
  }

  #startPlayback(trackId, entry) {
    entry.gapActive = false;
    if (entry.lifecycleEnded || entry.playbackStarted) return;
    entry.playbackStarted = true;
    this.#emitPlayout({
      type: "playout-started",
      trackId,
      listeningMode: this.#mode,
      gain: entry.element.volume,
      result: "started",
      ...this.#utteranceContext(entry),
    });
  }

  #complete(trackId, entry, result) {
    if (entry.lifecycleEnded) return;
    entry.lifecycleEnded = true;
    this.#emitPlayout({
      type: "playout-completed",
      trackId,
      listeningMode: this.#mode,
      gain: entry.element.volume,
      result,
      ...this.#utteranceContext(entry),
    });
  }

  #utteranceContext(entryOrTrackId) {
    const utteranceId = typeof entryOrTrackId === "string"
      ? this.#utteranceIdByTrackId.get(entryOrTrackId)
      : entryOrTrackId?.utteranceId;
    return utteranceId ? { utteranceId } : {};
  }

  #emitPlayout(event) {
    try {
      this.#onPlayoutEvent(event);
    } catch {
      // Event hooks cannot interrupt browser audio playback.
    }
  }
}
