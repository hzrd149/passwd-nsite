import { useEffect, useState, type ReactNode } from "react";
import { extractArchive, type SevenZipExtractedFile } from "../lib/7zip";
import { getRouterClient } from "../router/client";
import type { RouterFileRecord, RouterState } from "../router/protocol";

function formatRouterProgress(
  current: number,
  total: number,
  stage: "put" | "delete" | "clear",
) {
  const label =
    stage === "put" ? "Saving" : stage === "delete" ? "Deleting" : "Clearing";
  return `${label} ${current}/${total}`;
}

function formatBytes(size: number) {
  if (size < 1024) {
    return `${size} B`;
  }

  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }

  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function inferMimeType(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";

  switch (extension) {
    case "html":
      return "text/html; charset=utf-8";
    case "css":
      return "text/css; charset=utf-8";
    case "js":
      return "text/javascript; charset=utf-8";
    case "mjs":
      return "text/javascript; charset=utf-8";
    case "json":
      return "application/json; charset=utf-8";
    case "svg":
      return "image/svg+xml";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "ico":
      return "image/x-icon";
    case "txt":
      return "text/plain; charset=utf-8";
    case "woff":
      return "font/woff";
    case "woff2":
      return "font/woff2";
    case "ttf":
      return "font/ttf";
    default:
      return "application/octet-stream";
  }
}

function getArchiveFileCount(files: SevenZipExtractedFile[]) {
  return files.filter((file) => !file.isDirectory && file.data).length;
}

function getArchiveTotalSize(files: SevenZipExtractedFile[]) {
  return files.reduce(
    (total, file) => total + (file.isDirectory || !file.data ? 0 : file.data.byteLength),
    0,
  );
}

function buildRouterFiles(files: SevenZipExtractedFile[]): RouterFileRecord[] {
  return files.flatMap((file) => {
    if (file.isDirectory || !file.data) {
      return [];
    }

    const mime = inferMimeType(file.path);
    const blob = new Blob([new Uint8Array(file.data).slice().buffer], {
      type: mime,
    });

    return [
      {
        path: file.path,
        size: file.data.byteLength,
        mime,
        blob,
      },
    ];
  });
}

function StepCard({
  step,
  title,
  description,
  children,
}: {
  step: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-[28px] border border-white/10 bg-white/[0.03] p-6 shadow-[0_30px_80px_rgba(2,6,23,0.35)] backdrop-blur sm:p-7">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.28em] text-cyan-300/80">
            {step}
          </p>
          <h2 className="text-2xl font-semibold tracking-tight text-white">{title}</h2>
        </div>
      </div>
      <p className="mb-6 max-w-2xl text-sm leading-6 text-slate-300">{description}</p>
      {children}
    </section>
  );
}

function StatusPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-3">
      <p className="text-xs uppercase tracking-[0.22em] text-slate-500">{label}</p>
      <p className="mt-1 text-sm font-medium text-slate-100">{value}</p>
    </div>
  );
}

function HomePage() {
  const [routerState, setRouterState] = useState<RouterState | null>(null);
  const [routerProgress, setRouterProgress] = useState<string | null>(null);
  const [routerLogs, setRouterLogs] = useState<string[]>([]);
  const [routerError, setRouterError] = useState<string | null>(null);
  const [isRouterWorking, setIsRouterWorking] = useState(false);

  const [archiveBytes, setArchiveBytes] = useState<Uint8Array | null>(null);
  const [archiveName, setArchiveName] = useState("site.7z");
  const [archivePassword, setArchivePassword] = useState("");
  const [downloadMessage, setDownloadMessage] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [extractError, setExtractError] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [installSuccess, setInstallSuccess] = useState<string | null>(null);
  const [extractedFiles, setExtractedFiles] = useState<SevenZipExtractedFile[]>([]);
  const [isDownloading, setIsDownloading] = useState(false);
  const [isExtracting, setIsExtracting] = useState(false);
  const [isInstalling, setIsInstalling] = useState(false);

  useEffect(() => {
    let isCancelled = false;
    let unsubscribe = () => {};

    void getRouterClient()
      .then(async (client) => {
        if (isCancelled) {
          return;
        }

        unsubscribe = client.subscribe((event) => {
          if (event.type === "state") {
            setRouterState(event.state);
            setRouterProgress(null);
            return;
          }

          if (event.type === "progress") {
            setRouterProgress(
              formatRouterProgress(event.current, event.total, event.stage),
            );
            return;
          }

          if (event.type === "log") {
            setRouterLogs((currentLogs) => [event.message, ...currentLogs].slice(0, 10));
            return;
          }

          if (event.type === "error") {
            setRouterError(event.message);
          }
        });

        const nextState = await client.getStatus();
        if (!isCancelled) {
          setRouterState(nextState);
          setRouterError(null);
        }
      })
      .catch((error) => {
        if (!isCancelled) {
          setRouterError(
            error instanceof Error ? error.message : "Failed to connect to the router.",
          );
        }
      });

    return () => {
      isCancelled = true;
      unsubscribe();
    };
  }, []);

  async function refreshRouterStatus() {
    setIsRouterWorking(true);
    setRouterError(null);

    try {
      const client = await getRouterClient();
      setRouterState(await client.getStatus());
    } catch (error) {
      setRouterError(
        error instanceof Error ? error.message : "Failed to refresh the router status.",
      );
    } finally {
      setIsRouterWorking(false);
    }
  }

  async function switchRouterToFallback() {
    setIsRouterWorking(true);
    setRouterError(null);

    try {
      const client = await getRouterClient();
      setRouterState(await client.setMode("fallback"));
    } catch (error) {
      setRouterError(
        error instanceof Error ? error.message : "Failed to switch the router mode.",
      );
    } finally {
      setIsRouterWorking(false);
    }
  }

  async function handleDownloadArchive() {
    setIsDownloading(true);
    setDownloadError(null);
    setDownloadMessage(null);
    setExtractError(null);
    setInstallError(null);
    setInstallSuccess(null);
    setExtractedFiles([]);

    try {
      const response = await fetch("/site.7z", { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`Download failed with status ${response.status}.`);
      }

      const bytes = new Uint8Array(await response.arrayBuffer());

      setArchiveBytes(bytes);
      setArchiveName("site.7z");
      setDownloadMessage(`Downloaded site.7z (${formatBytes(bytes.byteLength)}).`);
    } catch (error) {
      setDownloadError(
        error instanceof Error ? error.message : "Failed to download /site.7z.",
      );
    } finally {
      setIsDownloading(false);
    }
  }

  async function handleDecryptArchive() {
    if (!archiveBytes) {
      setExtractError("Download the archive before decrypting it.");
      return;
    }

    setIsExtracting(true);
    setExtractError(null);
    setInstallError(null);
    setInstallSuccess(null);

    try {
      const files = await extractArchive({ path: archiveName, data: archiveBytes }, archivePassword);
      setExtractedFiles(files);
    } catch (error) {
      setExtractError(
        error instanceof Error ? error.message : "Failed to decrypt the archive.",
      );
      setExtractedFiles([]);
    } finally {
      setIsExtracting(false);
    }
  }

  async function handleInstallFlow() {
    if (extractedFiles.length === 0) {
      setInstallError("Decrypt the archive before installing it into the router.");
      return;
    }

    setIsInstalling(true);
    setRouterError(null);
    setInstallError(null);
    setInstallSuccess(null);

    try {
      const client = await getRouterClient();
      const routerFiles = buildRouterFiles(extractedFiles);

      if (routerFiles.length === 0) {
        throw new Error("The extracted archive did not contain any files to save.");
      }

      await client.clearFiles();
      await client.putFiles(routerFiles);
      const nextState = await client.setMode("on");

      setRouterState(nextState);
      setInstallSuccess(
        `Installed ${routerFiles.length} file(s) and switched the router to on mode.`,
      );
    } catch (error) {
      setInstallError(
        error instanceof Error ? error.message : "Failed to install the extracted files.",
      );
    } finally {
      setIsInstalling(false);
    }
  }

  const extractedFileCount = getArchiveFileCount(extractedFiles);
  const extractedTotalSize = getArchiveTotalSize(extractedFiles);

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-8 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <section className="overflow-hidden rounded-[32px] border border-cyan-400/20 bg-[radial-gradient(circle_at_top_left,rgba(34,211,238,0.18),transparent_30%),radial-gradient(circle_at_top_right,rgba(168,85,247,0.16),transparent_28%),linear-gradient(180deg,rgba(15,23,42,0.96),rgba(2,6,23,0.96))] p-6 shadow-[0_40px_120px_rgba(2,6,23,0.55)] sm:p-8 lg:p-10">
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1.5fr)_minmax(320px,0.9fr)] lg:items-end">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.32em] text-cyan-300/85">
              passwd nsite
            </p>
            <h1 className="mt-4 max-w-4xl text-4xl font-semibold tracking-tight text-white sm:text-5xl lg:text-6xl">
              Install the encrypted site bundle and switch the router live.
            </h1>
            <p className="mt-5 max-w-3xl text-base leading-7 text-slate-300 sm:text-lg">
              This screen is now the operational path only: fetch <code className="rounded bg-white/10 px-2 py-1 text-sm text-white">/site.7z</code>, decrypt it in the browser, write the extracted files into IndexedDB, and turn the service worker router on.
            </p>
          </div>

          <div className="grid gap-3 rounded-[28px] border border-white/10 bg-slate-950/50 p-4 backdrop-blur sm:grid-cols-2 lg:grid-cols-1">
            <StatusPill label="Router mode" value={routerState?.mode ?? "connecting"} />
            <StatusPill
              label="Stored files"
              value={String(routerState?.fileCount ?? 0)}
            />
            <StatusPill label="Worker activity" value={routerProgress ?? "Idle"} />
            <StatusPill
              label="Bundle status"
              value={
                extractedFileCount > 0
                  ? `${extractedFileCount} files ready`
                  : archiveBytes
                    ? "Archive downloaded"
                    : "Waiting to start"
              }
            />
          </div>
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-[minmax(0,1.55fr)_minmax(330px,0.85fr)]">
        <div className="grid gap-6">
          <StepCard
            step="Step 01"
            title="Download the deployment archive"
            description="Pull the latest encrypted site bundle from /site.7z. Downloading resets any prior decrypted result so each install run starts from a fresh archive."
          >
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-3 text-sm text-slate-300">
                Source: <code className="rounded bg-white/10 px-2 py-1 text-slate-100">/site.7z</code>
              </div>
              <button
                className="inline-flex min-h-12 items-center justify-center rounded-full bg-cyan-400 px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-cyan-300 disabled:cursor-wait disabled:opacity-60"
                type="button"
                onClick={handleDownloadArchive}
                disabled={isDownloading}
              >
                {isDownloading ? "Downloading archive..." : "Download archive"}
              </button>
            </div>

            {downloadMessage ? (
              <p className="mt-4 rounded-2xl border border-emerald-400/25 bg-emerald-400/10 px-4 py-3 text-sm text-emerald-200">
                {downloadMessage}
              </p>
            ) : null}

            {downloadError ? (
              <p className="mt-4 rounded-2xl border border-rose-400/25 bg-rose-400/10 px-4 py-3 text-sm text-rose-200">
                {downloadError}
              </p>
            ) : null}
          </StepCard>

          <StepCard
            step="Step 02"
            title="Decrypt and inspect the extracted site"
            description="Enter the archive password, run 7-Zip in the browser, and confirm the extracted file set before writing anything into the router database."
          >
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
              <label className="grid gap-2 text-left">
                <span className="text-sm font-medium text-slate-200">Archive password</span>
                <input
                  className="min-h-12 rounded-2xl border border-white/10 bg-slate-950/70 px-4 text-base text-white outline-none transition placeholder:text-slate-500 focus:border-cyan-400/60"
                  type="password"
                  value={archivePassword}
                  onChange={(event) => setArchivePassword(event.target.value)}
                  placeholder="Enter the site archive password"
                  autoComplete="current-password"
                />
              </label>
              <button
                className="inline-flex min-h-12 items-center justify-center rounded-full border border-white/15 bg-white/6 px-5 py-3 text-sm font-semibold text-white transition hover:border-cyan-400/35 hover:bg-cyan-400/10 disabled:cursor-wait disabled:opacity-60"
                type="button"
                onClick={handleDecryptArchive}
                disabled={isExtracting || !archiveBytes}
              >
                {isExtracting ? "Decrypting archive..." : "Decrypt archive"}
              </button>
            </div>

            {extractError ? (
              <p className="mt-4 rounded-2xl border border-rose-400/25 bg-rose-400/10 px-4 py-3 text-sm text-rose-200">
                {extractError}
              </p>
            ) : null}

            <div className="mt-5 grid gap-3 sm:grid-cols-3">
              <StatusPill label="Files" value={String(extractedFileCount)} />
              <StatusPill
                label="Folders"
                value={String(extractedFiles.filter((file) => file.isDirectory).length)}
              />
              <StatusPill
                label="Payload size"
                value={extractedFileCount > 0 ? formatBytes(extractedTotalSize) : "-"}
              />
            </div>

            <div className="mt-5 rounded-[24px] border border-white/10 bg-slate-950/60 p-4">
              <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
                <div>
                  <h3 className="text-lg font-semibold text-white">Extracted files</h3>
                  <p className="text-sm text-slate-400">
                    Review the first few paths before saving them into the router.
                  </p>
                </div>
                {extractedFileCount > 0 ? (
                  <p className="text-sm text-slate-400">{extractedFileCount} file(s) ready</p>
                ) : null}
              </div>

              {extractedFiles.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-5 text-sm text-slate-400">
                  No decrypted contents yet.
                </div>
              ) : (
                <ol className="grid gap-2">
                  {extractedFiles.slice(0, 12).map((file) => (
                    <li
                      key={file.path}
                      className="grid gap-2 rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-3 sm:grid-cols-[88px_minmax(0,1fr)] sm:items-center"
                    >
                      <span className="inline-flex w-fit rounded-full bg-cyan-400/12 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-cyan-200">
                        {file.isDirectory ? "Folder" : "File"}
                      </span>
                      <code className="overflow-hidden text-ellipsis whitespace-nowrap text-sm text-slate-200">
                        {file.path}
                      </code>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </StepCard>

          <StepCard
            step="Step 03"
            title="Install files into the router"
            description="This clears the router database, writes the extracted site files into IndexedDB, and switches the service worker router to on mode in one pass."
          >
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="max-w-2xl text-sm leading-6 text-slate-300">
                The service worker registration is started as soon as this page connects to the router client. The install action below performs the destructive database reset and then enables serving from IndexedDB.
              </div>
              <button
                className="inline-flex min-h-12 items-center justify-center rounded-full bg-violet-500 px-5 py-3 text-sm font-semibold text-white transition hover:bg-violet-400 disabled:cursor-wait disabled:opacity-60"
                type="button"
                onClick={handleInstallFlow}
                disabled={isInstalling || extractedFileCount === 0}
              >
                {isInstalling ? "Installing into router..." : "Install and enable router"}
              </button>
            </div>

            {installSuccess ? (
              <p className="mt-4 rounded-2xl border border-emerald-400/25 bg-emerald-400/10 px-4 py-3 text-sm text-emerald-200">
                {installSuccess}
              </p>
            ) : null}

            {installError ? (
              <p className="mt-4 rounded-2xl border border-rose-400/25 bg-rose-400/10 px-4 py-3 text-sm text-rose-200">
                {installError}
              </p>
            ) : null}
          </StepCard>
        </div>

        <aside className="grid gap-6">
          <section className="rounded-[28px] border border-white/10 bg-white/[0.03] p-6 shadow-[0_30px_80px_rgba(2,6,23,0.35)] backdrop-blur sm:p-7">
            <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.28em] text-cyan-300/80">
                  Router
                </p>
                <h2 className="mt-2 text-2xl font-semibold tracking-tight text-white">
                  Live status
                </h2>
              </div>
              <span className="rounded-full border border-white/10 bg-slate-950/70 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-slate-300">
                {routerState?.mode ?? "connecting"}
              </span>
            </div>

            <div className="grid gap-3">
              <StatusPill label="Stored files" value={String(routerState?.fileCount ?? 0)} />
              <StatusPill label="Current progress" value={routerProgress ?? "Idle"} />
            </div>

            <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
              <button
                className="inline-flex min-h-12 items-center justify-center rounded-full border border-white/15 bg-white/6 px-4 py-3 text-sm font-semibold text-white transition hover:border-cyan-400/35 hover:bg-cyan-400/10 disabled:cursor-wait disabled:opacity-60"
                type="button"
                onClick={refreshRouterStatus}
                disabled={isRouterWorking}
              >
                Refresh router status
              </button>
              <button
                className="inline-flex min-h-12 items-center justify-center rounded-full border border-white/15 bg-white/6 px-4 py-3 text-sm font-semibold text-white transition hover:border-amber-400/35 hover:bg-amber-400/10 disabled:cursor-wait disabled:opacity-60"
                type="button"
                onClick={switchRouterToFallback}
                disabled={isRouterWorking}
              >
                Switch to fallback
              </button>
            </div>

            {routerError ? (
              <p className="mt-4 rounded-2xl border border-rose-400/25 bg-rose-400/10 px-4 py-3 text-sm text-rose-200">
                {routerError}
              </p>
            ) : null}
          </section>

          <section className="rounded-[28px] border border-white/10 bg-white/[0.03] p-6 shadow-[0_30px_80px_rgba(2,6,23,0.35)] backdrop-blur sm:p-7">
            <div className="mb-4">
              <p className="text-xs font-semibold uppercase tracking-[0.28em] text-cyan-300/80">
                Activity
              </p>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight text-white">
                Worker stream
              </h2>
              <p className="mt-2 text-sm leading-6 text-slate-400">
                Service worker status messages from the current session.
              </p>
            </div>

            {routerLogs.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-5 text-sm text-slate-400">
                No router events yet.
              </div>
            ) : (
              <ol className="grid gap-2">
                {routerLogs.map((entry, index) => (
                  <li
                    key={`${index}-${entry}`}
                    className="rounded-2xl border border-white/8 bg-slate-950/60 px-4 py-3 text-sm leading-6 text-slate-300"
                  >
                    {entry}
                  </li>
                ))}
              </ol>
            )}
          </section>
        </aside>
      </section>
    </div>
  );
}

export default HomePage;
