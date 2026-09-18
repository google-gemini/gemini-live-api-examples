import { runAutomatedContractCanary } from "../src/automated-contract-canary.mjs";

try {
  const evidence = await runAutomatedContractCanary();
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
  if (!evidence.ok) process.exitCode = 1;
} catch {
  process.stderr.write("automated contract canary failed\n");
  process.exitCode = 1;
}
