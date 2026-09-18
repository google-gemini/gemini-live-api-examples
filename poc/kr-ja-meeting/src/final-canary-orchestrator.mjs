const REQUIRED_CANARIES = [
  { category: "service", command: "npm run check" },
  { category: "browser", command: "npm run canary:natural-conversation" },
];
const AUTOMATED_CONTRACT_COMMAND = "npm run canary:automated-contracts";
const REQUIRED_AUTOMATED_CATEGORIES = new Set([
  "service",
  "browser",
  "interruption",
  "reconnect",
  "long-session",
  "provider-semantic",
  "provider-browser",
]);

export async function runFinalCanaries({
  run,
  includePlayout = false,
  includeProvider = false,
} = {}) {
  if (typeof run !== "function") throw new Error("final canary command runner is required");

  const evidence = [];
  for (const canary of REQUIRED_CANARIES) {
    evidence.push(await runCanary(canary, run));
  }
  evidence.push(...await runAutomatedContract(run));

  evidence.push(includePlayout
    ? await runCanary({
      category: "playout",
      command: "npm run canary:playout-continuity",
    }, run)
    : {
      category: "playout",
      status: "local-livekit-gated",
      command: "npm run canary:playout-continuity",
      detail: "Run with --include-playout while a local LiveKit server is available.",
    });

  if (includeProvider) {
    evidence.push(await runStructuredOkCanary({
      category: "provider-semantic",
      command: "npm run canary:provider-semantic",
    }, run));
    evidence.push(await runCanary({
      category: "provider-browser",
      command: "npm run canary:provider-browser",
    }, run));
  } else {
    evidence.push(credentialGate("provider-semantic", "npm run canary:provider-semantic"));
    evidence.push(credentialGate("provider-browser", "npm run canary:provider-browser"));
  }

  evidence.push({
    category: "human",
    status: "not-claimed",
    detail: "Automated canaries do not establish human comprehension, fatigue, preference, or an exact gain.",
  });

  const automatedOk = evidence
    .filter(({ category }) => REQUIRED_AUTOMATED_CATEGORIES.has(category))
    .every(({ status }) => status === "passed")
    && REQUIRED_AUTOMATED_CATEGORIES.size === evidence
      .filter(({ category, status }) => REQUIRED_AUTOMATED_CATEGORIES.has(category) && status === "passed")
      .length;
  return { automatedOk, ok: false, evidence };
}

async function runCanary({ category, command }, run) {
  const result = await run(command);
  if (result?.status === 0) {
    return {
      category,
      status: "passed",
      command,
    };
  }
  return {
    category,
    status: "failed",
    command,
    detail: `${category}-command-failed`,
  };
}

async function runAutomatedContract(run) {
  const result = await run(AUTOMATED_CONTRACT_COMMAND);
  const report = result?.status === 0 ? parseLastJson(result.stdout) : null;
  return [
    timingCategory("interruption", report?.interruption, {
      milliseconds: report?.interruption?.milliseconds,
    }),
    timingCategory("reconnect", report?.reconnect, {
      statusMilliseconds: report?.reconnect?.statusMilliseconds,
      staleOutputBlocked: report?.reconnect?.staleOutputBlocked === true,
    }),
    timingCategory("long-session", report?.longSession, {
      replacementGapMilliseconds: report?.longSession?.replacementGapMilliseconds,
      acceleratedMeetingMinutes: report?.longSession?.acceleratedMeetingMinutes,
      proactiveReplacement: report?.longSession?.proactiveReplacement === true,
      outputContinued: report?.longSession?.outputContinued === true,
    }),
  ];
}

async function runStructuredOkCanary(canary, run) {
  const result = await run(canary.command);
  const report = result?.status === 0 ? parseLastJson(result.stdout) : null;
  return report?.ok === true
    ? { category: canary.category, status: "passed", command: canary.command }
    : {
      category: canary.category,
      status: "failed",
      command: canary.command,
      detail: `${canary.category}-evidence-incomplete`,
    };
}

function timingCategory(category, report, values) {
  return report?.ok === true
    ? { category, status: "passed", ...values }
    : { category, status: "failed", detail: `${category}-evidence-incomplete` };
}

function credentialGate(category, command) {
  return {
    category,
    status: "credential-gated",
    command,
    detail: "Run only in an authorized credential environment.",
  };
}

function parseLastJson(value) {
  const line = typeof value === "string" ? value.trim().split("\n").filter(Boolean).at(-1) : null;
  if (!line) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
