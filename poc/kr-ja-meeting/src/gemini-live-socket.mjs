import { buildGeminiSetup } from "./gemini-session.mjs";

const GEMINI_LIVE_URL =
  "wss://generativelanguage.googleapis.com/ws/" +
  "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

export class GeminiLiveTranslateSocket {
  #apiKey;
  #meetingId;
  #targetLanguage;
  #glossary;
  #socketFactory;
  #openState;
  #onTranslatedAudio;
  #onSetupComplete;
  #onGenerationComplete;
  #onTurnComplete;
  #onError;
  #onClose;
  #onServerEvent;
  #onInputTranscription;
  #onOutputTranscription;
  #automaticActivityDetection;
  #canaryTranscription;
  #eventRecorder;
  #participantId;
  #utteranceId;
  #socket = null;
  #setupComplete = false;

  constructor({
    apiKey,
    meetingId,
    targetLanguage,
    glossary = [],
    socketFactory,
    openState = 1,
    onTranslatedAudio,
    onSetupComplete,
    onGenerationComplete,
    onTurnComplete,
    onError,
    onClose,
    onServerEvent,
    onInputTranscription,
    onOutputTranscription,
    automaticActivityDetection = true,
    canaryTranscription = false,
    eventRecorder = { record() {} },
    participantId,
    utteranceId,
  }) {
    if (!apiKey || !meetingId || !socketFactory) {
      throw new Error("apiKey, meetingId, and socketFactory are required");
    }
    this.#apiKey = apiKey;
    this.#meetingId = meetingId;
    this.#targetLanguage = targetLanguage;
    this.#glossary = glossary;
    this.#socketFactory = socketFactory;
    this.#openState = openState;
    this.#onTranslatedAudio = onTranslatedAudio ?? (() => {});
    this.#onSetupComplete = onSetupComplete ?? (() => {});
    this.#onGenerationComplete = onGenerationComplete ?? (() => {});
    this.#onTurnComplete = onTurnComplete ?? (() => {});
    this.#onError = onError ?? (() => {});
    this.#onClose = onClose ?? (() => {});
    this.#onServerEvent = onServerEvent ?? (() => {});
    this.#onInputTranscription = onInputTranscription ?? (() => {});
    this.#onOutputTranscription = onOutputTranscription ?? (() => {});
    this.#automaticActivityDetection = automaticActivityDetection;
    this.#canaryTranscription = canaryTranscription === true;
    if (!eventRecorder || typeof eventRecorder.record !== "function") {
      throw new Error("eventRecorder.record must be a function");
    }
    this.#eventRecorder = eventRecorder;
    this.#participantId = participantId;
    this.#utteranceId = utteranceId;
  }

  connect() {
    if (this.#socket) {
      throw new Error("Gemini socket is already connected");
    }
    return this.#connectSocket();
  }

  #connectSocket() {
    const url = `${GEMINI_LIVE_URL}?key=${encodeURIComponent(this.#apiKey)}`;
    const socket = this.#socketFactory(url);
    this.#socket = socket;
    this.#listen(socket, "open", () => {
      if (this.#socket !== socket) return;
      socket.send(
        JSON.stringify(
          buildGeminiSetup({
            targetLanguage: this.#targetLanguage,
            glossary: this.#glossary,
            automaticActivityDetection: this.#automaticActivityDetection,
            canaryTranscription: this.#canaryTranscription,
          }),
        ),
      );
    });
    this.#listen(socket, "message", (data) => {
      if (this.#socket === socket) this.#handleMessage(data);
    });
    this.#listen(socket, "error", (error) => {
      if (this.#socket === socket) this.#onError(error);
    });
    this.#listen(socket, "close", (code, reason) => {
      if (this.#socket !== socket) return;
      this.#socket = null;
      this.#setupComplete = false;
      this.#onClose(code, reason);
    });
    return socket;
  }

  sendPcm16(buffer, sampleRate = 48000) {
    if (
      !this.#socket ||
      this.#socket.readyState !== this.#openState ||
      !this.#setupComplete
    ) {
      return false;
    }
    const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    this.#socket.send(
      JSON.stringify({
        realtimeInput: {
          audio: {
            mimeType: `audio/pcm;rate=${sampleRate}`,
            data: bytes.toString("base64"),
          },
        },
      }),
    );
    return true;
  }

  sendAudioStreamEnd() {
    if (
      !this.#socket ||
      this.#socket.readyState !== this.#openState ||
      !this.#setupComplete
    ) {
      return false;
    }
    this.#socket.send(
      JSON.stringify({ realtimeInput: { audioStreamEnd: true } }),
    );
    return true;
  }

  sendActivityStart() {
    return this.#sendRealtimeSignal("activityStart");
  }

  sendActivityEnd() {
    return this.#sendRealtimeSignal("activityEnd");
  }

  close() {
    const socket = this.#socket;
    if (!socket) return;
    this.#socket = null;
    this.#setupComplete = false;
    socket.close();
    this.#onClose();
  }

  #handleMessage(data) {
    const payload = typeof data === "string" ? data : data.toString();
    const message = JSON.parse(payload);
    const serverEvent = {};
    if (message.setupComplete) serverEvent.setupComplete = true;
    if (message.serverContent?.modelTurn?.parts?.some((part) => part.inlineData?.data)) {
      serverEvent.modelAudio = true;
    }
    if (message.serverContent?.generationComplete) {
      serverEvent.generationComplete = true;
    }
    if (message.serverContent?.turnComplete) serverEvent.turnComplete = true;
    if (message.serverContent?.interrupted) serverEvent.interrupted = true;
    if (message.goAway) {
      serverEvent.goAway = true;
      const timeLeftMilliseconds = durationMilliseconds(message.goAway.timeLeft);
      if (timeLeftMilliseconds !== null) {
        serverEvent.timeLeftMilliseconds = timeLeftMilliseconds;
      }
    }
    if (Object.keys(serverEvent).length > 0) this.#onServerEvent(serverEvent);
    if (message.setupComplete) {
      this.#setupComplete = true;
      this.#onSetupComplete();
    }

    for (const part of message.serverContent?.modelTurn?.parts ?? []) {
      if (part.inlineData?.data) {
        this.#onTranslatedAudio(part.inlineData.data);
      }
    }
    if (message.serverContent?.generationComplete) {
      this.#onGenerationComplete();
    }
    if (message.serverContent?.turnComplete) {
      this.#onTurnComplete();
    }
    const inputText = message.serverContent?.inputTranscription?.text;
    if (typeof inputText === "string" && inputText) this.#onInputTranscription(inputText);
    const outputText = message.serverContent?.outputTranscription?.text;
    if (typeof outputText === "string" && outputText) this.#onOutputTranscription(outputText);
  }

  #listen(socket, event, handler) {
    if (typeof socket.on === "function") {
      socket.on(event, handler);
      return;
    }
    socket.addEventListener(event, (message) => {
      if (event === "message") return handler(message.data);
      if (event === "close") return handler(message.code, message.reason);
      return handler(message);
    });
  }

  #sendRealtimeSignal(name) {
    if (
      !this.#socket ||
      this.#socket.readyState !== this.#openState ||
      !this.#setupComplete
    ) {
      return false;
    }
    this.#socket.send(JSON.stringify({ realtimeInput: { [name]: {} } }));
    return true;
  }

}

function durationMilliseconds(value) {
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?s$/.test(value)) return null;
  const milliseconds = Number.parseFloat(value.slice(0, -1)) * 1_000;
  return Number.isFinite(milliseconds) ? milliseconds : null;
}
