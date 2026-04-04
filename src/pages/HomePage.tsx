import { useCallback, useEffect, useState, type FormEvent } from "react";
import { getContentTypeForPath } from "../lib/mediaTypes";
import type { SevenZipExtractedFile } from "../lib/7zip";
import { getRouterClient, unregisterRouterClient } from "../router/client";
import type { RouterFileRecord } from "../router/protocol";
import {
  deleteRouterDatabase,
  getStoredMode,
  putStoredFiles,
} from "../router/storage";

type HomePhase =
  | "checking"
  | "downloading"
  | "locked"
  | "unlocking"
  | "unlocked"
  | "error"
  | "locking";

const SEVEN_ZIP_SIGNATURE = [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] as const;

function isSevenZipArchive(bytes: Uint8Array): boolean {
  return SEVEN_ZIP_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

function getSavedFiles(files: SevenZipExtractedFile[]) {
  return files.filter(
    (file): file is SevenZipExtractedFile & { data: Uint8Array } =>
      !file.isDirectory && Boolean(file.data),
  );
}

function stripSharedRoot(paths: string[]): string[] {
  if (paths.length === 0) {
    return paths;
  }

  const splitPaths = paths.map((path) =>
    path
      .split("/")
      .map((segment) => segment.trim())
      .filter(Boolean),
  );
  const firstSegment = splitPaths[0]?.[0];

  if (!firstSegment) {
    return paths;
  }

  const shouldStrip = splitPaths.every(
    (segments) => segments.length > 1 && segments[0] === firstSegment,
  );

  if (!shouldStrip) {
    return paths;
  }

  return splitPaths.map((segments) => segments.slice(1).join("/"));
}

function buildRouterFiles(files: SevenZipExtractedFile[]): RouterFileRecord[] {
  const savedFiles = getSavedFiles(files);
  const normalizedPaths = stripSharedRoot(savedFiles.map((file) => file.path));

  return savedFiles.map((file, index) => {
    const path = normalizedPaths[index];
    const mime = getContentTypeForPath(path);
    const blob = new Blob([new Uint8Array(file.data).slice().buffer], {
      type: mime,
    });

    return {
      path,
      size: file.data.byteLength,
      mime,
      blob,
    };
  });
}

function LoadingView({ title, message }: { title: string; message: string }) {
  return (
    <div className="flex flex-col items-center gap-5 text-center">
      <div className="h-12 w-12 animate-spin rounded-full border-2 border-cyan-300/25 border-t-cyan-300" />
      <div className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">
          {title}
        </h1>
        <p className="text-sm leading-6 text-slate-400 sm:text-base">
          {message}
        </p>
      </div>
    </div>
  );
}

function HomePage() {
  const [phase, setPhase] = useState<HomePhase>("checking");
  const [statusMessage, setStatusMessage] = useState("Checking site lock... ");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [archiveBytes, setArchiveBytes] = useState<Uint8Array | null>(null);
  const [retryAction, setRetryAction] = useState<
    "download" | "unlock" | "lock"
  >("download");

  const checkForArchive = useCallback(async (): Promise<Uint8Array | null> => {
    const response = await fetch("/site.7z", { cache: "no-store" });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error(`Archive check failed with status ${response.status}.`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    const bytes = new Uint8Array(await response.arrayBuffer());

    if (contentType.includes("text/html") || !isSevenZipArchive(bytes)) {
      return null;
    }

    return bytes;
  }, []);

  const downloadArchive = useCallback(async () => {
    setPhase("downloading");
    setStatusMessage("Preparing the locked site...");
    setErrorMessage(null);

    try {
      const bytes = await checkForArchive();
      if (!bytes) {
        window.location.replace("#/publish");
        return;
      }

      setArchiveBytes(bytes);
      setPhase("locked");
      setStatusMessage("The locked site is ready.");
    } catch (error) {
      setRetryAction("download");
      setPhase("error");
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Failed to prepare the locked site.",
      );
    }
  }, [checkForArchive]);

  useEffect(() => {
    async function syncLockState() {
      setPhase("checking");
      setStatusMessage("Checking site lock...");
      setErrorMessage(null);

      try {
        const mode = await getStoredMode();

        if (mode === "on") {
          setPhase("unlocked");
          return;
        }

        await downloadArchive();
      } catch (error) {
        setRetryAction("download");
        setPhase("error");
        setErrorMessage(
          error instanceof Error
            ? error.message
            : "Failed to check the site lock.",
        );
      }
    }

    void syncLockState();
  }, [downloadArchive]);

  async function handleUnlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!archiveBytes) {
      setRetryAction("download");
      setPhase("error");
      setErrorMessage("The locked site bundle is not available yet.");
      return;
    }

    setPhase("unlocking");
    setErrorMessage(null);

    try {
      setStatusMessage("Unlocking archive...");
      const { extractArchive } = await import("../lib/7zip");
      const extractedFiles = await extractArchive(
        { path: "site.7z", data: archiveBytes },
        password,
      );

      setStatusMessage("Loading site files...");
      const routerFiles = buildRouterFiles(extractedFiles);
      if (routerFiles.length === 0) {
        throw new Error("The locked site bundle did not contain any files.");
      }

      await deleteRouterDatabase();
      await putStoredFiles(routerFiles);

      setStatusMessage("Enabling site...");
      const client = await getRouterClient();
      await client.setMode("on");

      setStatusMessage("Opening site...");
      window.location.assign("/");
    } catch (error) {
      setRetryAction("unlock");
      setPhase("error");
      setErrorMessage(
        error instanceof Error ? error.message : "Failed to unlock the site.",
      );
    }
  }

  async function handleLock() {
    setPhase("locking");
    setStatusMessage("Disabling site access...");
    setErrorMessage(null);

    try {
      const mode = await getStoredMode();
      if (mode === "on") {
        const client = await getRouterClient();
        await client.setMode("fallback");
      }

      setStatusMessage("Removing site access...");
      await unregisterRouterClient();

      setStatusMessage("Removing stored site data...");
      await deleteRouterDatabase();

      setStatusMessage("Resetting locked site...");
      window.location.assign("/");
    } catch (error) {
      setRetryAction("lock");
      setPhase("error");
      setErrorMessage(
        error instanceof Error ? error.message : "Failed to lock the site.",
      );
    }
  }

  function handleRetry() {
    if (retryAction === "lock") {
      void handleLock();
      return;
    }

    if (retryAction === "unlock") {
      setPhase("locked");
      return;
    }

    void downloadArchive();
  }

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-4xl items-center justify-center px-4 py-8 sm:px-6 lg:px-8">
      <section className="w-full max-w-xl rounded-[32px] border border-white/10 bg-[radial-gradient(circle_at_top,rgba(34,211,238,0.12),transparent_35%),linear-gradient(180deg,rgba(15,23,42,0.96),rgba(2,6,23,0.96))] p-8 shadow-[0_40px_120px_rgba(2,6,23,0.55)] sm:p-10">
        <div className="mb-10 text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.32em] text-cyan-300/85">
            passwd nsite
          </p>
        </div>

        {phase === "checking" || phase === "downloading" ? (
          <LoadingView title="Site is locked" message={statusMessage} />
        ) : null}

        {phase === "locked" ? (
          <div className="space-y-8 text-center">
            <div className="space-y-3">
              <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">
                Unlock site
              </h1>
              <p className="text-sm leading-6 text-slate-400 sm:text-base">
                Enter the password to unlock the site and open it.
              </p>
            </div>

            <form className="space-y-4" onSubmit={handleUnlock}>
              <input
                className="min-h-14 w-full rounded-2xl border border-white/10 bg-slate-950/70 px-5 text-center text-lg text-white outline-none transition placeholder:text-slate-500 focus:border-cyan-400/60"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Password"
                autoComplete="current-password"
                autoFocus
              />
              <button
                className="inline-flex min-h-14 w-full items-center justify-center rounded-full bg-cyan-400 px-5 py-3 text-base font-semibold text-slate-950 transition hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-60"
                type="submit"
                disabled={!password}
              >
                Unlock site
              </button>
            </form>

            <div className="text-sm text-slate-400">
              <a className="transition hover:text-cyan-200" href="#/publish">
                Publish a new site instead
              </a>
            </div>
          </div>
        ) : null}

        {phase === "unlocking" ? (
          <LoadingView title="Unlocking site" message={statusMessage} />
        ) : null}

        {phase === "unlocked" ? (
          <div className="space-y-8 text-center">
            <div className="space-y-3">
              <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">
                Site is unlocked
              </h1>
              <p className="text-sm leading-6 text-slate-400 sm:text-base">
                Locking the site removes the service worker and deletes every
                stored site file.
              </p>
            </div>

            <button
              className="inline-flex min-h-14 w-full items-center justify-center rounded-full bg-cyan-400 px-5 py-3 text-base font-semibold text-slate-950 transition hover:bg-cyan-300"
              type="button"
              onClick={handleLock}
            >
              Lock site
            </button>

            <div className="text-sm text-slate-400">
              <a className="transition hover:text-cyan-200" href="#/publish">
                Open publish view
              </a>
            </div>
          </div>
        ) : null}

        {phase === "locking" ? (
          <LoadingView title="Locking site" message={statusMessage} />
        ) : null}

        {phase === "error" ? (
          <div className="space-y-8 text-center">
            <div className="space-y-3">
              <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">
                Site needs attention
              </h1>
              <p className="text-sm leading-6 text-slate-400 sm:text-base">
                {errorMessage ??
                  "Something went wrong while changing the site lock."}
              </p>
            </div>

            <button
              className="inline-flex min-h-14 w-full items-center justify-center rounded-full bg-cyan-400 px-5 py-3 text-base font-semibold text-slate-950 transition hover:bg-cyan-300"
              type="button"
              onClick={handleRetry}
            >
              {retryAction === "lock" ? "Try locking again" : "Try again"}
            </button>
          </div>
        ) : null}
      </section>
    </div>
  );
}

export default HomePage;
