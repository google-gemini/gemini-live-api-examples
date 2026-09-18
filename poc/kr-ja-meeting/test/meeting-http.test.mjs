import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import { createMeetingHttpServer } from "../src/meeting-http.mjs";

async function withServer(service, run) {
  const server = createMeetingHttpServer({ service, staticRoot: null });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

async function post(baseUrl, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test("dynamic join, mic, speech, and leave payloads reach the service", async () => {
  const calls = [];
  const service = {
    async join(input) {
      calls.push(["join", input]);
      return {
        livekitUrl: "ws://127.0.0.1:7880",
        roomName: "browser-poc",
        token: "opaque-token",
        participant: { id: "participant-1", ...input },
      };
    },
    mic(participantId, enabled) {
      calls.push(["mic", participantId, enabled]);
      return { microphone: enabled ? "unmuted" : "muted" };
    },
    speechActivity(event) {
      calls.push(["speech", event]);
      return { activeUtteranceId: "utterance-1" };
    },
    listeningMode(participantId, mode) {
      calls.push(["listening-mode", participantId, mode]);
      return { listeningMode: mode };
    },
    playout(participantId, event) {
      calls.push(["playout", participantId, event]);
      return { recorded: true };
    },
    leave(participantId) {
      calls.push(["leave", participantId]);
      return { participants: [] };
    },
    action() {
      throw new Error("unsupported meeting action: start-speaking");
    },
    snapshot() {
      return { activeSpeakerId: null, activeUtteranceId: null, participants: [] };
    },
  };

  await withServer(service, async (baseUrl) => {
    const joined = await post(baseUrl, "/api/meeting/join", { name: "Yuki", language: "ja" });
    assert.equal(joined.status, 200);
    assert.equal(joined.body.participant.id, "participant-1");

    assert.deepEqual(await post(baseUrl, "/api/meeting/mic", {
      participantId: "participant-1",
      enabled: true,
    }), { status: 200, body: { microphone: "unmuted" } });

    assert.deepEqual(await post(baseUrl, "/api/meeting/speech", {
      participantId: "participant-1",
      type: "speech-start",
      observedAt: 100,
    }), { status: 200, body: { activeUtteranceId: "utterance-1" } });

    assert.deepEqual(await post(baseUrl, "/api/meeting/listening-mode", {
      participantId: "participant-1",
      mode: "translation-only",
    }), { status: 200, body: { listeningMode: "translation-only" } });

    assert.deepEqual(await post(baseUrl, "/api/meeting/playout", {
      participantId: "participant-1",
      type: "playout-aborted",
      trackId: "translation:ja",
      listeningMode: "translation-only",
      gain: 1,
      result: "failed",
      errorCode: "browser-play-failed",
    }), { status: 200, body: { recorded: true } });

    assert.deepEqual(await post(baseUrl, "/api/meeting/leave", {
      participantId: "participant-1",
    }), { status: 200, body: { participants: [] } });

    const removed = await post(baseUrl, "/api/meeting/action", {
      participantId: "participant-1",
      action: "start-speaking",
    });
    assert.equal(removed.status, 400);
    assert.match(removed.body.error, /unsupported meeting action/);

    assert.deepEqual(calls, [
      ["join", { name: "Yuki", language: "ja" }],
      ["mic", "participant-1", true],
      ["speech", { participantId: "participant-1", type: "speech-start", observedAt: 100 }],
      ["listening-mode", "participant-1", "translation-only"],
      ["playout", "participant-1", {
        type: "playout-aborted",
        trackId: "translation:ja",
        listeningMode: "translation-only",
        gain: 1,
        result: "failed",
        errorCode: "browser-play-failed",
      }],
      ["leave", "participant-1"],
    ]);
  });
});

test("malformed JSON fails closed", async () => {
  const service = { snapshot() { return {}; } };
  await withServer(service, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/meeting/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid JSON body" });
  });
});
