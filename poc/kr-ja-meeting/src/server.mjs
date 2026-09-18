import { fileURLToPath } from "node:url";

import { Room } from "@livekit/rtc-node";
import { AccessToken } from "livekit-server-sdk";
import WebSocket from "ws";

import { BrowserMeetingService } from "./browser-meeting-service.mjs";
import { GeminiLiveTranslateSocket } from "./gemini-live-socket.mjs";
import { MemoryMeetingGlossary } from "./gemini-session.mjs";
import { LiveTranslationBridge } from "./live-translation-bridge.mjs";
import { LiveKitAudioGateway } from "./livekit-audio-gateway.mjs";
import {
  MeetingEventRecorder,
  MemoryMeetingSegmentTraceStore,
} from "./meeting-event-recorder.mjs";
import { createMeetingHttpServer } from "./meeting-http.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 4173);
const livekitUrl = process.env.LIVEKIT_URL ?? "ws://127.0.0.1:7880";
const livekitApiKey = process.env.LIVEKIT_API_KEY ?? "devkey";
const livekitApiSecret = process.env.LIVEKIT_API_SECRET ?? "secret";
const geminiApiKey = process.env.GEMINI_API_KEY;
const roomName = process.env.MEETING_ROOM ?? "kr-ja-browser-poc";
const segmentTraceStore = new MemoryMeetingSegmentTraceStore();
const eventRecorder = new MeetingEventRecorder({
  meetingId: roomName,
  write: (event) => segmentTraceStore.write(event),
});

if (!geminiApiKey) {
  throw new Error("GEMINI_API_KEY is required to start the live browser meeting");
}

const translatorRoom = new Room();
await translatorRoom.connect(
  livekitUrl,
  await tokenFor("translator", "통역 중계", true),
  { autoSubscribe: false, dynacast: false },
);
const audioGateway = new LiveKitAudioGateway(translatorRoom, { eventRecorder });
await audioGateway.initialize();
const glossary = new MemoryMeetingGlossary();
let service;
const translationBridge = new LiveTranslationBridge({
  meetingId: roomName,
  audioGateway,
  geminiFactory(callbacks) {
    return new GeminiLiveTranslateSocket({
      ...callbacks,
      apiKey: geminiApiKey,
      glossary: glossary.entries(),
      socketFactory: (url) => new WebSocket(url),
      openState: WebSocket.OPEN,
      automaticActivityDetection: true,
    });
  },
  continuousInput: true,
  onTranslationAvailability: (availability) => service?.translationAvailability(availability),
  eventRecorder,
});
service = new BrowserMeetingService({
  roomName,
  livekitUrl,
  tokenIssuer: (participant) => tokenFor(participant.id, participant.name, true),
  translationBridge,
  onMeetingEmpty: () => glossary.clear(),
  eventRecorder,
});
const vendorFiles = new Map([
  [
    "/vendor/livekit-client.mjs",
    `${root}/node_modules/livekit-client/dist/livekit-client.esm.mjs`,
  ],
]);
const server = createMeetingHttpServer({ service, staticRoot: root, vendorFiles });

server.listen(port, host, () => {
  console.log(`KR-JA live browser meeting: http://${host}:${port}`);
});

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  segmentTraceStore.close();
  glossary.clear();
  server.close();
  await translationBridge.abort().catch(() => {});
  await audioGateway.close();
  await translatorRoom.disconnect();
}

process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());

async function tokenFor(identity, name, canPublish) {
  const token = new AccessToken(livekitApiKey, livekitApiSecret, { identity, name });
  token.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish,
    canSubscribe: true,
  });
  return token.toJwt();
}
