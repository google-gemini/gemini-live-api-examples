import assert from "node:assert/strict";
import test from "node:test";

import { translationStatusView } from "../public/translation-status.mjs";

test("reconnecting translation shows the original-audio fallback status", () => {
  assert.deepEqual(translationStatusView("reconnecting"), {
    healthLabel: "통역 재연결 중",
    message: "통역 재연결 중입니다. 잠시 원음을 정상 크기로 들려드립니다.",
  });
  assert.equal(translationStatusView("available"), null);
  assert.deepEqual(translationStatusView("unavailable"), {
    healthLabel: "통역 복구 대기 중",
    message: "통역을 복구하고 있습니다. 원음을 정상 크기로 계속 들려드립니다.",
  });
});
