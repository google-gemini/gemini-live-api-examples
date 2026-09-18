import {
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  RoomEvent,
  TrackPublishOptions,
  TrackSource,
} from "@livekit/rtc-node";

import { publicationName } from "./provider-canary.mjs";

export class LiveKitAudioGateway {
  #room;
  #translationSinks = new Map();
  #localTracks = [];
  #closed = false;
  #eventRecorder;
  #disconnected;

  constructor(room, { eventRecorder = { record() {} } } = {}) {
    if (!room) throw new Error("connected translator room is required");
    if (!eventRecorder || typeof eventRecorder.record !== "function") {
      throw new Error("eventRecorder.record must be a function");
    }
    this.#room = room;
    this.#eventRecorder = eventRecorder;
    this.#disconnected = () => void this.close("disconnected");
    this.#room.on?.(RoomEvent.Disconnected, this.#disconnected);
  }

  async initialize() {
    await Promise.all([this.translationSink("ko"), this.translationSink("ja")]);
  }

  async translationSink(targetLanguage) {
    if (this.#closed) throw new Error("LiveKit audio gateway is closed");
    if (!new Set(["ko", "ja"]).has(targetLanguage)) {
      throw new Error(`unsupported target language: ${targetLanguage}`);
    }
    const existing = this.#translationSinks.get(targetLanguage);
    if (existing) return existing;

    const source = new AudioSource(24_000, 1);
    const track = LocalAudioTrack.createAudioTrack(`translation:${targetLanguage}`, source);
    const options = new TrackPublishOptions();
    options.source = TrackSource.SOURCE_MICROPHONE;
    const eventContext = {
      language: targetLanguage,
      trackId: `translation:${targetLanguage}`,
      trackKind: "translation",
    };
    this.#record("livekit-publish-started", eventContext, { result: "started" });
    try {
      await this.#room.localParticipant.publishTrack(track, options);
    } catch (error) {
      this.#record("livekit-publish-failed", eventContext, {
        result: "failed",
        errorCode: "translation-publish-failed",
      });
      await track.close(true);
      throw error;
    }
    if (this.#closed) {
      await track.close(true);
      throw new Error("LiveKit audio gateway closed while publishing translation track");
    }
    this.#record("livekit-publish-succeeded", eventContext, { result: "succeeded" });
    this.#localTracks.push(track);
    let captureCommitChain = Promise.resolve();
    const invalidatedGenerations = new WeakSet();
    const sink = {
      capture(pcm, generation) {
        const bytes = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm);
        const copy = Uint8Array.from(bytes);
        const samples = new Int16Array(copy.buffer);
        const commit = captureCommitChain.then(async () => {
          const queuedBeforeMs = source.queuedDuration;
          const startedAt = performance.now();
          if (generation && invalidatedGenerations.has(generation)) {
            return {
              committed: false,
              queuedBeforeMs,
              queuedAfterMs: source.queuedDuration,
              captureWaitMs: performance.now() - startedAt,
            };
          }
          await source.captureFrame(new AudioFrame(samples, 24_000, 1, samples.length));
          if (generation && invalidatedGenerations.has(generation)) {
            source.clearQueue();
            return {
              committed: false,
              queuedBeforeMs,
              queuedAfterMs: source.queuedDuration,
              captureWaitMs: performance.now() - startedAt,
            };
          }
          return {
            committed: true,
            queuedBeforeMs,
            queuedAfterMs: source.queuedDuration,
            captureWaitMs: performance.now() - startedAt,
          };
        });
        captureCommitChain = commit.catch(() => {});
        return commit;
      },
      queuedDurationMs() {
        return source.queuedDuration;
      },
      waitForPlayout() {
        return source.waitForPlayout();
      },
      clearQueue() {
        source.clearQueue();
      },
      invalidateGeneration(generation) {
        invalidatedGenerations.add(generation);
        source.clearQueue();
      },
    };
    this.#translationSinks.set(targetLanguage, sink);
    return sink;
  }

  async subscribeOriginal(trackName, onFrame) {
    const publication = await waitForPublication(this.#room, trackName);
    const track = await subscribe(this.#room, publication);
    const reader = new AudioStream(track, {
      sampleRate: 16_000,
      numChannels: 1,
      frameSizeMs: 100,
    }).getReader();
    let closed = false;
    const pump = (async () => {
      while (!closed) {
        const { done, value } = await reader.read();
        if (done) return;
        const pcm = Buffer.from(
          value.data.buffer,
          value.data.byteOffset,
          value.data.byteLength,
        );
        await onFrame(pcm, value.sampleRate);
      }
    })();

    return {
      async close() {
        closed = true;
        publication.setSubscribed(false);
        await reader.cancel();
        await pump.catch((error) => {
          if (!closed) throw error;
        });
      },
    };
  }

  async close(result = "closed") {
    if (this.#closed) return;
    this.#closed = true;
    this.#room.off?.(RoomEvent.Disconnected, this.#disconnected);
    await Promise.allSettled(this.#localTracks.map((track) => track.close(true)));
    this.#localTracks = [];
    this.#translationSinks.clear();
    this.#record("resources-closed", {}, { result });
  }

  #record(type, context, fields) {
    try {
      this.#eventRecorder.record({ type, ...context, ...fields });
    } catch {
      // Observability hooks cannot change LiveKit delivery.
    }
  }
}

export function waitForPublication(room, trackName, timeoutMs = 20_000) {
  for (const participant of room.remoteParticipants.values()) {
    for (const publication of participant.trackPublications.values()) {
      if (publicationName(publication) === trackName) return Promise.resolve(publication);
    }
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      room.off(RoomEvent.TrackPublished, published);
      reject(new Error(`LiveKit publication timed out: ${trackName}`));
    }, timeoutMs);
    const published = (publication) => {
      if (publicationName(publication) !== trackName) return;
      clearTimeout(timeout);
      room.off(RoomEvent.TrackPublished, published);
      resolve(publication);
    };
    room.on(RoomEvent.TrackPublished, published);
  });
}

export function subscribe(room, publication, timeoutMs = 20_000) {
  if (publication.subscribed && publication.track) return Promise.resolve(publication.track);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`LiveKit subscription timed out: ${publication.sid}`));
    }, timeoutMs);
    const subscribed = (track, candidate) => {
      if (candidate !== publication) return;
      cleanup();
      resolve(track);
    };
    const failed = (trackSid, _participant, reason) => {
      if (trackSid !== publication.sid) return;
      cleanup();
      reject(new Error(`LiveKit subscription failed: ${reason ?? trackSid}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      room.off(RoomEvent.TrackSubscribed, subscribed);
      room.off(RoomEvent.TrackSubscriptionFailed, failed);
    };
    room.on(RoomEvent.TrackSubscribed, subscribed);
    room.on(RoomEvent.TrackSubscriptionFailed, failed);
    publication.setSubscribed(true);
  });
}
