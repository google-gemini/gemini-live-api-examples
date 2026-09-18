import assert from "node:assert/strict";
import test from "node:test";

import { LiveTranslationBridge } from "../src/live-translation-bridge.mjs";

test("active original track flows through Gemini into the opposite-language track", async () => {
  const calls = [];
  let originalFrame;
  let geminiOptions;
  const gateway = {
    async translationSink(targetLanguage) {
      calls.push(`sink:${targetLanguage}`);
      return {
        async capture(buffer) { calls.push(`translated:${buffer.toString("hex")}`); },
      };
    },
    async subscribeOriginal(trackName, onFrame) {
      calls.push(`subscribe:${trackName}`);
      originalFrame = onFrame;
      return { async close() { calls.push("unsubscribe"); } };
    },
  };
  const gemini = {
    connect() { calls.push("connect"); geminiOptions.onSetupComplete(); },
    sendActivityStart() { calls.push("activity-start"); return true; },
    sendActivityEnd() { calls.push("activity-end"); return true; },
    sendPcm16(buffer, sampleRate) { calls.push(`pcm:${sampleRate}:${buffer.toString("hex")}`); return true; },
    close() { calls.push("gemini-close"); },
  };
  const bridge = new LiveTranslationBridge({
    meetingId: "browser-poc",
    audioGateway: gateway,
    geminiFactory(options) {
      geminiOptions = options;
      assert.equal(options.targetLanguage, "ko");
      return gemini;
    },
  });

  await bridge.start({ id: "ja-1", language: "ja" });
  await originalFrame(Buffer.from([1, 2]), 16_000);
  await geminiOptions.onTranslatedAudio(Buffer.from([3, 4]).toString("base64"));
  const boundary = bridge.phraseBoundary();
  await originalFrame(Buffer.from([9, 9]), 16_000);
  await boundary;
  await geminiOptions.onTranslatedAudio(Buffer.from([5, 6]).toString("base64"));
  const stop = bridge.stop();
  await stop;

  assert.deepEqual(calls, [
    "subscribe:original:ja-1",
    "sink:ko",
    "connect",
    "activity-start",
    "pcm:16000:0102",
    "translated:0304",
    "activity-end",
    "activity-start",
    "translated:0506",
    "activity-end",
    "gemini-close",
    "unsubscribe",
  ]);
});

test("one-second pre-roll and the final frame cross one persistent automatic-VAD session", async () => {
  const sentFrames = [];
  const signals = [];
  let originalFrame;
  let clientCount = 0;
  const bridge = new LiveTranslationBridge({
    meetingId: "browser-poc",
    continuousInput: true,
    preRollMilliseconds: 1_000,
    audioGateway: {
      async translationSink() { return { async capture() {} }; },
      async subscribeOriginal(_trackName, onFrame) {
        originalFrame = onFrame;
        return { async close() { signals.push("unsubscribe"); } };
      },
    },
    geminiFactory(options) {
      clientCount += 1;
      return {
        connect() { options.onSetupComplete(); },
        sendActivityStart() { signals.push("activity-start"); return true; },
        sendActivityEnd() { signals.push("activity-end"); return true; },
        sendAudioStreamEnd() { signals.push("stream-end"); return true; },
        sendPcm16(pcm, sampleRate) {
          sentFrames.push({ marker: pcm.readInt16LE(0), byteLength: pcm.byteLength, sampleRate });
          return true;
        },
        close() { signals.push("close"); },
      };
    },
  });
  const speaker = { id: "ja-1", language: "ja" };

  await bridge.prepare(speaker);
  for (let marker = 1; marker <= 12; marker += 1) {
    const frame = Buffer.alloc(3_200);
    frame.writeInt16LE(marker);
    originalFrame(frame, 16_000);
  }

  await bridge.start(speaker, { utteranceId: "utterance-1" });
  const liveFrame = Buffer.alloc(3_200);
  liveFrame.writeInt16LE(13);
  originalFrame(liveFrame, 16_000);
  await bridge.phraseBoundary();
  bridge.resume(speaker, { utteranceId: "utterance-2" });
  const finalFrame = Buffer.alloc(3_200);
  finalFrame.writeInt16LE(14);
  originalFrame(finalFrame, 16_000);
  await bridge.stop();

  assert.equal(clientCount, 1);
  assert.deepEqual(sentFrames.map(({ marker }) => marker), [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  assert.equal(sentFrames.every(({ byteLength, sampleRate }) => byteLength === 3_200 && sampleRate === 16_000), true);
  assert.deepEqual(signals, ["stream-end", "close", "unsubscribe"]);
});

test("automatic VAD keeps the phrase open until the final translated audio is captured", async () => {
  const calls = [];
  let originalFrame;
  let geminiOptions;
  const bridge = new LiveTranslationBridge({
    meetingId: "browser-poc",
    continuousInput: true,
    firstAudioTimeoutMilliseconds: 100,
    audioGateway: {
      async translationSink() {
        return { async capture(pcm) { calls.push(`capture:${pcm.toString("hex")}`); } };
      },
      async subscribeOriginal(_trackName, onFrame) {
        originalFrame = onFrame;
        return { async close() {} };
      },
    },
    geminiFactory(options) {
      geminiOptions = options;
      return {
        connect() { options.onSetupComplete(); },
        sendAudioStreamEnd() { return true; },
        sendPcm16() { return true; },
        close() {},
      };
    },
  });

  await bridge.start({ id: "ja-1", language: "ja" }, { utteranceId: "utterance-1" });
  originalFrame(Buffer.from([0xe8, 0x03]), 16_000);
  let boundaryResolved = false;
  const boundary = bridge.phraseBoundary().then(() => { boundaryResolved = true; });
  await delayForTest(1);
  assert.equal(boundaryResolved, false);

  await geminiOptions.onTranslatedAudio(Buffer.from([0xd0, 0x07]).toString("base64"));
  geminiOptions.onGenerationComplete();
  await boundary;
  assert.deepEqual(calls, ["capture:d007"]);

  bridge.resume({ id: "ja-1", language: "ja" }, { utteranceId: "utterance-2" });
  await bridge.abort();
});

test("stop waits for translated audio playout before closing the bridge", async () => {
  const playout = deferredForBridgeTest();
  const captured = [];
  let originalFrame;
  let geminiOptions;
  let geminiClosed = false;
  let playoutStarted = false;
  const bridge = new LiveTranslationBridge({
    meetingId: "browser-poc",
    drainQuietMilliseconds: 1_000,
    audioGateway: {
      async translationSink() {
        return {
          async capture(buffer) { captured.push(buffer.toString("hex")); },
          async waitForPlayout() {
            playoutStarted = true;
            await playout.promise;
          },
        };
      },
      async subscribeOriginal(_trackName, onFrame) {
        originalFrame = onFrame;
        return { async close() {} };
      },
    },
    geminiFactory(options) {
      geminiOptions = options;
      return {
        connect() { options.onSetupComplete(); },
        sendActivityStart() { return true; },
        sendActivityEnd() {
          void options.onTranslatedAudio(Buffer.from([1, 2]).toString("base64"));
          setTimeout(() => {
            void options.onTranslatedAudio(Buffer.from([3, 4]).toString("base64"));
            options.onGenerationComplete();
          }, 5);
          return true;
        },
        sendPcm16() { return true; },
        close() { geminiClosed = true; },
      };
    },
  });

  await bridge.start({ id: "ko-1", language: "ko" });
  originalFrame(Buffer.from([1, 2]), 16_000);
  const stop = bridge.stop();
  await delayForTest(40);

  assert.equal(playoutStarted, true);
  assert.equal(geminiClosed, true);
  assert.deepEqual(captured, ["0102", "0304"]);

  playout.resolve();
  await stop;
  assert.equal(geminiClosed, true);
  assert.equal(geminiOptions.targetLanguage, "ja");
});

test("a second speaker cannot overlap the active translation bridge", async () => {
  let geminiOptions;
  const bridge = new LiveTranslationBridge({
    meetingId: "browser-poc",
    audioGateway: {
      async translationSink() { return { async capture() {} }; },
      async subscribeOriginal() { return { async close() {} }; },
    },
    geminiFactory(options) {
      geminiOptions = options;
      return {
        connect() { geminiOptions.onSetupComplete(); },
        sendActivityStart() { return true; },
        sendActivityEnd() { return true; },
        sendPcm16() { return true; },
        close() {},
      };
    },
  });

  await bridge.start({ id: "ja-1", language: "ja" });
  await assert.rejects(
    bridge.start({ id: "ko-1", language: "ko" }),
    /translation bridge is already active/,
  );
  await geminiOptions.onTranslatedAudio(Buffer.from([1, 2]).toString("base64"));
  const stop = bridge.stop();
  await stop;
});

test("handoff clears stale translation within 200ms without draining old playout", async () => {
  const calls = [];
  const clients = [];
  const events = [];
  let originalFrame;
  let now = 1_000;
  const bridge = new LiveTranslationBridge({
    meetingId: "browser-poc",
    clock: () => now,
    audioGateway: {
      async translationSink(language) {
        calls.push(`sink:${language}`);
        return {
          async capture(pcm) { calls.push(`capture:${language}:${pcm.toString("hex")}`); },
          invalidateGeneration() { calls.push(`invalidate:${language}:${now}`); },
          clearQueue() { calls.push(`clear:${language}:${now}`); },
          async waitForPlayout() {
            calls.push(`wait:${language}`);
            throw new Error("stale playout must not be drained");
          },
        };
      },
      async subscribeOriginal(trackName, onFrame) {
        calls.push(`subscribe:${trackName}`);
        originalFrame = onFrame;
        return { async close() { calls.push(`unsubscribe:${trackName}`); } };
      },
    },
    geminiFactory(options) {
      const client = {
        connect() { options.onSetupComplete(); },
        sendActivityStart() { calls.push("activity-start"); return true; },
        sendActivityEnd() { calls.push("activity-end"); return true; },
        sendPcm16() { return true; },
        close() { calls.push("gemini-close"); },
      };
      clients.push({ client, options });
      return client;
    },
    eventRecorder: { record(event) { events.push(event); } },
  });

  await bridge.start(
    { id: "ja-1", language: "ja" },
    { utteranceId: "utterance-1" },
  );
  originalFrame(Buffer.from([1, 2]), 16_000);
  await clients[0].options.onTranslatedAudio(Buffer.from([3, 4]).toString("base64"));
  clients[0].options.onGenerationComplete();
  now = 1_100;
  const interruption = await bridge.handoff(
    { id: "ko-1", language: "ko" },
    { previousUtteranceId: "utterance-1", utteranceId: "utterance-2" },
  );
  now = 1_300;
  await clients[0].options.onTranslatedAudio(Buffer.from([5, 6]).toString("base64"));

  assert.equal(interruption.interruptionMilliseconds <= 200, true);
  assert.equal(calls.includes("clear:ko:1100"), true);
  assert.equal(calls.includes("wait:ko"), false);
  assert.equal(calls.includes("capture:ko:0506"), false);
  assert.equal(calls.includes("sink:ja"), true);
  assert.equal(clients.length, 2);
  assert.equal(clients[0].options.utteranceId, "utterance-1");
  assert.equal(clients[1].options.utteranceId, "utterance-2");
  assert.deepEqual(events.filter(({ type }) => type === "translation-interrupted"), [{
    type: "translation-interrupted",
    participantId: "ja-1",
    utteranceId: "utterance-1",
    language: "ja",
    targetLanguage: "ko",
    relatedParticipantId: "ko-1",
    interruptionMilliseconds: 0,
    queueDurationMs: 0,
    result: "interrupted",
  }]);
  await bridge.abort();
});

test("handoff clears audio enqueued by a capture that was already pending at the generation fence", async () => {
  const clients = [];
  const queues = new Map();
  const invalidated = new WeakSet();
  const captureEntered = deferredForBridgeTest();
  const releaseCapture = deferredForBridgeTest();
  const bridge = new LiveTranslationBridge({
    meetingId: "browser-poc",
    audioGateway: {
      async translationSink(language) {
        const queue = [];
        queues.set(language, queue);
        return {
          async capture(pcm, generation) {
            if (language === "ko" && pcm.readInt16LE(0) === 7) {
              captureEntered.resolve();
              await releaseCapture.promise;
            }
            if (invalidated.has(generation)) return { committed: false };
            queue.push(pcm.readInt16LE(0));
            return { committed: true };
          },
          invalidateGeneration(generation) { invalidated.add(generation); queue.length = 0; },
          clearQueue() { queue.length = 0; },
          queuedDurationMs() { return queue.length * 20; },
        };
      },
      async subscribeOriginal() { return { async close() {} }; },
    },
    geminiFactory(options) {
      const client = {
        connect() { options.onSetupComplete(); },
        sendActivityStart() { return true; },
        sendActivityEnd() { return true; },
        sendPcm16() { return true; },
        close() {},
      };
      clients.push({ client, options });
      return client;
    },
  });

  await bridge.start({ id: "ja-1", language: "ja" }, { utteranceId: "utterance-1" });
  const oldCapture = clients[0].options.onTranslatedAudio(Buffer.from([7, 0]).toString("base64"));
  await captureEntered.promise;
  const handoff = bridge.handoff(
    { id: "ko-1", language: "ko" },
    { utteranceId: "utterance-2" },
  );
  releaseCapture.resolve();
  await oldCapture;
  await handoff;

  assert.deepEqual(queues.get("ko"), []);
  assert.equal(clients.length, 2);
  await bridge.abort();
});

test("a 220ms old capture cannot delay handoff or commit after its generation is invalidated", async () => {
  const clients = [];
  const queues = new Map();
  const captureEntered = deferredForBridgeTest();
  const invalidated = new WeakSet();
  const bridge = new LiveTranslationBridge({
    meetingId: "browser-poc",
    audioGateway: {
      async translationSink(language) {
        const queue = [];
        queues.set(language, queue);
        let commitChain = Promise.resolve();
        return {
          capture(pcm, generation) {
            const commit = commitChain.then(async () => {
              if (language === "ko" && pcm.readInt16LE(0) === 7) {
                captureEntered.resolve();
                await delayForTest(220);
              }
              if (invalidated.has(generation)) return { committed: false };
              queue.push(pcm.readInt16LE(0));
              return { committed: true };
            });
            commitChain = commit.catch(() => {});
            return commit;
          },
          invalidateGeneration(generation) {
            invalidated.add(generation);
            queue.length = 0;
          },
          clearQueue() { queue.length = 0; },
          queuedDurationMs() { return queue.length * 20; },
        };
      },
      async subscribeOriginal() { return { async close() {} }; },
    },
    geminiFactory(options) {
      const client = {
        connect() { options.onSetupComplete(); },
        sendActivityStart() { return true; },
        sendActivityEnd() { return true; },
        sendPcm16() { return true; },
        close() {},
      };
      clients.push({ client, options });
      return client;
    },
  });

  await bridge.start({ id: "ja-1", language: "ja" }, { utteranceId: "utterance-1" });
  const oldCapture = clients[0].options.onTranslatedAudio(Buffer.from([7, 0]).toString("base64"));
  await captureEntered.promise;
  const handoffStartedAt = performance.now();
  await bridge.handoff({ id: "ko-1", language: "ko" }, { utteranceId: "utterance-2" });
  const handoffElapsedMilliseconds = performance.now() - handoffStartedAt;
  await clients[1].options.onTranslatedAudio(Buffer.from([8, 0]).toString("base64"));
  await oldCapture;

  assert.equal(handoffElapsedMilliseconds <= 200, true);
  assert.deepEqual(queues.get("ko"), []);
  assert.deepEqual(queues.get("ja"), [8]);
  await bridge.abort();
});

test("a second start is rejected while Gemini setup is still pending", async () => {
  const setupCallbacks = [];
  const clients = [];
  const bridge = new LiveTranslationBridge({
    meetingId: "browser-poc",
    audioGateway: {
      async translationSink() { return { async capture() {} }; },
      async subscribeOriginal() { return { async close() {} }; },
    },
    geminiFactory(options) {
      setupCallbacks.push(options.onSetupComplete);
      const client = {
        options,
        connect() {},
        sendActivityStart() { return true; },
        sendActivityEnd() { return true; },
        sendPcm16() { return true; },
        close() {},
      };
      clients.push(client);
      return client;
    },
  });

  const firstStart = bridge.start({ id: "ja-1", language: "ja" });
  const secondStart = bridge.start({ id: "ko-1", language: "ko" });
  while (setupCallbacks.length === 0) await Promise.resolve();
  for (const completeSetup of setupCallbacks) completeSetup();
  await assert.rejects(
    secondStart,
    /translation bridge is already active/,
  );
  await firstStart;
  await clients[0].options.onTranslatedAudio(Buffer.from([1, 2]).toString("base64"));
  const stop = bridge.stop();
  await stop;
});

test("Gemini is closed when setup fails", async () => {
  let failSetup;
  let closed = false;
  const bridge = new LiveTranslationBridge({
    meetingId: "browser-poc",
    audioGateway: {
      async translationSink() { return { async capture() {} }; },
      async subscribeOriginal() { return { async close() {} }; },
    },
    geminiFactory(options) {
      failSetup = options.onError;
      return {
        connect() { failSetup(new Error("setup failed")); },
        sendActivityStart() { return true; },
        sendActivityEnd() { return true; },
        sendPcm16() { return true; },
        close() { closed = true; },
      };
    },
  });

  await assert.rejects(bridge.start({ id: "ja-1", language: "ja" }), /setup failed/);
  assert.equal(closed, true);
});

test("a synchronous Gemini connect failure is closed intentionally without starting recovery", async () => {
  let closed = 0;
  let factoryCalls = 0;
  const availability = [];
  const bridge = new LiveTranslationBridge({
    meetingId: "browser-poc",
    fastRecoveryAttempts: 1,
    onTranslationAvailability(value) { availability.push(value); },
    audioGateway: {
      async translationSink() { return { async capture() {} }; },
      async subscribeOriginal() { return { async close() {} }; },
    },
    geminiFactory(options) {
      factoryCalls += 1;
      return {
        connect() {
          options.onClose();
          throw new Error("connect threw synchronously");
        },
        close() { closed += 1; },
      };
    },
  });

  await assert.rejects(
    bridge.start({ id: "ja-1", language: "ja" }),
    /connect threw synchronously/,
  );
  assert.equal(factoryCalls, 1);
  assert.equal(closed, 1);
  assert.deepEqual(availability, []);
});

test("recovery waits for an in-flight stale capture and clears it before accepting replacement output", async () => {
  const clients = [];
  const queued = [];
  const captureEntered = deferredForBridgeTest();
  const releaseCapture = deferredForBridgeTest();
  let clearCalls = 0;
  const bridge = new LiveTranslationBridge({
    meetingId: "browser-poc",
    continuousInput: true,
    audioGateway: {
      async translationSink() {
        return {
          async capture(pcm) {
            captureEntered.resolve();
            await releaseCapture.promise;
            queued.push(pcm.readInt16LE(0));
          },
          clearQueue() { clearCalls += 1; queued.length = 0; },
        };
      },
      async subscribeOriginal() { return { async close() {} }; },
    },
    geminiFactory(options) {
      const client = {
        connect() { options.onSetupComplete(); },
        sendAudioStreamEnd() { return true; },
        sendPcm16() { return true; },
        close() {},
      };
      clients.push({ client, options });
      return client;
    },
  });

  await bridge.start({ id: "ja-1", language: "ja" });
  const staleCapture = clients[0].options.onTranslatedAudio(Buffer.from([7, 0]).toString("base64"));
  await captureEntered.promise;
  clients[0].options.onError(new Error("provider disconnected"));
  await Promise.resolve();
  assert.equal(clients.length, 1);
  releaseCapture.resolve();
  await staleCapture;
  await waitUntil(() => clients.length === 2);
  await waitUntil(() => clearCalls === 1);
  await clients[1].options.onTranslatedAudio(Buffer.from([8, 0]).toString("base64"));

  assert.deepEqual(queued, [8]);
  await bridge.abort();
});

test("abort cancels and awaits a pending recovery replacement without orphan retries", async () => {
  const clients = [];
  const availability = [];
  const scheduled = [];
  const bridge = new LiveTranslationBridge({
    meetingId: "browser-poc",
    continuousInput: true,
    onTranslationAvailability(value) { availability.push(value); },
    scheduleRecovery(callback) { scheduled.push(callback); return scheduled.length; },
    cancelRecovery() {},
    audioGateway: {
      async translationSink() { return { async capture() {}, clearQueue() {} }; },
      async subscribeOriginal() { return { async close() {} }; },
    },
    geminiFactory(options) {
      const index = clients.length;
      const client = {
        closed: false,
        connect() { if (index === 0) options.onSetupComplete(); },
        sendAudioStreamEnd() { return true; },
        sendPcm16() { return true; },
        close() { this.closed = true; options.onClose(); },
      };
      clients.push({ client, options });
      return client;
    },
  });

  await bridge.start({ id: "ja-1", language: "ja" });
  clients[0].options.onError(new Error("provider disconnected"));
  await waitUntil(() => clients.length === 2);
  await bridge.abort();
  await Promise.resolve();

  assert.equal(clients[1].client.closed, true);
  assert.equal(clients.length, 2);
  assert.equal(scheduled.length, 0);
  assert.deepEqual(availability, ["reconnecting"]);
});

test("abort closes the provider before bounded cleanup abandons a pending capture", async () => {
  const clients = [];
  const availability = [];
  const queued = [];
  const invalidated = new WeakSet();
  const captureEntered = deferredForBridgeTest();
  const releaseCapture = deferredForBridgeTest();
  const bridge = new LiveTranslationBridge({
    meetingId: "browser-poc",
    continuousInput: true,
    captureCleanupTimeoutMilliseconds: 10,
    onTranslationAvailability(value) { availability.push(value); },
    audioGateway: {
      async translationSink() {
        return {
          async capture(pcm, generation) {
            captureEntered.resolve();
            await releaseCapture.promise;
            if (!invalidated.has(generation)) queued.push(pcm.readInt16LE(0));
          },
          invalidateGeneration(generation) { invalidated.add(generation); },
          clearQueue() {},
        };
      },
      async subscribeOriginal() { return { async close() {} }; },
    },
    geminiFactory(options) {
      const client = {
        closed: false,
        connect() { options.onSetupComplete(); },
        sendAudioStreamEnd() { return true; },
        sendPcm16() { return true; },
        close() { this.closed = true; },
      };
      clients.push({ client, options });
      return client;
    },
  });

  await bridge.start({ id: "ja-1", language: "ja" });
  const pendingCapture = clients[0].options.onTranslatedAudio(Buffer.from([7, 0]).toString("base64"));
  await captureEntered.promise;
  clients[0].options.onError(new Error("provider disconnected"));
  await waitUntil(() => availability.at(-1) === "reconnecting");
  const abort = bridge.abort();
  const completedWithinLimit = await Promise.race([
    abort.then(() => true),
    delayForTest(100).then(() => false),
  ]);

  assert.equal(completedWithinLimit, true);
  assert.equal(clients[0].client.closed, true);
  assert.equal(clients.length, 1);
  releaseCapture.resolve();
  await pendingCapture;
  await abort;
  assert.deepEqual(queued, []);
});

test("a fresh start publishes available after an unavailable recovery was aborted", async () => {
  const clients = [];
  const availability = [];
  const bridge = new LiveTranslationBridge({
    meetingId: "browser-poc",
    continuousInput: true,
    fastRecoveryAttempts: 1,
    onTranslationAvailability(value) { availability.push(value); },
    scheduleRecovery() { return 1; },
    cancelRecovery() {},
    audioGateway: {
      async translationSink() { return { async capture() {}, clearQueue() {} }; },
      async subscribeOriginal() { return { async close() {} }; },
    },
    geminiFactory(options) {
      const index = clients.length;
      const client = {
        connect() {
          if (index === 0 || index === 2) options.onSetupComplete();
          else options.onError(new Error("replacement failed"));
        },
        sendAudioStreamEnd() { return true; },
        sendPcm16() { return true; },
        close() {},
      };
      clients.push({ client, options });
      return client;
    },
  });

  await bridge.start({ id: "ja-1", language: "ja" });
  clients[0].options.onError(new Error("provider disconnected"));
  await waitUntil(() => availability.at(-1) === "unavailable");
  await bridge.abort();
  await bridge.start({ id: "ja-1", language: "ja" });

  assert.deepEqual(availability, ["reconnecting", "unavailable", "available"]);
  await bridge.abort();
});

test("provider replacement fences stale output, buffers only two seconds, and cools down after three retries", async () => {
  const clients = [];
  const sent = [];
  const captured = [];
  const availability = [];
  const scheduled = [];
  let originalFrame;
  const bridge = new LiveTranslationBridge({
    meetingId: "browser-poc",
    continuousInput: true,
    replacementBufferMilliseconds: 2_000,
    fastRecoveryAttempts: 3,
    recoveryCooldownMilliseconds: 30_000,
    scheduleRecovery(callback, milliseconds) {
      scheduled.push({ callback, milliseconds });
      return scheduled.length;
    },
    cancelRecovery() {},
    onTranslationAvailability(value) { availability.push(value); },
    audioGateway: {
      async translationSink() {
        return { async capture(pcm) { captured.push(pcm.readInt16LE(0)); }, clearQueue() {} };
      },
      async subscribeOriginal(_trackName, onFrame) {
        originalFrame = onFrame;
        return { async close() {} };
      },
    },
    geminiFactory(options) {
      const index = clients.length;
      const client = {
        connect() {
          if (index === 0 || index === 4) options.onSetupComplete();
          else options.onError(new Error(`replacement-${index}-failed`));
        },
        sendAudioStreamEnd() { return true; },
        sendPcm16(pcm) { sent.push({ client: index, marker: pcm.readInt16LE(0) }); return true; },
        close() {},
      };
      clients.push({ client, options });
      return client;
    },
  });

  await bridge.start({ id: "ja-1", language: "ja" });
  clients[0].options.onClose();
  await waitUntil(() => availability.at(-1) === "unavailable");
  assert.equal(clients.length, 4);
  assert.deepEqual(availability, ["reconnecting", "unavailable"]);
  assert.equal(scheduled[0].milliseconds, 30_000);

  for (let marker = 1; marker <= 25; marker += 1) {
    const frame = Buffer.alloc(3_200);
    frame.writeInt16LE(marker);
    originalFrame(frame, 16_000);
  }
  await clients[0].options.onTranslatedAudio(Buffer.from([99, 0]).toString("base64"));
  assert.deepEqual(captured, []);

  scheduled[0].callback();
  await waitUntil(() => availability.at(-1) === "available");
  assert.equal(clients.length, 5);
  assert.deepEqual(sent.filter(({ client }) => client === 4).map(({ marker }) => marker),
    [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25]);
  await bridge.abort();
});

test("a 60-minute goAway path replaces proactively with at most a 500ms measured gap", async () => {
  const clients = [];
  const captured = [];
  const sent = [];
  const availability = [];
  const events = [];
  let originalFrame;
  let now = 0;
  const bridge = new LiveTranslationBridge({
    meetingId: "browser-poc",
    continuousInput: true,
    clock: () => now,
    onTranslationAvailability(value) { availability.push(value); },
    eventRecorder: { record(event) { events.push(event); } },
    audioGateway: {
      async translationSink() {
        return { async capture(pcm) { captured.push(pcm.readInt16LE(0)); }, clearQueue() {} };
      },
      async subscribeOriginal(_trackName, onFrame) {
        originalFrame = onFrame;
        return { async close() {} };
      },
    },
    geminiFactory(options) {
      const index = clients.length;
      const client = {
        closed: false,
        connect() { if (index === 0) options.onSetupComplete(); },
        sendAudioStreamEnd() { return true; },
        sendPcm16(pcm) { sent.push({ client: index, marker: pcm.readInt16LE(0) }); return true; },
        close() { this.closed = true; },
      };
      clients.push({ client, options });
      return client;
    },
  });

  await bridge.start({ id: "ja-1", language: "ja" });
  now = 3_599_600;
  clients[0].options.onServerEvent({ goAway: true, timeLeftMilliseconds: 400 });
  await waitUntil(() => clients.length === 2);
  assert.equal(clients[0].client.closed, false);

  for (let marker = 1; marker <= 25; marker += 1) {
    const frame = Buffer.alloc(3_200);
    frame.writeInt16LE(marker);
    originalFrame(frame, 16_000);
  }
  await clients[0].options.onTranslatedAudio(Buffer.from([99, 0]).toString("base64"));
  assert.deepEqual(captured, []);

  now = 3_600_000;
  clients[1].options.onSetupComplete();
  await waitUntil(() => availability.at(-1) === "available");

  assert.equal(clients[0].client.closed, true);
  assert.deepEqual(sent.filter(({ client }) => client === 1).map(({ marker }) => marker),
    [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25]);
  const replacement = events.find(({ type, reconnectReason }) =>
    type === "gemini-retry-succeeded" && reconnectReason === "go-away-time-left");
  assert.equal(replacement.interruptionMilliseconds, 400);
  assert.equal(replacement.interruptionMilliseconds <= 500, true);
  assert.deepEqual(availability, ["reconnecting", "available"]);
  await bridge.abort();
});

test("stop closes Gemini and permits restart even when subscription cleanup fails", async () => {
  const clients = [];
  let subscriptionCount = 0;
  const bridge = new LiveTranslationBridge({
    meetingId: "browser-poc",
    audioGateway: {
      async translationSink() { return { async capture() {} }; },
      async subscribeOriginal() {
        subscriptionCount += 1;
        return {
          async close() {
            if (subscriptionCount === 1) throw new Error("unsubscribe failed");
          },
        };
      },
    },
    geminiFactory(options) {
      const client = {
        closed: false,
        options,
        connect() { options.onSetupComplete(); },
        sendActivityStart() { return true; },
        sendActivityEnd() { return true; },
        sendPcm16() { return true; },
        close() { this.closed = true; },
      };
      clients.push(client);
      return client;
    },
  });

  await bridge.start({ id: "ja-1", language: "ja" });
  await clients[0].options.onTranslatedAudio(Buffer.from([1, 2]).toString("base64"));
  const failedStop = bridge.stop();
  await assert.rejects(failedStop, /unsubscribe failed/);
  assert.equal(clients[0].closed, true);

  await bridge.start({ id: "ko-1", language: "ko" });
  await clients[1].options.onTranslatedAudio(Buffer.from([1, 2]).toString("base64"));
  const successfulStop = bridge.stop();
  await successfulStop;
});

test("a phrase boundary drains translated audio when Live Translate omits completion events", async () => {
  const calls = [];
  let geminiOptions;
  const bridge = new LiveTranslationBridge({
    meetingId: "browser-poc",
    drainQuietMilliseconds: 5,
    audioGateway: {
      async translationSink() {
        return { async capture() { calls.push("capture"); } };
      },
      async subscribeOriginal() { return { async close() {} }; },
    },
    geminiFactory(options) {
      geminiOptions = options;
      return {
        connect() { options.onSetupComplete(); },
        sendActivityStart() { calls.push("activity-start"); return true; },
        sendActivityEnd() { calls.push("activity-end"); return true; },
        sendPcm16() { return true; },
        close() {},
      };
    },
  });

  await bridge.start({ id: "ko-1", language: "ko" });
  const boundary = bridge.phraseBoundary();
  await delayForTest(1);
  await geminiOptions.onTranslatedAudio(Buffer.from([0, 0]).toString("base64"));
  await geminiOptions.onTranslatedAudio(Buffer.from([1, 2]).toString("base64"));
  await boundary;
  assert.deepEqual(calls, [
    "activity-start",
    "activity-end",
    "capture",
    "capture",
    "activity-start",
  ]);

  await geminiOptions.onTranslatedAudio(Buffer.from([3, 4]).toString("base64"));
  const stop = bridge.stop();
  await stop;
});

test("a missing first translation aborts instead of reporting a successful boundary", async () => {
  const clients = [];
  let closes = 0;
  const bridge = new LiveTranslationBridge({
    meetingId: "browser-poc",
    drainQuietMilliseconds: 1,
    firstAudioTimeoutMilliseconds: 5,
    audioGateway: {
      async translationSink() { return { async capture() {} }; },
      async subscribeOriginal() {
        return { async close() { closes += 1; } };
      },
    },
    geminiFactory(options) {
      const client = {
        closed: false,
        connect() { options.onSetupComplete(); },
        sendActivityStart() { return true; },
        sendActivityEnd() { return true; },
        sendPcm16() { return true; },
        close() { this.closed = true; },
      };
      clients.push(client);
      return client;
    },
  });

  await bridge.start({ id: "ko-1", language: "ko" });
  await assert.rejects(
    bridge.phraseBoundary(),
    /no audible translation before the drain timeout/,
  );
  assert.equal(clients[0].closed, true);
  assert.equal(closes, 1);

  await bridge.start({ id: "ja-1", language: "ja" });
  await bridge.abort();
  assert.equal(clients[1].closed, true);
  assert.equal(closes, 2);
});

test("abort waits for an in-progress start and prevents an orphan bridge", async () => {
  const subscriptionEntered = deferredForBridgeTest();
  const subscription = deferredForBridgeTest();
  let client;
  let subscriptionClosed = false;
  const bridge = new LiveTranslationBridge({
    meetingId: "browser-poc",
    audioGateway: {
      async translationSink() { return { async capture() {} }; },
      async subscribeOriginal() {
        subscriptionEntered.resolve();
        return subscription.promise;
      },
    },
    geminiFactory(options) {
      client = {
        closed: false,
        connect() { options.onSetupComplete(); },
        sendActivityStart() { return true; },
        sendActivityEnd() { return true; },
        sendPcm16() { return true; },
        close() { this.closed = true; },
      };
      return client;
    },
  });

  const start = bridge.start({ id: "ko-1", language: "ko" });
  await subscriptionEntered.promise;
  const abort = bridge.abort();
  subscription.resolve({ async close() { subscriptionClosed = true; } });
  await abort;
  await assert.rejects(start, /start was aborted/);
  assert.equal(client, undefined);
  assert.equal(subscriptionClosed, true);
});

function delayForTest(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function deferredForBridgeTest() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("condition was not reached");
}
