import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackPublishOptions,
  TrackSource,
} from "@livekit/rtc-node";
import { AccessToken } from "livekit-server-sdk";
import WebSocket from "ws";

import { GeminiLiveTranslateSocket } from "../src/gemini-live-socket.mjs";
import {
  GEMINI_INPUT_SAMPLE_RATE,
  ProviderCanaryEvidence,
  publicationName,
} from "../src/provider-canary.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const livekitUrl = process.env.LIVEKIT_URL ?? "ws://127.0.0.1:7880";
const livekitApiKey = process.env.LIVEKIT_API_KEY ?? "devkey";
const livekitApiSecret = process.env.LIVEKIT_API_SECRET ?? "secret";
const roomName = `kr-ja-canary-${Date.now()}`;
const evidence = new ProviderCanaryEvidence();
const rooms = [];
const localTracks = [];
const temporaryDirectories = [];
let apiKey = "";

function readApiKey() {
  const envFile = readFileSync(`${root}/.env.local`, "utf8");
  const match = envFile.match(/^GEMINI_API_KEY=(.+)$/m);
  if (!match?.[1]?.trim()) {
    throw new Error("GEMINI_API_KEY is missing from .env.local");
  }
  return match[1].trim();
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

function withTimeout(promise, label, milliseconds = 30_000) {
  let timeout;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error(`${label} timed out after ${milliseconds}ms`)),
        milliseconds,
      );
    }),
  ]).finally(() => clearTimeout(timeout));
}

async function tokenFor(identity) {
  const accessToken = new AccessToken(livekitApiKey, livekitApiSecret, {
    identity,
    name: identity,
  });
  accessToken.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
  });
  return accessToken.toJwt();
}

async function connectRoom(identity) {
  const room = new Room();
  rooms.push(room);
  await room.connect(livekitUrl, await tokenFor(identity), {
    autoSubscribe: false,
    dynacast: false,
  });
  return room;
}

function waitForPublication(room, identity, name) {
  for (const participant of room.remoteParticipants.values()) {
    if (participant.identity !== identity) continue;
    for (const publication of participant.trackPublications.values()) {
      if (publicationName(publication) === name) return Promise.resolve(publication);
    }
  }

  return new Promise((resolve) => {
    const handler = (publication, participant) => {
      if (
        participant.identity === identity &&
        publicationName(publication) === name
      ) {
        room.off(RoomEvent.TrackPublished, handler);
        resolve(publication);
      }
    };
    room.on(RoomEvent.TrackPublished, handler);
  });
}

function subscribe(room, publication) {
  if (publication.subscribed && publication.track) {
    return Promise.resolve(publication.track);
  }
  return new Promise((resolve, reject) => {
    const subscribed = (track, candidate) => {
      if (candidate === publication) {
        room.off(RoomEvent.TrackSubscribed, subscribed);
        room.off(RoomEvent.TrackSubscriptionFailed, failed);
        resolve(track);
      }
    };
    const failed = (trackSid, _participant, reason) => {
      if (trackSid === publication.sid) {
        room.off(RoomEvent.TrackSubscribed, subscribed);
        room.off(RoomEvent.TrackSubscriptionFailed, failed);
        reject(new Error(`LiveKit subscription failed: ${reason ?? trackSid}`));
      }
    };
    room.on(RoomEvent.TrackSubscribed, subscribed);
    room.on(RoomEvent.TrackSubscriptionFailed, failed);
    publication.setSubscribed(true);
  });
}

async function publishAudioTrack(room, name, sampleRate) {
  const source = new AudioSource(sampleRate, 1);
  const track = LocalAudioTrack.createAudioTrack(name, source);
  localTracks.push(track);
  const options = new TrackPublishOptions();
  options.source = TrackSource.SOURCE_MICROPHONE;
  await room.localParticipant.publishTrack(track, options);
  return { source, track };
}

function synthesizeJapanesePcm() {
  const directory = mkdtempSync(join(tmpdir(), "gemini-live-poc-"));
  temporaryDirectories.push(directory);
  const aiffPath = join(directory, "ja.aiff");
  execFileSync("/usr/bin/say", [
    "-v",
    "Kyoko",
    "-o",
    aiffPath,
    "こんにちは。今日の会議では、新しい製品の計画を確認します。よろしくお願いします。",
  ]);
  return execFileSync("/opt/homebrew/bin/ffmpeg", [
    "-v",
    "error",
    "-i",
    aiffPath,
    "-f",
    "s16le",
    "-acodec",
    "pcm_s16le",
    "-ac",
    "1",
    "-ar",
    "48000",
    "pipe:1",
  ], { maxBuffer: 8 * 1024 * 1024 });
}

async function publishPcm(source, pcm) {
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2);
  const frameSamples = 4_800;
  for (let offset = 0; offset < samples.length; offset += frameSamples) {
    const chunk = samples.subarray(offset, Math.min(offset + frameSamples, samples.length));
    await source.captureFrame(new AudioFrame(chunk, 48_000, 1, chunk.length));
  }
  const silence = new Int16Array(frameSamples);
  for (let index = 0; index < 15; index += 1) {
    await source.captureFrame(new AudioFrame(silence, 48_000, 1, silence.length));
  }
  await new Promise((resolve) => setTimeout(resolve, 2_000));
}

async function receiveOneFrame(track) {
  const reader = new AudioStream(track, {
    sampleRate: 24_000,
    numChannels: 1,
    frameSizeMs: 100,
  }).getReader();
  try {
    const result = await reader.read();
    if (result.done || !result.value?.data?.length) {
      throw new Error("translated LiveKit track ended without audio");
    }
  } finally {
    await reader.cancel();
  }
}

async function run() {
  apiKey = readApiKey();

  const [speaker, japaneseListener, koreanListener1, koreanListener2, translator] =
    await Promise.all([
      connectRoom("ja-1"),
      connectRoom("ja-2"),
      connectRoom("ko-1"),
      connectRoom("ko-2"),
      connectRoom("translator-ko"),
    ]);
  evidence.record(
    "participantsConnected",
    [speaker, japaneseListener, koreanListener1, koreanListener2].filter(
      (room) => room.isConnected,
    ).length,
  );

  const translationPublication1 = waitForPublication(
    koreanListener1,
    "translator-ko",
    "translation:ko",
  );
  const translationPublication2 = waitForPublication(
    koreanListener2,
    "translator-ko",
    "translation:ko",
  );
  const originalForTranslator = waitForPublication(
    translator,
    "ja-1",
    "original:ja-1",
  );
  const originalForJapanese = waitForPublication(
    japaneseListener,
    "ja-1",
    "original:ja-1",
  );
  const originalForKorean = waitForPublication(
    koreanListener1,
    "ja-1",
    "original:ja-1",
  );

  const translated = await publishAudioTrack(translator, "translation:ko", 24_000);
  evidence.record("translationTrackPublished", true);
  const koreanTranslationPublication1 = await withTimeout(
    translationPublication1,
    "ko-1 translation publication",
  );
  const koreanTranslationPublication2 = await withTimeout(
    translationPublication2,
    "ko-2 translation publication",
  );
  const koreanTranslationTrack1 = await withTimeout(
    subscribe(koreanListener1, koreanTranslationPublication1),
    "ko-1 translation subscription",
  );
  const koreanTranslationTrack2 = await withTimeout(
    subscribe(koreanListener2, koreanTranslationPublication2),
    "ko-2 translation subscription",
  );
  evidence.record("translationTrackSubscribed", true);
  const listenerAudio = withTimeout(
    receiveOneFrame(koreanTranslationTrack2),
    "translated LiveKit listener audio",
    45_000,
  );

  const original = await publishAudioTrack(speaker, "original:ja-1", 48_000);
  const translatorOriginalPublication = await withTimeout(
    originalForTranslator,
    "translator original publication",
  );
  const translatorOriginalTrack = await withTimeout(
    subscribe(translator, translatorOriginalPublication),
    "translator original subscription",
  );
  evidence.record("originalTrackSubscribed", true);
  const japaneseOriginalPublication = await withTimeout(
    originalForJapanese,
    "ja-2 original publication",
  );
  await withTimeout(
    subscribe(japaneseListener, japaneseOriginalPublication),
    "ja-2 original subscription",
  );
  const koreanOriginalPublication = await withTimeout(
    originalForKorean,
    "ko-1 original publication",
  );

  const setup = deferred();
  const firstTranslatedFrame = deferred();
  let translatedFrames = 0;
  const serverEventCounts = {};
  let captureChain = Promise.resolve();
  const gemini = new GeminiLiveTranslateSocket({
    apiKey,
    meetingId: roomName,
    targetLanguage: "ko",
    socketFactory: (url) => new WebSocket(url),
    openState: WebSocket.OPEN,
    automaticActivityDetection: false,
    onSetupComplete: setup.resolve,
    onError: setup.reject,
    onServerEvent(event) {
      for (const name of Object.keys(event)) {
        serverEventCounts[name] = (serverEventCounts[name] ?? 0) + 1;
      }
    },
    onTranslatedAudio(base64Audio) {
      translatedFrames += 1;
      const pcm = Buffer.from(base64Audio, "base64");
      const samples = new Int16Array(
        pcm.buffer,
        pcm.byteOffset,
        pcm.byteLength / 2,
      );
      captureChain = captureChain.then(() =>
        translated.source.captureFrame(
          new AudioFrame(samples, 24_000, 1, samples.length),
        ),
      );
      firstTranslatedFrame.resolve();
    },
  });
  gemini.connect();
  await withTimeout(setup.promise, "Gemini setup");
  evidence.record("geminiSetupComplete", true);
  if (!gemini.sendActivityStart()) {
    throw new Error("Gemini activityStart was not sent");
  }

  const originalReader = new AudioStream(translatorOriginalTrack, {
    sampleRate: GEMINI_INPUT_SAMPLE_RATE,
    numChannels: 1,
    frameSizeMs: 100,
  }).getReader();
  let inputOpen = true;
  const pipeOriginal = (async () => {
    while (true) {
      const { done, value } = await originalReader.read();
      if (done) return;
      const pcm = Buffer.from(
        value.data.buffer,
        value.data.byteOffset,
        value.data.byteLength,
      );
      if (inputOpen) gemini.sendPcm16(pcm, value.sampleRate);
    }
  })();

  const publishOriginal = publishPcm(original.source, synthesizeJapanesePcm());
  await withTimeout(firstTranslatedFrame.promise, "first Gemini translated frame", 45_000);
  await withTimeout(listenerAudio, "translated LiveKit listener audio", 45_000);
  evidence.record("translatedFrames", translatedFrames);
  evidence.record("listenerReceivedTranslatedAudio", true);

  koreanTranslationPublication1.setSubscribed(false);
  await withTimeout(
    subscribe(koreanListener1, koreanOriginalPublication),
    "ko-1 original check subscription",
  );
  evidence.record(
    "originalCheckExclusive",
    koreanOriginalPublication.subscribed && !koreanTranslationPublication1.subscribed,
  );

  await withTimeout(publishOriginal, "original LiveKit utterance", 30_000);
  inputOpen = false;
  if (!gemini.sendActivityEnd()) {
    throw new Error("Gemini activityEnd was not sent");
  }
  void originalReader.cancel();
  evidence.record("phraseBoundary", true);
  koreanOriginalPublication.setSubscribed(false);
  await withTimeout(
    subscribe(koreanListener1, koreanTranslationPublication1),
    "ko-1 translation boundary restore",
  );
  evidence.record(
    "translationRestoredAtBoundary",
    koreanTranslationPublication1.subscribed && !koreanOriginalPublication.subscribed,
  );

  await captureChain;
  gemini.close();

  const freshSetup = deferred();
  const freshGemini = new GeminiLiveTranslateSocket({
    apiKey,
    meetingId: roomName,
    targetLanguage: "ko",
    socketFactory: (url) => new WebSocket(url),
    openState: WebSocket.OPEN,
    onSetupComplete: freshSetup.resolve,
    onError: freshSetup.reject,
  });
  freshGemini.connect();
  await withTimeout(freshSetup.promise, "fresh Gemini setup", 30_000);
  evidence.record("freshSessionSetup", true);
  freshGemini.close();

  if (!evidence.complete) {
    throw new Error(`provider evidence incomplete: ${JSON.stringify(evidence.snapshot())}`);
  }
  process.stdout.write(`${JSON.stringify(evidence.snapshot())}\n`);
}

try {
  await run();
} catch (error) {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const safeMessage = apiKey ? rawMessage.replaceAll(apiKey, "[REDACTED]") : rawMessage;
  process.stderr.write(`provider canary failed: ${safeMessage}\n`);
  process.exitCode = 1;
} finally {
  apiKey = "";
  await Promise.allSettled(localTracks.map((track) => track.close(true)));
  await Promise.allSettled(
    temporaryDirectories.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
  await Promise.allSettled(
    rooms.map((room) =>
      withTimeout(room.disconnect(), "LiveKit room disconnect", 5_000),
    ),
  );
  process.exit(process.exitCode ?? 0);
}
