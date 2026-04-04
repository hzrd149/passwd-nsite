import { useEffect, useState } from "react";
import { getRouterClient } from "../router/client";
import type { RouterState } from "../router/protocol";

function formatRouterProgress(
  current: number,
  total: number,
  stage: "put" | "delete" | "clear",
) {
  const label =
    stage === "put" ? "Saving" : stage === "delete" ? "Deleting" : "Clearing";
  return `${label} ${current}/${total}`;
}

function HomePage() {
  const [routerState, setRouterState] = useState<RouterState | null>(null);
  const [routerProgress, setRouterProgress] = useState<string | null>(null);
  const [routerLogs, setRouterLogs] = useState<string[]>([]);
  const [routerError, setRouterError] = useState<string | null>(null);
  const [isRouterWorking, setIsRouterWorking] = useState(false);

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
            setRouterLogs((currentLogs) =>
              [event.message, ...currentLogs].slice(0, 8),
            );
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
            error instanceof Error
              ? error.message
              : "Failed to connect to the router.",
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
        error instanceof Error
          ? error.message
          : "Failed to refresh the router status.",
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
        error instanceof Error
          ? error.message
          : "Failed to switch the router mode.",
      );
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
      setRouterError(
        error instanceof Error
          ? error.message
          : "Failed to clear router files.",
      );
    } finally {
      setIsRouterWorking(false);
    }
  }

  return (
    <>
      <section className="panel router-panel">
        <div className="results-header">
          <div>
            <h2>Router service worker</h2>
            <p>
              The worker is registered at <code>/</code>, serves all paths from
              IndexedDB in
              <code> on </code>
              mode, and falls back to the network when disabled.
            </p>
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
              {routerLogs.map((entry, index) => (
                <li key={`${index}-${entry}`}>{entry}</li>
              ))}
            </ol>
          )}
        </div>
      </section>

      <section className="panel home-panel">
        <div className="results-header">
          <h2>Install flow</h2>
          <p>
            The main archive download, decrypt, and upload workflow will live
            here.
          </p>
        </div>

        <p className="empty-state">
          Next step: download <code>/site.7z</code>, extract it in the config
          app, clear the router database, upload the resulting files, then
          switch the router to
          <code> on </code>
          mode.
        </p>
      </section>
    </>
  );
}

export default HomePage;
