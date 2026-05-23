# Vision → claude-mem: what to do

**Goal:** the claude-mem stream on `:37778` shows real-time observations of the
video feed **without any user intervention** (no one has to talk).

## How it works

1. **Describe the frame.** Every few seconds, take the latest video frame (the
   exact bytes sent to Gemini) and ask a Gemini vision model for a **plain
   textual description** of it — or the literal word `NO_CHANGE` if it's
   materially the same as the previous description.
2. **Send it straight to the observer.** If it's not `NO_CHANGE`, POST that text
   to the claude-mem worker (`:37778`) as a `GeminiLiveVision` tool-use message.
   That's the whole job of the captioner.
3. **The observer does the rest.** The worker extracts observations from those
   messages on its own cadence and they appear in the stream.

## Division of labor (do not blur this)

- **Captioner = dumb eyes.** Frame → text, or `NO_CHANGE`. Nothing else.
- **Observer mode = the brain.** *All* of "what to look for" and "what to skip"
  lives in the observer mode (`gemini-live.json`). claude-mem already decides how
  many tool-use messages combine into an observation — that's built in.

## Do / Don't

- ✅ Keep the caption prompt neutral: "describe what you see," plus the
  `NO_CHANGE` gate. That's it.
- ✅ Put every instruction about *what matters* and *what to ignore* in the mode.
- ❌ Don't build dedup, batching, or extraction logic in the app.
- ❌ Don't bake observation rules ("look for appearance/behavior/…") into the
  caption prompt.

## Files

- `claude_mem_sink.py` — the dumb captioner (frame → text → POST).
- `claude-mem-docker/gemini-live.json` — the observer mode (the intelligence).
