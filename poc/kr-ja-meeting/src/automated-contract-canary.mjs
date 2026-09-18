import { buildAutomatedCanaryEvidence } from "./automated-canary-evidence.mjs";
import { runAutomatedContractScenarios } from "./automated-contract-scenarios.mjs";

export async function runAutomatedContractCanary({
  runScenarios = runAutomatedContractScenarios,
} = {}) {
  if (typeof runScenarios !== "function") {
    throw new Error("automated contract scenario runner is required");
  }
  const measurements = await runScenarios();
  return buildAutomatedCanaryEvidence(measurements);
}
