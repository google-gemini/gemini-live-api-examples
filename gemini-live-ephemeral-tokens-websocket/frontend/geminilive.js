/**
 * Gemini Live API Utilities
 * Based on multimodalLiveApi.ts - converted to JavaScript
 */

// Response type constants
const MultimodalLiveResponseType = {
  TEXT: "TEXT",
  AUDIO: "AUDIO",
  SETUP_COMPLETE: "SETUP COMPLETE",
  INTERRUPTED: "INTERRUPTED",
  TURN_COMPLETE: "TURN COMPLETE",
  TOOL_CALL: "TOOL_CALL",
  ERROR: "ERROR",
  INPUT_TRANSCRIPTION: "INPUT_TRANSCRIPTION",
  OUTPUT_TRANSCRIPTION: "OUTPUT_TRANSCRIPTION",
};

/**
 * Parses response messages from the Gemini Live API
 */
/**
 * Parses ALL response types from a single server message.
 * The server can now bundle multiple fields (e.g. audio + transcription)
 * in the same message. Returns an array of response objects.
 */
function parseResponseMessages(data) {
  const responses = [];
  const serverContent = data?.serverContent;
  const parts = serverContent?.modelTurn?.parts;

  try {
    // Setup complete (exclusive — no other fields expected)
    if (data?.setupComplete) {
      console.log("🏁 SETUP COMPLETE response", data);
      responses.push({ type: MultimodalLiveResponseType.SETUP_COMPLETE, data: "", endOfTurn: false });
      return responses;
    }

    // Tool call (exclusive)
    if (data?.toolCall) {
      console.log("🎯 🛠️ TOOL CALL response", data?.toolCall);
      responses.push({ type: MultimodalLiveResponseType.TOOL_CALL, data: data.toolCall, endOfTurn: false });
      return responses;
    }

    // Audio data from model turn parts
    if (parts?.length) {
      for (const part of parts) {
        if (part.inlineData) {
          responses.push({ type: MultimodalLiveResponseType.AUDIO, data: part.inlineData.data, endOfTurn: false });
        } else if (part.text) {
          console.log("💬 TEXT response", part.text);
          responses.push({ type: MultimodalLiveResponseType.TEXT, data: part.text, endOfTurn: false });
        }
      }
    }

    // Transcriptions — checked independently, NOT in else-if with audio
    if (serverContent?.inputTranscription) {
      responses.push({
        type: MultimodalLiveResponseType.INPUT_TRANSCRIPTION,
        data: {
          text: serverContent.inputTranscription.text || "",
          finished: serverContent.inputTranscription.finished || false,
        },
        endOfTurn: false,
      });
    }

    if (serverContent?.outputTranscription) {
      responses.push({
        type: MultimodalLiveResponseType.OUTPUT_TRANSCRIPTION,
        data: {
          text: serverContent.outputTranscription.text || "",
          finished: serverContent.outputTranscription.finished || false,
        },
        endOfTurn: false,
      });
    }

    // Interrupted
    if (serverContent?.interrupted) {
      console.log("🗣️ INTERRUPTED response");
      responses.push({ type: MultimodalLiveResponseType.INTERRUPTED, data: "", endOfTurn: false });
    }

    // Turn complete
    if (serverContent?.turnComplete) {
      console.log("🏁 TURN COMPLETE response");
      responses.push({ type: MultimodalLiveResponseType.TURN_COMPLETE, data: "", endOfTurn: true });
    }
  } catch (err) {
    console.log("⚠️ Error parsing response data: ", err, data);
  }

  return responses;
}

/**
 * Function call definition for tool use
 */
class FunctionCallDefinition {
  /**
   * @param {string} name
   * @param {string} description
   * @param {object} parameters  - JSON Schema object
   * @param {string[]} requiredParameters
   * @param {string|null} behavior - Optional. "NON_BLOCKING" to run the function
   *   asynchronously (the model keeps talking while it waits for the result).
   *   Leave null/undefined for default blocking behaviour.
   */
  constructor(name, description, parameters, requiredParameters, behavior = null) {
    this.name = name;
    this.description = description;
    this.parameters = parameters;
    this.requiredParameters = requiredParameters;
    this.behavior = behavior; // "NON_BLOCKING" | null
  }

  functionToCall(parameters) {
    console.log("▶️Default function call");
  }

  getDefinition() {
    const definition = {
      name: this.name,
      description: this.description,
      parameters: { required: this.requiredParameters, ...this.parameters },
    };
    // Include behavior field when set — required by the Live API for NON_BLOCKING tools
    if (this.behavior) {
      definition.behavior = this.behavior;
    }
    console.log("created FunctionDefinition: ", definition);
    return definition;
  }

  async runFunction(parameters) {
    console.log(
      `⚡ Running ${this.name} function with parameters: ${JSON.stringify(
        parameters
      )}`
    );
    return await this.functionToCall(parameters);
  }
}

/**
 * Main Gemini Live API client
 */
class GeminiLiveAPI {
  constructor(token, model) {
    this.token = token;
    this.model = model;
    this.modelUri = `models/${this.model}`;

    this.responseModalities = ["AUDIO"];
    this.systemInstructions = "";
    this.googleGrounding = false;
    this.voiceName = "Puck"; // Default voice
    this.thinkingLevel = "minimal"; // Default thinking level
    this.temperature = 1.0; // Default temperature
    this.inputAudioTranscription = false;
    this.outputAudioTranscription = false;
    this.enableFunctionCalls = false;
    this.functions = [];
    this.functionsMap = {};
    this.previousImage = null;
    this.totalBytesSent = 0;

    // Automatic activity detection settings with defaults
    this.automaticActivityDetection = {
      disabled: false,
      silence_duration_ms: 2000,
      prefix_padding_ms: 500,
      end_of_speech_sensitivity: "END_SENSITIVITY_UNSPECIFIED",
      start_of_speech_sensitivity: "START_SENSITIVITY_UNSPECIFIED",
    };

    this.activityHandling = "ACTIVITY_HANDLING_UNSPECIFIED";

    this.serviceUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=${this.token}`;
    console.log("Service URL (v1beta): ", this.serviceUrl);

    this.connected = false;
    this.webSocket = null;
    this.lastSetupMessage = null; // Store the last setup message

    // Default callbacks
    this.onReceiveResponse = (message) => {
      console.log("Default message received callback", message);
    };

    this.onOpen = () => {
      console.log("Default onOpen");
    };

    this.onClose = () => {
      console.log("Default onClose");
    };

    this.onError = (message) => {
      alert(message);
      this.connected = false;
    };

    console.log("Created Gemini Live API object: ", this);
  }

  setProjectId(projectId) {
    // No longer needed for Gemini API
  }

  setSystemInstructions(newSystemInstructions) {
    console.log("setting system instructions: ", newSystemInstructions);
    this.systemInstructions = newSystemInstructions;
  }

  setGoogleGrounding(newGoogleGrounding) {
    console.log("setting google grounding: ", newGoogleGrounding);
    this.googleGrounding = newGoogleGrounding;
  }

  setResponseModalities(modalities) {
    this.responseModalities = modalities;
  }

  setVoice(voiceName) {
    console.log("setting voice: ", voiceName);
    this.voiceName = voiceName;
  }



  setInputAudioTranscription(enabled) {
    console.log("setting input audio transcription: ", enabled);
    this.inputAudioTranscription = enabled;
  }

  setOutputAudioTranscription(enabled) {
    console.log("setting output audio transcription: ", enabled);
    this.outputAudioTranscription = enabled;
  }

  setEnableFunctionCalls(enabled) {
    console.log("setting enable function calls: ", enabled);
    this.enableFunctionCalls = enabled;
  }

  addFunction(newFunction) {
    this.functions.push(newFunction);
    this.functionsMap[newFunction.name] = newFunction;
    console.log("added function: ", newFunction);
  }

  async callFunction(functionName, parameters) {
    const functionToCall = this.functionsMap[functionName];
    return await functionToCall.runFunction(parameters);
  }

  connect() {
    this.setupWebSocketToService();
  }

  disconnect() {
    if (this.webSocket) {
      this.webSocket.close();
      this.connected = false;
    }
  }

  sendMessage(message) {
    if (this.webSocket && this.webSocket.readyState === WebSocket.OPEN) {
      this.webSocket.send(JSON.stringify(message));
    }
  }

  async onReceiveMessage(messageEvent) {
    let jsonData;
    if (messageEvent.data instanceof Blob) {
      jsonData = await messageEvent.data.text();
    } else if (messageEvent.data instanceof ArrayBuffer) {
      jsonData = new TextDecoder().decode(messageEvent.data);
    } else {
      jsonData = messageEvent.data;
    }

    try {
      const messageData = JSON.parse(jsonData);
      // Parse all response types from this message (audio + transcription can coexist)
      const responses = parseResponseMessages(messageData);
      for (const response of responses) {
        this.onReceiveResponse(response);
      }
    } catch (err) {
      console.error("Error parsing JSON message:", err, jsonData);
    }
  }

  setupWebSocketToService() {
    console.log("connecting directly to: ", this.serviceUrl);

    this.webSocket = new WebSocket(this.serviceUrl);

    this.webSocket.onclose = (event) => {
      console.log("websocket closed: ", event);
      this.connected = false;
      this.onClose();
    };

    this.webSocket.onerror = (event) => {
      console.log("websocket error: ", event);
      this.connected = false;
      this.onError("Connection error");
    };

    this.webSocket.onopen = (event) => {
      console.log("websocket open: ", event);
      this.connected = true;
      this.totalBytesSent = 0;
      this.sendInitialSetupMessages();
      this.onOpen();
    };

    this.webSocket.onmessage = this.onReceiveMessage.bind(this);
  }

  getFunctionDefinitions() {
    console.log("🛠️ getFunctionDefinitions called");
    const tools = [];

    for (let index = 0; index < this.functions.length; index++) {
      const func = this.functions[index];
      tools.push(func.getDefinition());
    }
    return tools;
  }

  sendInitialSetupMessages() {
    const tools = this.getFunctionDefinitions();

    const sessionSetupMessage = {
      setup: {
        model: this.modelUri,
        generationConfig: {
          responseModalities: this.responseModalities,
          temperature: this.temperature,
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: this.voiceName,
              },
            },
          },
          thinkingConfig: {
            thinkingLevel: this.thinkingLevel,
          },
        },
        systemInstruction: { parts: [{ text: this.systemInstructions }] },
        tools: [{ functionDeclarations: tools }],


        realtimeInputConfig: {
          automaticActivityDetection: {
            disabled: this.automaticActivityDetection.disabled,
            silenceDurationMs: this.automaticActivityDetection.silence_duration_ms,
            prefixPaddingMs: this.automaticActivityDetection.prefix_padding_ms,
            endOfSpeechSensitivity: this.automaticActivityDetection.end_of_speech_sensitivity,
            startOfSpeechSensitivity: this.automaticActivityDetection.start_of_speech_sensitivity,
          },
          activityHandling: this.activityHandling,
          turnCoverage: "TURN_INCLUDES_ONLY_ACTIVITY",
        },
      },
    };

    // Add transcription config if enabled
    if (this.inputAudioTranscription) {
      sessionSetupMessage.setup.inputAudioTranscription = {};
    }
    if (this.outputAudioTranscription) {
      sessionSetupMessage.setup.outputAudioTranscription = {};
    }

    if (this.googleGrounding) {
      // Currently can't have both Google Search with custom tools.
      console.log(
        "Google Grounding enabled, removing custom function calls if any."
      );
      sessionSetupMessage.setup.tools = [{ googleSearch: {} }];
    }



    // Store the setup message for later access
    this.lastSetupMessage = sessionSetupMessage;

    console.log("sessionSetupMessage: ", sessionSetupMessage);
    this.sendMessage(sessionSetupMessage);
  }

  sendTextMessage(text) {
    const message = {
      realtimeInput: {
        text: text,
      },
    };
    this.sendMessage(message);
  }

  sendClientContentMessage(text, turnComplete = true) {
    const message = {
      clientContent: {
        turns: [
          {
            role: "user",
            parts: [
              {
                text: text,
              },
            ],
          },
        ],
        turnComplete: turnComplete,
      },
    };
    this.sendMessage(message);
  }

  sendToolResponse(functionResponses) {
    const message = {
      toolResponse: {
        functionResponses: functionResponses,
      },
    };
    console.log("🔧 Sending tool response:", message);
    this.sendMessage(message);
  }

  sendRealtimeInputMessage(data, mimeType) {
    const blob = { mimeType, data };
    const message = { realtimeInput: {} };

    if (mimeType.startsWith("audio/")) {
      message.realtimeInput.audio = blob;
    } else if (mimeType.startsWith("image/") || mimeType.startsWith("video/")) {
      message.realtimeInput.video = blob;
    }

    this.sendMessage(message);
    this.addToBytesSent(data);
  }

  addToBytesSent(data) {
    const encoder = new TextEncoder();
    const encodedData = encoder.encode(data);
    this.totalBytesSent += encodedData.length;
  }

  getBytesSent() {
    return this.totalBytesSent;
  }

  sendAudioMessage(base64PCM) {
    this.sendRealtimeInputMessage(base64PCM, "audio/pcm");
  }

  async sendImageMessage(base64Image, mimeType = "image/jpeg") {
    this.sendRealtimeInputMessage(base64Image, mimeType);
  }
}

console.log("loaded geminiLiveApi.js");
