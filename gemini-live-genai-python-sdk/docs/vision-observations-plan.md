# Vision → claude-mem: execution plan

> Plan authored by `make-plan` for execution by `claude-mem:do`.
> Spec: [`docs/vision-observations.md`](./vision-observations.md).
>
> **State at authoring time:** the implementation already exists in the working
> tree and matches the spec. This is therefore a **verify → validate →
> guard → commit** plan, not a from-scratch build. Subagents must NOT rewrite
> working code; they confirm it matches the spec and prove it runs.

---

## Phase 0 — Documentation Discovery (consolidated)

### Allowed APIs (verified against source, not assumed)

**claude-mem worker HTTP API** (`claude_mem_sink.py:85-214`):
- `POST /api/sessions/init` — body `{contentSessionId, project, prompt, platformSource}`
- `POST /api/sessions/observations` — body `{contentSessionId, tool_name, tool_input, tool_response, cwd, platformSource}`
- `GET /api/health` — readiness probe (`claude-mem-docker/start.sh:74`)

**Gemini vision** (`claude_mem_sink.py:179-188`) — the one correct pattern:
```python
client.aio.models.generate_content(
    model="gemini-flash-latest",
    contents=[
        types.Part.from_bytes(data=jpeg_bytes, mime_type="image/jpeg"),
        types.Part(text=prompt),
    ],
)
```

**Gemini Live realtime video** (`gemini_live.py:82-84`):
```python
session.send_realtime_input(video=types.Blob(data=chunk, mime_type="image/jpeg"))
```

### Runtime topology (verified)
- Isolated worker: host `:37778` → container `:37777` (`start.sh:31,66`).
- Sink posts to `CLAUDE_MEM_WORKER_URL=http://127.0.0.1:37778` (`.env`). ✅ matches spec.
- Host `:37777` is the global "code" worker — **do not touch it** (`start.sh:4-6`).
- Mode mounted read-only: `gemini-live.json → /opt/claude-mem/modes/gemini-live.json` (`start.sh:68`).
- Real worker DB lives at `~/.claude-mem/gemini-live-mem/claude-mem.db` (the local
  `claude-mem-docker/data/` copy is a stale snapshot — do NOT verify against it).

### Anti-patterns to guard against (from spec "Do / Don't")
- ❌ dedup / batching / extraction logic in the app (the `NO_CHANGE` delta gate is
  the **only** permitted gating — it is explicitly endorsed by the spec).
- ❌ observation rules ("look for appearance/behavior/…") baked into `VISION_PROMPT`.
- ❌ a new tool name other than `GeminiLiveVision` for frame captions.
- ❌ anything in the caption path that blocks or can crash the live audio session
  (must stay fail-soft).

---

## Phase 1 — Confirm captioner matches spec ("dumb eyes")

**What to verify** against `docs/vision-observations.md` lines 20-32:
1. `VISION_PROMPT` (`claude_mem_sink.py:34-42`) is neutral "describe what you see"
   + the `NO_CHANGE` gate, and contains **no** rules about what matters/what to skip.
2. Captions POST as `tool_name="GeminiLiveVision"` (`claude_mem_sink.py:27,171-175`),
   not a new tool name, not the conversational `GeminiLiveTurn`.
3. `_caption_loop` (`:149-177`) only: sleeps the interval, skips when no new frame
   (`_frame_seq == _last_captioned_seq`), skips on `NO_CHANGE`, posts otherwise.
   No dedup/batch/extract beyond that.
4. `note_latest_frame` (`:103-112`) is cheap, non-blocking, overwrites a single
   latest frame, and is a no-op when vision disabled.
5. The whole path is fail-soft: every caption/post error is swallowed
   (`:163-167`, `_post` `:216-225`).

**Verification checklist:**
- [ ] `grep -n "GeminiLiveVision" claude_mem_sink.py claude-mem-docker/gemini-live.json` — present in both.
- [ ] Read `VISION_PROMPT`; confirm zero observation-type vocabulary
      (no "appearance", "behavior", "environment", "companion") in it.
- [ ] Confirm `_caption_loop` has no list accumulation / batching / no second
      LLM extraction step.

**Anti-pattern guard:** if the prompt contains observation rules or the app contains
extraction/batching → FLAG, do not silently "improve."

---

## Phase 2 — Confirm observer mode is "the brain"

**What to verify** against spec lines 18-23 and `gemini-live.json`:
1. `spatial_awareness` prompt (`gemini-live.json:90`) instructs the observer that
   `GeminiLiveVision.tool_response.description` is direct visual observation, that
   consecutive messages describe the same evolving scene, and that they must
   **never** be recorded as a `tool-call`.
2. The 7 observation types include `person, companion, behavior, appearance,
   environment, conversation, tool-call` (`:5-55`) — so vision captions can land
   as appearance/behavior/environment/companion/person.
3. All "what to look for / what to skip" intelligence lives here
   (`recording_focus` `:92`, `skip_guidance` `:93`), NOT in the app.

**Verification checklist:**
- [ ] `python -c "import json;json.load(open('claude-mem-docker/gemini-live.json'))"` — valid JSON.
- [ ] `grep -n "GeminiLiveVision" claude-mem-docker/gemini-live.json` — appears in `spatial_awareness`.
- [ ] Confirm `spatial_awareness` says GeminiLiveVision is NOT a tool-call.

---

## Phase 3 — End-to-end runtime validation (the real proof)

**Goal:** a synthetic frame produces a `GeminiLiveVision` observation that the
worker extracts into a presence observation in the **real** DB.

**Steps (copy the proven path from session memory obs 87095/87102):**
1. Ensure the isolated worker is up: `curl -sf http://127.0.0.1:37778/api/health`.
   If down, start via `claude-mem-docker/start.sh` and wait for "worker healthy".
2. Drive the sink directly (no full Gemini Live session needed): instantiate
   `MemorySink`, `on_session_start()`, feed it a **real JPEG** via
   `note_latest_frame(jpeg_bytes)`, let `_caption_loop` run one interval, then
   `on_session_end()`. Use a genuine photographic JPEG — a malformed synthetic PNG
   caused the historical 400 INVALID_ARGUMENT (obs 87082-87083); do NOT repeat that.
3. Confirm a `GeminiLiveVision` observation was POSTed (sink debug log
   `/api/sessions/observations -> 200`).
4. Confirm the worker stored a presence observation of type
   appearance/environment/etc. in `~/.claude-mem/gemini-live-mem/claude-mem.db`
   (NOT the stale `claude-mem-docker/data/` path).

**Verification checklist:**
- [ ] Health endpoint returns 200.
- [ ] Sink logs a 200 from `/api/sessions/observations` for a `GeminiLiveVision` post.
- [ ] A new row appears in the real worker DB with a non-`tool-call` type.
- [ ] The global `:37777` worker was never contacted (grep config / no posts there).

**Anti-pattern guard:** do not "fix" a failing vision call by switching to a synthetic
image — fix the input to a valid JPEG. Do not point validation at the stale local DB.

---

## Phase 4 — Code quality + commit

1. **Code-quality review** of the three files: fail-soft preserved, no blocking
   calls on the audio path, naming/comments consistent with surrounding code.
2. **Anti-pattern sweep** (grep): no batching/dedup/extraction added to the app
   beyond the `NO_CHANGE` gate; no observation rules in `VISION_PROMPT`.
3. **Commit only if Phases 1-3 all verified.** Branch is
   `gemini-live-isolated-mem-worker` (feature branch, not main — safe to commit).
   Stage the vision feature files + this plan + the design doc. Commit message must
   describe the autonomous vision captioner pipeline.

**Verification checklist:**
- [ ] All Phase 1-3 boxes checked.
- [ ] `git status` shows only intended files staged.
- [ ] Commit created on the feature branch; nothing pushed unless asked.

---

## Final verification
- [ ] Implementation matches `docs/vision-observations.md` division of labor.
- [ ] E2E proof captured (a real `GeminiLiveVision` → stored presence observation).
- [ ] No anti-patterns present.
- [ ] Working tree committed on the feature branch.
