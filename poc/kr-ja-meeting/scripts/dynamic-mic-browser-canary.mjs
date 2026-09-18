import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import { BrowserMeetingService } from "../src/browser-meeting-service.mjs";
import { MeetingEventRecorder } from "../src/meeting-event-recorder.mjs";
import { createMeetingHttpServer } from "../src/meeting-http.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const temporaryDirectory = await mkdtemp(join(tmpdir(), "natural-conversation-browser-"));
const fakeLiveKitPath = join(temporaryDirectory, "livekit-client.mjs");
const events = [];
let participantSequence = 0;
let utteranceSequence = 0;
let now = 0;

const service = new BrowserMeetingService({
  roomName: "natural-conversation-canary",
  livekitUrl: "ws://fake-livekit",
  tokenIssuer: async () => "opaque-test-token",
  participantIdFactory: () => `participant-${++participantSequence}`,
  utteranceIdFactory: () => `utterance-${++utteranceSequence}`,
  clock: () => ++now,
  translationBridge: {
    async start() {},
    async stop() {},
    async handoff() {},
  },
  eventRecorder: new MeetingEventRecorder({
    meetingId: "natural-conversation-canary",
    clock: () => ++now,
    write: (event) => events.push(event),
  }),
});

const speaker = (await service.join({ name: "Yuki", language: "ja" })).participant;
await service.mic(speaker.id, true);
await service.speechActivity({ participantId: speaker.id, type: "speech-start", observedAt: ++now });
await writeFile(fakeLiveKitPath, fakeLiveKitModule(speaker.id));

const server = createMeetingHttpServer({
  service,
  staticRoot: root,
  vendorFiles: new Map([["/vendor/livekit-client.mjs", fakeLiveKitPath]]),
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

const executablePath = process.env.CHROME_PATH
  ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const browser = await chromium.launch({
  headless: true,
  executablePath,
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
});
const context = await browser.newContext({ permissions: ["microphone"] });
const page = await context.newPage();

try {
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: "networkidle" });
  await page.getByLabel("표시 이름").fill("민준");
  await page.getByRole("button", { name: "회의 입장" }).click();
  await page.getByText("회의에 연결되었습니다", { exact: false }).waitFor();
  await page.getByRole("button", { name: "마이크 켜기" }).click();
  await page.getByRole("button", { name: "마이크 끄기" }).waitFor();

  const state = await page.evaluate(async () => (await fetch("/api/meeting")).json());
  const local = state.participants.find((participant) => participant.name === "민준");
  assert.ok(local?.id?.startsWith("participant-"));
  assert.equal(local.language, "ko");
  assert.equal(local.microphone, "unmuted");
  assert.equal(local.speech, "silent");
  assert.equal(
    await page.getByRole("button", { name: /^(말하기|발화 종료|문장 경계)$/ }).count(),
    0,
  );
  await service.listeningMode(local.id, "translation-only");

  for (const type of [
    "meeting-joined",
    "microphone-enabled",
    "speech-started",
    "translation-focus-selected",
    "listening-gain-applied",
  ]) {
    assert.ok(events.some((event) => event.type === type), `missing timeline event: ${type}`);
  }
  assert.doesNotMatch(
    JSON.stringify(events),
    /apiKey|token|handle|transcript|pcm|rawAudio/i,
  );

  console.log(JSON.stringify({
    participantGenerated: true,
    microphone: local.microphone,
    speech: local.speech,
    manualSpeechControls: 0,
    privacySafeTimeline: true,
  }));
} finally {
  await page.getByRole("button", { name: "나가기" }).click().catch(() => {});
  await browser.close();
  await service.speechActivity({
    participantId: speaker.id,
    type: "speech-end",
    observedAt: ++now,
  }).catch(() => {});
  await service.leave(speaker.id).catch(() => {});
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(temporaryDirectory, { recursive: true, force: true });
}

function fakeLiveKitModule(speakerId) {
  return `
export const RoomEvent = {
  TrackPublished: "track-published",
  TrackUnpublished: "track-unpublished",
  TrackSubscribed: "track-subscribed",
  TrackUnsubscribed: "track-unsubscribed",
  Disconnected: "disconnected",
};
export const Track = { Kind: { Audio: "audio" }, Source: { Microphone: "microphone" } };
class FakeTrack {
  constructor(trackName) { this.trackName = trackName; this.kind = "audio"; this.elements = []; }
  attach() { const element = document.createElement("audio"); this.elements.push(element); return element; }
  detach() { const elements = [...this.elements]; this.elements = []; return elements; }
}
class FakePublication {
  constructor(room, trackName) {
    this.room = room; this.trackName = trackName; this.name = trackName; this.kind = "audio";
    this.track = new FakeTrack(trackName); this.subscribed = false;
  }
  setSubscribed(value) {
    if (this.subscribed === value) return;
    this.subscribed = value;
    const event = value ? RoomEvent.TrackSubscribed : RoomEvent.TrackUnsubscribed;
    this.room.handlers.get(event)?.(this.track, this);
  }
}
export class Room {
  constructor() {
    this.handlers = new Map(); this.remoteParticipants = new Map();
    this.localParticipant = {
      async setMicrophoneEnabled() {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mediaStreamTrack = stream.getAudioTracks()[0];
        return {
          track: { mediaStreamTrack },
          async mute() { mediaStreamTrack.enabled = false; mediaStreamTrack.stop(); },
        };
      },
    };
    const publications = new Map();
    for (const name of [${JSON.stringify(`original:${speakerId}`)}, "translation:ko"]) {
      publications.set(name, new FakePublication(this, name));
    }
    this.remoteParticipants.set("remote", { trackPublications: publications });
  }
  on(event, handler) { this.handlers.set(event, handler); return this; }
  async connect() {}
  async disconnect() {}
}
`;
}
