import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    if (entry.isFile() && /\.(?:mjs|js)$/.test(entry.name)) files.push(path);
  }
  return files;
}

const roots = ["src", "public", "scripts"];
for (const root of roots) {
  for (const file of await sourceFiles(root)) {
    const result = spawnSync(process.execPath, ["--check", file], {
      encoding: "utf8",
    });
    if (result.status !== 0) {
      process.stderr.write(result.stderr);
      process.exit(result.status ?? 1);
    }
  }
}
for (const file of await sourceFiles("scripts")) {
  const contents = await readFile(file, "utf8");
  if (/['"][^'"\n]+\.pcm['"]/.test(contents)) {
    throw new Error(`raw PCM evidence files are forbidden: ${file}`);
  }
  if (/['"][^'"\n]+\.jsonl['"]|['"](?:manifest|scorecard)\.json['"]/.test(contents)) {
    throw new Error(`persistent canary evidence files are forbidden: ${file}`);
  }
}
const productServer = await readFile("src/server.mjs", "utf8");
if (/canaryTranscription\s*:\s*true/.test(productServer)) {
  throw new Error("product server must not enable canary transcription");
}
console.log("source syntax: ok");
