import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import "./App.css";
import {
  createEncryptedArchive,
  listArchiveEntries,
  type SevenZipArchiveEntry,
  type SevenZipInputFile,
} from "./lib/7zip";
import { getRouterClient } from "./router/client";
import type { RouterState } from "./router/protocol";

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
    new Blob([bytes.buffer as ArrayBuffer], { type: "application/x-7z-compressed" }),
  );
  const link = document.createElement("a");

  link.href = url;
  link.download = archiveName;
  link.click();

  URL.revokeObjectURL(url);
}

function formatRouterProgress(current: number, total: number, stage: "put" | "delete" | "clear") {
  const label = stage === "put" ? "Saving" : stage === "delete" ? "Deleting" : "Clearing";
  return `${label} ${current}/${total}`;
}

function App() {
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

  const [routerState, setRouterState] = useState<RouterState | null>(null);
  const [routerProgress, setRouterProgress] = useState<string | null>(null);
  const [routerLogs, setRouterLogs] = useState<string[]>([]);
  const [routerError, setRouterError] = useState<string | null>(null);
  const [isRouterWorking, setIsRouterWorking] = useState(false);

  useEffect(() => {
    const input = folderInputRef.current;
    if (!input) {
      return;
    }

    input.setAttribute("webkitdirectory", "");
    input.setAttribute("directory", "");
  }, []);

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
            setRouterProgress(formatRouterProgress(event.current, event.total, event.stage));
            return;
          }

          if (event.type === "log") {
            setRouterLogs((currentLogs) => [event.message, ...currentLogs].slice(0, 8));
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
          setRouterError(error instanceof Error ? error.message : "Failed to connect to the router.");
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
      setRouterError(error instanceof Error ? error.message : "Failed to refresh the router status.");
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
      setRouterError(error instanceof Error ? error.message : "Failed to switch the router mode.");
    } finally {
      setIsRouterWorking(false);
    }
  }

  async function clearRouterFiles() {
    setIsRouterWorking(true);
    setRouterError(null);

    try {
      const client = await getRouterClient();
      await client.clearFiles();
      setRouterState(await client.getStatus());
    } catch (error) {
      setRouterError(error instanceof Error ? error.message : "Failed to clear router files.");
    } finally {
      setIsRouterWorking(false);
    }
  }

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
      const nextEntries = await listArchiveEntries(selectedFile, inspectPassword);
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
    <main className="app-shell">
      <section className="panel intro-panel">
        <p className="eyebrow">Encrypted archive tools</p>
        <h1>Inspect or create password-protected 7z archives in the browser</h1>
        <p className="lede">
          This Vite app loads <code>7z-wasm</code> in the browser so you can
          inspect a local <code>.7z</code> file or select a folder and package it
          into a new encrypted archive without uploading anything to a server.
        </p>
      </section>

      <section className="panel router-panel">
        <div className="results-header">
          <div>
            <h2>Router service worker</h2>
            <p>It stays in fallback mode until the config app uploads a site into IndexedDB.</p>
          </div>

          <div className="button-row">
            <button
              className="secondary-action"
              type="button"
              onClick={refreshRouterStatus}
              disabled={isRouterWorking}
            >
              Refresh status
            </button>
            <button
              className="secondary-action"
              type="button"
              onClick={switchRouterToFallback}
              disabled={isRouterWorking}
            >
              Use fallback mode
            </button>
            <button
              className="secondary-action"
              type="button"
              onClick={clearRouterFiles}
              disabled={isRouterWorking}
            >
              Clear stored files
            </button>
          </div>
        </div>

        <div className="router-status-grid">
          <p>
            <strong>Mode:</strong> {routerState?.mode ?? "connecting"}
          </p>
          <p>
            <strong>Stored files:</strong> {routerState?.fileCount ?? 0}
          </p>
          <p>
            <strong>Progress:</strong> {routerProgress ?? "Idle"}
          </p>
        </div>

        {routerError ? <p className="error-banner">{routerError}</p> : null}

        <div className="results-panel">
          <div className="results-header">
            <h2>Router stream</h2>
            <p>Status messages from the worker appear here.</p>
          </div>

          {routerLogs.length === 0 ? (
            <p className="empty-state">No router events yet.</p>
          ) : (
            <ol className="router-log-list">
              {routerLogs.map((entry) => (
                <li key={entry}>{entry}</li>
              ))}
            </ol>
          )}
        </div>
      </section>

      <section className="panel workflow-grid">
        <form className="archive-form" onSubmit={handleInspectArchive}>
          <div className="section-copy">
            <h2>Inspect archive</h2>
            <p>Choose a `.7z` file and list its contents.</p>
          </div>

          <label className="field">
            <span>Archive</span>
            <input
              type="file"
              accept=".7z,application/x-7z-compressed"
              onChange={(event) => {
                setSelectedFile(event.target.files?.[0] ?? null);
                setInspectError(null);
                setEntries([]);
              }}
            />
          </label>

          <label className="field">
            <span>Password</span>
            <input
              type="password"
              value={inspectPassword}
              onChange={(event) => setInspectPassword(event.target.value)}
              placeholder="Leave blank for unencrypted archives"
              autoComplete="current-password"
            />
          </label>

          <button className="primary-action" type="submit" disabled={isInspecting}>
            {isInspecting ? "Reading archive..." : "Show file list"}
          </button>
        </form>

        <form className="archive-form" onSubmit={handleCreateArchive}>
          <div className="section-copy">
            <h2>Create archive</h2>
            <p>Select a folder, set a password, and download a new `.7z`.</p>
          </div>

          <label className="field">
            <span>Folder</span>
            <input ref={folderInputRef} type="file" onChange={handleFolderChange} />
          </label>

          <label className="field">
            <span>Archive name</span>
            <input
              type="text"
              value={archiveName}
              onChange={(event) => setArchiveName(event.target.value)}
              placeholder="archive.7z"
            />
          </label>

          <label className="field">
            <span>Password</span>
            <input
              type="password"
              value={createPassword}
              onChange={(event) => setCreatePassword(event.target.value)}
              placeholder="Required for encrypted archives"
              autoComplete="new-password"
            />
          </label>

          <button className="primary-action" type="submit" disabled={isCreating}>
            {isCreating ? "Creating archive..." : "Create encrypted .7z"}
          </button>
        </form>
      </section>

      <section className="panel results-grid">
        <div>
          <div className="status-row" aria-live="polite">
            <p>
              {selectedFile
                ? `Selected: ${selectedFile.name}`
                : "No archive selected yet."}
            </p>
            {entries.length > 0 ? <p>{entries.length} item(s) found</p> : null}
          </div>

          {inspectError ? <p className="error-banner">{inspectError}</p> : null}

          <div className="results-panel">
            <div className="results-header">
              <h2>Archive contents</h2>
              <p>Files and folders reported by 7-Zip.</p>
            </div>

            {entries.length === 0 ? (
              <p className="empty-state">
                Select an archive, enter its password if needed, and list its
                contents.
              </p>
            ) : (
              <ol className="entry-list">
                {entries.map((entry) => (
                  <li key={entry.path} className="entry-row">
                    <span className="entry-kind">
                      {entry.isDirectory ? "Dir" : "File"}
                    </span>
                    <code>{entry.path}</code>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>

        <div>
          <div className="status-row" aria-live="polite">
            <p>
              {folderFiles.length > 0
                ? `${folderFiles.length} file(s) selected from ${folderName}`
                : "No folder selected yet."}
            </p>
            <p>{archiveName || "archive.7z"}</p>
          </div>

          {createError ? <p className="error-banner">{createError}</p> : null}
          {createSuccess ? <p className="success-banner">{createSuccess}</p> : null}

          <div className="results-panel">
            <div className="results-header">
              <h2>Archive creation</h2>
              <p>The generated archive downloads immediately after creation.</p>
            </div>

            <p className="empty-state">
              Choose a folder, provide a password, and this app will create a
              new encrypted <code>.7z</code> file in the browser.
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}

export default App;
