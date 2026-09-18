import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

import { chromium } from "playwright";

const moduleSource = await readFile(
  new URL("../public/browser-audio-playout.mjs", import.meta.url),
  "utf8",
);
const server = createServer((request, response) => {
  if (request.url === "/browser-audio-playout.mjs") {
    response.writeHead(200, { "content-type": "text/javascript" });
    response.end(moduleSource);
    return;
  }
  response.writeHead(200, { "content-type": "text/html" });
  response.end(`<!doctype html><html><body><div id="audio-output"></div>
    <script type="module">
      import { BrowserAudioPlayout } from "/browser-audio-playout.mjs";
      const output = document.querySelector("#audio-output");
      const playout = new BrowserAudioPlayout(output);
      const track = (trackName) => {
        const element = document.createElement("audio");
        return { kind: "audio", attach: () => element, detach: () => [element], trackName };
      };
      const original = track("original:ja-1");
      const translation = track("translation:ko");
      playout.setPlan({ tracks: [
        { trackId: original.trackName, gain: 0.2 },
        { trackId: translation.trackName, gain: 1 },
      ] });
      playout.attach(original, { trackName: original.trackName });
      playout.attach(translation, { trackName: translation.trackName });
      window.__listeningMixEvidence = [...output.querySelectorAll("audio")].map((element) => ({
        trackId: element.dataset.trackId,
        gain: element.volume,
      }));
    </script></body></html>`);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

const address = server.address();
const executablePath = process.env.CHROME_PATH
  ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const browser = await chromium.launch({ headless: true, executablePath });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}`, { waitUntil: "networkidle" });
  const evidence = await page.evaluate(() => window.__listeningMixEvidence);
  assert.equal(evidence.length, 2);
  const original = evidence.find(({ trackId }) => trackId === "original:ja-1");
  const translation = evidence.find(({ trackId }) => trackId === "translation:ko");
  assert.ok(original.gain > 0);
  assert.ok(original.gain < translation.gain);
  console.log(JSON.stringify({ attachedAudioElements: evidence.length, gainRelation: "original < translation" }));
} finally {
  await browser.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
