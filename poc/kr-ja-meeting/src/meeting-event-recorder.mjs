import { performance } from "node:perf_hooks";

const EVENT_TYPES = new Set([
  "meeting-joined",
  "meeting-left",
  "microphone-enabled",
  "microphone-disabled",
  "speech-started",
  "speech-ended",
  "translation-focus-selected",
  "translation-focus-changed",
  "translation-focus-cleared",
  "translation-interrupted",
  "overlap-started",
  "overlap-detected",
  "overlap-ended",
  "gemini-setup-started",
  "gemini-setup-succeeded",
  "gemini-setup-failed",
  "gemini-input-started",
  "gemini-input-received",
  "gemini-output-received",
  "gemini-output-completed",
  "gemini-output-aborted",
  "gemini-retry-started",
  "gemini-retry-succeeded",
  "gemini-retry-failed",
  "livekit-publish-started",
  "livekit-publish-succeeded",
  "livekit-publish-failed",
  "livekit-subscribe-started",
  "livekit-subscribe-succeeded",
  "livekit-subscribe-failed",
  "livekit-queue-updated",
  "listening-mode-changed",
  "listening-mode-restored",
  "listening-gain-applied",
  "playout-attached",
  "playout-started",
  "playout-gap",
  "playout-completed",
  "playout-aborted",
  "utterance-completed",
  "utterance-aborted",
  "resources-closed",
]);

const STRING_FIELDS = [
  "participantId",
  "utteranceId",
  "language",
  "targetLanguage",
  "result",
  "errorCode",
  "relatedParticipantId",
  "listeningMode",
  "trackId",
  "trackKind",
  "reconnectReason",
];

const NUMBER_FIELDS = new Map([
  ["detectedAt", (value) => Number.isFinite(value)],
  ["gain", (value) => Number.isFinite(value) && value >= 0 && value <= 1],
  ["queueDurationMs", (value) => Number.isFinite(value) && value >= 0],
  ["interruptionMilliseconds", (value) => Number.isFinite(value) && value >= 0],
]);

const INPUT_FIELDS = new Set(["type", ...STRING_FIELDS, ...NUMBER_FIELDS.keys()]);
const STORED_FIELDS = new Set([
  ...INPUT_FIELDS,
  "meetingId",
  "timestamp",
  "stage",
]);
const TRACE_READ_ROLES = new Set(["operator", "developer"]);

export const SEGMENT_TRACE_RETENTION_MILLISECONDS = 7 * 24 * 60 * 60 * 1_000;
export const SEGMENT_TRACE_MAX_RECORDS = 10_000;

export class MeetingEventRecorder {
  #meetingId;
  #clock;
  #write;

  constructor({ meetingId, clock = () => performance.now(), write } = {}) {
    requireString(meetingId, "meetingId");
    if (typeof clock !== "function") throw new Error("event clock must be a function");
    if (typeof write !== "function") throw new Error("event writer must be a function");
    this.#meetingId = meetingId;
    this.#clock = clock;
    this.#write = write;
  }

  record(event = {}) {
    rejectUnsupportedFields(event, INPUT_FIELDS);
    if (!EVENT_TYPES.has(event.type)) throw new Error(`unsupported meeting event type: ${event.type}`);
    const timestamp = this.#clock();
    if (!Number.isFinite(timestamp)) throw new Error("event timestamp must be finite");
    const safe = {
      type: event.type,
      meetingId: this.#meetingId,
    };
    for (const field of STRING_FIELDS) {
      if (event[field] === undefined) continue;
      requireString(event[field], field);
      safe[field] = event[field];
    }
    for (const [field, isValid] of NUMBER_FIELDS) {
      if (event[field] === undefined) continue;
      if (!isValid(event[field])) throw new Error(`${field} is invalid`);
      safe[field] = event[field];
    }
    safe.timestamp = timestamp;
    try {
      this.#write(Object.freeze(safe));
    } catch {
      // Diagnostic delivery cannot change the meeting contract.
    }
    return safe;
  }
}

export class MemoryMeetingSegmentTraceStore {
  #clock;
  #retentionMilliseconds;
  #maxRecords;
  #scheduleExpiry;
  #cancelExpiry;
  #expiryTimer = null;
  #records = [];

  constructor({
    clock = Date.now,
    retentionMilliseconds = SEGMENT_TRACE_RETENTION_MILLISECONDS,
    maxRecords = SEGMENT_TRACE_MAX_RECORDS,
    scheduleExpiry = setTimeout,
    cancelExpiry = clearTimeout,
  } = {}) {
    if (typeof clock !== "function") throw new Error("trace store clock must be a function");
    if (!Number.isFinite(retentionMilliseconds) || retentionMilliseconds <= 0) {
      throw new Error("trace retention must be a positive number");
    }
    if (!Number.isSafeInteger(maxRecords) || maxRecords <= 0) {
      throw new Error("trace maxRecords must be a positive integer");
    }
    if (typeof scheduleExpiry !== "function" || typeof cancelExpiry !== "function") {
      throw new Error("trace expiry scheduler must provide schedule and cancel functions");
    }
    this.#clock = clock;
    this.#retentionMilliseconds = retentionMilliseconds;
    this.#maxRecords = maxRecords;
    this.#scheduleExpiry = scheduleExpiry;
    this.#cancelExpiry = cancelExpiry;
  }

  write(event = {}) {
    rejectUnsupportedFields(event, STORED_FIELDS);
    if (!EVENT_TYPES.has(event.type)) throw new Error(`unsupported meeting event type: ${event.type}`);
    requireString(event.meetingId, "meetingId");
    if (!Number.isFinite(event.timestamp)) throw new Error("event timestamp must be finite");
    const storedAt = this.#now();
    this.#purge(storedAt);
    const record = {
      event: Object.freeze({ ...event, stage: traceStage(event.type) }),
      storedAt,
    };
    const previous = this.#records.at(-1);
    if (canCoalesceQueueTelemetry(previous?.event, record.event)) {
      this.#records[this.#records.length - 1] = record;
    } else {
      this.#records.push(record);
      if (this.#records.length > this.#maxRecords) {
        this.#records.splice(0, this.#records.length - this.#maxRecords);
      }
    }
    this.#armExpiry(storedAt);
  }

  query({ role, meetingId, participantId, utteranceId, stage } = {}) {
    if (!TRACE_READ_ROLES.has(role)) throw new Error("segment trace role is not authorized");
    const now = this.#now();
    this.#purge(now);
    this.#armExpiry(now);
    return this.#records
      .map(({ event }) => event)
      .filter((event) => meetingId === undefined || event.meetingId === meetingId)
      .filter((event) => participantId === undefined || event.participantId === participantId)
      .filter((event) => utteranceId === undefined || event.utteranceId === utteranceId)
      .filter((event) => stage === undefined || event.stage === stage);
  }

  close() {
    if (this.#expiryTimer !== null) this.#cancelExpiry(this.#expiryTimer);
    this.#expiryTimer = null;
    this.#records = [];
  }

  #now() {
    const now = this.#clock();
    if (!Number.isFinite(now)) throw new Error("trace store clock must return a finite number");
    return now;
  }

  #purge(now) {
    const oldestAllowed = now - this.#retentionMilliseconds;
    this.#records = this.#records.filter(({ storedAt }) => storedAt > oldestAllowed);
  }

  #armExpiry(now) {
    if (this.#expiryTimer !== null) this.#cancelExpiry(this.#expiryTimer);
    this.#expiryTimer = null;
    const oldest = this.#records[0];
    if (!oldest) return;
    const delay = Math.max(0, oldest.storedAt + this.#retentionMilliseconds - now);
    this.#expiryTimer = this.#scheduleExpiry(() => {
      this.#expiryTimer = null;
      const expiredAt = this.#now();
      this.#purge(expiredAt);
      this.#armExpiry(expiredAt);
    }, delay);
    this.#expiryTimer?.unref?.();
  }
}

export function noopMeetingEventRecorder() {
  return { record() {} };
}

function requireString(value, label) {
  if (typeof value !== "string" || !value) throw new Error(`${label} must be a non-empty string`);
}

function rejectUnsupportedFields(event, allowedFields) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new Error("meeting event must be an object");
  }
  for (const field of Object.keys(event)) {
    if (!allowedFields.has(field)) throw new Error(`unsupported meeting event field: ${field}`);
  }
}

function traceStage(type) {
  if (type.startsWith("gemini-retry-")) return "provider-reconnect";
  if (type.startsWith("gemini-")) return "gemini-provider";
  if (type.startsWith("livekit-")) return "livekit-webrtc";
  if (type.startsWith("translation-") || type.startsWith("overlap-")) {
    return "focus-control";
  }
  if (type.startsWith("playout-") || type.startsWith("listening-")) {
    return "browser-playout";
  }
  if (["utterance-completed", "utterance-aborted", "resources-closed"].includes(type)) {
    return "meeting-lifecycle";
  }
  return "browser-input";
}

function canCoalesceQueueTelemetry(previous, next) {
  if (previous?.type !== "livekit-queue-updated" || next?.type !== "livekit-queue-updated") {
    return false;
  }
  return ["meetingId", "participantId", "utteranceId", "targetLanguage", "trackId"]
    .every((field) => previous[field] === next[field]);
}
