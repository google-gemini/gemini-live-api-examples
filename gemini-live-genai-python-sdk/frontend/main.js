// --- Main Application Logic ---

const statusDiv = document.getElementById("status");
const authSection = document.getElementById("auth-section");
const appSection = document.getElementById("app-section");
const sessionEndSection = document.getElementById("session-end-section");
const restartBtn = document.getElementById("restartBtn");
const micBtn = document.getElementById("micBtn");
const cameraBtn = document.getElementById("cameraBtn");
const screenBtn = document.getElementById("screenBtn");
const disconnectBtn = document.getElementById("disconnectBtn");
const textInput = document.getElementById("textInput");
const sendBtn = document.getElementById("sendBtn");
const videoPreview = document.getElementById("video-preview");
const videoPlaceholder = document.getElementById("video-placeholder");
const connectBtn = document.getElementById("connectBtn");
const apiKeyInput = document.getElementById("apiKeyInput");
const chatLog = document.getElementById("chat-log");
const modelFeed = document.getElementById("model-feed");
const modelFrame = document.getElementById("model-frame");
const modelFeedStats = document.getElementById("model-feed-stats");
const memoryFeedList = document.getElementById("memory-feed-list");
const memoryFeedCount = document.getElementById("memory-feed-count");

let currentGeminiMessageDiv = null;
let currentUserMessageDiv = null;
let modelFrameCount = 0;
let memoryCount = 0;
// BYO key: set when the backend rejects the connection (missing/invalid key) so
// onClose returns to the auth panel with the error instead of "Session Ended".
let sessionError = null;

// --- BYO Gemini key (mandatory) ----------------------------------------------
// The visitor's key gates Connect, persists in localStorage (paste-once), and is
// sent as the first WebSocket frame. It never leaves the browser except to start
// the session, and is never written to our server's disk.
const STORED_KEY_NAME = "geminiApiKey";
function syncConnectEnabled() {
  connectBtn.disabled = !apiKeyInput.value.trim();
}
apiKeyInput.value = localStorage.getItem(STORED_KEY_NAME) || "";
syncConnectEnabled();
apiKeyInput.oninput = () => {
  localStorage.setItem(STORED_KEY_NAME, apiKeyInput.value.trim());
  syncConnectEnabled();
};

// Observation type -> emoji, matching the worker's gemini-live.json mode.
const OBS_EMOJI = {
  person: "🧑",
  companion: "👥",
  behavior: "🎭",
  appearance: "👤",
  environment: "🏠",
  conversation: "💬",
  security_alert: "🚨",
  security_note: "🔐",
  "tool-call": "🔧",
};

// Send a captured frame to Gemini AND mirror it in the picture-in-picture
// feed so you can see exactly what the model receives. Shared by camera + screen.
function sendFrameToModel(base64Data) {
  if (!geminiClient.isConnected()) return;
  geminiClient.sendImage(base64Data);

  modelFrameCount++;
  modelFrame.src = "data:image/jpeg;base64," + base64Data;
  modelFeed.classList.remove("hidden");
  const kb = Math.round((base64Data.length * 3) / 4 / 1024);
  modelFeedStats.textContent = `→ model · #${modelFrameCount} · ${kb} KB`;
}

function hideModelFeed() {
  modelFeed.classList.add("hidden");
  modelFrame.removeAttribute("src");
  modelFrameCount = 0;
  modelFeedStats.textContent = "waiting…";
}

const mediaHandler = new MediaHandler();
const geminiClient = new GeminiClient({
  onOpen: () => {
    statusDiv.textContent = "Connected";
    statusDiv.className = "status connected";
    authSection.classList.add("hidden");
    appSection.classList.remove("hidden");

    // Send hidden instruction
    geminiClient.sendText(
      `System: Introduce yourself as a demo of the Gemini Live API.
       Keep the intro concise and friendly.`
    );
  },
  onMessage: (event) => {
    if (typeof event.data === "string") {
      try {
        const msg = JSON.parse(event.data);
        handleJsonMessage(msg);
      } catch (e) {
        console.error("Parse error:", e);
      }
    } else {
      mediaHandler.playAudio(event.data);
    }
  },
  onClose: (e) => {
    console.log("WS Closed:", e);
    if (sessionError) {
      // BYO key: a rejected/invalid key — return to the auth panel with the
      // error still visible (set in handleJsonMessage) instead of the generic
      // "Session Ended" screen, so the visitor can fix their key and retry.
      authSection.classList.remove("hidden");
      appSection.classList.add("hidden");
      sessionEndSection.classList.add("hidden");
      syncConnectEnabled();
      sessionError = null;
      return;
    }
    statusDiv.textContent = "Disconnected";
    statusDiv.className = "status disconnected";
    showSessionEnd();
  },
  onError: (e) => {
    console.error("WS Error:", e);
    statusDiv.textContent = "Connection Error";
    statusDiv.className = "status error";
  },
});

function handleJsonMessage(msg) {
  if (msg.type === "interrupted") {
    mediaHandler.stopAudioPlayback();
    currentGeminiMessageDiv = null;
    currentUserMessageDiv = null;
  } else if (msg.type === "turn_complete") {
    currentGeminiMessageDiv = null;
    currentUserMessageDiv = null;
  } else if (msg.type === "user") {
    if (currentUserMessageDiv) {
      currentUserMessageDiv.textContent += msg.text;
      chatLog.scrollTop = chatLog.scrollHeight;
    } else {
      currentUserMessageDiv = appendMessage("user", msg.text);
    }
  } else if (msg.type === "gemini") {
    if (currentGeminiMessageDiv) {
      currentGeminiMessageDiv.textContent += msg.text;
      chatLog.scrollTop = chatLog.scrollHeight;
    } else {
      currentGeminiMessageDiv = appendMessage("gemini", msg.text);
    }
  } else if (msg.type === "event_invitation") {
    appendInvitation(msg);
  } else if (msg.type === "observation") {
    appendObservation(msg.observation);
  } else if (msg.type === "error") {
    // BYO key: surface a missing/invalid key (e.g. a key without Gemini Live
    // access) in the status area instead of failing into a silent dead session.
    // onClose reads sessionError to restore the auth panel.
    sessionError = msg.error || "Connection error.";
    statusDiv.textContent = sessionError;
    statusDiv.className = "status error";
  }
}

function appendInvitation(msg) {
  const details = msg.details || {};
  const card = document.createElement("div");
  card.className = "message invitation";

  const img = document.createElement("img");
  img.className = "invitation-img";
  img.src = `data:${msg.mime_type || "image/png"};base64,${msg.image_base64}`;
  img.alt = details.title || "Event invitation";
  card.appendChild(img);

  const caption = document.createElement("div");
  caption.className = "invitation-caption";
  const line = [
    details.title,
    [details.date, details.time].filter(Boolean).join(" "),
    details.location,
  ]
    .filter(Boolean)
    .join(" • ");
  caption.textContent = line || "You're invited!";
  card.appendChild(caption);

  chatLog.appendChild(card);
  chatLog.scrollTop = chatLog.scrollHeight;
}

// Render one live memory observation into the left-panel memory feed.
// Uses textContent only — observation titles/subtitles are model-generated.
function appendObservation(obs) {
  if (!obs || !obs.title) return;

  const placeholder = memoryFeedList.querySelector(".memory-empty");
  if (placeholder) placeholder.remove();

  const item = document.createElement("div");
  item.className = "memory-item";
  if (obs.obs_type) item.dataset.type = obs.obs_type;

  const icon = document.createElement("span");
  icon.className = "memory-item-icon";
  icon.textContent = OBS_EMOJI[obs.obs_type] || "🧠";
  item.appendChild(icon);

  const body = document.createElement("div");
  body.className = "memory-item-body";

  const title = document.createElement("div");
  title.className = "memory-item-title";
  title.textContent = obs.title;
  body.appendChild(title);

  if (obs.subtitle) {
    const subtitle = document.createElement("div");
    subtitle.className = "memory-item-subtitle";
    subtitle.textContent = obs.subtitle;
    body.appendChild(subtitle);
  }

  item.appendChild(body);
  memoryFeedList.appendChild(item);
  memoryFeedList.scrollTop = memoryFeedList.scrollHeight;

  memoryCount += 1;
  memoryFeedCount.textContent = String(memoryCount);
}

function appendMessage(type, text) {
  const msgDiv = document.createElement("div");
  msgDiv.className = `message ${type}`;
  msgDiv.textContent = text;
  chatLog.appendChild(msgDiv);
  chatLog.scrollTop = chatLog.scrollHeight;
  return msgDiv;
}

// Connect Button Handler
connectBtn.onclick = async () => {
  const apiKey = apiKeyInput.value.trim();
  if (!apiKey) {
    statusDiv.textContent = "Enter your Gemini API key to connect.";
    statusDiv.className = "status error";
    return;
  }

  statusDiv.textContent = "Connecting...";
  statusDiv.className = "status disconnected";
  sessionError = null;
  connectBtn.disabled = true;

  try {
    // Initialize audio context on user gesture
    await mediaHandler.initializeAudio();

    geminiClient.connect(apiKey);
  } catch (error) {
    console.error("Connection error:", error);
    statusDiv.textContent = "Connection Failed: " + error.message;
    statusDiv.className = "status error";
    syncConnectEnabled();
  }
};

// UI Controls
disconnectBtn.onclick = () => {
  geminiClient.disconnect();
};

micBtn.onclick = async () => {
  if (mediaHandler.isRecording) {
    mediaHandler.stopAudio();
    micBtn.textContent = "Start Mic";
  } else {
    try {
      await mediaHandler.startAudio((data) => {
        if (geminiClient.isConnected()) {
          geminiClient.send(data);
        }
      });
      micBtn.textContent = "Stop Mic";
    } catch (e) {
      alert("Could not start audio capture");
    }
  }
};

cameraBtn.onclick = async () => {
  if (cameraBtn.textContent === "Stop Camera") {
    mediaHandler.stopVideo(videoPreview);
    hideModelFeed();
    cameraBtn.textContent = "Start Camera";
    screenBtn.textContent = "Share Screen";
    videoPlaceholder.classList.remove("hidden");
  } else {
    // If another stream is active (e.g. Screen), stop it first
    if (mediaHandler.videoStream) {
      mediaHandler.stopVideo(videoPreview);
      screenBtn.textContent = "Share Screen";
    }

    try {
      await mediaHandler.startVideo(videoPreview, sendFrameToModel);
      cameraBtn.textContent = "Stop Camera";
      screenBtn.textContent = "Share Screen";
      videoPlaceholder.classList.add("hidden");
    } catch (e) {
      alert("Could not access camera");
    }
  }
};

screenBtn.onclick = async () => {
  if (screenBtn.textContent === "Stop Sharing") {
    mediaHandler.stopVideo(videoPreview);
    hideModelFeed();
    screenBtn.textContent = "Share Screen";
    cameraBtn.textContent = "Start Camera";
    videoPlaceholder.classList.remove("hidden");
  } else {
    // If another stream is active (e.g. Camera), stop it first
    if (mediaHandler.videoStream) {
      mediaHandler.stopVideo(videoPreview);
      cameraBtn.textContent = "Start Camera";
    }

    try {
      await mediaHandler.startScreen(
        videoPreview,
        sendFrameToModel,
        () => {
          // onEnded callback (e.g. user stopped sharing from browser)
          hideModelFeed();
          screenBtn.textContent = "Share Screen";
          videoPlaceholder.classList.remove("hidden");
        }
      );
      screenBtn.textContent = "Stop Sharing";
      cameraBtn.textContent = "Start Camera";
      videoPlaceholder.classList.add("hidden");
    } catch (e) {
      alert("Could not share screen");
    }
  }
};

sendBtn.onclick = sendText;
textInput.onkeypress = (e) => {
  if (e.key === "Enter") sendText();
};

function sendText() {
  const text = textInput.value;
  if (text && geminiClient.isConnected()) {
    geminiClient.sendText(text);
    appendMessage("user", text);
    textInput.value = "";
  }
}

function resetUI() {
  authSection.classList.remove("hidden");
  appSection.classList.add("hidden");
  sessionEndSection.classList.add("hidden");

  mediaHandler.stopAudio();
  mediaHandler.stopVideo(videoPreview);
  hideModelFeed();
  videoPlaceholder.classList.remove("hidden");

  micBtn.textContent = "Start Mic";
  cameraBtn.textContent = "Start Camera";
  screenBtn.textContent = "Share Screen";
  chatLog.innerHTML = "";
  memoryFeedList.innerHTML =
    '<div class="memory-empty">Watching… memories appear here as the session unfolds.</div>';
  memoryCount = 0;
  memoryFeedCount.textContent = "";
  syncConnectEnabled();
}

function showSessionEnd() {
  appSection.classList.add("hidden");
  sessionEndSection.classList.remove("hidden");
  mediaHandler.stopAudio();
  mediaHandler.stopVideo(videoPreview);
  hideModelFeed();
}

restartBtn.onclick = () => {
  resetUI();
};
