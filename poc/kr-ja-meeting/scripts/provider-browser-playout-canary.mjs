import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { dispose } from "@livekit/rtc-node";
import WebSocket from "ws";

import {
  connectCanaryPublisher,
  openBrowserPlayout,
} from "../src/browser-playout-harness.mjs";
import { GeminiLiveTranslateSocket } from "../src/gemini-live-socket.mjs";
import { LiveKitAudioGateway } from "../src/livekit-audio-gateway.mjs";
import { pcm16Rms, withTimeout } from "../src/playout-continuity.mjs";
import {
  dualProbeContractResult,
  scoreDualProbePlayout,
  summarizeProviderBrowserRuns,
  waitForCanarySignal,
} from "../src/provider-browser-playout.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const FRAME_DURATION_MS = 20;
const PROVIDER_SAMPLE_RATE = 24_000;
const PROVIDER_FRAME_BYTES = PROVIDER_SAMPLE_RATE * FRAME_DURATION_MS / 1_000 * 2;
const INPUT_SAMPLE_RATE = 16_000;
const INPUT_CHUNK_BYTES = INPUT_SAMPLE_RATE / 10 * 2;
const OPERATION_TIMEOUT_MS = 45_000;
const PROVIDER_CAPTURE_TIMEOUT_MS = 5_000;
const PROVIDER_IDLE_MS = 1_500;
const livekitUrl = process.env.LIVEKIT_URL ?? "ws://127.0.0.1:7880";
const livekitApiKey = process.env.LIVEKIT_API_KEY ?? "devkey";
const livekitApiSecret = process.env.LIVEKIT_API_SECRET ?? "secret";
const repeat = readRepeat(process.argv.slice(2));
const temporaryDirectories = [];
let geminiApiKey = "";

try {
  geminiApiKey = readApiKey();
  const inputPcm = synthesizeKoreanPcm();
  const results = [];
  for (let run = 1; run <= repeat; run += 1) {
    results.push(await runOnce({ run, inputPcm }));
  }
  const contracts = results.map((scorecard) => dualProbeContractResult(scorecard));
  const contractConsistent = new Set(contracts.map((contract) => JSON.stringify(contract))).size === 1;
  const ok = results.every((scorecard) => scorecard.ok) && contractConsistent;
  const scorecards = results;
  process.stdout.write(`${JSON.stringify({
    ok,
    contractConsistent,
    latency: summarizeProviderBrowserRuns(scorecards),
    runs: scorecards.map((scorecard) => ({
      continuous: scorecard.ok,
      firstProviderAudioMilliseconds: scorecard.firstProviderAudioMs,
      providerEndAfterInputEndMilliseconds: scorecard.providerEndAfterInputEndMs,
      maximumBrowserGapMilliseconds: scorecard.maxBrowserFrameGapMs,
      tailLossMilliseconds: scorecard.tailLossMs,
    })),
  })}\n`);
  if (!ok) process.exitCode = 1;
} catch (error) {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const safeMessage = geminiApiKey
    ? rawMessage.replaceAll(geminiApiKey, "[REDACTED]")
    : rawMessage;
  process.stderr.write(`provider browser playout canary failed: ${safeMessage}\n`);
  process.exitCode = 1;
} finally {
  geminiApiKey = "";
  dispose();
  await Promise.allSettled(temporaryDirectories.map((directory) =>
    rm(directory, { recursive: true, force: true })));
}

async function runOnce({ run, inputPcm }) {
  const runId = `${Date.now()}-${process.pid}-${run}`;
  const roomName = `provider-browser-${runId}`;
  let publisher;
  let gateway;
  let browserPlayout;
  let gemini;
  let publisherQueueTimer;
  const providerPcm = [];
  const publisherQueue = [];
  let captureChain = Promise.resolve();
  let captureError;
  let setupComplete = false;
  let generationComplete = false;
  let geminiError;
  let firstProviderAtMs;
  let lastProviderAtMs;
  let publisherCompleteAtMs;

  try {
    publisher = await connectCanaryPublisher({
      livekitUrl,
      livekitApiKey,
      livekitApiSecret,
      roomName,
      identity: `publisher-${runId}`,
      timeoutMs: OPERATION_TIMEOUT_MS,
    });
    gateway = new LiveKitAudioGateway(publisher);
    const sink = await withTimeout(
      gateway.translationSink("ja"),
      OPERATION_TIMEOUT_MS,
      "translation track publication",
    );
    browserPlayout = await openBrowserPlayout({
      livekitUrl,
      livekitApiKey,
      livekitApiSecret,
      roomName,
      identity: `browser-${runId}`,
      trackName: "translation:ja",
      timeoutMs: OPERATION_TIMEOUT_MS,
    });
    publisherQueueTimer = setInterval(() => {
      publisherQueue.push({
        atMs: Date.now(),
        queuedDurationMs: sink.queuedDurationMs(),
      });
    }, 100);

    gemini = new GeminiLiveTranslateSocket({
      apiKey: geminiApiKey,
      meetingId: roomName,
      targetLanguage: "ja",
      socketFactory: (url) => new WebSocket(url),
      openState: WebSocket.OPEN,
      automaticActivityDetection: false,
      onSetupComplete() {
        setupComplete = true;
      },
      onGenerationComplete() {
        generationComplete = true;
      },
      onTurnComplete() {
        generationComplete = true;
      },
      onError(error) {
        geminiError = error;
      },
      onTranslatedAudio(base64Audio) {
        const pcm = Buffer.from(base64Audio, "base64");
        const atMs = Date.now();
        const rms = pcm16Rms(pcm) / 32_768;
        if (rms >= 0.01) {
          if (firstProviderAtMs === undefined) firstProviderAtMs = atMs;
          lastProviderAtMs = atMs;
        }
        providerPcm.push(pcm);
        captureChain = captureChain.then(async () => {
          if (captureError) return;
          try {
            const metrics = await withTimeout(
              sink.capture(pcm),
              PROVIDER_CAPTURE_TIMEOUT_MS,
              "provider frame capture",
            );
            publisherQueue.push({
              atMs: Date.now(),
              queuedDurationMs: metrics.queuedBeforeMs,
            });
          } catch (error) {
            captureError ??= error;
          }
        });
      },
    });
    gemini.connect();
    await waitForCanarySignal({
      predicate: () => setupComplete,
      timeoutMs: OPERATION_TIMEOUT_MS,
      label: "Gemini setup",
      readError: () => geminiError ?? captureError,
    });
    if (!gemini.sendActivityStart()) throw new Error("Gemini activityStart was not sent");

    const inputStartedAtMs = Date.now();
    await sendRealtimeInput(gemini, inputPcm);
    const inputEndedAtMs = Date.now();
    if (!gemini.sendActivityEnd()) throw new Error("Gemini activityEnd was not sent");
    await waitForCanarySignal({
      predicate: () => firstProviderAtMs !== undefined,
      timeoutMs: OPERATION_TIMEOUT_MS,
      label: "first Gemini translated audio",
      readError: () => geminiError ?? captureError,
    });
    await waitForCanarySignal({
      predicate: () => generationComplete || Date.now() - lastProviderAtMs >= PROVIDER_IDLE_MS,
      timeoutMs: OPERATION_TIMEOUT_MS,
      label: "Gemini translated audio completion",
      readError: () => geminiError ?? captureError,
    });
    gemini.close();
    await withTimeout(captureChain, OPERATION_TIMEOUT_MS, "provider capture chain");
    if (captureError) throw captureError;
    publisherCompleteAtMs = Date.now();
    clearInterval(publisherQueueTimer);
    publisherQueueTimer = undefined;
    await withTimeout(sink.waitForPlayout(), OPERATION_TIMEOUT_MS, "publisher queue drain");
    await delay(1_000);
    const browserState = await browserPlayout.finish();
    const providerOutput = Buffer.concat(providerPcm);
    const providerFrames = pcmEnvelope(providerOutput);
    const timing = {
      providerOutputDurationMs: providerOutput.length / 2 / PROVIDER_SAMPLE_RATE * 1_000,
      browserRtpSampleCount: browserState.rtpSamples.length,
      firstProviderAudioMs: firstProviderAtMs - inputStartedAtMs,
      firstProviderAfterInputEndMs: firstProviderAtMs - inputEndedAtMs,
      providerEndAfterInputEndMs: lastProviderAtMs - inputEndedAtMs,
    };
    let scorecard;
    try {
      scorecard = {
        ...scoreDualProbePlayout({
          frameDurationMs: FRAME_DURATION_MS,
          providerFrames,
          rawTrackFrames: browserState.rawTrackFrames,
          elementFrames: browserState.frames,
          publisherQueue,
          publisherCompleteAtMs,
          rtpSamples: browserState.rtpSamples,
        }),
        ...timing,
      };
    } catch (error) {
      scorecard = {
        ok: false,
        location: "canary_evidence_incomplete",
        evidenceError: error instanceof Error ? error.message : String(error),
        frameDurationMs: FRAME_DURATION_MS,
        providerFrameCount: providerFrames.length,
        browserFrameCount: browserState.frames.length,
        rawTrackFrameCount: browserState.rawTrackFrames.length,
        providerSilentRunMs: null,
        unexpectedSilentRunMs: null,
        tailLossMs: null,
        ...timing,
      };
    }
    return scorecard;
  } finally {
    if (publisherQueueTimer) clearInterval(publisherQueueTimer);
    gemini?.close();
    if (browserPlayout) await browserPlayout.close().catch(() => {});
    if (gateway) await withTimeout(gateway.close(), OPERATION_TIMEOUT_MS, "gateway close")
      .catch(() => {});
    if (publisher) await withTimeout(
      publisher.disconnect(),
      OPERATION_TIMEOUT_MS,
      "publisher disconnect",
    ).catch(() => {});
  }
}

function readApiKey() {
  const fromEnvironment = process.env.GEMINI_API_KEY?.trim();
  if (fromEnvironment) return fromEnvironment;
  const envFile = readFileSync(join(root, ".env.local"), "utf8");
  const match = envFile.match(/^GEMINI_API_KEY=(.+)$/m);
  if (!match?.[1]?.trim()) throw new Error("GEMINI_API_KEY is missing from .env.local");
  return match[1].trim();
}

function synthesizeKoreanPcm() {
  const directory = mkdtempSync(join(tmpdir(), "gemini-live-provider-input-"));
  temporaryDirectories.push(directory);
  const aiffPath = join(directory, "ko.aiff");
  execFileSync("/usr/bin/say", [
    "-v",
    "Yuna",
    "-o",
    aiffPath,
    "안녕하세요. 오늘 회의에서는 새 제품 계획을 확인합니다. 잘 부탁드립니다.",
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
    String(INPUT_SAMPLE_RATE),
    "pipe:1",
  ], { maxBuffer: 8 * 1024 * 1024 });
}

async function sendRealtimeInput(gemini, pcm) {
  for (let offset = 0; offset < pcm.length; offset += INPUT_CHUNK_BYTES) {
    const chunk = pcm.subarray(offset, Math.min(offset + INPUT_CHUNK_BYTES, pcm.length));
    if (!gemini.sendPcm16(chunk, INPUT_SAMPLE_RATE)) {
      throw new Error("Gemini input audio was not sent");
    }
    await delay(100);
  }
}

function pcmEnvelope(pcm) {
  const frames = [];
  for (let offset = 0; offset + PROVIDER_FRAME_BYTES <= pcm.length;
    offset += PROVIDER_FRAME_BYTES) {
    frames.push({
      rms: pcm16Rms(pcm.subarray(offset, offset + PROVIDER_FRAME_BYTES)) / 32_768,
    });
  }
  return frames;
}

function readRepeat(args) {
  if (args.length === 0) return 5;
  if (args.length !== 1) throw new Error(`unsupported arguments: ${args.join(" ")}`);
  const match = args[0].match(/^--repeat=(\d+)$/);
  const value = match ? Number.parseInt(match[1], 10) : Number.NaN;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("--repeat must be a positive integer");
  }
  return value;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
