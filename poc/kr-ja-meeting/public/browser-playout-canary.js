import { Room, RoomEvent } from "/vendor/livekit-client.mjs";

const startButton = document.querySelector("#start");
const audioOutput = document.querySelector("#audio-output");
const status = document.querySelector("#status");
const STATS_TIMEOUT_MS = 2_000;
const state = {
  phase: "idle",
  error: null,
  frames: [],
  rawTrackFrames: [],
  rtpSamples: [],
  mediaEvents: [],
};
let room;
let track;
let audioElement;
let audioContext;
let playoutGain;
let statsTimer;
let statsInFlight = Promise.resolve();

window.browserCanary = {
  state,
  startMute(milliseconds) {
    if (state.phase !== "ready" || !playoutGain) return false;
    playoutGain.gain.setValueAtTime(0, audioContext.currentTime);
    recordMediaEvent("injected-playout-mute-start", { milliseconds });
    window.setTimeout(() => {
      playoutGain.gain.setValueAtTime(1, audioContext.currentTime);
      recordMediaEvent("injected-playout-mute-end", { milliseconds });
    }, milliseconds);
    return true;
  },
  async finish() {
    if (statsTimer) window.clearInterval(statsTimer);
    statsTimer = null;
    await queueRtpSample();
    state.phase = "finished";
    return structuredClone(state);
  },
};

startButton.addEventListener("click", () => void start());

async function start() {
  startButton.disabled = true;
  state.phase = "starting";
  status.value = "starting";
  try {
    const configResponse = await fetch("/config", { cache: "no-store" });
    if (!configResponse.ok) throw new Error("browser canary config unavailable");
    const config = await configResponse.json();
    room = new Room({ autoSubscribe: false, dynacast: false });
    await room.connect(config.livekitUrl, config.token, { autoSubscribe: false });
    const publication = findPublication(room, config.trackName);
    track = await subscribe(room, publication);
    audioElement = track.attach();
    for (const eventName of ["playing", "waiting", "stalled", "suspend", "pause", "volumechange"]) {
      audioElement.addEventListener(eventName, () => recordMediaEvent(eventName));
    }
    audioOutput.replaceChildren(audioElement);
    await room.startAudio();
    await audioElement.play();
    if (typeof audioElement.captureStream !== "function") {
      throw new Error("browser_capture_unavailable");
    }
    const captured = audioElement.captureStream();
    await waitFor(() => captured.getAudioTracks().length > 0, 5_000, "captured audio track");
    audioContext = new AudioContext();
    await audioContext.audioWorklet.addModule("/playout-meter-worklet.js");
    const elementSource = audioContext.createMediaStreamSource(captured);
    const rawTrackSource = audioContext.createMediaStreamSource(
      new MediaStream([track.mediaStreamTrack]),
    );
    playoutGain = audioContext.createGain();
    const elementMeter = new AudioWorkletNode(audioContext, "playout-meter");
    const rawTrackMeter = new AudioWorkletNode(audioContext, "playout-meter");
    const silentGain = audioContext.createGain();
    silentGain.gain.value = 0;
    const contextEpochOffsetMs = epochNow() - audioContext.currentTime * 1_000;
    elementMeter.port.onmessage = ({ data }) => {
      state.frames.push({
        atMs: contextEpochOffsetMs + data.audioTimeMs,
        rms: data.rms,
      });
    };
    rawTrackMeter.port.onmessage = ({ data }) => {
      state.rawTrackFrames.push({
        atMs: contextEpochOffsetMs + data.audioTimeMs,
        rms: data.rms,
      });
    };
    elementSource.connect(playoutGain).connect(elementMeter).connect(audioContext.destination);
    rawTrackSource.connect(rawTrackMeter).connect(silentGain).connect(audioContext.destination);
    audioElement.muted = true;
    await audioContext.resume();
    statsTimer = window.setInterval(() => {
      void queueRtpSample().catch((error) => {
        state.error = error instanceof Error ? error.message : String(error);
      });
    }, 100);
    await queueRtpSample();
    state.phase = "ready";
    status.value = "ready";
  } catch (error) {
    state.phase = "failed";
    state.error = error instanceof Error ? error.message : String(error);
    status.value = state.error;
  }
}

function findPublication(activeRoom, trackName) {
  for (const participant of activeRoom.remoteParticipants.values()) {
    for (const publication of participant.trackPublications.values()) {
      if (publication.trackName === trackName) return publication;
    }
  }
  throw new Error(`LiveKit publication unavailable: ${trackName}`);
}

function subscribe(activeRoom, publication) {
  if (publication.isSubscribed && publication.track) return Promise.resolve(publication.track);
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error(`LiveKit subscription timed out: ${publication.trackSid}`));
    }, 5_000);
    const subscribed = (candidate, published) => {
      if (published !== publication) return;
      cleanup();
      resolve(candidate);
    };
    const failed = (trackSid, _participant, reason) => {
      if (trackSid !== publication.trackSid) return;
      cleanup();
      reject(new Error(`LiveKit subscription failed: ${reason ?? trackSid}`));
    };
    const cleanup = () => {
      window.clearTimeout(timeout);
      activeRoom.off(RoomEvent.TrackSubscribed, subscribed);
      activeRoom.off(RoomEvent.TrackSubscriptionFailed, failed);
    };
    activeRoom.on(RoomEvent.TrackSubscribed, subscribed);
    activeRoom.on(RoomEvent.TrackSubscriptionFailed, failed);
    publication.setSubscribed(true);
  });
}

async function sampleRtpStats() {
  if (!track?.receiver) return;
  const report = await withBrowserTimeout(
    track.receiver.getStats(),
    STATS_TIMEOUT_MS,
    "RTP stats",
  );
  for (const sample of report.values()) {
    if (sample.type !== "inbound-rtp" || sample.kind !== "audio") continue;
    state.rtpSamples.push({
      atMs: epochNow(),
      packetsReceived: sample.packetsReceived,
      packetsLost: sample.packetsLost,
      concealedSamples: sample.concealedSamples,
      concealmentEvents: sample.concealmentEvents,
      jitterBufferDelay: sample.jitterBufferDelay ?? 0,
      jitterBufferEmittedCount: sample.jitterBufferEmittedCount ?? 0,
    });
    return;
  }
}

function queueRtpSample() {
  statsInFlight = statsInFlight.then(() => sampleRtpStats());
  return statsInFlight;
}

function recordMediaEvent(type, fields = {}) {
  state.mediaEvents.push({ type, atMs: epochNow(), ...fields });
}

function epochNow() {
  return performance.timeOrigin + performance.now();
}

function withBrowserTimeout(promise, milliseconds, label) {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(
      () => reject(new Error(`${label} timed out`)),
      milliseconds,
    );
    promise.then(
      (value) => {
        window.clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(`timed out: ${label}`);
    await new Promise((resolve) => window.setTimeout(resolve, 20));
  }
}
