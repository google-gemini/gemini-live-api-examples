import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import WebSocket from "ws";

import { GeminiLiveTranslateSocket } from "../src/gemini-live-socket.mjs";
import {
  ProviderSemanticEvidence,
  evaluateProviderSemanticTrial,
  providerSemanticFixtures,
  providerSemanticStreamPlan,
  semanticStreamSettled,
} from "../src/provider-canary.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const SAMPLE_RATE = 16_000;
const CHUNK_BYTES = SAMPLE_RATE / 10 * 2;
const temporaryDirectories = [];
const fixtures = providerSemanticFixtures();
const streamPlan = providerSemanticStreamPlan();

let apiKey = "";
try {
  apiKey = readApiKey();
  const evidence = new ProviderSemanticEvidence();
  for (const item of fixtures) {
    const result = await runTrial(item);
    evidence.record({ direction: item.direction, trialId: item.id, ...result });
  }
  const snapshot = evidence.snapshot();
  process.stdout.write(`${JSON.stringify(snapshot)}\n`);
  if (!snapshot.ok) process.exitCode = 1;
} catch {
  process.stderr.write("provider semantic canary failed\n");
  process.exitCode = 1;
} finally {
  apiKey = "";
  await Promise.allSettled(temporaryDirectories.map((directory) =>
    rm(directory, { recursive: true, force: true })));
}

async function runTrial(item) {
  const inputParts = [];
  const outputParts = [];
  const setup = deferred();
  const failed = deferred();
  let lastTranscriptionAt = 0;
  let finished = false;
  const client = new GeminiLiveTranslateSocket({
    apiKey,
    meetingId: `semantic-canary-${item.id}`,
    targetLanguage: item.direction === "ko-to-ja" ? "ja" : "ko",
    canaryTranscription: true,
    automaticActivityDetection: streamPlan.automaticActivityDetection,
    socketFactory: (url) => new WebSocket(url),
    openState: WebSocket.OPEN,
    onSetupComplete: setup.resolve,
    onInputTranscription(value) {
      inputParts.push(value);
      lastTranscriptionAt = Date.now();
    },
    onOutputTranscription(value) {
      outputParts.push(value);
      lastTranscriptionAt = Date.now();
    },
    onError() {
      const error = new Error("provider error");
      setup.reject(error);
      if (!finished) failed.resolve(error);
    },
    onClose() {
      if (!finished) failed.resolve(new Error("provider closed"));
    },
  });
  try {
    client.connect();
    await withTimeout(setup.promise, 30_000);
    const pcm = synthesize(item.voice, item.spoken);
    await sendSilence(client, streamPlan.leadingSilenceMilliseconds);
    await sendPcm(client, pcm);
    await sendSilence(client, streamPlan.trailingSilenceMilliseconds);
    const failure = await Promise.race([
      waitForTranscriptionQuiet({
        inputParts,
        outputParts,
        lastTranscriptionAt: () => lastTranscriptionAt,
      }).then(() => null),
      failed.promise,
    ]);
    if (failure) throw failure;
    await delay(250);
    return evaluateProviderSemanticTrial({
      fixture: item,
      input: inputParts.join(" "),
      output: outputParts.join(" "),
    });
  } finally {
    finished = true;
    client.close();
  }
}

function synthesize(voice, spoken) {
  const directory = mkdtempSync(join(tmpdir(), "provider-semantic-input-"));
  temporaryDirectories.push(directory);
  const sourcePath = join(directory, "source.aiff");
  execFileSync("/usr/bin/say", ["-v", voice, "-o", sourcePath, spoken]);
  return execFileSync("/opt/homebrew/bin/ffmpeg", [
    "-v", "error", "-i", sourcePath, "-f", "s16le", "-acodec", "pcm_s16le",
    "-ac", "1", "-ar", String(SAMPLE_RATE), "pipe:1",
  ], { maxBuffer: 8 * 1024 * 1024 });
}

function readApiKey() {
  const fromEnvironment = process.env.GEMINI_API_KEY?.trim();
  if (fromEnvironment) return fromEnvironment;
  const match = readFileSync(join(root, ".env.local"), "utf8").match(/^GEMINI_API_KEY=(.+)$/m);
  if (!match?.[1]?.trim()) throw new Error("missing credential");
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

function withTimeout(promise, milliseconds) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), milliseconds); }),
  ]).finally(() => clearTimeout(timer));
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function sendPcm(client, pcm) {
  for (let offset = 0; offset < pcm.length; offset += CHUNK_BYTES) {
    if (!client.sendPcm16(pcm.subarray(offset, offset + CHUNK_BYTES), SAMPLE_RATE)) {
      throw new Error("input failed");
    }
    await delay(100);
  }
}

async function sendSilence(client, milliseconds) {
  const frame = Buffer.alloc(CHUNK_BYTES);
  for (let elapsed = 0; elapsed < milliseconds; elapsed += 100) {
    if (!client.sendPcm16(frame, SAMPLE_RATE)) throw new Error("input failed");
    await delay(100);
  }
}

async function waitForTranscriptionQuiet({ inputParts, outputParts, lastTranscriptionAt }) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < streamPlan.transcriptionTimeoutMilliseconds) {
    if (semanticStreamSettled({
      inputEvents: inputParts.length,
      outputEvents: outputParts.length,
      lastTranscriptionAt: lastTranscriptionAt(),
      now: Date.now(),
      quietMilliseconds: streamPlan.transcriptionQuietMilliseconds,
    })) return;
    await delay(100);
  }
  throw new Error("provider semantic transcription timed out");
}
