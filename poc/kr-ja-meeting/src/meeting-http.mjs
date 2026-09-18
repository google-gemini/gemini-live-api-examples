import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
]);

export function createMeetingHttpServer({ service, staticRoot, vendorFiles = new Map() }) {
  if (!service) throw new Error("meeting service is required");

  return createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
    try {
      if (request.method === "GET" && url.pathname === "/api/meeting") {
        return sendJson(response, 200, service.refresh ? await service.refresh() : service.snapshot());
      }
      if (request.method === "POST" && url.pathname === "/api/meeting/join") {
        const { name, language } = await readJson(request);
        return sendJson(response, 200, await service.join({ name, language }));
      }
      if (request.method === "POST" && url.pathname === "/api/meeting/leave") {
        const { participantId } = await readJson(request);
        return sendJson(response, 200, await service.leave(participantId));
      }
      if (request.method === "POST" && url.pathname === "/api/meeting/mic") {
        const { participantId, enabled } = await readJson(request);
        return sendJson(response, 200, await service.mic(participantId, enabled));
      }
      if (request.method === "POST" && url.pathname === "/api/meeting/speech") {
        const { participantId, type, observedAt } = await readJson(request);
        return sendJson(
          response,
          200,
          await service.speechActivity({ participantId, type, observedAt }),
        );
      }
      if (request.method === "POST" && url.pathname === "/api/meeting/listening-mode") {
        const { participantId, mode } = await readJson(request);
        return sendJson(response, 200, await service.listeningMode(participantId, mode));
      }
      if (request.method === "POST" && url.pathname === "/api/meeting/playout") {
        const { participantId, ...event } = await readJson(request);
        return sendJson(response, 200, await service.playout(participantId, event));
      }
      if (request.method === "POST" && url.pathname === "/api/meeting/action") {
        const { participantId, action } = await readJson(request);
        return sendJson(response, 200, await service.action(participantId, action));
      }
      if (request.method === "GET" && vendorFiles.has(url.pathname)) {
        return sendFile(response, vendorFiles.get(url.pathname));
      }
      if (request.method === "GET" && staticRoot) {
        return sendStatic(response, staticRoot, url.pathname);
      }
      return sendJson(response, 404, { error: "not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return sendJson(response, 400, { error: message });
    }
  });
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16_384) throw new Error("request body is too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("invalid JSON body");
  }
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

async function sendStatic(response, root, pathname) {
  const relativePath = pathname === "/"
    ? "public/index.html"
    : normalize(decodeURIComponent(pathname)).replace(/^[/\\]+/, "");
  if (
    !relativePath.startsWith("public/") &&
    !relativePath.startsWith("src/") &&
    !relativePath.startsWith("vendor/")
  ) {
    return sendJson(response, 404, { error: "not found" });
  }
  const filePath = join(root, relativePath);
  if (!filePath.startsWith(root)) return sendJson(response, 404, { error: "not found" });

  return sendFile(response, filePath);
}

async function sendFile(response, filePath) {
  try {
    const details = await stat(filePath);
    if (!details.isFile()) throw new Error("not a file");
    response.writeHead(200, {
      "Content-Type": contentTypes.get(extname(filePath)) ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    createReadStream(filePath).pipe(response);
  } catch {
    sendJson(response, 404, { error: "not found" });
  }
}
