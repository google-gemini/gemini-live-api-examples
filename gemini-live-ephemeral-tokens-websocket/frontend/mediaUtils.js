/**
 * Media Utilities - Audio and Video streaming helpers for Gemini Live API
 * Handles media capture, processing, and playback
 */

/**
 * Audio Streamer - Captures and streams microphone audio
 */
class AudioStreamer {
  constructor(geminiClient) {
    this.client = geminiClient;
    this.audioContext = null;
    this.audioWorklet = null;
    this.mediaStream = null;
    this.audioSource = null;
    this.isStreaming = false;
    this.sampleRate = 16000; // Gemini requires 16kHz
  }

  /**
   * Start streaming audio from microphone
   * @param {string} deviceId - Optional device ID for specific microphone
   */
  async start(deviceId = null) {
    if (this.isStreaming) {
      return;
    }
    try {
      // Build audio constraints
      const audioConstraints = {
        sampleRate: this.sampleRate,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      };

      // Add device ID if specified
      if (deviceId) {
        audioConstraints.deviceId = { exact: deviceId };
      }

      // Get microphone access
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
      });

      // Create audio context at 16kHz if it doesn't exist
      if (!this.audioContext) {
        this.audioContext = new (window.AudioContext ||
          window.webkitAudioContext)({
          sampleRate: this.sampleRate,
        });

        // Load the audio worklet module
        await this.audioContext.audioWorklet.addModule(
          "audio-processors/capture.worklet.js"
        );

        // Create the audio worklet node
        this.audioWorklet = new AudioWorkletNode(
          this.audioContext,
          "audio-capture-processor"
        );

        // Set up message handling from the worklet
        this.audioWorklet.port.onmessage = (event) => {
          if (!this.isStreaming) return;

          if (event.data.type === "audio") {
            const inputData = event.data.data;
            const pcmData = this.convertToPCM16(inputData);
            const base64Audio = this.arrayBufferToBase64(pcmData);

            // Send to Gemini
            if (this.client && this.client.connected) {
              this.client.sendAudioMessage(base64Audio);
            }
          }
        };
      }

      // Ensure the context is running (it might be suspended by the browser or by us in stop())
      if (this.audioContext.state === "suspended") {
        await this.audioContext.resume();
      }

      // Connect the audio graph
      this.audioSource = this.audioContext.createMediaStreamSource(
        this.mediaStream
      );
      this.audioSource.connect(this.audioWorklet);

      this.isStreaming = true;
      console.log("🎤 Audio streaming started");
      return true;
    } catch (error) {
      console.error("Failed to start audio streaming:", error);
      throw error;
    }
  }

  /**
   * Stop audio streaming
   */
  stop() {
    this.isStreaming = false;

    if (this.audioSource) {
      this.audioSource.disconnect();
      this.audioSource = null;
    }

    if (this.audioContext && this.audioContext.state === "running") {
      this.audioContext.suspend();
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }

    console.log("🛑 Audio streaming stopped");
  }

  /**
   * Clean up resources
   */
  destroy() {
    this.stop();
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
  }

  /**
   * Convert Float32Array to PCM16 Int16Array
   */
  convertToPCM16(float32Array) {
    const int16Array = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
      const sample = Math.max(-1, Math.min(1, float32Array[i]));
      int16Array[i] = sample * 0x7fff;
    }
    return int16Array.buffer;
  }

  /**
   * Convert ArrayBuffer to base64
   */
  arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
  }
}

/**
 * Base Video Capture - Shared functionality for video/screen capture
 */
class BaseVideoCapture {
  constructor(geminiClient) {
    this.client = geminiClient;
    this.video = null;
    this.canvas = null;
    this.ctx = null;
    this.mediaStream = null;
    this.isStreaming = false;
    this.captureInterval = null;
    this.fps = 1; // Default 1 frame per second
    this.quality = 0.8; // Default JPEG quality
  }

  /**
   * Initialize canvas and video elements
   */
  initializeElements(width, height) {
    // Create video element
    this.video = document.createElement("video");
    this.video.srcObject = this.mediaStream;
    this.video.autoplay = true;
    this.video.playsInline = true;
    this.video.muted = true;

    // Create canvas for frame capture
    this.canvas = document.createElement("canvas");
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx = this.canvas.getContext("2d");
  }

  /**
   * Wait for video to be ready and start playing
   */
  async waitForVideoReady() {
    await new Promise((resolve) => {
      this.video.onloadedmetadata = resolve;
    });
    this.video.play();
  }

  /**
   * Start capturing and sending frames
   */
  startCapturing() {
    const captureFrame = () => {
      if (!this.isStreaming) return;

      // Draw current frame to canvas
      this.ctx.drawImage(
        this.video,
        0,
        0,
        this.canvas.width,
        this.canvas.height
      );

      // Convert to JPEG and send
      this.canvas.toBlob(
        (blob) => {
          if (!blob) return;

          const reader = new FileReader();
          reader.onloadend = () => {
            const base64 = reader.result.split(",")[1];
            if (this.client && this.client.connected) {
              this.client.sendImageMessage(base64, "image/jpeg");
            }
          };
          reader.readAsDataURL(blob);
        },
        "image/jpeg",
        this.quality
      );
    };

    // Start interval
    this.captureInterval = setInterval(captureFrame, 1000 / this.fps);
  }

  /**
   * Stop capturing
   */
  stop() {
    this.isStreaming = false;

    if (this.captureInterval) {
      clearInterval(this.captureInterval);
      this.captureInterval = null;
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }

    if (this.video) {
      this.video.srcObject = null;
      this.video = null;
    }

    this.canvas = null;
    this.ctx = null;
  }

  /**
   * Take a single snapshot
   */
  takeSnapshot() {
    if (!this.video || !this.canvas) {
      throw new Error("Video not initialized");
    }

    this.ctx.drawImage(
      this.video,
      0,
      0,
      this.canvas.width,
      this.canvas.height
    );
    return this.canvas.toDataURL("image/jpeg", this.quality);
  }

  /**
   * Get the video element for preview
   */
  getVideoElement() {
    return this.video;
  }
}

/**
 * Video Streamer - Captures and streams camera video
 */
class VideoStreamer extends BaseVideoCapture {
  /**
   * Start video streaming from camera
   * @param {Object} options - { fps: number, width: number, height: number, facingMode: string, quality: number, deviceId: string }
   */
  async start(options = {}) {
    try {
      const {
        fps = 1,
        width = 640,
        height = 480,
        facingMode = "user", // 'user' for front camera, 'environment' for back
        quality = 0.8,
        deviceId = null,
      } = options;

      this.fps = fps;
      this.quality = quality;

      // Build video constraints
      const videoConstraints = {
        width: { ideal: width },
        height: { ideal: height },
      };

      // Add device ID if specified, otherwise use facingMode
      if (deviceId) {
        videoConstraints.deviceId = { exact: deviceId };
      } else {
        videoConstraints.facingMode = facingMode;
      }

      // Get camera access
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        video: videoConstraints,
      });

      // Initialize video and canvas elements
      this.initializeElements(width, height);

      // Wait for video to be ready
      await this.waitForVideoReady();

      // Start capturing frames
      this.isStreaming = true;
      this.startCapturing();

      console.log("📹 Camera streaming started at", fps, "fps");
      return this.video; // Return video element for preview
    } catch (error) {
      console.error("Failed to start camera streaming:", error);
      throw error;
    }
  }

  stop() {
    super.stop();
    console.log("🛑 Camera streaming stopped");
  }
}

/**
 * Screen Capture - Captures and streams screen/window
 */
class ScreenCapture extends BaseVideoCapture {
  /**
   * Start screen capture
   * @param {Object} options - { fps: number, width: number, height: number, quality: number }
   */
  async start(options = {}) {
    try {
      const {
        fps = 1,
        width = 1280,
        height = 720,
        quality = 0.7
      } = options;

      this.fps = fps;
      this.quality = quality;

      // Get screen capture permission
      this.mediaStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: width },
          height: { ideal: height },
        },
        audio: false,
      });

      // Initialize video and canvas elements
      this.initializeElements(width, height);

      // Wait for video to be ready
      await this.waitForVideoReady();

      // Start capturing frames
      this.isStreaming = true;
      this.startCapturing();

      // Handle stream end (user stops sharing)
      this.mediaStream.getVideoTracks()[0].onended = () => {
        console.log("User stopped screen sharing");
        this.stop();
      };

      console.log("🖥️ Screen capture started at", fps, "fps");
      return this.video; // Return video element for preview
    } catch (error) {
      console.error("Failed to start screen capture:", error);
      throw error;
    }
  }

  stop() {
    super.stop();
    console.log("🛑 Screen capture stopped");
  }
}

/**
 * Audio Player - Plays audio responses from Gemini
 */
class AudioPlayer {
  constructor() {
    this.audioContext = null;
    this.workletNode = null;
    this.gainNode = null;
    this.isInitialized = false;
    this.initPromise = null;
    this.volume = 1.0;
    this.sampleRate = 24000; // Gemini outputs at 24kHz
  }

  /**
   * Initialize the audio player
   */
  async init() {
    if (this.isInitialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        // Create audio context at 24kHz to match Gemini
        this.audioContext = new (window.AudioContext ||
          window.webkitAudioContext)({
          sampleRate: this.sampleRate,
        });

        // Resume immediately since we are in a user-initiated gesture
        if (this.audioContext.state === "suspended") {
          await this.audioContext.resume();
        }

        // Load the audio worklet from external file
        await this.audioContext.audioWorklet.addModule(
          "audio-processors/playback.worklet.js"
        );

        // Create worklet node
        this.workletNode = new AudioWorkletNode(
          this.audioContext,
          "pcm-processor"
        );

        // Create gain node for volume control
        this.gainNode = this.audioContext.createGain();
        this.gainNode.gain.value = this.volume;

        // Connect nodes
        this.workletNode.connect(this.gainNode);
        this.gainNode.connect(this.audioContext.destination);

        this.isInitialized = true;
        console.log("🔊 Audio player initialized");
      } catch (error) {
        console.error("Failed to initialize audio player:", error);
        this.initPromise = null;
        throw error;
      }
    })();

    return this.initPromise;
  }

  /**
   * Play audio chunk from base64 PCM
   */
  async play(base64Audio) {
    if (!this.isInitialized) {
      await this.init();
    }

    try {
      // Resume audio context if suspended
      if (this.audioContext.state === "suspended") {
        await this.audioContext.resume();
      }

      // Efficient base64 → binary decode
      const binaryString = atob(base64Audio);
      const len = binaryString.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      // Convert PCM16 LE to Float32
      const inputArray = new Int16Array(bytes.buffer);
      const float32Data = new Float32Array(inputArray.length);
      for (let i = 0; i < inputArray.length; i++) {
        float32Data[i] = inputArray[i] / 32768;
      }

      // Send to worklet for playback
      this.workletNode.port.postMessage(float32Data);
    } catch (error) {
      console.error("Error playing audio chunk:", error);
      throw error;
    }
  }

  /**
   * Interrupt current playback
   */
  interrupt() {
    if (this.workletNode) {
      this.workletNode.port.postMessage("interrupt");
    }
  }

  /**
   * Set volume (0.0 to 1.0)
   */
  setVolume(volume) {
    this.volume = Math.max(0, Math.min(1, volume));
    if (this.gainNode) {
      this.gainNode.gain.value = this.volume;
    }
  }

  /**
   * Clean up resources
   */
  destroy() {
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
    this.isInitialized = false;
    this.initPromise = null;
  }
}