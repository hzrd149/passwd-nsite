import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";
import type { SevenZipArchiveEntry, SevenZipInputFile } from "../lib/7zip";

function inferFolderName(files: FileList | null): string {
  const firstPath = files?.[0]?.webkitRelativePath;
  if (!firstPath) {
    return "archive";
  }

  return firstPath.split("/")[0] || "archive";
}

function downloadArchive(data: Uint8Array, archiveName: string) {
  const bytes = new Uint8Array(data.byteLength);
  bytes.set(data);
  const url = URL.createObjectURL(
    new Blob([bytes.buffer as ArrayBuffer], {
      type: "application/x-7z-compressed",
    }),
  );
  const link = document.createElement("a");

  link.href = url;
  link.download = archiveName;
  link.click();

  URL.revokeObjectURL(url);
}

function DebugPage() {
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [inspectPassword, setInspectPassword] = useState("");
  const [entries, setEntries] = useState<SevenZipArchiveEntry[]>([]);
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [isInspecting, setIsInspecting] = useState(false);

  const [folderFiles, setFolderFiles] = useState<File[]>([]);
  const [folderName, setFolderName] = useState("archive");
  const [archiveName, setArchiveName] = useState("archive.7z");
  const [createPassword, setCreatePassword] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [createSuccess, setCreateSuccess] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  useEffect(() => {
    const input = folderInputRef.current;
    if (!input) {
      return;
    }

    input.setAttribute("webkitdirectory", "");
    input.setAttribute("directory", "");
  }, []);

  async function handleInspectArchive(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!selectedFile) {
      setInspectError("Choose a .7z file first.");
      setEntries([]);
      return;
    }

    setIsInspecting(true);
    setInspectError(null);
    setEntries([]);

    try {
      const { listArchiveEntries } = await import("../lib/7zip");
      const nextEntries = await listArchiveEntries(
        selectedFile,
        inspectPassword,
      );
      setEntries(nextEntries);
    } catch (caughtError) {
      setInspectError(
        caughtError instanceof Error
          ? caughtError.message
          : "Failed to inspect the archive.",
      );
    } finally {
      setIsInspecting(false);
    }
  }

  function handleFolderChange(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    const nextFolderName = inferFolderName(event.target.files);

    setFolderFiles(files);
    setFolderName(nextFolderName);
    setArchiveName(`${nextFolderName}.7z`);
    setCreateError(null);
    setCreateSuccess(null);
  }

  async function handleCreateArchive(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (folderFiles.length === 0) {
      setCreateError("Choose a folder first.");
      setCreateSuccess(null);
      return;
    }

    if (!createPassword) {
      setCreateError("Enter a password before creating the archive.");
      setCreateSuccess(null);
      return;
    }

    setIsCreating(true);
    setCreateError(null);
    setCreateSuccess(null);

    try {
      const { createEncryptedArchive } = await import("../lib/7zip");
      const files: SevenZipInputFile[] = await Promise.all(
        folderFiles.map(async (file) => ({
          path: file.webkitRelativePath || file.name,
          data: await file.arrayBuffer(),
        })),
      );

      const outputName = archiveName.trim() || `${folderName}.7z`;
      const archiveBytes = await createEncryptedArchive(
        files,
        createPassword,
        outputName,
      );

      downloadArchive(archiveBytes, outputName);
      setCreateSuccess(`Created and downloaded ${outputName}.`);
    } catch (caughtError) {
      setCreateError(
        caughtError instanceof Error
          ? caughtError.message
          : "Failed to create the archive.",
      );
    } finally {
      setIsCreating(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-8 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <section className="rounded-[32px] border border-white/10 bg-[radial-gradient(circle_at_top_left,rgba(168,85,247,0.2),transparent_30%),linear-gradient(180deg,rgba(15,23,42,0.96),rgba(2,6,23,0.96))] p-6 shadow-[0_40px_120px_rgba(2,6,23,0.55)] sm:p-8 lg:p-10">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.32em] text-violet-300/85">
              Debug tools
            </p>
            <h1 className="mt-4 max-w-4xl text-4xl font-semibold tracking-tight text-white sm:text-5xl">
              7z inspection and archive creation sandbox.
            </h1>
            <p className="mt-5 max-w-3xl text-base leading-7 text-slate-300">
              This stays out of the main install screen so experimental archive
              work does not clutter the operational flow.
            </p>
          </div>

          <a
            className="inline-flex min-h-12 items-center justify-center rounded-full border border-white/15 bg-white/6 px-5 py-3 text-sm font-semibold text-white transition hover:border-violet-300/40 hover:bg-violet-400/10"
            href="#/"
          >
            Back to install flow
          </a>
        </div>
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <form
          className="rounded-[28px] border border-white/10 bg-white/[0.03] p-6 shadow-[0_30px_80px_rgba(2,6,23,0.35)] backdrop-blur sm:p-7"
          onSubmit={handleInspectArchive}
        >
          <p className="text-xs font-semibold uppercase tracking-[0.28em] text-violet-300/80">
            Inspect
          </p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight text-white">
            Read archive contents
          </h2>
          <p className="mt-3 text-sm leading-6 text-slate-300">
            Choose a{" "}
            <code className="rounded bg-white/10 px-2 py-1 text-slate-100">
              .7z
            </code>{" "}
            file and list every reported entry.
          </p>

          <div className="mt-6 grid gap-4">
            <label className="grid gap-2 text-left">
              <span className="text-sm font-medium text-slate-200">
                Archive
              </span>
              <input
                className="min-h-12 rounded-2xl border border-white/10 bg-slate-950/70 px-4 text-sm text-slate-200 file:mr-4 file:rounded-full file:border-0 file:bg-violet-400 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-slate-950"
                type="file"
                accept=".7z,application/x-7z-compressed"
                onChange={(event) => {
                  setSelectedFile(event.target.files?.[0] ?? null);
                  setInspectError(null);
                  setEntries([]);
                }}
              />
            </label>

            <label className="grid gap-2 text-left">
              <span className="text-sm font-medium text-slate-200">
                Password
              </span>
              <input
                className="min-h-12 rounded-2xl border border-white/10 bg-slate-950/70 px-4 text-base text-white outline-none transition placeholder:text-slate-500 focus:border-violet-400/60"
                type="password"
                value={inspectPassword}
                onChange={(event) => setInspectPassword(event.target.value)}
                placeholder="Leave blank for unencrypted archives"
                autoComplete="current-password"
              />
            </label>

            <button
              className="inline-flex min-h-12 items-center justify-center rounded-full bg-violet-400 px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-violet-300 disabled:cursor-wait disabled:opacity-60"
              type="submit"
              disabled={isInspecting}
            >
              {isInspecting ? "Reading archive..." : "Show file list"}
            </button>
          </div>

          {inspectError ? (
            <p className="mt-4 rounded-2xl border border-rose-400/25 bg-rose-400/10 px-4 py-3 text-sm text-rose-200">
              {inspectError}
            </p>
          ) : null}
        </form>

        <form
          className="rounded-[28px] border border-white/10 bg-white/[0.03] p-6 shadow-[0_30px_80px_rgba(2,6,23,0.35)] backdrop-blur sm:p-7"
          onSubmit={handleCreateArchive}
        >
          <p className="text-xs font-semibold uppercase tracking-[0.28em] text-violet-300/80">
            Create
          </p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight text-white">
            Build encrypted archive
          </h2>
          <p className="mt-3 text-sm leading-6 text-slate-300">
            Pick a folder, name the output, and generate a new encrypted site
            bundle in the browser.
          </p>

          <div className="mt-6 grid gap-4">
            <label className="grid gap-2 text-left">
              <span className="text-sm font-medium text-slate-200">Folder</span>
              <input
                ref={folderInputRef}
                className="min-h-12 rounded-2xl border border-white/10 bg-slate-950/70 px-4 text-sm text-slate-200 file:mr-4 file:rounded-full file:border-0 file:bg-violet-400 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-slate-950"
                type="file"
                onChange={handleFolderChange}
              />
            </label>

            <label className="grid gap-2 text-left">
              <span className="text-sm font-medium text-slate-200">
                Archive name
              </span>
              <input
                className="min-h-12 rounded-2xl border border-white/10 bg-slate-950/70 px-4 text-base text-white outline-none transition placeholder:text-slate-500 focus:border-violet-400/60"
                type="text"
                value={archiveName}
                onChange={(event) => setArchiveName(event.target.value)}
                placeholder="archive.7z"
              />
            </label>

            <label className="grid gap-2 text-left">
              <span className="text-sm font-medium text-slate-200">
                Password
              </span>
              <input
                className="min-h-12 rounded-2xl border border-white/10 bg-slate-950/70 px-4 text-base text-white outline-none transition placeholder:text-slate-500 focus:border-violet-400/60"
                type="password"
                value={createPassword}
                onChange={(event) => setCreatePassword(event.target.value)}
                placeholder="Required for encrypted archives"
                autoComplete="new-password"
              />
            </label>

            <button
              className="inline-flex min-h-12 items-center justify-center rounded-full bg-violet-400 px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-violet-300 disabled:cursor-wait disabled:opacity-60"
              type="submit"
              disabled={isCreating}
            >
              {isCreating ? "Creating archive..." : "Create encrypted .7z"}
            </button>
          </div>

          {createError ? (
            <p className="mt-4 rounded-2xl border border-rose-400/25 bg-rose-400/10 px-4 py-3 text-sm text-rose-200">
              {createError}
            </p>
          ) : null}

          {createSuccess ? (
            <p className="mt-4 rounded-2xl border border-emerald-400/25 bg-emerald-400/10 px-4 py-3 text-sm text-emerald-200">
              {createSuccess}
            </p>
          ) : null}
        </form>
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-[28px] border border-white/10 bg-white/[0.03] p-6 shadow-[0_30px_80px_rgba(2,6,23,0.35)] backdrop-blur sm:p-7">
          <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-2xl font-semibold tracking-tight text-white">
                Archive contents
              </h2>
              <p className="mt-2 text-sm leading-6 text-slate-400">
                Files and folders reported by 7-Zip.
              </p>
            </div>
            <div className="text-sm text-slate-400">
              {selectedFile
                ? `Selected: ${selectedFile.name}`
                : "No archive selected"}
            </div>
          </div>

          {entries.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-5 text-sm text-slate-400">
              Select an archive, enter its password if needed, and list its
              contents.
            </div>
          ) : (
            <ol className="grid gap-2">
              {entries.map((entry) => (
                <li
                  key={entry.path}
                  className="grid gap-2 rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-3 sm:grid-cols-[88px_minmax(0,1fr)] sm:items-center"
                >
                  <span className="inline-flex w-fit rounded-full bg-violet-400/12 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-violet-200">
                    {entry.isDirectory ? "Folder" : "File"}
                  </span>
                  <code className="overflow-hidden text-ellipsis whitespace-nowrap text-sm text-slate-200">
                    {entry.path}
                  </code>
                </li>
              ))}
            </ol>
          )}
        </div>

        <div className="rounded-[28px] border border-white/10 bg-white/[0.03] p-6 shadow-[0_30px_80px_rgba(2,6,23,0.35)] backdrop-blur sm:p-7">
          <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-2xl font-semibold tracking-tight text-white">
                Archive creation
              </h2>
              <p className="mt-2 text-sm leading-6 text-slate-400">
                The generated archive downloads immediately after creation.
              </p>
            </div>
            <div className="text-sm text-slate-400">
              {folderFiles.length > 0
                ? `${folderFiles.length} file(s) from ${folderName}`
                : "No folder selected"}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-3">
              <p className="text-xs uppercase tracking-[0.22em] text-slate-500">
                Output name
              </p>
              <p className="mt-1 text-sm font-medium text-slate-100">
                {archiveName || "archive.7z"}
              </p>
            </div>
            <div className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-3">
              <p className="text-xs uppercase tracking-[0.22em] text-slate-500">
                Source files
              </p>
              <p className="mt-1 text-sm font-medium text-slate-100">
                {folderFiles.length}
              </p>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

export default DebugPage;
