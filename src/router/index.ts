/// <reference lib="webworker" />

import type {
  RouterEvent,
  RouterFileRecord,
  RouterMode,
  RouterRequest,
  RouterResultEvent,
  RouterState,
} from "./protocol";
import {
  getStoredFile,
  getStoredMode,
  resolveStoredFilePaths,
  setStoredMode,
} from "./storage";

declare const self: ServiceWorkerGlobalScope;

const FALLBACK_MODE: RouterMode = "fallback";

let currentMode: RouterMode = FALLBACK_MODE;
const startupPromise = (async () => {
  currentMode = await getStoredMode();
})();

function emitToClient(client: Client, event: RouterEvent) {
  client.postMessage(event);
}

async function broadcast(event: RouterEvent) {
  const clients = await self.clients.matchAll({
    includeUncontrolled: true,
    type: "window",
  });
  for (const client of clients) {
    emitToClient(client, event);
  }
}

async function buildState(): Promise<RouterState> {
  return {
    mode: currentMode,
  };
}

async function broadcastState() {
  await broadcast({ type: "state", state: await buildState() });
}

async function sendResult(result: RouterResultEvent) {
  await broadcast(result);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The router request failed.";
}

async function handleRequest(request: RouterRequest): Promise<unknown> {
  await startupPromise;

  switch (request.type) {
    case "connect":
      await broadcastState();
      return undefined;
    case "getStatus":
      return buildState();
    case "setMode": {
      await setStoredMode(request.mode);
      currentMode = request.mode;
      await broadcastState();
      return buildState();
    }
    default:
      return undefined;
  }
}

function createResponse(
  file: RouterFileRecord,
  requestMethod: string,
  status = 200,
): Response {
  const headers = new Headers();
  headers.set("Content-Type", file.mime || "application/octet-stream");
  headers.set("Content-Length", String(file.size));

  return new Response(requestMethod === "HEAD" ? null : file.blob, {
    status,
    headers,
  });
}

async function matchFile(pathname: string): Promise<RouterFileRecord | null> {
  for (const candidate of resolveStoredFilePaths(pathname)) {
    const record = await getStoredFile(candidate);
    if (record) {
      return record;
    }
  }

  return null;
}

async function handleFetch(request: Request): Promise<Response | null> {
  await startupPromise;

  if (currentMode !== "on") {
    return null;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return null;
  }

  const requestUrl = new URL(request.url);
  if (requestUrl.origin !== self.location.origin) {
    return null;
  }

  const file = await matchFile(requestUrl.pathname);
  if (file) {
    return createResponse(file, request.method);
  }

  const notFoundFile = await getStoredFile("/404.html");
  if (notFoundFile) {
    return createResponse(notFoundFile, request.method, 404);
  }

  return new Response(request.method === "HEAD" ? null : "Not found", {
    status: 404,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      await startupPromise;
      await self.clients.claim();
      await broadcastState();
    })(),
  );
});

self.addEventListener("message", (event) => {
  event.waitUntil(
    (async () => {
      const request = event.data as RouterRequest;
      if (
        !request ||
        typeof request !== "object" ||
        typeof request.type !== "string"
      ) {
        return;
      }

      try {
        const data = await handleRequest(request);
        await sendResult({
          type: "result",
          requestId: request.id,
          ok: true,
          data,
        });
      } catch (error) {
        const message = getErrorMessage(error);
        await broadcast({ type: "error", message });
        await sendResult({
          type: "result",
          requestId: request.id,
          ok: false,
          error: message,
        });
      }
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  event.respondWith(
    (async () => {
      const response = await handleFetch(event.request);
      return response ?? fetch(event.request);
    })(),
  );
});

export {};
