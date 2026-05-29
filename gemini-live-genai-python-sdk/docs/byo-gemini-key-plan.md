# Plan: Mandatory Bring-Your-Own Gemini Key (live session + isolated live observations)

## Goal

Make the public demo runnable by anyone with **their own Gemini API key**, supplied
in the UI, with **none of our server key used** for either the live voice session or
the memory observations. Because the demo lives on a **public web URL**, each
visitor's observations must be **isolated to their key** (e.g. project namespace
`gemini-live-<key-derived-id>`) so strangers never see each other's memory.

This directly fixes the production blocker from 2026-05-25: the server's free-tier key
(20 generateContent req/day) is exhausted in seconds by a single session, killing
observations for everyone (obs 88709, 88736).

## What "done" looks like

1. The UI shows a **mandatory** "Your Gemini API key" input. Connect is disabled until a key is entered. Key is saved in the browser (localStorage) so it's paste-once.
2. The live voice session runs on the **visitor's** key (server key not used).
3. Memory observations are generated on the **visitor's** key (server key not used).
4. Each visitor's observations are **isolated**: stored and read under a project namespace derived from their key. Two different keys never see each other's feed.
5. Sharing the URL "just works" for any visitor with a key — no server quota consumed by us.

---

## Decisions already made (do not re-litigate during execution)

These were chosen deliberately for a *public* demo handling *secret* visitor keys. Each
has a rationale; keep them unless a verification step disproves the underlying fact.

| Decision | Choice | Why |
|---|---|---|
| Observation generation strategy | **Patch the claude-mem worker** to accept a per-session key override | User-selected. Keeps the full claude-mem pipeline + persistence + live feed intact. |
| Per-visitor isolation | **Per-session `project` in the sink** (key-derived). No worker patch. | Worker already stores by `session.project` and filters reads by `project=?` (Phase 0 evidence). |
| Namespace scheme | `gemini-live-{sha256(normalized_key)[:12]}` | **One-way (preimage-resistant) and deterministic**: the same key always maps to the same namespace, so a returning visitor recovers the exact same memories — but the namespace reveals nothing about the key and isn't reversible. Key is normalized (`.strip()`) before hashing so incidental whitespace can't fork a visitor into a new namespace. Truncating to 12 hex (48 bits) is collision-safe at demo scale. (User's "gemini-live-sk..XXXX" intent, done safely.) |
| Key persistence (browser) | **localStorage** (`geminiApiKey`) | Paste-once; survives reloads; returning visitor auto-fills and reconnects to the same key-derived namespace. |
| Where the worker stores the per-session key | **In-memory `ActiveSession` only** — NOT a SQLite column | No migration; and we never write a visitor's secret key to the Fly disk. |
| Live-session key transport (browser → backend) | **First WebSocket message** `{"type":"setup","api_key":"…"}` — NOT a `?api_key=` query param | A query param lands in Uvicorn/Fly access logs; a WS body frame does not. Don't log visitor keys. |
| "Never use our key" hardening | Run the worker with an **empty** boot Gemini key in the demo image | With no real server key present, any session lacking an override fails safe (no observation) instead of silently spending our key. |

---

## Repos involved (two of them)

- **App repo** (FastAPI + frontend + Docker): `/Users/alexnewman/.superset/projects/gemini-live-mem/gemini-live-genai-python-sdk/`
- **claude-mem source** (worker patch): `/Users/alexnewman/.claude/plugins/marketplaces/thedotmack/`
  - This is a git checkout at the v13.3.0 commit (`c3d2af7`); its built `plugin/scripts/worker-service.cjs` is **md5-identical** to the published bundle the Docker image installs. It is the correct source to patch.

---

# Phase 0 — Documentation Discovery (consolidated; read before editing)

This is the authoritative fact base. All line numbers verified by full-file reads on
2026-05-25. **Do not invent APIs, columns, endpoints, or SDK methods beyond these.**

### Allowed APIs / patterns (cite these; copy, don't invent)

**Frontend (app repo `frontend/`)**
- Connect trigger: `<button id="connectBtn">` at `index.html:48`; handler `connectBtn.onclick` at `main.js:208-223` (calls `mediaHandler.initializeAudio()` then `geminiClient.connect()`).
- WS open: `gemini-client.js:13-18` — `new WebSocket(\`${protocol}//${window.location.host}/ws\`)`, path **`/ws`**, no params today.
- Auth panel to insert the key UI into: `<div class="auth-section" id="auth-section">` at `index.html:19-49` (flex column, `gap:1rem`, `style.css:133-141`).
- Text input to **clone** for the key field: `index.html:106-110` (`#textInput`); inherits `input[type="text"]` style at `style.css:346-351`.
- Button class to reuse: `.btn` at `style.css:248-266`; disabled state `.btn:disabled` at `style.css:263-266`.
- JS wiring pattern to copy: element capture `main.js:12-13`; click+Enter handlers `main.js:307-310`; disable pattern `main.js:210`.
- Intro message sent on open today: `main.js:71-75` (`geminiClient.sendText("System: Introduce yourself…")`).
- Outbound WS message shapes: text `JSON.stringify({text})` `gemini-client.js:43-45`; image `{type:"image",mime_type,data}` `:47-55`; audio binary `:37-41`.
- Live memory feed panel: `index.html:89-100`; `appendObservation()` `main.js:160-196`; JSON router `handleJsonMessage()` `main.js:102-129` (observation handled `:126-128`).
- **No localStorage / settings / modal exists anywhere** — the key input + persistence is net-new.

**App backend (app repo)**
- Key load (to be made unused for web path): `main.py:26` `GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")`.
- `/ws` endpoint: `main.py:54-55`, handler signature takes only `websocket: WebSocket`. `Query` is already imported (`main.py:8`) but we will NOT use it.
- **Client built before any message is read**: `GeminiLive(api_key=GEMINI_API_KEY, …)` at `main.py:72-74`, immediately after `websocket.accept()` (`:57`); receive loop `receive_from_client` `main.py:76-99` starts at `:101`. → restructuring is required to read a setup frame first.
- `GeminiLive.__init__(api_key, …)` `gemini_live.py:17`; stores `self.api_key` `:28`; builds `self.client = genai.Client(api_key=api_key)` `:31`.
- Live session call (do not change): `gemini_live.py:78` `async with self.client.aio.live.connect(model=self.model, config=config) as session:`.
- Sink integration: import `gemini_live.py:10`; **created** `memory_sink = make_memory_sink_if_enabled()` at `gemini_live.py:40` (inside `start_session`, has access to `self.api_key`); `on_session_start()` `:82`; `emit` wired `:127`; `on_event` `:219`; `on_session_end` `:228`.

**Sink (app repo `claude_mem_sink.py`)**
- Factory: `make_memory_sink_if_enabled()` `:62-70` (currently takes no args).
- `MemorySink.__init__` `:74-149`: `self.worker_url` `:75`; **`self.project = os.getenv("CLAUDE_MEM_PROJECT", "gemini-live-mem")` `:76`** (the shared value to make per-visitor); `self.content_session_id` `:78`; `gemini_api_key = os.getenv("GEMINI_API_KEY")` `:88`; vision client `genai.Client(api_key=gemini_api_key)` `:95`; invitation key reuse `:106-108`.
- Session init POST: `on_session_start()` `:151-161`, body at `:155-160` = `{contentSessionId, project, prompt, platformSource}` (this is where we add `geminiApiKey`).
- Observation POST: `_post_observation()` `:601-612` — body has **no `project`** field; isolation rides on the session's project from init (confirmed below).
- Feed/recall reads already scoped by `self.project`: `:322, :342, :490, :505`.

**claude-mem worker (source repo)** — patch sites for the per-session key:
- Init route + schema: `src/services/worker/http/routes/SessionRoutes.ts` — route `:180-184`; schema `sessionInitByClaudeIdSchema` `:198-204` (already `.passthrough()`).
- Init handler: `handleSessionInitByClaudeId` `SessionRoutes.ts:331-476`; calls `sessionManager.initializeSession(...)` `:420`.
- In-memory session type: `ActiveSession` in `src/services/worker-types.ts`.
- Session hydration (where `project` is read from the DB row — add the key here too): `src/services/worker/SessionManager.ts:~93-161`.
- Key resolution: `getGeminiConfig()` `src/services/worker/GeminiProvider.ts:503-535`, resolve line `:507`.
- Generation entry + threading: `startSession` `GeminiProvider.ts:190`, config read `:191`; → `processMessageLoop` `:251-276` (apiKey passed `:233`) → `processObservationMessage` `:278-323` (apiKey `:271`, calls `queryGeminiMultiTurn(...apiKey...)` `:306`) → `queryGeminiMultiTurn` `:423-501`, URL `:439` `\`${GEMINI_API_URL}/${model}:generateContent?key=${apiKey}\``.
- Build: `node scripts/build-hooks.js` (esbuild; source `src/services/worker-service.ts`, outfile `plugin/scripts/worker-service.cjs` at `scripts/build-hooks.js:142`).

**Isolation correctness (the make-or-break — confirmed YES, no patch needed):**
- Stored observation's project = **`session.project`** (set at init), via `ResponseProcessor.ts:79-88` → `SessionStore.storeObservations` plural INSERT, project bind at `SessionStore.ts:1971`. **No cwd fallback on this path** (the only `|| cwd` fallback is in the *singular* `observations/store.ts:31`, which the Gemini path does not use; and `session.project` is never falsy — init defaults it to `'unknown'`).
- `GET /api/observations?project=X` filters strictly: `PaginationHelper.ts:81-87` (`o.project = ?`).
- `GET /api/context/recent?project=X` scoped: `SearchManager.ts:1112-1116` (sink always passes `project`).

**Deploy facts:**
- Dockerfile install: `Dockerfile:17` `RUN npm install -g claude-mem@13.3.0`. Existing overwrite precedent: `Dockerfile:31-32` `RUN cp claude-mem-docker/gemini-live.json "$(npm root -g)/claude-mem/plugin/modes/gemini-live.json"`.
- Entrypoint runs worker from `docker-entrypoint.sh:32` `WORKER="$(npm root -g)/claude-mem/plugin/scripts/worker-service.cjs"`; launched `:35` `bun "$WORKER" start &`. In-image absolute path: `/usr/local/lib/node_modules/claude-mem/plugin/scripts/worker-service.cjs`.
- Entrypoint sets the worker key from env: `docker-entrypoint.sh:14-17` (`CLAUDE_MEM_GEMINI_API_KEY="$GEMINI_API_KEY"`), and requires `GEMINI_API_KEY` at `:10`.

### Anti-patterns to avoid
- ❌ Putting the API key in the `/ws` query string (logged).
- ❌ Adding a SQLite column / migration for the key (writes visitor secret to disk; unnecessary — use in-memory `ActiveSession`).
- ❌ Patching the worker for isolation (not needed; isolation is a sink-only `project` change).
- ❌ Editing the 3.9 MB built `.cjs` by hand — patch the TS source and rebuild.
- ❌ Inventing a "store finished observation" endpoint — none exists; keep POSTing raw turns to `/api/sessions/observations`.
- ❌ Leaving a real server Gemini key configured in the demo image (it could get silently spent).

---

# Phase 1 — Patch the claude-mem worker for a per-session key override

**Repo:** `/Users/alexnewman/.claude/plugins/marketplaces/thedotmack/`
**Goal:** `getGeminiConfig()` accepts an optional override; the override comes from the
session's `geminiApiKey`, supplied at `/api/sessions/init` and held only in memory.

### What to implement (copy the existing `project` plumbing — the key follows the same path)

1. **Accept the field at init.** In `SessionRoutes.ts:198-204`, add to `sessionInitByClaudeIdSchema`:
   `geminiApiKey: z.string().optional()`. (Schema is already `.passthrough()`, so this is additive and safe.)
2. **Carry it into the in-memory session.** In `handleSessionInitByClaudeId` (`SessionRoutes.ts:331-476`), read `req.body.geminiApiKey` and pass it into `this.sessionManager.initializeSession(...)` at `:420` (mirror how `project`/`prompt` are passed).
3. **Type + store it in memory.** Add `geminiApiKey?: string` to `ActiveSession` in `src/services/worker-types.ts`. In `SessionManager.initializeSession` (`SessionManager.ts:~93-161`), set `session.geminiApiKey` right where `session.project = dbSession.project` is set (use the value passed in step 2). **Do NOT add a `sdk_sessions` column.**
4. **Make the resolver accept an override.** In `GeminiProvider.getGeminiConfig` (`:503-535`), add a parameter and prefer it:
   - signature → `getGeminiConfig(apiKeyOverride?: string)`
   - line `:507` → `const apiKey = apiKeyOverride || settings.CLAUDE_MEM_GEMINI_API_KEY || getCredential('GEMINI_API_KEY') || '';`
5. **Pass the session key at the one call site.** In `startSession` (`:191`), change `this.getGeminiConfig()` → `this.getGeminiConfig(session.geminiApiKey)`. Downstream threading (`191→233→271→306→439`) already carries `apiKey` — no other edits.

### Verification checklist
- [ ] `grep -n "geminiApiKey" src/services/worker/http/routes/SessionRoutes.ts src/services/worker-types.ts src/services/worker/SessionManager.ts src/services/worker/GeminiProvider.ts` shows the field added at all four hops.
- [ ] Confirm the `session` object passed to `startSession`/`processObservationMessage` is the **same in-memory `ActiveSession`** that `initializeSession` created (so `.geminiApiKey` set in step 3 is visible at generation). If generation instead reloads the session from SQLite, fall back to a `gemini_api_key TEXT` column on `sdk_sessions` (created in `SessionStore.createSDKSession` `:1713-1772`) and accept the on-disk-key tradeoff — but verify first; the `project` trace says in-memory is correct.
- [ ] `node -e` / unit check: `getGeminiConfig('OVERRIDE')` returns `apiKey === 'OVERRIDE'` even when env/settings have a different key.
- [ ] No SQLite migration was added.

### Anti-pattern guards
- Override must take precedence over settings/env (precedence order in step 4 — override first).
- Don't touch the isolation/storage paths (`ResponseProcessor.ts`, `SessionStore.storeObservations`, `PaginationHelper.ts`) — they're already correct.

---

# Phase 2 — Build the patched worker and vendor it into the Docker image

**Repos:** build in claude-mem source; wire into the app repo's Docker image.
**Goal:** the Fly image runs the patched worker, with **no real server key** so our key can't be spent.

### What to implement
1. **Rebuild the bundle** in `/Users/alexnewman/.claude/plugins/marketplaces/thedotmack/`:
   - Run the worker bundler: `node scripts/build-hooks.js` (verify it regenerates `plugin/scripts/worker-service.cjs`; confirm which `npm run` script wraps it — `npm run build` runs manifest+hooks but confirm it includes the esbuild worker step).
   - Sanity: `git diff --stat` shows only the intended TS edits; the rebuilt `.cjs` changed.
2. **Vendor the rebuilt `.cjs`** into the app repo next to the existing mode file it already copies:
   - Copy `…/thedotmack/plugin/scripts/worker-service.cjs` → `gemini-live-genai-python-sdk/claude-mem-docker/worker-service.cjs`.
3. **Overwrite the installed worker in the image.** In `Dockerfile`, after `:17` (`npm install -g`) — mirror the existing `:31-32` `RUN cp` pattern (a plain `COPY` can't expand `$(npm root -g)`):
   ```dockerfile
   COPY claude-mem-docker/worker-service.cjs /tmp/worker-service.cjs
   RUN cp /tmp/worker-service.cjs "$(npm root -g)/claude-mem/plugin/scripts/worker-service.cjs"
   ```
   (Or hardcode the dest `/usr/local/lib/node_modules/claude-mem/plugin/scripts/worker-service.cjs`.)
4. **Remove the real server key from the demo image** so visitor sessions are the only key source:
   - In `docker-entrypoint.sh:14-17`, set the worker's boot key empty (`export CLAUDE_MEM_GEMINI_API_KEY=""`) and relax the `:10` requirement that `GEMINI_API_KEY` be present (the worker only needs a key at generation time, which now comes per-session).
   - On Fly, the `GEMINI_API_KEY` secret can be unset/emptied for this app.

### Verification checklist
- [ ] In a built image: `ls -l $(npm root -g)/claude-mem/plugin/scripts/worker-service.cjs` exists and its md5 == the vendored file's md5.
- [ ] Worker **boots with an empty boot key** without crashing (if `getGeminiConfig()` is invoked at startup/health and throws on empty, set a clearly-fake placeholder like `disabled-no-server-key` instead of empty — verify which).
- [ ] `grep -n "worker-service.cjs" Dockerfile` shows the overwrite after the install line.

### Anti-pattern guards
- The vendored `.cjs` must be the **rebuilt** one (containing the Phase 1 edits), not a stale copy — diff against the published bundle to confirm it changed.
- Keep the `plugin/scripts/` layout in the dest path (the entrypoint and `Dockerfile:31-32` depend on it).

---

# Phase 3 — App backend: per-session key transport + sink isolation

**Repo:** app repo. **Goal:** read the visitor key from the first WS frame, use it for the
live session and the sink, and isolate observations by a key-derived project.

### What to implement
1. **Read a mandatory setup frame before building the client.** Restructure `main.py` `/ws` (`:54-126`):
   - After `await websocket.accept()` (`:57`), `await websocket.receive()` once; parse `json.loads(text)`; require `payload.get("type") == "setup"` and a non-empty `api_key = (payload.get("api_key") or "").strip()` (strip so the backend hash matches the frontend's trimmed value → stable namespace).
   - If missing/invalid: `await websocket.send_json({"type":"error","error":"A Gemini API key is required."})` then `close()` and return.
   - Build the client with the visitor key: `GeminiLive(api_key=api_key, model=MODEL, input_sample_rate=16000)` (replaces `:72-74`). Keep queues/callbacks and the `receive_from_client`/`run_session` structure unchanged — they now run *after* the setup frame is consumed.
2. **Thread the key to the sink.** In `gemini_live.py:40`, change to `make_memory_sink_if_enabled(api_key=self.api_key)`.
3. **Sink: accept the key, derive the namespace, send it at init.** In `claude_mem_sink.py`:
   - `make_memory_sink_if_enabled(api_key=None)` (`:62-70`) → `return MemorySink(api_key=api_key)`.
   - `MemorySink.__init__(self, api_key=None)` (`:74`): normalize ONCE so every downstream use (vision client, namespace, init POST) sees the identical key — `gemini_api_key = (api_key or os.getenv("GEMINI_API_KEY") or "").strip()`; keep using `gemini_api_key` for the vision/invitation client (`:88, :95`).
   - Replace `:76` with a key-derived project (one-way + deterministic so the same key always returns the same memories):
     ```python
     # sha256 is preimage-resistant: the project string can't be reversed to the
     # key, yet the SAME key always hashes to the SAME namespace, so a returning
     # visitor recovers their prior observations. Normalized above so whitespace
     # never forks a visitor into a fresh namespace.
     self.project = (
         f"gemini-live-{hashlib.sha256(gemini_api_key.encode('utf-8')).hexdigest()[:12]}"
         if gemini_api_key else os.getenv("CLAUDE_MEM_PROJECT", "gemini-live-mem")
     )
     ```
     (`hashlib` already imported `:15`.)
   - Store `self._user_gemini_api_key = gemini_api_key`.
   - In `on_session_start()` init body (`:155-160`), add `"geminiApiKey": self._user_gemini_api_key`.

### Verification checklist
- [ ] `grep -n "query\|Query\|api_key" main.py` confirms the key arrives via the setup **message**, not a query param.
- [ ] Two keys → two namespaces: in a Python REPL, `MemorySink(api_key="A").project != MemorySink(api_key="B").project`, and the same key is stable.
- [ ] `_post_observation` still sends no `project` (isolation comes from the init session project) — unchanged.
- [ ] The init POST body includes `geminiApiKey`.

### Anti-pattern guards
- Don't log `api_key` (no `logger.info(... api_key ...)`).
- Don't fall back to a server key for the live session — the setup frame is mandatory; reject the connection if absent.

---

# Phase 4 — Frontend: mandatory key UI + send it as the setup frame

**Repo:** app repo `frontend/`. **Goal:** a required key input that gates Connect,
persists in the browser, and is sent as the first WS frame.

### What to implement (copy existing markup/handlers — see Phase 0 citations)
1. **Key input in the auth panel.** In `index.html`, inside `.auth-section` (`:19-49`), immediately **before** `#connectBtn` (`:48`), add (cloning the `#textInput` markup at `:106-110` + a `.note` helper):
   - `<input type="password" id="apiKeyInput" placeholder="Paste your Gemini API key" />`
   - a `.note`: "Your key stays in your browser and is sent only to start your session. Get one at aistudio.google.com/apikey."
   (Use `type="password"` so it's not shoulder-surfed; inherits `input[type="text"]`-style — add `input[type="password"]` to the `style.css:346` selector list.)
2. **Persist + gate Connect.** In `main.js` (capture pattern `:12-13`, handlers `:307-310`, disable pattern `:210`):
   - On load: `apiKeyInput.value = localStorage.getItem("geminiApiKey") || ""`; set `connectBtn.disabled = !apiKeyInput.value.trim()`.
   - `apiKeyInput.oninput = () => { localStorage.setItem("geminiApiKey", apiKeyInput.value.trim()); connectBtn.disabled = !apiKeyInput.value.trim(); }`.
   - In `connectBtn.onclick` (`:208-223`), pass the key: `geminiClient.connect(apiKeyInput.value.trim())`.
3. **Send the setup frame first.** In `gemini-client.js`, `connect(apiKey)` (`:13-18`): store `this.apiKey = apiKey`; in `ws.onopen`, **before** invoking the existing `onOpen` callback, `this.websocket.send(JSON.stringify({ type: "setup", api_key: this.apiKey }))`. The existing intro (`main.js:71-75`) then sends as the second frame. (WS preserves order → backend reads setup first.)
4. **Surface key/connection errors.** In `handleJsonMessage` (`main.js:102-129`), add a branch for `msg.type === "error"` that shows the message in the status area and re-enables the auth panel, with a hint that some keys lack Gemini **Live** access (ref obs 87664: a key can pass REST yet fail the Live WebSocket).

### Verification checklist
- [ ] With localStorage empty, Connect is disabled and the input is shown.
- [ ] After entering a key and reloading, the key persists and Connect is enabled.
- [ ] In devtools Network → WS frames, the **first** outbound frame is `{"type":"setup","api_key":"…"}`.
- [ ] An invalid key produces a visible error (not a silent dead session).

### Anti-pattern guards
- Don't auto-connect on load — keep the explicit Connect click (`:208`).
- Don't echo the key into the transcript/feed.

---

# Phase 5 — End-to-end verification + deploy

### Local end-to-end (before deploy)
1. Build & run the patched worker locally (or via `claude-mem-docker/start.sh`) pointing at a temp data dir; run `main.py`.
2. Open the UI, paste **Key A** (a real Gemini key with Live access), Connect.
   - [ ] Live audio works (the session uses Key A; server key is empty).
   - [ ] Speak; within a few seconds the live memory feed shows observations (worker generated them with Key A — confirm worker log shows `generateContent` 200s, not 429/400).
3. Isolation test:
   - [ ] `curl 'http://127.0.0.1:37777/api/observations?project=gemini-live-<sha12_of_A>'` returns this session's observations.
   - [ ] Run a second session with **Key B**; `…?project=<sha12_of_B>` returns only B's; A's query still returns only A's. The two sets are disjoint.
   - [ ] **Continuity** (the returning-visitor guarantee): disconnect, reload the page (key auto-fills from localStorage), reconnect with **Key A** → the namespace is byte-identical and A's earlier observations are still in the feed/`/api/observations`. Same key → same memories.
4. "No server key" proof:
   - [ ] With the worker boot key empty and **no** setup key (simulate a malformed client), generation produces no observation and logs a clear failure — our key is never charged.

### Anti-pattern grep sweep
- [ ] `grep -rn "api_key" main.py frontend/ | grep -i query` → empty (key not in URL).
- [ ] `grep -n "gemini-live-mem\"" claude_mem_sink.py` → only the no-key fallback default remains; `self.project` is key-derived.
- [ ] App image: server `GEMINI_API_KEY` is unset/empty; the live session still works via the per-session key.

### Deploy
1. Commit the app-repo changes (frontend, `main.py`, `gemini_live.py`, `claude_mem_sink.py`, `Dockerfile`, `docker-entrypoint.sh`, vendored `claude-mem-docker/worker-service.cjs`).
2. Push to `main` → Fly auto-deploy (`.github/workflows/deploy-fly.yml`). Unset/empty the `GEMINI_API_KEY` Fly secret for this app.
3. Post-deploy: repeat steps 2–3 of the local test against `gemini-live-mem.fly.dev` with two different keys.

### Optional: upstream the worker patch
The Phase 1 edits are a clean, general claude-mem feature ("per-session BYO key"). If
desired, apply the same diff in the primary claude-mem dev checkout and publish a new
version (then the Dockerfile could pin it instead of vendoring) — out of scope for the demo.

---

## Cross-phase risks / notes
- **Worker restart mid-session** loses the in-memory key → that session's later observations fail safe (no server key to fall back to). Acceptable for a demo; this is the intended "never spend our key" behavior.
- **Twilio path** (`main.py:175-191`, `twilio_handler.py`) still references the server `GEMINI_API_KEY`; with it empty, Twilio calls won't work. Out of scope for the public web demo — leave as-is or guard behind its own key later.
- **Key-with-no-Live-access**: some keys pass REST but fail the Live WebSocket (obs 87664). Phase 4 step 4 surfaces this to the visitor rather than failing silently.
