# Execution Plan — Intuitive-Trigger Actions System

*Plan for implementing `actions-system.md` + the prompt edits in `observation-strategy.md`. Scope: **full cross-repo** (Python sink in this repo + claude-mem worker in the claude-mem repo). Authored 2026-05-24.*

> **Read first:** `docs/actions-system.md` (design) and `docs/observation-strategy.md` (prompt edits). This plan turns those into phased, copy-from-source tasks. Each phase is self-contained and can run in a fresh context.

---

## The architectural truth this plan is built on

Discovery confirmed the system has **two structurally different action paths**, and the plan respects both rather than forcing them into one:

| | **Outward actions** (Telegram, webhook, calendar) | **Live actions** (event invitation) |
|---|---|---|
| Recognized by | Observer LLM (worker) stamps `<action>` in its XML | Local intent gate in the Python sink |
| Fires | *After* the observation is stored, outward | *Into the live frontend* via `self.emit` |
| Lives in | **claude-mem repo** (worker, TS) | **this repo** (`claude_mem_sink.py`, Python) |
| Why it can't move | — | Worker has **no path to the live UI**; only the sink's `self.emit` reaches it |

Both paths share **one contract** (`actions-system.md`): if an element triggers an action, it carries an explicit `action` attribute referencing a **declared** action; recognition is fuzzy, linkage is strict. The action registry's plain-English `when` descriptions feed **both** recognizers.

**Single source of truth for action *definitions*:**
- `claude-mem-docker/gemini-live.json → action_types` — the canonical registry the **observer/worker** reads (mounted into docker via `start.sh`).
- `prompts.json → actions` — the subset of *live-fireable* actions the **Python sink** reads (currently just `generate_invitation`). `_meta` cross-references gemini-live.json as canonical.

---

## Phase 0 — Prerequisites & Allowed-APIs (do first, no code)

**Confirm the claude-mem source checkout** (NOT the plugin cache — cache edits get clobbered on reinstall):
- ✅ Recommended target: **`~/Scripts/claude-mem`** (remote `github.com/thedotmack/claude-mem`, has `src/sdk/parser.ts`). It is on branch `guard-hardening-follow-up` with 1 dirty file — **confirm the right branch and a clean tree before editing.**
- ❌ Do NOT edit `~/.claude/plugins/cache/...` (read-only cache) or `~/.claude/plugins/marketplaces/thedotmack` (marketplace checkout) as the primary target.
- Verify: `git -C ~/Scripts/claude-mem remote -v` shows thedotmack/claude-mem; `ls ~/Scripts/claude-mem/src/services/integrations/TelegramNotifier.ts` exists.

**Allowed APIs / facts (cite these; do not invent):**

*This repo (`gemini-live-genai-python-sdk/`):*
- `prompts.py` loads `prompts.json` fail-fast at import (`PROMPTS = json.load(...)`). Access via `PROMPTS["section"]["key"]`.
- `claude_mem_sink.py`: `MemorySink.__init__` lines 74–133. `EVENT_PLANNING_PATTERN` lines 48–59, used **only** at line 269. Single-flight guard pattern lines 271–276. `_generate_and_emit_invitation` line 279, `_extract_event_details` line 320, `_render_invitation_image` line 334. `self.emit({...})` lines 305–310. `_post_observation(tool_name, tool_input, tool_response)` lines 501–512 → POSTs `/api/sessions/observations`. Vision loop `_caption_loop` lines 204–232 (interval-gated, fail-soft) — the model pattern for a debounced background LLM pass.
- `claude-mem-docker/gemini-live.json`: `observation_types` lines 5–69, `observation_concepts` lines 70–101, `prompts` object lines 102–135. **No `action_types` block exists yet.** Insertion point for the registry: between `observation_concepts` (ends ~101) and `prompts` (~102).

*claude-mem repo (`~/Scripts/claude-mem/src/`):*
- `sdk/parser.ts` lines 15–150: `ParsedObservation` interface (8 fields: type, title, subtitle, facts, narrative, concepts, files_read, files_modified). **Parser silently drops unknown XML tags** — `<action>` MUST be explicitly extracted or it is lost.
- `services/sqlite/SessionStore.ts` `storeObservations()`: INSERT already includes a `metadata` column and passes `observation.metadata ?? null`. **`metadata TEXT` column exists** (migration #2116), currently unpopulated by the parse flow → **no DB migration needed.**
- `services/worker/agents/ResponseProcessor.ts` lines 17–144: parses XML → labels obs with agent_type/agent_id → `storeObservations(...)` → **fire-and-forget** `void notifyTelegram({...})` at lines 116–121.
- `services/integrations/TelegramNotifier.ts` lines 66–107: `notifyTelegram(input)` reads settings, splits `CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES` / `_TRIGGER_CONCEPTS` CSV, matches `obs.type` / `obs.concepts`, sends. **This is the pattern `ActionsDispatcher` generalizes.**
- `claude-mem-docker/start.sh` lines 48–94: renders host `~/.claude-mem/settings.json` keys into the docker worker env — the path any new action settings keys must travel.

**Anti-patterns to guard against:**
- ❌ Adding a DB migration / new `action` column — use the existing `metadata` JSON column.
- ❌ Assuming the parser preserves `<action>` — it does not; extract explicitly.
- ❌ Moving the invitation into the worker — impossible (no frontend path); it stays Python-side.
- ❌ Breaking the existing `security_alert → Telegram` behavior — `TRIGGER_TYPES` matching must keep working (back-compat).
- ❌ Editing the plugin cache instead of the source repo.
- ❌ Blocking the live audio session — every new path must be `asyncio` non-blocking and fail-soft (swallow errors, log, continue), like `_caption_loop` and `_post`.

---

## Phase 1 — Shared registry + prompt edits (this repo; safe, no behavior change)

**What to implement (copy the shapes already in these files):**

1. **`claude-mem-docker/gemini-live.json` — add `action_types` registry** between `observation_concepts` and `prompts`. Mirror the `observation_types` object shape (id/label/description), adding `when`, `needs`, `fire_at_confidence`:
   ```jsonc
   "action_types": [
     { "id": "generate_invitation", "label": "Generate Invitation",
       "when": "People are arranging to bring others together at a future time or place.",
       "needs": ["occasion","date?","time?","location?","guests?","theme?"], "fire_at_confidence": 0.7 },
     { "id": "push_alert", "label": "Push Alert",
       "when": "Something just happened the user would want to know immediately.",
       "needs": ["what_happened","why_it_matters"], "fire_at_confidence": 0.6 }
   ]
   ```
2. **`gemini-live.json → prompts.action_guidance`** (new key) + **append an `<action>` few-shot to `format_examples`** — follow the existing `security_alert` few-shot style (proven highest-leverage shaping, per obs #87360). Instruct: recognize *intent not keywords*; emit `<action><id>…</id><confidence>…</confidence><payload>{…}</payload></action>`; never invent an unlisted action.
3. **`gemini-live.json → prompts.recording_focus`** — apply the `observation-strategy.md` edit: replace the bare accessory bullet with the salient-attribute ladder (color → brand/model → text/logo) + uncertainty-hedge instruction.
4. **`prompts.json → vision_captioner.prompt`** — apply the `observation-strategy.md` edit: drop "do not editorialize", add "include distinguishing features (color, brand/model, visible text); hedge ambiguous features rather than omitting"; add "do not invent" clause.
5. **`prompts.json → actions`** (new top-level section) — the live-fireable subset for the Python gate, with `_meta` note that `gemini-live.json` is canonical:
   ```jsonc
   "actions": {
     "generate_invitation": { "when": "People are arranging to gather others at a future time/place.",
       "needs": ["occasion","date","time","location","host","guests","theme","image_prompt"], "fire_at_confidence": 0.7 }
   }
   ```

**Verification checklist:**
- `python3 -c "import json,sys; [json.load(open(f)) for f in ['gemini-live-genai-python-sdk/prompts.json','gemini-live-genai-python-sdk/claude-mem-docker/gemini-live.json']]; print('JSON OK')"`
- `cd gemini-live-genai-python-sdk && python3 -c "import prompts; print(prompts.PROMPTS['actions']['generate_invitation']['when'])"` → prints the string (fail-fast loader works).
- Grep confirms `action_types` present in gemini-live.json and `actions` present in prompts.json.

**Anti-pattern guard:** This phase changes only prompt/config text. The observer may begin emitting `<action>` XML, but until Phase 3 the parser drops it — that is **safe and intended** (no broken behavior).

---

## Phase 2 — Python intent gate + generic dispatcher; retire the regex (this repo)

**What to implement (copy from the named methods):**

1. **Load the registry:** `ACTIONS = PROMPTS["actions"]` at module top (beside `VISION_PROMPT`, line 42).
2. **Add `_recognize_action(self, window_text)`** — a lightweight, fail-soft LLM call (copy the `_extract_event_details` call shape, lines 320–332: same `self.vision_model`, same ```json fence-strip, `json.loads`). Prompt it with the registry `when`/`needs` and return `{"id": str|None, "confidence": float, "payload": {...}}`. This **replaces `EVENT_PLANNING_PATTERN.search`**.
3. **Add `_dispatch_action(self, recognition, window_text)`** — generalize `_maybe_trigger_invitation` (lines 265–277): per-action single-flight map `self._action_tasks: dict[str, asyncio.Task]` (replaces the single `self._invitation_task`); gate on `confidence >= fire_at_confidence` from `ACTIONS[id]`; look up handler in `self._action_handlers`; unknown id → log + drop (contract rule 2).
4. **Run the gate debounced/non-blocking** — call from `_flush_turn` (line 263) but rate-limit like `_caption_loop` (e.g. only when `_recent_turns` grew and no recognition ran in the last N seconds). Keep it an `asyncio.create_task`, fail-soft.
5. **Register `generate_invitation` handler** = a thin wrapper over the existing `_generate_and_emit_invitation` (line 279), now fed the gate's `payload` (skip re-extraction when payload is complete; otherwise fall back to `_extract_event_details`). Keep the SHA1 dedup (lines 291–295) and `self.emit` push (lines 305–310) exactly.
6. **Stamp the action onto memory** — in the `EventInvitationGenerated` `_post_observation` (lines 314–318), add the action id/confidence into `tool_input` so the stored record carries the explicit link (contract rule 1) even on the live path.
7. **DELETE `EVENT_PLANNING_PATTERN`** (lines 45–59) and its reference (line 269).

**Verification checklist:**
- Unit/scratch test feeding turns to `_recognize_action`: keyword phrasing ("planning a birthday party") → `generate_invitation`; **novel phrasing** ("we should get everyone over for Mom's 60th") → `generate_invitation` (the regex missed this); unrelated chatter → `id: None`.
- Single-flight: two event turns back-to-back spawn **one** task; dedup blocks a duplicate signature.
- `grep -rn EVENT_PLANNING_PATTERN gemini-live-genai-python-sdk/` → **no matches**.
- Fail-soft: malformed LLM JSON / network error in the gate does not raise into the session loop.

**Anti-pattern guard:** Do not block `_flush_turn` on the gate; do not let a gate exception escape; do not regress the invitation's frontend `emit` payload shape (`{"type":"event_invitation","details":…,"mime_type":…,"image_base64":…}`).

---

## Phase 3 — Worker parser captures `<action>` (claude-mem repo)

**What to implement (extend `src/sdk/parser.ts`):**

1. Extend `ParsedObservation` (interface ~lines 15–24): add `action?: { id: string; confidence?: number; payload?: Record<string, unknown> }`.
2. Add `extractActionBlock(content)` helper (copy the structure of the existing field/array extractors): regex `/<action>([\s\S]*?)<\/action>/`, pull `<id>`, `<confidence>`, `<payload>` (JSON.parse, tolerate invalid → undefined). Return `undefined` when absent or no `id`.
3. Call it in the per-observation parse (after concepts extraction ~line 103); attach to the returned object.

**Verification checklist:**
- Add a parser unit test: XML with a well-formed `<action>` → `obs.action.id` set, payload parsed; XML without `<action>` → `obs.action === undefined` (existing tests unaffected); malformed `<payload>` JSON → action present, payload undefined (no throw).
- `cd ~/Scripts/claude-mem && <pkg typecheck cmd>` passes.

**Anti-pattern guard:** Don't change any of the 8 existing extracted fields; `<action>` is purely additive.

---

## Phase 4 — Persist action in `metadata` + track tool_name (claude-mem repo)

**What to implement (`ResponseProcessor.ts` + provider):**

1. Where observations are labeled before `storeObservations` (~lines 71–75), build a `metadata` object `{ tool_name: session.lastToolName ?? null, ...(obs.action ? { action: obs.action } : {}) }` and set `metadata: JSON.stringify(metadata)` on each labeled obs. `storeObservations` already persists `observation.metadata ?? null` — **no schema change**.
2. Track `session.lastToolName`: add the field to the active-session type and set it in the Claude/Gemini provider where each message's `tool_name` is read for `buildObservationPrompt`.

**Verification checklist:**
- Process a synthetic observer response containing `<action>`; query the DB row → `metadata` JSON contains `action` and `tool_name`.
- An observation **without** an action stores `metadata` with just `tool_name` (or null) — no regression to existing rows.
- Typecheck passes.

**Anti-pattern guard:** Do not add a DB migration. Do not break observations that have no action (metadata stays optional/nullable).

---

## Phase 5 — `ActionsDispatcher` generalizes the brainbeat (claude-mem repo)

**What to implement (new `src/services/integrations/ActionsDispatcher.ts`):**

1. Copy `notifyTelegram`'s skeleton (TelegramNotifier.ts lines 66–107): same `ActionDispatchInput` shape (`observations`, `observationIds`, `project`, `memorySessionId`), same settings-load, same **fire-and-forget** semantics.
2. For each obs with `obs.action` (or `metadata.action`): confidence-gate (`>= fire_at_confidence` if present), then `switch(action.id)` → handler. Unknown id → `logger.warn` + skip (contract rule 2).
3. Handlers: `telegram` (reuse the existing `postOne`/`formatMessage` from TelegramNotifier, honoring `payload` overrides like chat_id/priority), and a generic `webhook_post` (POST obs JSON to `payload.url`).
4. **Preserve the existing brainbeat:** keep `notifyTelegram`'s `TRIGGER_TYPES`/`TRIGGER_CONCEPTS` path working as-is for `security_alert` (back-compat). Wire `dispatchActions({...})` as an additional fire-and-forget call right after `notifyTelegram` in ResponseProcessor (~line 121). (Do NOT delete `notifyTelegram` — the two coexist: type/concept-triggered pushes vs. explicit-action dispatch.)
5. Route any new settings keys through `start.sh` (lines 48–94) the same way the Telegram keys travel.

**Verification checklist:**
- Regression: an observation typed `security_alert` with `CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES=security_alert` **still** pushes to Telegram.
- New path: an observation carrying `action.id=push_alert` routes through the dispatcher's telegram handler; `action.id=webhook_post` POSTs to the configured URL; an unknown id is logged and dropped, session continues.
- Typecheck + existing integration tests pass.

**Anti-pattern guard:** Dispatcher is fire-and-forget (`void`, no `await` in the hot path) and must never throw into `ResponseProcessor`. Don't regress `notifyTelegram`.

---

## Phase 6 — End-to-end verification

1. **Live invitation (novel phrasing):** run a session; speak event-planning intent that uses **no** legacy keyword ("let's get the crew together for Dana's send-off Friday"). Confirm: invitation image appears in the frontend **and** the `EventInvitationGenerated` observation's `tool_input` carries the action id/confidence.
2. **Outward action via observer:** drive observer input that should yield an outward action; confirm the stored observation's `metadata.action` is populated (Phase 4) and `ActionsDispatcher` fired the handler (Phase 5).
3. **Brainbeat regression:** `security_alert` still reaches Telegram.
4. **Salient-attribute prompt:** show the camera a colored, branded object; confirm the vision caption now includes color/brand (and hedges when ambiguous) rather than a bare noun.
5. **Static checks:** both JSON configs valid; `grep -rn EVENT_PLANNING_PATTERN` empty; claude-mem repo typecheck + tests green; no DB migration was added.

---

## Phase/file map at a glance

| Phase | Repo | Files |
|---|---|---|
| 1 | this | `claude-mem-docker/gemini-live.json`, `prompts.json` |
| 2 | this | `claude_mem_sink.py` (+ `prompts.json` actions consumed) |
| 3 | claude-mem | `src/sdk/parser.ts` |
| 4 | claude-mem | `src/services/worker/agents/ResponseProcessor.ts`, active-session type, provider |
| 5 | claude-mem | `src/services/integrations/ActionsDispatcher.ts` (new), `claude-mem-docker/start.sh` |
| 6 | both | verification only |

Phases 1–2 ship value in this repo alone (intuitive invitation trigger + better vision). Phases 3–5 are the claude-mem-repo half that stamps the explicit `action` attribute and generalizes the brainbeat. Land them as two PRs (one per repo); Phase 1 is a safe precursor to both.
