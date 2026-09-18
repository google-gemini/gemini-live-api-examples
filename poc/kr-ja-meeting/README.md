# 한국어 ↔ 일본어 자연 대화 회의 tracer

Google의 [Live Translate LiveKit 예제](https://github.com/google-gemini/gemini-live-translate-livekit)가 사용하는 두 핵심 seam을 한국어·일본어 동적 회의에 맞춰 최소화한 로컬 PoC입니다.

- Gemini Live: `translationConfig`로 언어별 음성을 번역하고, 끊기면 이전 대화 없이 새 ZDR 세션으로 복구
- LiveKit: `autoSubscribe: false`에서 청취 계획에 포함된 원음·통역 트랙만 `setSubscribed()`
- 참가 경험: 이름과 언어로 입장하고 일반 회의처럼 마이크만 켜고 끔
- 발화 경험: 마이크가 켜진 무음 상태를 유지할 수 있고, VAD가 발화 시작과 끝을 자동 전달
- 현재 통역 규칙: 겹침 발화를 막지 않고 하나의 통역 초점을 유지한 뒤 안전하게 넘김
- 초점 유지 규칙: 첫 화자는 즉시 선택하고, 겹침 후보는 설정된 최소 시간 동안 계속 말한 경우에만 종료된 화자의 다음 초점이 됨
- 데이터 경계: session resumption handle을 사용하지 않고, 회의 용어집은 메모리에만 두며 빈 회의에서 폐기
- 제품 경로 미사용: File API, explicit cache, Grounding, 입력·출력 전사, 애플리케이션 음성 로그

## 로컬 tracer 실행

```bash
cd poc/kr-ja-meeting
npm test
npm run dev
```

브라우저에서 `http://127.0.0.1:4173`을 열고 다음 순서로 확인합니다.

1. 표시 이름과 `ko` 또는 `ja`를 선택해 입장합니다.
2. roster에 서버가 생성한 참가자 ID의 사용자가 추가되는지 확인합니다.
3. `마이크 켜기` 후 말하지 않아도 `마이크 켜짐` 상태가 유지되는지 확인합니다.
4. 말하면 자동으로 통역 상태가 시작되고 침묵 뒤 자동 종료되는지 확인합니다.
5. 화면에 `말하기`, `발화 종료`, `문장 경계` 버튼이 없는지 확인합니다.
6. `나가기` 후 roster와 마이크 자원이 정리되는지 확인합니다.

자격증명 없이 실제 Chrome에서 동적 입장, 마이크가 켜진 무음 상태, 수동 발화 버튼 부재,
두 오디오 트랙의 상대 크기, `통역만`, `원음 확인` 자동 복귀를 함께 확인할 수 있습니다.

```bash
npm run canary:natural-conversation
npm run canary:automated-contracts
```

전체 결정론적 테스트와 브라우저 canary를 실행하고, 아직 실행하지 않은 증거 경계를 분리한
최종 JSON 보고서는 다음 명령으로 만듭니다.

```bash
npm run canary:final
```

로컬 LiveKit이 준비된 경우에만 `npm run canary:final -- --include-playout`을 사용합니다.
실제 Gemini provider는 별도 자격증명 권한이 있는 환경에서만 `--include-provider`로 실행합니다.
보고서의 `service`, `browser`, `interruption`, `reconnect`, `long-session`, `playout`,
`provider-semantic`, `provider-browser`, `human`은 서로 대체되지 않습니다. 자격증명 gate가
남으면 `automatedOk=false`이고, 사람 청취는 항상 별도 `not-claimed`로 남습니다.
자동시험은 사람의 이해도·피로·선호나 정확한 gain 값을 확정하지 않습니다.

브라우저 canary의 합성 track은 오디오 element와 상대 gain 적용만 검사합니다. 실제 Gemini 번역 음질이나 지연을 흉내 내지 않습니다.

## 실제 provider canary

로컬 LiveKit 개발 서버가 `ws://127.0.0.1:7880`에서 실행 중이고, Git에서 제외된 `.env.local`에 `GEMINI_API_KEY`가 있을 때 실행합니다.

```bash
npm install
npm run canary:provider
npm run canary:provider-semantic
```

첫 canary는 합성 일본어 음성을 `original:ja-1`로 게시하고 번역 PCM을 `translation:ko`로
다시 게시하는 실제 provider 경로입니다. semantic canary는 양방향 3개 문장의 input/output
transcription을 메모리에서만 판정하고 first/last meaning boolean만 출력합니다. 제품 server는
transcription을 켜지 않습니다. 어떤 canary도 key, 음성, PCM 또는 전사 본문을 증거 파일로 저장하지 않습니다.

## 실제 어댑터 연결

- `src/gemini-live-socket.mjs`는 공식 `BidiGenerateContent` WebSocket 메시지 형태로 ZDR setup, PCM 입력, 번역 PCM 출력을 구현합니다. API key는 생성자 주입만 허용하며 파일에 쓰지 않습니다.
- `src/livekit-subscriptions.mjs`는 LiveKit `Room`의 remote audio publications에 대해 청취 계획의 모든 트랙을 구독합니다.
- `src/meeting-session.mjs`가 동적 roster, 마이크와 발화 상태, 통역 초점과 참가자별 청취 모드를 관리하는 단일 상태 원본입니다.
- `src/speech-activity-detector.mjs`는 음량 관측을 자동 `speech-start`·`speech-end` event로 바꾸는 교체 가능한 경계입니다.

Egress, Cloud Run 배포, Gemini 프로젝트 설정 변경은 이 PoC 범위에 포함하지 않습니다.
