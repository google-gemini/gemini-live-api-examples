import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

import { chromium } from "playwright";

const root = new URL("../", import.meta.url);
const local = { id: "ko-listener", name: "민준", language: "ko" };
const speaker = { id: "ja-speaker", name: "Yuki", language: "ja" };
let listeningMode = "translation-focused";
let returnMode = listeningMode;
const modeEvents = [];

function audioPlan() {
  if (listeningMode === "translation-only") {
    return {
      mode: listeningMode,
      tracks: [{ trackId: "translation:ko", kind: "translation", role: "foreground", gain: 1 }],
    };
  }
  if (listeningMode === "original-check") {
    return {
      mode: listeningMode,
      tracks: [{ trackId: "original:ja-speaker", kind: "original", role: "foreground", gain: 1 }],
    };
  }
  return {
    mode: listeningMode,
    tracks: [
      { trackId: "original:ja-speaker", kind: "original", role: "background", gain: 0.2 },
      { trackId: "translation:ko", kind: "translation", role: "foreground", gain: 1 },
    ],
  };
}

function snapshot() {
  return {
    activeSpeakerId: speaker.id,
    translationFocusId: speaker.id,
    activeUtteranceId: "utterance-1",
    speakingParticipantIds: [speaker.id],
    participants: [
      {
        ...local,
        microphone: "muted",
        speech: "silent",
        utteranceId: null,
        listeningMode,
        audio: audioPlan(),
      },
      {
        ...speaker,
        microphone: "unmuted",
        speech: "speaking",
        utteranceId: "utterance-1",
        listeningMode: "translation-focused",
        audio: { mode: "speaking", tracks: [] },
      },
    ],
    overlap: { detected: false },
  };
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function json(response, payload) {
  response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(payload));
}

const fakeLiveKit = `
export const RoomEvent = {
  TrackPublished: "track-published", TrackUnpublished: "track-unpublished",
  TrackSubscribed: "track-subscribed", TrackUnsubscribed: "track-unsubscribed",
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
    this.localParticipant = { async setMicrophoneEnabled() {} };
    const publications = new Map();
    for (const name of ["original:ja-speaker", "translation:ko"]) {
      publications.set(name, new FakePublication(this, name));
    }
    this.remoteParticipants.set("remote", { trackPublications: publications });
  }
  on(event, handler) { this.handlers.set(event, handler); return this; }
  async connect() {}
  async disconnect() {}
}
`;

const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  if (request.method === "GET" && url.pathname === "/api/meeting") return json(response, snapshot());
  if (request.method === "POST" && url.pathname === "/api/meeting/join") {
    return json(response, { livekitUrl: "ws://fake", roomName: "canary", token: "opaque", participant: local });
  }
  if (request.method === "POST" && url.pathname === "/api/meeting/listening-mode") {
    const body = await readBody(request);
    if (body.mode === "original-check") returnMode = listeningMode;
    listeningMode = body.mode;
    modeEvents.push(body.mode);
    return json(response, snapshot());
  }
  if (request.method === "POST" && url.pathname === "/__test/automatic-boundary") {
    listeningMode = returnMode;
    return json(response, snapshot());
  }
  if (request.method === "POST" && url.pathname === "/api/meeting/leave") return json(response, { participants: [] });
  if (url.pathname === "/vendor/livekit-client.mjs") {
    response.writeHead(200, { "content-type": "text/javascript" });
    return response.end(fakeLiveKit);
  }
  const relative = url.pathname === "/" ? "public/index.html" : url.pathname.slice(1);
  try {
    const source = await readFile(new URL(relative, root));
    const contentType = relative.endsWith(".html")
      ? "text/html"
      : relative.endsWith(".css") ? "text/css" : "text/javascript";
    response.writeHead(200, { "content-type": contentType });
    response.end(source);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

const executablePath = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const browser = await chromium.launch({ headless: true, executablePath });
try {
  const page = await browser.newPage();
  await page.addInitScript(() => {
    window.__listeningPlanEvents = [];
    window.addEventListener("bridge:listening-plan-applied", (event) => {
      window.__listeningPlanEvents.push(event.detail);
    });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: "networkidle" });
  await page.getByLabel("표시 이름").fill(local.name);
  await page.getByRole("button", { name: "회의 입장" }).click();
  await page.getByText("회의에 연결되었습니다", { exact: false }).waitFor();

  await page.getByRole("button", { name: "통역만" }).click();
  await page.getByRole("button", { name: "원음 작게 + 통역" }).waitFor();
  let audio = await page.locator("#audio-output audio").evaluateAll((elements) => elements.map((element) => ({
    trackId: element.dataset.trackId,
    gain: element.volume,
  })));
  assert.deepEqual(audio, [{ trackId: "translation:ko", gain: 1 }]);

  await page.getByRole("button", { name: "원음 확인" }).click();
  await page.getByRole("button", { name: "원음 확인 중 · 자동 복귀" }).waitFor();
  audio = await page.locator("#audio-output audio").evaluateAll((elements) => elements.map((element) => ({
    trackId: element.dataset.trackId,
    gain: element.volume,
  })));
  assert.deepEqual(audio, [{ trackId: "original:ja-speaker", gain: 1 }]);

  await page.evaluate(() => fetch("/__test/automatic-boundary", { method: "POST" }));
  await page.getByRole("button", { name: "원음 작게 + 통역" }).waitFor();
  audio = await page.locator("#audio-output audio").evaluateAll((elements) => elements.map((element) => ({
    trackId: element.dataset.trackId,
    gain: element.volume,
  })));
  assert.deepEqual(audio, [{ trackId: "translation:ko", gain: 1 }]);
  assert.deepEqual(modeEvents, ["translation-only", "original-check"]);
  const planModes = await page.evaluate(() => window.__listeningPlanEvents.map(({ mode }) => mode));
  assert.deepEqual(planModes.slice(-3), ["translation-only", "original-check", "translation-only"]);
  console.log(JSON.stringify({
    modeEvents,
    translationOnly: true,
    automaticRestore: "translation-only",
    audioNodesMatchPlans: true,
  }));
} finally {
  await browser.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
