import type { RouterFileRecord, RouterMode } from "./protocol";

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

export function normalizeRouterPath(path: string): string {
  const normalizedPath = path.split(/[?#]/, 1)[0]?.trim() ?? "/";
  const parts = normalizedPath.split("/").filter(Boolean);
  return parts.length === 0 ? "/" : `/${parts.join("/")}`;
}

function hasFileExtension(path: string): boolean {
  const lastSegment = path.split("/").pop() ?? "";
  return /\.[^./]+$/.test(lastSegment);
}

export function resolveStoredFilePaths(path: string): string[] {
  const normalizedPath = normalizeRouterPath(path);
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

export async function getStoredMode(): Promise<RouterMode> {
  const entry = await withStore(META_STORE, "readonly", (store) =>
    requestToPromise(store.get(MODE_KEY)),
  );

  return entry && typeof (entry as MetaValue).value === "string"
    ? ((entry as MetaValue).value as RouterMode)
    : FALLBACK_MODE;
}

export async function setStoredMode(mode: RouterMode): Promise<void> {
  await withStore(META_STORE, "readwrite", (store) =>
    requestToPromise(
      store.put({ key: MODE_KEY, value: mode } satisfies MetaValue),
    ),
  );
}

export async function getStoredFile(
  path: string,
): Promise<RouterFileRecord | null> {
  const record = await withStore(FILE_STORE, "readonly", (store) =>
    requestToPromise(store.get(normalizeRouterPath(path))),
  );

  return (record as RouterFileRecord | undefined) ?? null;
}

export async function clearStoredFiles(): Promise<void> {
  await withStore(FILE_STORE, "readwrite", (store) =>
    requestToPromise(store.clear()),
  );
}

export async function putStoredFiles(files: RouterFileRecord[]): Promise<void> {
  const normalizedFiles = files.map((file) => ({
    ...file,
    path: normalizeRouterPath(file.path),
  }));

  await withStore(FILE_STORE, "readwrite", (store) => {
    normalizedFiles.forEach((file) => {
      store.put(file);
    });
  });
}

export async function deleteRouterDatabase(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);

    request.onsuccess = () => resolve();
    request.onerror = () =>
      reject(
        request.error ?? new Error("Failed to delete the router database."),
      );
    request.onblocked = () =>
      reject(
        new Error("The router database is blocked and could not be deleted."),
      );
  });
}
