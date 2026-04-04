/// <reference lib="webworker" />

import type {
  RouterEvent,
  RouterFileInfo,
  RouterFileRecord,
  RouterMode,
  RouterRequest,
  RouterResultEvent,
  RouterState,
} from "./protocol";

declare const self: ServiceWorkerGlobalScope;

const DB_NAME = "router-db";
const DB_VERSION = 1;
const FILE_STORE = "files";
const META_STORE = "meta";
const MODE_KEY = "mode";
const FALLBACK_MODE: RouterMode = "fallback";

type MetaValue = {
  key: string;
  value: unknown;
};

let currentMode: RouterMode = FALLBACK_MODE;
const startupPromise = (async () => {
  currentMode = await getStoredMode();
})();

function normalizePath(path: string): string {
  const normalizedPath = path.split(/[?#]/, 1)[0]?.trim() ?? "/";
  const parts = normalizedPath.split("/").filter(Boolean);
  return `/${parts.join("/")}` || "/";
}

function hasFileExtension(path: string): boolean {
  const lastSegment = path.split("/").pop() ?? "";
  return /\.[^./]+$/.test(lastSegment);
}

function resolveCandidatePaths(path: string): string[] {
  const normalizedPath = normalizePath(path);
  const candidates = new Set<string>([normalizedPath]);

  if (normalizedPath === "/") {
    candidates.add("/index.html");
    return [...candidates];
  }

  if (normalizedPath.endsWith("/")) {
    candidates.add(`${normalizedPath}index.html`);
    return [...candidates];
  }

  if (!hasFileExtension(normalizedPath)) {
    candidates.add(`${normalizedPath}/index.html`);
  }

  return [...candidates];
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;

      if (!database.objectStoreNames.contains(FILE_STORE)) {
        database.createObjectStore(FILE_STORE, { keyPath: "path" });
      }

      if (!database.objectStoreNames.contains(META_STORE)) {
        database.createObjectStore(META_STORE, { keyPath: "key" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Failed to open IndexedDB."));
  });
}

async function withStore<T>(
  storeName: string,
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => T | Promise<T>,
): Promise<T> {
  const database = await openDatabase();

  return new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    let result: T;

    transaction.oncomplete = () => {
      database.close();
      resolve(result);
    };

    transaction.onerror = () => {
      database.close();
      reject(
        transaction.error ??
          new Error(`IndexedDB transaction failed for ${storeName}.`),
      );
    };

    transaction.onabort = () => {
      database.close();
      reject(
        transaction.error ??
          new Error(`IndexedDB transaction aborted for ${storeName}.`),
      );
    };

    Promise.resolve()
      .then(() => work(store))
      .then((value) => {
        result = value;
      })
      .catch((error) => {
        transaction.abort();
        reject(error);
      });
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

async function getStoredMode(): Promise<RouterMode> {
  const entry = await withStore(META_STORE, "readonly", (store) =>
    requestToPromise(store.get(MODE_KEY)),
  );

  return entry && typeof (entry as MetaValue).value === "string"
    ? ((entry as MetaValue).value as RouterMode)
    : FALLBACK_MODE;
}

async function setStoredMode(mode: RouterMode): Promise<void> {
  await withStore(META_STORE, "readwrite", (store) =>
    requestToPromise(
      store.put({ key: MODE_KEY, value: mode } satisfies MetaValue),
    ),
  );
  currentMode = mode;
}

async function countFiles(): Promise<number> {
  return withStore(FILE_STORE, "readonly", (store) =>
    requestToPromise(store.count()),
  );
}

async function listFiles(): Promise<RouterFileInfo[]> {
  const records = await withStore(FILE_STORE, "readonly", (store) =>
    requestToPromise(store.getAll()),
  );
  return (records as RouterFileRecord[]).map(
    ({ blob: _blob, ...info }) => info,
  );
}

async function getFile(path: string): Promise<RouterFileRecord | null> {
  const record = await withStore(FILE_STORE, "readonly", (store) =>
    requestToPromise(store.get(normalizePath(path))),
  );

  return (record as RouterFileRecord | undefined) ?? null;
}

async function deleteFiles(paths: string[]): Promise<number> {
  await withStore(FILE_STORE, "readwrite", (store) => {
    paths.forEach((path) => {
      store.delete(normalizePath(path));
    });
  });

  return countFiles();
}

async function clearFiles(): Promise<number> {
  await withStore(FILE_STORE, "readwrite", (store) =>
    requestToPromise(store.clear()),
  );
  return 0;
}

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
    fileCount: await countFiles(),
  };
}

async function broadcastState() {
  await broadcast({ type: "state", state: await buildState() });
}

async function broadcastLog(message: string) {
  await broadcast({ type: "log", message });
}

async function broadcastProgress(
  stage: "put" | "delete" | "clear",
  current: number,
  total: number,
) {
  await broadcast({ type: "progress", stage, current, total });
}

async function sendResult(result: RouterResultEvent) {
  await broadcast(result);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The router request failed.";
}

async function putFiles(files: RouterFileRecord[]): Promise<number> {
  const normalizedFiles = files.map((file) => ({
    ...file,
    path: normalizePath(file.path),
  }));

  await withStore(FILE_STORE, "readwrite", (store) => {
    normalizedFiles.forEach((file, index) => {
      store.put(file);

      if ((index + 1) % 25 === 0 || index === normalizedFiles.length - 1) {
        void broadcastProgress("put", index + 1, normalizedFiles.length);
      }
    });
  });

  return countFiles();
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
      await broadcastLog(`Router mode set to ${request.mode}.`);
      await broadcastState();
      return buildState();
    }
    case "putFiles": {
      const fileCount = await putFiles(request.files);
      await broadcastLog(
        `Stored ${request.files.length} file(s) in the router database.`,
      );
      await broadcastState();
      return { fileCount };
    }
    case "deleteFiles": {
      await broadcastProgress("delete", 0, request.paths.length);
      request.paths.forEach((_, index) => {
        void broadcastProgress("delete", index + 1, request.paths.length);
      });
      const fileCount = await deleteFiles(request.paths);
      await broadcastLog(
        `Deleted ${request.paths.length} file(s) from the router database.`,
      );
      await broadcastState();
      return { fileCount };
    }
    case "clearFiles": {
      await broadcastProgress("clear", 0, 1);
      const fileCount = await clearFiles();
      await broadcastProgress("clear", 1, 1);
      await broadcastLog("Cleared all stored router files.");
      await broadcastState();
      return { fileCount };
    }
    case "getFile":
      return getFile(request.path);
    case "listFiles":
      return listFiles();
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
  for (const candidate of resolveCandidatePaths(pathname)) {
    const record = await getFile(candidate);
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

  const notFoundFile = await getFile("/404.html");
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
