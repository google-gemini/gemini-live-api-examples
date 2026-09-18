import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { AccessToken } from "livekit-server-sdk";
import { Room } from "@livekit/rtc-node";
import { chromium } from "playwright";

import { withTimeout } from "./playout-continuity.mjs";

export async function openBrowserPlayout({
  livekitUrl,
  livekitApiKey,
  livekitApiSecret,
  roomName,
  identity,
  trackName,
  timeoutMs,
}) {
  let browser;
  let server;
  try {
    const token = await tokenFor({
      livekitApiKey,
      livekitApiSecret,
      roomName,
      identity,
      canPublish: false,
    });
    const started = await startCanaryServer({ livekitUrl, token, trackName });
    server = started.server;
    browser = await chromium.launch({
      channel: "chrome",
      headless: true,
      ignoreDefaultArgs: ["--mute-audio"],
      args: ["--autoplay-policy=no-user-gesture-required"],
    });
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.goto(started.url, { waitUntil: "domcontentloaded" });
    await page.click("#start");
    await page.waitForFunction(
      () => ["ready", "failed"].includes(window.browserCanary?.state.phase),
      undefined,
      { timeout: timeoutMs },
    );
    const startupState = await page.evaluate(() => structuredClone(window.browserCanary.state));
    if (startupState.phase !== "ready") {
      throw new Error(startupState.error ?? "browser canary failed to start");
    }

    return {
      async startMute(milliseconds) {
        return page.evaluate(
          (durationMs) => window.browserCanary.startMute(durationMs),
          milliseconds,
        );
      },
      async finish() {
        const state = await withTimeout(
          page.evaluate(() => window.browserCanary.finish()),
          timeoutMs,
          "browser evidence finish",
        );
        if (errors.length > 0) throw new Error(`browser errors: ${errors.join(" | ")}`);
        return state;
      },
      async close() {
        await closeResources({ browser, server, timeoutMs });
        browser = null;
        server = null;
      },
    };
  } catch (error) {
    await closeResources({ browser, server, timeoutMs });
    throw error;
  }
}

export async function connectCanaryPublisher({
  livekitUrl,
  livekitApiKey,
  livekitApiSecret,
  roomName,
  identity,
  timeoutMs,
}) {
  const room = new Room();
  try {
    const token = await tokenFor({
      livekitApiKey,
      livekitApiSecret,
      roomName,
      identity,
      canPublish: true,
    });
    await withTimeout(
      room.connect(livekitUrl, token, { autoSubscribe: false, dynacast: false }),
      timeoutMs,
      `${identity} connection`,
    );
    return room;
  } catch (error) {
    await withTimeout(room.disconnect(), timeoutMs, `${identity} disconnect`).catch(() => {});
    throw error;
  }
}

async function tokenFor({
  livekitApiKey,
  livekitApiSecret,
  roomName,
  identity,
  canPublish,
}) {
  const token = new AccessToken(livekitApiKey, livekitApiSecret, { identity });
  token.addGrant({ roomJoin: true, room: roomName, canPublish, canSubscribe: true });
  return token.toJwt();
}

async function startCanaryServer(config) {
  const publicRoot = fileURLToPath(new URL("../public/", import.meta.url));
  const vendorPath = fileURLToPath(
    new URL("../node_modules/livekit-client/dist/livekit-client.esm.mjs", import.meta.url),
  );
  const files = new Map([
    ["/", [join(publicRoot, "browser-playout-canary.html"), "text/html; charset=utf-8"]],
    ["/browser-playout-canary.js", [
      join(publicRoot, "browser-playout-canary.js"),
      "text/javascript; charset=utf-8",
    ]],
    ["/playout-meter-worklet.js", [
      join(publicRoot, "playout-meter-worklet.js"),
      "text/javascript; charset=utf-8",
    ]],
    ["/vendor/livekit-client.mjs", [vendorPath, "text/javascript; charset=utf-8"]],
  ]);
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, "http://127.0.0.1").pathname;
      response.setHeader("cache-control", "no-store");
      if (pathname === "/config") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(config));
        return;
      }
      if (pathname === "/favicon.ico") {
        response.writeHead(204).end();
        return;
      }
      const entry = files.get(pathname);
      if (!entry) {
        response.writeHead(404).end("not found");
        return;
      }
      const [path, contentType] = entry;
      response.writeHead(200, { "content-type": contentType });
      response.end(await readFile(path));
    } catch {
      response.writeHead(500).end("canary server error");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return { server, url: `http://127.0.0.1:${address.port}/` };
}

async function closeResources({ browser, server, timeoutMs }) {
  if (browser) await withTimeout(browser.close(), timeoutMs, "browser close").catch(() => {});
  if (server) {
    const closing = new Promise((resolve) => server.close(() => resolve()));
    server.closeAllConnections?.();
    await withTimeout(closing, timeoutMs, "canary server close").catch(() => {});
  }
}
