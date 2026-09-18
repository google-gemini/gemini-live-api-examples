import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { runNaturalConversationCanary } from "../src/natural-conversation-canary.mjs";

const execute = promisify(execFile);

try {
  const report = await runNaturalConversationCanary({ run: runComponent });
  process.stdout.write(`${JSON.stringify(report)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`natural conversation browser canary failed: ${message}\n`);
  process.exitCode = 1;
}

async function runComponent(command) {
  const [executable, ...args] = command.split(" ");
  const { stdout } = await execute(executable, args, {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });
  const lastLine = stdout.trim().split("\n").at(-1);
  return JSON.parse(lastLine);
}
