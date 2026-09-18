import assert from "node:assert/strict";
import test from "node:test";

import { runFinalCanaries } from "../src/final-canary-orchestrator.mjs";

test("final canaries keep service, browser, playout, provider, and human evidence separate", async () => {
  const commands = [];
  const report = await runFinalCanaries({
    run: async (command) => {
      commands.push(command);
      if (command.includes("automated-contracts")) return {
        status: 0,
        stdout: `${JSON.stringify({
          ok: true,
          interruption: { ok: true, milliseconds: 200 },
          reconnect: { ok: true, statusMilliseconds: 500, staleOutputBlocked: true },
          longSession: {
            ok: true,
            replacementGapMilliseconds: 400,
            acceleratedMeetingMinutes: 60,
            proactiveReplacement: true,
            outputContinued: true,
          },
        })}\n`,
      };
      return { status: 0, stdout: "ok" };
    },
  });

  assert.deepEqual(commands, [
    "npm run check",
    "npm run canary:natural-conversation",
    "npm run canary:automated-contracts",
  ]);
  assert.equal(report.automatedOk, false);
  assert.equal(report.ok, false);
  assert.deepEqual(report.evidence.map(({ category, status }) => ({ category, status })), [
    { category: "service", status: "passed" },
    { category: "browser", status: "passed" },
    { category: "interruption", status: "passed" },
    { category: "reconnect", status: "passed" },
    { category: "long-session", status: "passed" },
    { category: "playout", status: "local-livekit-gated" },
    { category: "provider-semantic", status: "credential-gated" },
    { category: "provider-browser", status: "credential-gated" },
    { category: "human", status: "not-claimed" },
  ]);
});

test("optional LiveKit playout and provider canaries reuse their existing commands", async () => {
  const commands = [];
  const report = await runFinalCanaries({
    includePlayout: true,
    includeProvider: true,
    run: async (command) => {
      commands.push(command);
      if (command.includes("automated-contracts")) return {
        status: 0,
        stdout: `${JSON.stringify({
          ok: true,
          interruption: { ok: true, milliseconds: 200 },
          reconnect: { ok: true, statusMilliseconds: 500, staleOutputBlocked: true },
          longSession: {
            ok: true,
            replacementGapMilliseconds: 400,
            acceleratedMeetingMinutes: 60,
            proactiveReplacement: true,
            outputContinued: true,
          },
        })}\n`,
      };
      if (command.includes("provider-semantic")) return {
        status: 0,
        stdout: `${JSON.stringify({ ok: true })}\n`,
      };
      return { status: 0, stdout: "ok" };
    },
  });

  assert.deepEqual(commands, [
    "npm run check",
    "npm run canary:natural-conversation",
    "npm run canary:automated-contracts",
    "npm run canary:playout-continuity",
    "npm run canary:provider-semantic",
    "npm run canary:provider-browser",
  ]);
  assert.equal(report.evidence.find(({ category }) => category === "playout").status, "passed");
  assert.equal(report.evidence.find(({ category }) => category === "provider-semantic").status, "passed");
  assert.equal(report.evidence.find(({ category }) => category === "provider-browser").status, "passed");
  assert.equal(report.automatedOk, true);
  assert.equal(report.ok, false);
});

test("a failed executable category fails the report without upgrading gated evidence", async () => {
  const report = await runFinalCanaries({
    run: async (command) => ({
      status: command.includes("natural-conversation") ? 1 : 0,
      stderr: command.includes("natural-conversation") ? "browser contract failed" : "",
    }),
  });

  assert.equal(report.ok, false);
  assert.deepEqual(report.evidence.find(({ category }) => category === "browser"), {
    category: "browser",
    status: "failed",
    command: "npm run canary:natural-conversation",
    detail: "browser-command-failed",
  });
  assert.equal(report.evidence.find(({ category }) => category === "provider-semantic").status, "credential-gated");
  assert.equal(report.evidence.find(({ category }) => category === "human").status, "not-claimed");
});

test("malformed timing output fails all timing categories closed", async () => {
  const report = await runFinalCanaries({
    run: async (command) => ({
      status: 0,
      stdout: command.includes("automated-contracts") ? "not-json" : "ok",
    }),
  });
  assert.equal(report.automatedOk, false);
  assert.deepEqual(
    report.evidence.filter(({ category }) => ["interruption", "reconnect", "long-session"].includes(category))
      .map(({ category, status }) => ({ category, status })),
    [
      { category: "interruption", status: "failed" },
      { category: "reconnect", status: "failed" },
      { category: "long-session", status: "failed" },
    ],
  );
});
