/**
 * GeminiClient: Handles WebSocket communication
 */
class GeminiClient {
  constructor(config) {
    this.websocket = null;
    this.onOpen = config.onOpen;
    this.onMessage = config.onMessage;
    this.onClose = config.onClose;
    this.onError = config.onError;
  }

  connect(apiKey) {
    this.apiKey = apiKey;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    this.websocket = new WebSocket(wsUrl);
    this.websocket.binaryType = "arraybuffer";

    this.websocket.onopen = () => {
      // BYO key: the visitor's key MUST be the very first frame. The backend
      // reads it before building the Gemini client and the memory sink, and
      // rejects the connection if it's missing. WS preserves order, so this
      // lands before the intro text the onOpen callback sends next.
      this.websocket.send(
        JSON.stringify({ type: "setup", api_key: this.apiKey })
      );
      if (this.onOpen) this.onOpen();
    };

    this.websocket.onmessage = (event) => {
      if (this.onMessage) this.onMessage(event);
    };

    this.websocket.onclose = (event) => {
      if (this.onClose) this.onClose(event);
    };

    this.websocket.onerror = (event) => {
      if (this.onError) this.onError(event);
    };
  }

  send(data) {
    if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
      this.websocket.send(data);
    }
  }

  sendText(text) {
    this.send(JSON.stringify({ text: text }));
  }

  sendImage(base64Data, mimeType = "image/jpeg") {
    this.send(
      JSON.stringify({
        type: "image",
        mime_type: mimeType,
        data: base64Data,
      })
    );
  }

  disconnect() {
    if (this.websocket) {
      this.websocket.close();
      this.websocket = null;
    }
  }

  isConnected() {
    return this.websocket && this.websocket.readyState === WebSocket.OPEN;
  }
}
