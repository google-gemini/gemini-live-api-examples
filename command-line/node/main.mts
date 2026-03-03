import { GoogleGenAI, Modality, type LiveServerMessage } from '@google/genai';
import mic from 'mic';
import Speaker from 'speaker';

const ai = new GoogleGenAI({});
// WARNING: Do not use API keys in client-side (browser based) applications
// Consider using Ephemeral Tokens instead
// More information at: https://ai.google.dev/gemini-api/docs/ephemeral-tokens

// --- Live API config ---
const model = 'gemini-2.5-flash-native-audio-preview-12-2025';
const config = {
  responseModalities: [Modality.AUDIO],
  systemInstruction: "You are a helpful and friendly AI assistant.",
};

async function live() {
  const responseQueue: LiveServerMessage[] = [];
  const audioQueue: Buffer[] = [];
  let speaker: Speaker | null = null;

  async function waitMessage(): Promise<LiveServerMessage> {
    while (responseQueue.length === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return responseQueue.shift()!;
  }

  function createSpeaker() {
    if (speaker) {
      process.stdin.unpipe(speaker);
      speaker.end();
    }
    speaker = new Speaker({
      channels: 1,
      bitDepth: 16,
      sampleRate: 24000,
    });
    speaker.on('error', (err: Error) => console.error('Speaker error:', err));
    process.stdin.pipe(speaker);
  }

  async function messageLoop() {
    // Puts incoming messages in the audio queue.
    while (true) {
      const message = await waitMessage();
      if (message.serverContent && message.serverContent.interrupted) {
        // Empty the queue on interruption to stop playback
        audioQueue.length = 0;
        continue;
      }
      if (message.serverContent && message.serverContent.modelTurn && message.serverContent.modelTurn.parts) {
        for (const part of message.serverContent.modelTurn.parts) {
          if (part.inlineData && part.inlineData.data) {
            audioQueue.push(Buffer.from(part.inlineData.data, 'base64'));
          }
        }
      }
    }
  }

  async function playbackLoop() {
    // Plays audio from the audio queue.
    while (true) {
      if (audioQueue.length === 0) {
        if (speaker) {
          // Destroy speaker if no more audio to avoid warnings from speaker library
          process.stdin.unpipe(speaker);
          speaker.end();
          speaker = null;
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      } else {
        if (!speaker) createSpeaker();
        const chunk = audioQueue.shift()!;
        await new Promise<void>((resolve) => {
          speaker!.write(chunk, () => resolve());
        });
      }
    }
  }

  // Start loops
  messageLoop();
  playbackLoop();

  // Connect to Gemini Live API
  const session = await ai.live.connect({
    model: model,
    config: config,
    callbacks: {
      onopen: () => console.log('Connected to Gemini Live API'),
      onmessage: (message: LiveServerMessage) => responseQueue.push(message),
      onerror: (e: ErrorEvent) => console.error('Error:', e.message),
      onclose: (e: CloseEvent) => console.log('Closed:', e.reason),
    },
  });

  // Setup Microphone for input
  const micInstance = mic({
    rate: '16000',
    bitwidth: '16',
    channels: '1',
  });
  const micInputStream = micInstance.getAudioStream();

  micInputStream.on('data', (data: Buffer) => {
    // API expects base64 encoded PCM data
    session.sendRealtimeInput({
      audio: {
        data: data.toString('base64'),
        mimeType: "audio/pcm;rate=16000"
      }
    });
  });

  micInputStream.on('error', (err: Error) => {
    console.error('Microphone error:', err);
  });

  micInstance.start();
  console.log('Microphone started. Speak now...');
}

live().catch(console.error);