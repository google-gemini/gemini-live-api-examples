// Gemini Multimodal Live API client
// WebSocket endpoint for BidiGenerateContent
const GEMINI_WS_URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const MODEL = "models/gemini-2.5-flash-native-audio-latest";

export interface GeminiLiveCallbacks {
  onTranscript: (text: string, isFinal: boolean) => void;
  onAudioResponse: (audio: ArrayBuffer) => void;
  onModelTurn: (text: string) => void;
  onError: (error: string) => void;
  onConnectionChange: (connected: boolean) => void;
  onInterrupted: () => void;
  onToolCall?: (toolCall: any) => void;
}

export class GeminiLiveClient {
  private isSilent: boolean = false;
  private ws: WebSocket | null = null;
  private audioContext: AudioContext | null = null;
  private audioDestination: MediaStreamAudioDestinationNode | null = null;
  private audioQueue: Float32Array[] = [];
  private isPlaying: boolean = false;
  private currentSourceNode: AudioBufferSourceNode | null = null;

  private apiKey: string;
  private systemInstruction: string;
  private callbacks: GeminiLiveCallbacks;

  private reconnectAttempts = 0;
  private maxReconnectAttempts = 3;
  private isExplicitDisconnect = false;

  constructor(apiKey: string, systemInstruction: string, callbacks: GeminiLiveCallbacks, isSilent: boolean = false) {
    this.apiKey = apiKey;
    this.systemInstruction = systemInstruction;
    this.callbacks = callbacks;
    this.isSilent = isSilent;
  }

  connect() {
    this.isExplicitDisconnect = false;
    const url = `${GEMINI_WS_URL}?key=${this.apiKey}`;
    this.ws = new WebSocket(url);

    // Initialize AudioContext and Destination Node synchronously so the caller can get the stream
    this.audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
    this.audioDestination = this.audioContext.createMediaStreamDestination();

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.isExplicitDisconnect = false;
      console.log("Gemini WS connected, sending setup...");
      // Send setup message
      const setup = {
        setup: {
          model: MODEL,
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: localStorage.getItem("gemini_agent_voice") === "male" ? "Puck" : "Aoede"
                }
              }
            }
          },
          tools: [{
            functionDeclarations: [
              {
                name: "take_picture",
                description: "Capture a high resolution image using the user's camera so you can get a crisp, clear view of what they want to show you."
              },
              {
                name: "draw_diagram",
                description: "Generate a technical architecture diagram using Mermaid syntax.",
                parameters: {
                  type: "OBJECT",
                  properties: {
                    code: {
                      type: "STRING",
                      description: "The Mermaid code for the diagram."
                    }
                  },
                  required: ["code"]
                }
              }
            ]
          }],
          systemInstruction: {
            parts: [{ text: this.systemInstruction }]
          }
        }
      };
      this.ws?.send(JSON.stringify(setup));
    };

    this.ws.onmessage = async (event) => {
      try {
        let textData = event.data;
        if (event.data instanceof Blob) {
          textData = await event.data.text();
        }
        const data = JSON.parse(textData as string);
        this.handleServerMessage(data);
      } catch (e) {
        console.error("Failed to parse Gemini message:", e);
      }
    };

    this.ws.onerror = (event) => {
      console.error("Gemini WS error:", event);
      this.callbacks.onError("WebSocket connection error. Check your API key and try again.");
    };

    this.ws.onclose = (event) => {
      console.log("Gemini WS closed:", event.code, event.reason);
      
      if (!this.isExplicitDisconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnectAttempts++;
        const delay = Math.pow(2, this.reconnectAttempts) * 1000;
        console.log(`Attempting reconnect ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms...`);
        setTimeout(() => {
          if (!this.isExplicitDisconnect) {
            this.connect();
          }
        }, delay);
      } else {
        this.callbacks.onConnectionChange(false);
      }
    };
  }

  private handleServerMessage(data: any) {
    if (data.setupComplete) {
      console.log("Gemini setup complete");
      this.callbacks.onConnectionChange(true);
      return;
    }

    if (data.serverContent) {
      const content = data.serverContent;

      if (content.interrupted) {
        this.callbacks.onInterrupted();
        this.stopAudioPlayback();
        return;
      }

      if (content.modelTurn?.parts) {
        for (const part of content.modelTurn.parts) {
          if (part.functionCall && this.callbacks.onToolCall) {
            this.callbacks.onToolCall(part.functionCall);
          }
          if (part.text) {
            this.callbacks.onModelTurn(part.text);
          }
          if (part.inlineData?.data && !this.isSilent) {
            const audioBytes = this.base64ToArrayBuffer(part.inlineData.data);
            this.callbacks.onAudioResponse(audioBytes);
            this.enqueueAudio(audioBytes);
          }
        }
      }

      if (content.turnComplete) {
        console.log("Turn complete");
      }
    }

    if (data.toolCall) {
      const toolCall = data.toolCall;
      if (toolCall.functionCalls) {
        for (const call of toolCall.functionCalls) {
          if (this.callbacks.onToolCall) {
            this.callbacks.onToolCall(call);
          }
        }
      }
    }
  }

  // Send real-time audio input (PCM 16kHz 16-bit LE, base64)
  sendAudio(pcmBase64: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const message = {
      realtimeInput: {
        mediaChunks: [{
          mimeType: "audio/pcm;rate=16000",
          data: pcmBase64
        }]
      }
    };
    this.ws.send(JSON.stringify(message));
  }

  // Send real-time video frame (JPEG base64)
  sendVideo(jpegBase64: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const message = {
      realtimeInput: {
        mediaChunks: [{
          mimeType: "image/jpeg",
          data: jpegBase64
        }]
      }
    };
    this.ws.send(JSON.stringify(message));
  }

  // Send text input
  sendText(text: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const message = {
      clientContent: {
        turns: [{
          role: "user",
          parts: [{ text }]
        }],
        turnComplete: true
      }
    };
    this.ws.send(JSON.stringify(message));
  }

  // Send content input (generic parts)
  sendContent(parts: any[]) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const message = {
      clientContent: {
        turns: [{
          role: "user",
          parts: parts
        }],
        turnComplete: true
      }
    };
    this.ws.send(JSON.stringify(message));
  }

  // Send tool response
  sendToolResponse(functionResponses: { id: string, name: string, response: any }[]) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const message = {
      toolResponse: {
        functionResponses: functionResponses.map(resp => ({
          id: resp.id,
          name: resp.name,
          response: resp.response
        }))
      }
    };
    this.ws.send(JSON.stringify(message));
  }

  disconnect() {
    this.isExplicitDisconnect = true;
    this.stopAudioPlayback();
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      try {
        this.ws.close();
      } catch (err) {
        console.warn("Error closing WebSocket:", err);
      }
      this.ws = null;
    }
    if (this.audioContext) {
      try {
        this.audioContext.close();
      } catch (err) {
        console.warn("Error closing AudioContext:", err);
      }
      this.audioContext = null;
    }
    this.audioDestination = null;
    this.audioQueue = [];
  }

  // Audio playback
  private async enqueueAudio(pcmData: ArrayBuffer) {
    if (!this.audioContext) {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
      this.audioDestination = this.audioContext.createMediaStreamDestination();
    }

    // Convert PCM 16-bit LE to Float32
    const int16 = new Int16Array(pcmData);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768.0;
    }
    this.audioQueue.push(float32);

    if (!this.isPlaying) {
      this.playNextChunk();
    }
  }

  private playNextChunk() {
    if (this.audioQueue.length === 0) {
      this.isPlaying = false;
      return;
    }

    this.isPlaying = true;
    const chunk = this.audioQueue.shift()!;

    if (!this.audioContext) return;

    const buffer = this.audioContext.createBuffer(1, chunk.length, 24000);
    buffer.copyToChannel(new Float32Array(chunk) as Float32Array<ArrayBuffer>, 0);

    const source = this.audioContext.createBufferSource();
    source.buffer = buffer;
    
    // Connect to both speakers AND the recording destination
    source.connect(this.audioContext.destination);
    if (this.audioDestination) {
      source.connect(this.audioDestination);
    }
    
    source.onended = () => this.playNextChunk();
    source.start();
    this.currentSourceNode = source;
  }

  getAudioStream(): MediaStream | null {
    return this.audioDestination ? this.audioDestination.stream : null;
  }

  public stopAudioPlayback() {
    this.audioQueue = [];
    if (this.currentSourceNode) {
      try { this.currentSourceNode.stop(); } catch {}
      this.currentSourceNode = null;
    }
    this.isPlaying = false;
  }

  private base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }
}

export interface AudioCaptureCallbacks {
  onChunk: (base64Pcm: string) => void;
  onSpeechDetected?: () => void;
}

// Audio capture utility — captures microphone as PCM 16kHz 16-bit LE chunks via modern AudioWorkletNode
export class AudioCapture {
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private callbacks: AudioCaptureCallbacks;

  constructor(callbacks: AudioCaptureCallbacks | ((base64Pcm: string) => void)) {
    if (typeof callbacks === "function") {
      this.callbacks = { onChunk: callbacks };
    } else {
      this.callbacks = callbacks;
    }
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true }
    });

    this.audioContext = new AudioContext({ sampleRate: 16000 });

    // Dynamic inline AudioWorklet registration to bypass static file imports and bundle constraints
    const workletCode = `
      class PCMProcessor extends AudioWorkletProcessor {
        constructor() {
          super();
          this.speechFramesCount = 0;
          this.threshold = 0.015; // RMS voice activity threshold
        }

        process(inputs, outputs, parameters) {
          const input = inputs[0];
          if (input && input[0]) {
            const channelData = input[0]; // Float32Array
            
            // Calculate Root Mean Square (RMS) amplitude for local VAD
            let sum = 0;
            for (let i = 0; i < channelData.length; i++) {
              sum += channelData[i] * channelData[i];
            }
            const rms = Math.sqrt(sum / channelData.length);
            
            // If RMS exceeds threshold for ~100ms (3 frames @ 4096 size)
            if (rms > this.threshold) {
              this.speechFramesCount++;
              if (this.speechFramesCount >= 3) {
                this.port.postMessage({ type: "speech_detected" });
              }
            } else {
              this.speechFramesCount = 0;
            }

            // Convert Float32 to Int16 PCM
            const pcm = new Int16Array(channelData.length);
            for (let i = 0; i < channelData.length; i++) {
              const s = Math.max(-1, Math.min(1, channelData[i]));
              pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
            }
            this.port.postMessage({ type: "pcm_chunk", buffer: pcm.buffer }, [pcm.buffer]);
          }
          return true;
        }
      }
      registerProcessor('pcm-worklet-processor', PCMProcessor);
    `;

    const blob = new Blob([workletCode], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    await this.audioContext.audioWorklet.addModule(url);
    URL.revokeObjectURL(url); // Immediate cleanup

    const source = this.audioContext.createMediaStreamSource(this.stream);

    this.workletNode = new AudioWorkletNode(this.audioContext, "pcm-worklet-processor");
    this.workletNode.port.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === "speech_detected") {
        if (this.callbacks.onSpeechDetected) {
          this.callbacks.onSpeechDetected();
        }
      } else if (msg.type === "pcm_chunk") {
        const pcmBuffer = msg.buffer as ArrayBuffer;
        const bytes = new Uint8Array(pcmBuffer);
        let binary = "";
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        this.callbacks.onChunk(btoa(binary));
      }
    };

    source.connect(this.workletNode);
    this.workletNode.connect(this.audioContext.destination);
  }

  stop() {
    if (this.workletNode) {
      this.workletNode.disconnect();
      this.workletNode = null;
    }
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
  }
}
