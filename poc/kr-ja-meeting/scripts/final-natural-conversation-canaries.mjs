import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { runFinalCanaries } from "../src/final-canary-orchestrator.mjs";

const execute = promisify(execFile);
const argumentsSet = new Set(process.argv.slice(2));
const knownArguments = new Set(["--include-playout", "--include-provider"]);
for (const argument of argumentsSet) {
  if (!knownArguments.has(argument)) throw new Error(`unknown final canary option: ${argument}`);
}

const report = await runFinalCanaries({
  includePlayout: argumentsSet.has("--include-playout"),
  includeProvider: argumentsSet.has("--include-provider"),
  run: runCommand,
});
process.stdout.write(`${JSON.stringify(report)}\n`);
if (!report.automatedOk) process.exitCode = 1;

async function runCommand(command) {
  const [executable, ...args] = command.split(" ");
  try {
    const { stdout, stderr } = await execute(executable, args, {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    return { status: 0, stdout, stderr };
  } catch (error) {
    return {
      status: Number.isInteger(error?.code) ? error.code : 1,
      stdout: error?.stdout ?? "",
      stderr: error?.stderr ?? error?.message ?? "command failed",
    };
  }
}
