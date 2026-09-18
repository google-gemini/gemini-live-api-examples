import { Room, RoomEvent, Track } from "/vendor/livekit-client.mjs";
import { BrowserAudioPlayout } from "/public/browser-audio-playout.mjs";
import { translationStatusView } from "/public/translation-status.mjs";
import { syncAudioSubscriptions } from "/src/livekit-subscriptions.mjs";
import { SpeechActivityDetector } from "/src/speech-activity-detector.mjs";

const languageName = { ko: "한국어", ja: "日本語" };
const modeCopy = {
  silent: "연결 대기",
  speaking: "말하는 중",
  "translation-focused": "작은 원음 · 통역 음성 청취",
  "translation-only": "통역 음성만 청취",
  "original-check": "원음 확인 중 · 자동 복귀",
  "same-language-original": "같은 언어 원음",
  "focus-pending": "원음 청취 · 통역 초점 대기",
  "original-fallback": "원음 정상 크기 · 통역 재연결 중",
};

const app = document.querySelector("#app");
const audioOutput = document.querySelector("#audio-output");
const audioPlayout = new BrowserAudioPlayout(audioOutput, {
  onPlanApplied(event) {
    window.dispatchEvent(new CustomEvent("bridge:listening-plan-applied", { detail: event }));
  },
  onPlayoutEvent(event) {
    window.dispatchEvent(new CustomEvent("bridge:playout", { detail: event }));
    if (localParticipant) {
      void postJson("/api/meeting/playout", {
        participantId: localParticipant.id,
        ...event,
      }).catch(() => {
        // Diagnostic delivery cannot interrupt browser audio playback.
      });
    }
  },
});
let displayName = "";
let preferredLanguage = "ko";
let localParticipant = null;
let room = null;
let microphonePublication = null;
let speechDetector = null;
let speechDetectorResources = null;
let speechEventChain = Promise.resolve();
let snapshot = { activeSpeakerId: null, activeUtteranceId: null, participants: [] };
let pollTimer = null;
let busy = false;
let intentionalDisconnect = false;
let statusMessage = "이름과 언어를 선택해 회의에 입장하세요.";

function participantById(id) {
  return snapshot.participants.find((participant) => participant.id === id);
}

function activeParticipant() {
  return participantById(snapshot.translationFocusId ?? snapshot.activeSpeakerId);
}

function localState() {
  return participantById(localParticipant?.id);
}

function localAudioState() {
  return localState()?.audio ?? { mode: "silent", tracks: [] };
}

function render() {
  app.innerHTML = localParticipant ? renderMeeting() : renderJoin();
}

function renderJoin() {
  return `<main class="join-shell">
    <section class="join-card">
      <div class="join-brand"><span class="brand-mark" aria-hidden="true"><i></i><i></i></span><strong>Bridge</strong></div>
      <span class="concept-label">KR × JP LIVE INTERPRETATION</span>
      <h1>언어는 달라도,<br>회의는 같은 속도로</h1>
      <p>이름과 사용하는 언어를 선택하세요. 입장한 뒤에는 일반 회의처럼 마이크만 켜고 끕니다.</p>
      <div class="join-fields">
        <label><span>표시 이름</span><input name="display-name" autocomplete="name" maxlength="40" value="${escapeHtml(displayName)}" placeholder="예: Yuki"></label>
        <fieldset class="language-picker">
          <legend>내 언어</legend>
          ${Object.entries(languageName).map(([language, label]) => `<label class="pick-language ${preferredLanguage === language ? "is-selected" : ""}">
            <input type="radio" name="language" value="${language}" ${preferredLanguage === language ? "checked" : ""}>
            <strong>${label}</strong><small>${language.toUpperCase()}</small>
          </label>`).join("")}
        </fieldset>
      </div>
      <button class="join-button" type="button" data-global="join" ${busy ? "disabled" : ""}>${busy ? "연결 중…" : "회의 입장"}</button>
      <div class="join-policy"><span><i></i> 음성·전사 기록 OFF</span><span>마이크가 켜져 있어도 침묵할 수 있습니다</span></div>
      <p class="status-message" aria-live="polite">${escapeHtml(statusMessage)}</p>
    </section>
    <aside class="join-visual" aria-hidden="true">
      <div class="language-orbit"><span>KO</span><i>⇄</i><span>JA</span></div>
      <strong>말의 시작과 끝은<br>자동으로 감지합니다</strong>
    </aside>
  </main>`;
}

function renderMeeting() {
  const active = activeParticipant();
  const reconnectView = translationStatusView(snapshot.translationAvailability ?? "available");
  const featured = active ?? localState() ?? snapshot.participants[0];
  const featuredState = featured?.audio ?? { mode: "silent" };
  const target = active ? (active.language === "ko" ? "ja" : "ko") : null;
  const overlapWarning = snapshot.overlap?.detected
    ? `<p class="status-message meeting-status" role="status">${escapeHtml(snapshot.overlap.message)}</p>`
    : "";
  const reconnectStatus = reconnectView
    ? `<p class="status-message meeting-status" role="status">${escapeHtml(reconnectView.message)}</p>`
    : "";
  return `${renderTopbar(active, reconnectView)}<main class="stage-layout">
    <section class="stage-card" aria-label="현재 발화자">
      <div class="stage-ambient"></div>
      <div class="stage-copy">
        <span class="concept-label">LIVE STAGE</span>${featured ? avatar(featured, "hero") : ""}
        <h1>${escapeHtml(featured?.name ?? "대기 중")}</h1>
        <p>${active ? `${languageName[featured.language]} 참가자가 말하고 있습니다` : "다음 발화를 기다리고 있습니다"}</p>
        <div class="translation-callout ${active ? "is-active" : ""}">
          <span class="wave" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
          <div><strong>${active ? `${languageName[target]}로 실시간 통역 중` : "말하면 자동으로 통역합니다"}</strong>
          <span>${active ? "음성 활동에 맞춰 발화 구간을 자동 관리합니다" : "마이크를 켜 둔 채 말하지 않아도 됩니다"}</span></div>
        </div>
      </div>
      <div class="stage-corner-state">${trackPill(featuredState)}</div>
    </section>
    <aside class="stage-side">
      <div class="side-heading"><div><span class="concept-label">IN THE ROOM</span><h2>참가자 ${snapshot.participants.length}명</h2></div><span class="secure-copy">기록하지 않음</span></div>
      <div class="people-list">${snapshot.participants.map((state) => participantRow(state, active)).join("")}</div>
      ${reconnectStatus}
      ${overlapWarning}
      ${meetingControls()}
      <p class="status-message meeting-status" aria-live="polite">${escapeHtml(statusMessage)}</p>
    </aside>
  </main><footer class="meeting-footer"><strong>${escapeHtml(localParticipant.name)}</strong><span>${modeCopy[localAudioState().mode]} · 실제 LiveKit room</span></footer>`;
}

function renderTopbar(active, reconnectView) {
  return `<header class="topbar">
    <a class="brand" href="/" aria-label="Bridge 회의 홈"><span class="brand-mark" aria-hidden="true"><i></i><i></i></span><span>Bridge</span></a>
    <div class="meeting-title"><strong>한국어 × 日本語</strong><span>실시간 통역 회의 · ${snapshot.participants.length}명</span></div>
    <div class="meeting-health ${active ? "is-live" : ""}"><span class="live-dot"></span>${reconnectView?.healthLabel ?? (active ? "통역 중" : "준비됨")}</div>
    <button class="leave-button" type="button" data-global="leave">나가기</button>
  </header>`;
}

function participantRow(state, active) {
  const isMe = state.id === localParticipant.id;
  return `<article class="person-row ${active?.id === state.id ? "is-speaking" : ""} ${isMe ? "is-me" : ""}" data-participant="${escapeHtml(state.id)}">
    ${avatar(state)}<div class="person-copy"><strong>${escapeHtml(state.name)}${isMe ? " · 나" : ""}</strong><span>${languageName[state.language]} · ${state.microphone === "unmuted" ? "마이크 켜짐" : "마이크 꺼짐"}</span></div>
    ${trackPill(state.audio)}${isMe ? listenerActions(state, active) : ""}
  </article>`;
}

function listenerActions(state, active) {
  const mode = state.listeningMode ?? "translation-focused";
  const persistentButton = mode === "translation-focused"
    ? `<button type="button" data-listening-mode="translation-only" ${busy ? "disabled" : ""}>통역만</button>`
    : mode === "translation-only"
      ? `<button type="button" data-listening-mode="translation-focused" ${busy ? "disabled" : ""}>원음 작게 + 통역</button>`
      : `<button type="button" disabled>원음 확인 중 · 자동 복귀</button>`;
  const canCheckOriginal = active
    && active.id !== state.id
    && active.language !== state.language
    && mode !== "original-check";
  const originalButton = canCheckOriginal
    ? `<button type="button" data-listening-mode="original-check" ${busy ? "disabled" : ""}>원음 확인</button>`
    : "";
  return `<div class="participant-actions">${persistentButton}${originalButton}</div>`;
}

function meetingControls() {
  const microphoneOn = localState()?.microphone === "unmuted";
  return `<div class="meeting-controls">
    <button type="button" data-global="mic" aria-pressed="${microphoneOn}" ${busy ? "disabled" : ""}>${microphoneOn ? "마이크 끄기" : "마이크 켜기"}</button>
    <span><i></i> ${microphoneOn ? "마이크 켜짐 · 자동 발화 감지" : "마이크 꺼짐"}</span>
  </div>`;
}

function avatar(participant, size = "normal") {
  const initial = Array.from(participant.name ?? "?")[0] ?? "?";
  return `<span class="avatar avatar-${participant.language} avatar-${size}" aria-hidden="true">${escapeHtml(initial)}</span>`;
}

function trackPill(audio) {
  const hasTranslation = audio.tracks?.some(({ kind }) => kind === "translation");
  const hasOriginal = audio.tracks?.some(({ kind }) => kind === "original");
  const tone = hasTranslation ? "translated" : hasOriginal ? "original" : "silent";
  return `<span class="track-pill ${tone}"><i></i>${modeCopy[audio.mode] ?? "연결 대기"}</span>`;
}

async function joinMeeting() {
  if (!displayName.trim()) {
    statusMessage = "표시 이름을 입력해 주세요.";
    render();
    return;
  }
  busy = true;
  statusMessage = "LiveKit room을 연결하고 있습니다.";
  render();
  let joinedParticipantId = null;
  try {
    const join = await postJson("/api/meeting/join", {
      name: displayName,
      language: preferredLanguage,
    });
    joinedParticipantId = join.participant.id;
    room = new Room({ autoSubscribe: false, dynacast: false });
    room.on(RoomEvent.TrackPublished, syncSubscriptions);
    room.on(RoomEvent.TrackUnpublished, syncSubscriptions);
    room.on(RoomEvent.TrackSubscribed, attachSubscribedTrack);
    room.on(RoomEvent.TrackUnsubscribed, detachTrack);
    room.on(RoomEvent.Disconnected, () => {
      if (!intentionalDisconnect) void handleUnexpectedDisconnect();
    });
    await room.connect(join.livekitUrl, join.token, { autoSubscribe: false });
    localParticipant = join.participant;
    await refreshState();
    pollTimer = window.setInterval(() => void refreshState(), 500);
    statusMessage = "회의에 연결되었습니다. 필요할 때 마이크를 켜세요.";
  } catch (error) {
    if (joinedParticipantId) {
      await postJson("/api/meeting/leave", { participantId: joinedParticipantId }).catch(() => {});
    }
    await disconnectRoom();
    localParticipant = null;
    statusMessage = readableError(error);
  } finally {
    busy = false;
    render();
  }
}

async function toggleMicrophone() {
  if (!localParticipant || busy) return;
  busy = true;
  render();
  const enable = localState()?.microphone !== "unmuted";
  try {
    if (enable) {
      microphonePublication = await room.localParticipant.setMicrophoneEnabled(
        true,
        { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        { name: `original:${localParticipant.id}`, source: Track.Source.Microphone, dtx: false },
      );
      snapshot = await postJson("/api/meeting/mic", {
        participantId: localParticipant.id,
        enabled: true,
      });
      startSpeechDetection(microphonePublication);
      statusMessage = "마이크가 켜졌습니다. 말하지 않아도 연결은 유지됩니다.";
    } else {
      await stopSpeechDetection();
      await microphonePublication?.mute();
      snapshot = await postJson("/api/meeting/mic", {
        participantId: localParticipant.id,
        enabled: false,
      });
      statusMessage = "마이크가 꺼졌습니다.";
    }
    syncSubscriptions();
  } catch (error) {
    if (enable) {
      await stopSpeechDetection();
      await microphonePublication?.mute().catch(() => {});
    }
    statusMessage = readableError(error);
  } finally {
    busy = false;
    render();
  }
}

function startSpeechDetection(publication) {
  const mediaStreamTrack = publication?.track?.mediaStreamTrack;
  if (!mediaStreamTrack) throw new Error("마이크 음성 활동을 확인할 수 없습니다.");
  const AudioContextClass = window.AudioContext ?? window.webkitAudioContext;
  const context = new AudioContextClass();
  const source = context.createMediaStreamSource(new MediaStream([mediaStreamTrack]));
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const samples = new Uint8Array(analyser.fftSize);
  speechDetector = new SpeechActivityDetector({
    onEvent(event) {
      speechEventChain = speechEventChain.then(async () => {
        if (!localParticipant) return;
        snapshot = await postJson("/api/meeting/speech", {
          participantId: localParticipant.id,
          ...event,
        });
        syncSubscriptions();
        render();
      }).catch((error) => {
        statusMessage = readableError(error);
        render();
      });
    },
  });
  const timer = window.setInterval(() => {
    analyser.getByteTimeDomainData(samples);
    let energy = 0;
    for (const sample of samples) {
      const normalized = (sample - 128) / 128;
      energy += normalized * normalized;
    }
    speechDetector?.observe(Math.sqrt(energy / samples.length), performance.now());
  }, 50);
  speechDetectorResources = { context, source, timer };
}

async function stopSpeechDetection() {
  speechDetector?.stop(performance.now());
  speechDetector = null;
  await speechEventChain;
  if (!speechDetectorResources) return;
  window.clearInterval(speechDetectorResources.timer);
  speechDetectorResources.source.disconnect();
  await speechDetectorResources.context.close();
  speechDetectorResources = null;
}

async function changeListeningMode(mode) {
  if (!localParticipant || busy) return;
  busy = true;
  render();
  try {
    snapshot = await postJson("/api/meeting/listening-mode", {
      participantId: localParticipant.id,
      mode,
    });
    statusMessage = mode === "original-check"
      ? "원음만 확인합니다. 이 발화가 끝나면 이전 청취 모드로 자동 복귀합니다."
      : mode === "translation-only"
        ? "다른 언어의 원음을 끄고 통역 음성만 듣습니다."
        : "작은 원음과 통역 음성을 함께 듣습니다.";
    syncSubscriptions();
  } catch (error) {
    statusMessage = readableError(error);
  } finally {
    busy = false;
    render();
  }
}

async function refreshState() {
  if (!room) return;
  const response = await fetch("/api/meeting", { cache: "no-store" });
  if (!response.ok) throw new Error("회의 상태를 가져오지 못했습니다.");
  snapshot = await response.json();
  syncSubscriptions();
  render();
}

function syncSubscriptions() {
  if (!room || !localParticipant) return;
  const listeningPlan = localAudioState();
  audioPlayout.setPlan(listeningPlan);
  syncAudioSubscriptions(room, listeningPlan);
}

function attachSubscribedTrack(track, publication) {
  if (track.kind !== Track.Kind.Audio) return;
  audioPlayout.attach(track, publication);
}

function detachTrack(track) {
  audioPlayout.detach(track);
}

async function leaveMeeting() {
  if (!localParticipant || busy) return;
  busy = true;
  try {
    await stopSpeechDetection();
    await microphonePublication?.mute().catch(() => {});
    await postJson("/api/meeting/leave", { participantId: localParticipant.id });
  } catch (error) {
    statusMessage = readableError(error);
  } finally {
    await disconnectRoom();
    localParticipant = null;
    snapshot = { activeSpeakerId: null, activeUtteranceId: null, participants: [] };
    busy = false;
    statusMessage = "회의에서 나왔습니다.";
    render();
  }
}

async function handleUnexpectedDisconnect() {
  const participantId = localParticipant?.id;
  await stopSpeechDetection().catch(() => {});
  if (participantId) await postJson("/api/meeting/leave", { participantId }).catch(() => {});
  localParticipant = null;
  room = null;
  snapshot = { activeSpeakerId: null, activeUtteranceId: null, participants: [] };
  statusMessage = "LiveKit 연결이 종료되었습니다.";
  render();
}

async function disconnectRoom() {
  if (pollTimer) window.clearInterval(pollTimer);
  pollTimer = null;
  audioPlayout.clear();
  intentionalDisconnect = true;
  if (room) await room.disconnect();
  intentionalDisconnect = false;
  room = null;
  microphonePublication = null;
}

async function postJson(path, payload) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? "요청에 실패했습니다.");
  return body;
}

function readableError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/permission|denied|NotAllowed/i.test(message)) {
    return "마이크 권한이 필요합니다. 브라우저 주소창의 마이크 권한을 허용해 주세요.";
  }
  return message;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character]);
}

document.addEventListener("input", (event) => {
  if (event.target.matches("input[name=display-name]")) displayName = event.target.value;
});

document.addEventListener("change", (event) => {
  const input = event.target.closest("input[name=language]");
  if (!input) return;
  preferredLanguage = input.value;
  render();
});

document.addEventListener("click", (event) => {
  const global = event.target.closest("[data-global]")?.dataset.global;
  if (global === "join") return void joinMeeting();
  if (global === "leave") return void leaveMeeting();
  if (global === "mic") return void toggleMicrophone();
  const listeningMode = event.target.closest("[data-listening-mode]")?.dataset.listeningMode;
  if (listeningMode) void changeListeningMode(listeningMode);
});

window.addEventListener("beforeunload", () => {
  if (localParticipant) {
    navigator.sendBeacon(
      "/api/meeting/leave",
      new Blob([JSON.stringify({ participantId: localParticipant.id })], { type: "application/json" }),
    );
  }
});

render();
