# Observation Strategy — What Memi Should Watch For

*Status: design proposal · 2026-05-24 · grounded in the 420-observation demo corpus and the centralized prompt config*

## The gap, in one example

During the demos two objects got noticed on people's heads:

- **The "Internet hat"** became a recurring identity anchor for Alex. Memi attached it to *who he is* — it shows up across sessions as a recognition signal.
- **Spencer's headphones** were recorded as bare presence ("headphones on his head"). The single most obvious feature — they're **pink** (large over-ear, likely AirPods Max) — was never captured. Lighting may have pushed the pink toward silver, so the observer hedged by dropping the attribute entirely.

Same kind of object, two very different outcomes. The hat got an *identity*; the headphones got a *noun*. That difference is the whole problem we need to fix: **Memi reliably logs that a thing is present, but not what makes that thing identifiable next time.**

## Root cause — two prompts, two misses

The observation pipeline has two LLM stages, and the gap lives in both:

1. **`prompts.json → vision_captioner.prompt`** (the raw frame describer)
   > "Describe what is currently visible … 1-3 concise, plain sentences … Report only what you can see; **do not editorialize**."

   This actively suppresses detail. "Concise" + "do not editorialize" gets read as "headphones" instead of "large pink over-ear headphones." Color, brand, and text are exactly the "editorializing" the prompt discourages — but they're the highest-value bits for memory.

2. **`gemini-live.json → recording_focus`** (the synthesizer that mines frames + transcript into typed observations)
   > "Distinctive accessories: hats, headphones, glasses, badges, lanyards"

   It names accessory **types** but never asks for their **attributes**. The observer dutifully records the noun and stops. There's no instruction that says *for each notable object, capture its color, brand/model, and any visible text.*

So the system is doing exactly what it was told. The fix is prompt direction, not code.

## The principle: capture the distinguishing attribute, not just the noun

For anything worth noting, the memory value is in **what would let you recognize or describe it again.** A noun is a placeholder; the adjective is the memory.

| Logged today | What it should be |
|---|---|
| "headphones on his head" | "large over-ear headphones, **pink** (could read silver under warm lighting — **likely AirPods Max**)" |
| "wearing a hat" | "a knit beanie with an **'Internet' wordmark** across the front" |
| "at a desk with a laptop" | "a **stickered MacBook**, lid covered in dev-tool logos" |
| "someone showed a phone screen" | "showed a phone screen — **a Telegram chat**, light theme" |

The rule of thumb: **noun → color → brand/model → text/logo → size/style → condition.** Walk that ladder as far as the frame allows, then stop.

## Handling uncertainty (the lighting problem)

The headphones got dropped because pink-under-warm-light is ambiguous. That instinct is backwards. **A hedged attribute beats a missing one.** Record the best read, flag the doubt, and include the disambiguating cue:

> "pink, though warm lighting could make it read silver — large over-ear form factor suggests AirPods Max"

Next session, if the same headphones appear under different light, Memi has two data points to reconcile instead of zero. Never omit a salient feature solely because you're unsure of it — **observe it with a confidence hedge.**

## What to observe "for most purposes"

Ranked by the value humans actually placed on it in the demos (what they probed, praised, and asked Memi to recall):

1. **Identity & recognition signals** — *highest value.* The entire demo kept returning to "does it remember me?" Capture: stated names and whose they are, the durable visual anchor (the hat), and any cue that a past-session person has returned (familiar name/face/voice). This is what makes cross-session memory feel real.

2. **Salient appearance & object attributes** — the gap this doc fixes. For each person and each notable object, walk the attribute ladder (color → brand/model → text → style → condition). This is where the pink headphones live.

3. **Emotional state & shifts** — users explicitly asked Memi to retrieve "the times I got happy" and "the times I was frustrated or confused." Emotion is a first-class retrieval axis, not flavor text. Capture demeanor, energy, and *transitions* (relief, frustration, delight), tied to what triggered them.

4. **Companions & relationships** — who else is present, their relationship to the user, how they interact (Alex's wife entering; Spencer being introduced). High-signal for the social graph.

5. **Environment synthesis** — recurring background elements (mural, tables, people on laptops) that let Memi *infer the setting* ("you're at a hackathon"). The win here is the inference, not the inventory.

6. **Stated facts, preferences & plans** — location, role, what they're building, likes/dislikes ("prefers music over voices in the background"). The substance of conversation.

7. **Actionable triggers** — event-planning details (occasion, date, guests, theme) that fire downstream actions like the invitation generator. Narrow but high-leverage. See `actions-system.md` for how to make these triggers intuitive (recognize intent, not keywords) while keeping the observation→action link explicit.

Tiers 1–3 are the ones the demo proved people care about most and the ones we're currently weakest on (esp. 2). Tiers 4–7 are already reasonably covered by `recording_focus`.

## Make it easy to augment

The purpose-specific part of "what to watch for" is dynamic, as you noted — a retail demo wants brands/prices, a childcare demo wants the kids, a security demo wants exposed secrets. Two things make this easy:

**Both edit surfaces are already centralized** (good — recent prompt-centralization work did this):
- `prompts.json → vision_captioner.prompt` — tune what the *raw describer* bothers to mention.
- `gemini-live.json → recording_focus` — tune what the *synthesizer* promotes into durable memory.

**Proposal: a swappable "focus overlay."** Keep the default profile above as the base, then add a named, purpose-specific block appended to `recording_focus` at runtime. e.g.:

```jsonc
"focus_overlays": {
  "default":   "",                       // the base profile only
  "retail":    "Prioritize product brands, models, prices, and packaging text.",
  "childcare": "Prioritize children present: count, names, activity, safety.",
  "event":     "Prioritize guests, occasion, date, venue, and theme details.",
  "security":  "Prioritize any credential, key, or sensitive screen visible."
}
```

Select with an env var (`MEMI_FOCUS=retail`) or per-session config. The base profile always runs; the overlay just re-weights attention. This gives "most purposes covered by default, one line to specialize."

## Concrete prompt edits (ready to paste)

**1. `prompts.json → vision_captioner.prompt`** — stop suppressing salient detail:

> You are an automatic camera feed for a memory system. Describe what is currently visible in this frame in 1-3 concise sentences — who is present, what they are doing, and the setting. **For any notable person or object, include its most distinguishing features: color, brand or model, and any visible text or logo. If a feature is ambiguous under the lighting, give your best read and flag it (e.g. "pink, though could read silver") rather than omitting it.** Report what you see; do not invent detail you cannot observe.

(Note: dropped "do not editorialize" — it was misfiring as "stay vague." The "do not invent" clause keeps it honest without suppressing real attributes.)

**2. `gemini-live.json → recording_focus`** — replace the bare accessory bullet:

> - Distinctive accessories and notable objects — and **their salient attributes**: for hats, headphones, glasses, badges, devices, etc., capture the color, brand/model, and any text or logo (e.g. "pink over-ear headphones, likely AirPods Max"; "a beanie with an 'Internet' wordmark"). When lighting makes a feature uncertain, record your best read with a hedge rather than dropping it.

## One-line summary

Memi already sees the headphones — it just isn't allowed to tell us they're pink. Teach both prompt stages to walk *noun → color → brand → text*, hedge uncertainty instead of dropping it, and keep a swappable focus overlay so "most purposes" works out of the box and specializing takes one line.
