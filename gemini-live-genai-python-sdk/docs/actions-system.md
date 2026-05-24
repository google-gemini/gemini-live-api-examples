# Actions System — Intuitive Triggers, Explicit Links

*Status: design proposal · 2026-05-24 · companion to `observation-strategy.md`*

## Two triggers exist today — one is the model, one is the anti-pattern

We already ship two ways an observation can cause an action. They are philosophically opposite, and the better one should eat the other.

**Anti-pattern — `EVENT_PLANNING_PATTERN` (code-side regex).** A 10-line regex enumerating `party|wedding|bbq|housewarming|…`. It's "deliberately broad" and still misses *"we should get everyone over for Mom's 60th"* because that hits no keyword. The trigger logic lives in Python, away from the prompt config, and only fires on words it was pre-told to expect. Every new phrasing is a code change.

**The model — `security_alert → Telegram` (brainbeat).** The LLM observer *semantically* decides "this is a secret being exposed," tags the observation `security_alert`, and a configurable watcher fires the push. The trigger is **fuzzy** (the model judges intent), the link is **explicit** (the type tag), and the wiring is **config** (`TRIGGER_TYPES=security_alert`), not code.

Your instinct is the brainbeat generalized: **loose recognition, strict linkage.** Make the *front door* intuitive (recognize what a moment is reaching toward, not the words it used), and make the *contract* explicit (if an observation fires an action, it carries an attribute naming that action — and that action must exist in a registry).

## The principle in one sentence

> If you can name the action a moment is reaching toward, you don't need to name the words it used.

Fuzziness lives in **recognition** — the observer's job. Precision lives in **linkage** — a hard reference from the observation to a declared action. The two never blur into each other.

## The attribute contract

Two rules, both directions:

1. **If an observation triggers an action, it MUST carry an `action` attribute.** No hidden, code-side triggers. The reason a thing happened is always visible on the element that caused it — auditable, replayable, testable.
2. **An `action` attribute MUST reference an action declared in the registry.** Fail-fast: the observer cannot invent an action that has no handler. Unknown id → logged + dropped, never silently swallowed.

An action-bearing observation looks like:

```jsonc
{
  "type": "conversation",
  "facts": ["The user and Spencer agreed to get the team together for a launch dinner next Friday at 7pm"],
  "action": {
    "id": "generate_invitation",          // MUST exist in the registry
    "confidence": 0.85,                    // recognition was fuzzy — say how sure
    "payload": {                           // what the action needs, already extracted
      "occasion": "launch dinner",
      "date": "next Friday", "time": "7pm",
      "guests": "the team"
    }
  }
}
```

The observation is still a normal memory record. The `action` attribute is the *only* thing that turns it into a trigger. Strip it and nothing fires.

## The actions registry — and why it doubles as the trigger spec

A declared catalog. Each entry is plain English describing *when the action wants to fire* and *what it needs*:

```jsonc
"actions": {
  "generate_invitation": {
    "when":  "People are arranging to bring others together at a future time or place.",
    "needs": ["occasion", "date?", "time?", "location?", "guests?", "theme?"],
    "fire_at_confidence": 0.7,
    "debounce": "one in flight"
  },
  "push_alert": {
    "when":  "Something just happened that the user would want to know immediately.",
    "needs": ["what_happened", "why_it_matters"],
    "fire_at_confidence": 0.6
  },
  "add_to_calendar": {
    "when":  "A specific future commitment with a time was made.",
    "needs": ["what", "date", "time?", "with_whom?"],
    "fire_at_confidence": 0.75
  },
  "surface_memory": {
    "when":  "Someone reaches for something past — a name, an earlier session, or is visibly searching.",
    "needs": ["what_theyre_after"],
    "fire_at_confidence": 0.5
  }
}
```

**The elegant part:** the registry's `when` fields *are* the trigger spec. They get injected into the observer prompt as the menu of actions it's allowed to reach for. The observer asks, per moment, *"is this reaching toward any action I know about?"* — not *"did the text match a keyword?"* Adding a new action is one registry entry in plain English; the observer's fuzzy recognition starts watching for it automatically. This is the "easy ability to augment" goal from `observation-strategy.md`, applied to actions: **one entry, no code.**

## Intuitive trigger catalog

Worked examples of triggers that *relate to* an action without being specific about wording. Each `when` is an intent shape, not a keyword list:

| Action | Intuitive trigger (the intent shape) | Misses today because… |
|---|---|---|
| **generate_invitation** | People are coordinating to gather others later — "get everyone over," "do something for Mom's 60th," "we should all meet up." No word "party" required. | regex needs an enumerated noun |
| **add_to_calendar** | A future commitment with a time got pinned — "let's sync Tuesday at 3," "I'll call them tomorrow AM." | no trigger exists |
| **push_alert** | Something happened the user would want *now* — a secret exposed, a deadline named as imminent, a sharp emotional spike. | only `security_alert` is wired |
| **surface_memory** | Someone reaches backward — "what was that thing we…," a familiar name returns, or they're visibly stuck searching. | no trigger exists |
| **capture_wish** | An unmet want surfaces — "I wish I had…," "we really need a…," lingering on something they like. | no trigger exists |
| **session_recap** | The session is winding down — goodbyes, "alright that's it," wrap-up language. | no trigger exists |
| **offer_help** | Visible friction on a task — repeated attempts, sighs, "this isn't working." | no trigger exists |
| **greet_returning_person** | A newly-introduced person matches someone from a past session — recall the prior context unprompted. | recognition exists, no action |

The first row alone justifies the migration: the launch-dinner example at the top of this doc fires `generate_invitation` under the semantic trigger and is *invisible* to the regex.

## The dispatcher (brainbeat, generalized)

One loop, replacing both the regex call and the type-specific Telegram watcher:

1. Observation arrives. No `action` attribute → store and move on.
2. Has `action` → look up `id` in the registry. Unknown → log + drop (rule 2).
3. `confidence ≥ fire_at_confidence` → dispatch with `payload`. Below → queue for confirmation (or drop, per action policy).
4. Honor `debounce` (e.g. one invitation in flight — the single-flight guard `_maybe_trigger_invitation` already has, now generic).

Recognition is fuzzy, so the dispatcher is where safety lives: **confidence gates, debounce, and per-action dry-run.** High-confidence, low-cost actions (surface a memory) auto-fire; high-cost or outward-facing ones (send a message, spend image-gen tokens) can require a higher bar or a confirm step.

## Migration path

1. Add the `actions` registry to `gemini-live.json` (sits beside `observation_types`).
2. Inject each action's `when` into `recording_focus` as "actions you may trigger," and add a few-shot showing the `action` attribute populated (the `security_alert` example proved few-shots are the highest-leverage shaping tool — #87360).
3. Build the generic dispatcher; point the existing invitation renderer and Telegram notifier at it as the first two registered handlers.
4. **Delete `EVENT_PLANNING_PATTERN`.** Its job is now `generate_invitation`'s `when` clause plus the observer's judgment.

## Concrete prompt addition (`recording_focus`)

> **ACTIONS** — Some moments call for an action, not just a memory. You may trigger any action listed below. When a moment reaches toward one, add an `action` block to that observation naming the action `id`, your `confidence` (0–1), and the `payload` it needs. Recognize the *intent*, not specific words — "let's get everyone together for Mom's birthday" is an invitation even though it never says "party." Never invent an action that is not in this list. Available actions:
> - `generate_invitation` — people are arranging to gather others at a future time/place
> - `add_to_calendar` — a specific future commitment with a time was made
> - `push_alert` — something happened the user would want to know immediately
> - `surface_memory` — someone is reaching for something from the past

## One-line summary

Stop matching keywords; start recognizing intent. Let the observer name the action a moment reaches toward, make it stamp that action onto the observation as an explicit, registry-backed attribute, and let one dispatcher fire it — fuzzy at the door, strict on the contract, and a new action is one plain-English line in the registry.
