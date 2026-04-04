import { useEffect, useState, type FormEvent } from "react";
import { extractArchive, type SevenZipExtractedFile } from "../lib/7zip";
import { getRouterClient } from "../router/client";
import type { RouterFileRecord } from "../router/protocol";

type InstallerPhase =
  | "downloading"
  | "download_error"
  | "awaiting_password"
  | "installing"
  | "install_error";

const SEVEN_ZIP_SIGNATURE = [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] as const;

function isSevenZipArchive(bytes: Uint8Array): boolean {
  return SEVEN_ZIP_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

function inferMimeType(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";

  switch (extension) {
    case "html":
      return "text/html; charset=utf-8";
    case "css":
      return "text/css; charset=utf-8";
    case "js":
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
    const mime = inferMimeType(path);
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
        <p className="text-sm leading-6 text-slate-400 sm:text-base">{message}</p>
      </div>
    </div>
  );
}

function HomePage() {
  const [phase, setPhase] = useState<InstallerPhase>("downloading");
  const [statusMessage, setStatusMessage] = useState("Downloading site bundle...");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [archiveBytes, setArchiveBytes] = useState<Uint8Array | null>(null);

  async function downloadArchive() {
    setPhase("downloading");
    setStatusMessage("Downloading site bundle...");
    setErrorMessage(null);

    try {
      const response = await fetch("/site.7z", { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`Download failed with status ${response.status}.`);
      }

      const contentType = response.headers.get("content-type") ?? "";
      const bytes = new Uint8Array(await response.arrayBuffer());

      if (contentType.includes("text/html") || !isSevenZipArchive(bytes)) {
        throw new Error("/site.7z is missing or did not return a valid 7z archive.");
      }

      setArchiveBytes(bytes);
      setPhase("awaiting_password");
      setStatusMessage("Archive ready.");
    } catch (error) {
      setPhase("download_error");
      setErrorMessage(
        error instanceof Error ? error.message : "Failed to download /site.7z.",
      );
    }
  }

  useEffect(() => {
    void downloadArchive();
  }, []);

  async function handleInstall(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!archiveBytes) {
      setPhase("download_error");
      setErrorMessage("The site bundle is not available yet. Retry the download.");
      return;
    }

    setPhase("installing");
    setErrorMessage(null);

    try {
      setStatusMessage("Decrypting archive...");
      const extractedFiles = await extractArchive(
        { path: "site.7z", data: archiveBytes },
        password,
      );

      setStatusMessage("Preparing files...");
      const routerFiles = buildRouterFiles(extractedFiles);
      if (routerFiles.length === 0) {
        throw new Error("The archive did not contain any files to install.");
      }

      const client = await getRouterClient();

      setStatusMessage("Clearing local router storage...");
      await client.clearFiles();

      setStatusMessage("Saving site files...");
      await client.putFiles(routerFiles);

      setStatusMessage("Enabling router...");
      await client.setMode("on");

      setStatusMessage("Reloading site...");
      window.location.assign("/");
    } catch (error) {
      setPhase("install_error");
      setErrorMessage(
        error instanceof Error ? error.message : "Failed to install the site bundle.",
      );
    }
  }

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-4xl items-center justify-center px-4 py-8 sm:px-6 lg:px-8">
      <section className="w-full max-w-xl rounded-[32px] border border-white/10 bg-[radial-gradient(circle_at_top,rgba(34,211,238,0.12),transparent_35%),linear-gradient(180deg,rgba(15,23,42,0.96),rgba(2,6,23,0.96))] p-8 shadow-[0_40px_120px_rgba(2,6,23,0.55)] sm:p-10">
        <div className="mb-10 text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.32em] text-cyan-300/85">
            passwd nsite
          </p>
        </div>

        {phase === "downloading" ? (
          <LoadingView title="Preparing site" message={statusMessage} />
        ) : null}

        {phase === "awaiting_password" ? (
          <div className="space-y-8 text-center">
            <div className="space-y-3">
              <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">
                Unlock site bundle
              </h1>
              <p className="text-sm leading-6 text-slate-400 sm:text-base">
                Enter the archive password to install the site and enable the router.
              </p>
            </div>

            <form className="space-y-4" onSubmit={handleInstall}>
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
                Install site
              </button>
            </form>
          </div>
        ) : null}

        {phase === "installing" ? (
          <LoadingView title="Installing site" message={statusMessage} />
        ) : null}

        {phase === "download_error" || phase === "install_error" ? (
          <div className="space-y-8 text-center">
            <div className="space-y-3">
              <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">
                Setup paused
              </h1>
              <p className="text-sm leading-6 text-slate-400 sm:text-base">
                {errorMessage ?? "Something went wrong while preparing the site."}
              </p>
            </div>

            <div className="space-y-3">
              <button
                className="inline-flex min-h-14 w-full items-center justify-center rounded-full bg-cyan-400 px-5 py-3 text-base font-semibold text-slate-950 transition hover:bg-cyan-300"
                type="button"
                onClick={() => {
                  if (phase === "download_error") {
                    void downloadArchive();
                    return;
                  }

                  setPhase("awaiting_password");
                }}
              >
                {phase === "download_error" ? "Retry download" : "Try again"}
              </button>

              <a
                className="inline-flex min-h-12 w-full items-center justify-center rounded-full border border-white/10 bg-white/[0.03] px-5 py-3 text-sm font-medium text-slate-300 transition hover:border-white/20 hover:text-white"
                href="#/debug"
              >
                Open debug view
              </a>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}

export default HomePage;
