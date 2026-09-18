import assert from "node:assert/strict";
import test from "node:test";

import { ListeningMixController } from "../src/listening-mix-controller.mjs";

const controller = new ListeningMixController();

test("same-language speech is one foreground original track", () => {
  assert.deepEqual(controller.planFor({
    listener: { id: "ja-listener", language: "ja" },
    speakers: [{ id: "ja-speaker", language: "ja" }],
    focusSpeaker: { id: "ja-speaker", language: "ja" },
  }), {
    mode: "same-language-original",
    tracks: [
      { trackId: "original:ja-speaker", kind: "original", role: "foreground", gain: 1 },
    ],
  });
});

test("foreign speech keeps original quieter than the foreground translation", () => {
  const plan = controller.planFor({
    listener: { id: "ko-listener", language: "ko" },
    speakers: [{ id: "ja-speaker", language: "ja" }],
    focusSpeaker: { id: "ja-speaker", language: "ja" },
  });

  assert.equal(plan.mode, "translation-focused");
  assert.deepEqual(plan.tracks.map(({ trackId, kind, role }) => ({ trackId, kind, role })), [
    { trackId: "original:ja-speaker", kind: "original", role: "background" },
    { trackId: "translation:ko", kind: "translation", role: "foreground" },
  ]);
  const original = plan.tracks.find(({ kind }) => kind === "original");
  const translation = plan.tracks.find(({ kind }) => kind === "translation");
  assert.ok(original.gain > 0);
  assert.ok(original.gain < translation.gain);
  assert.equal(translation.gain, 1);
});

test("foreign speech can use translation-only or temporary original-check plans", () => {
  const listener = { id: "ko-listener", language: "ko" };
  const speaker = { id: "ja-speaker", language: "ja" };

  assert.deepEqual(controller.planFor({ listener, speakers: [speaker], focusSpeaker: speaker, mode: "translation-only" }), {
    mode: "translation-only",
    tracks: [
      { trackId: "translation:ko", kind: "translation", role: "foreground", gain: 1 },
    ],
  });
  assert.deepEqual(controller.planFor({ listener, speakers: [speaker], focusSpeaker: speaker, mode: "original-check" }), {
    mode: "original-check",
    tracks: [
      { trackId: "original:ja-speaker", kind: "original", role: "foreground", gain: 1 },
    ],
  });
});
