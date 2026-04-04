import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { loadPublishProfile, type PublishProfile } from "../lib/nostr";

type PublishPhase = "connect" | "loading" | "ready";

function inferFolderName(files: FileList | null): string {
  const firstPath = files?.[0]?.webkitRelativePath;
  if (!firstPath) {
    return "site";
  }

  return firstPath.split("/")[0] || "site";
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

function IdentityAvatar({
  picture,
  displayName,
}: {
  picture: string | null;
  displayName: string;
}) {
  if (picture) {
    return (
      <img
        className="h-16 w-16 rounded-full border border-white/10 object-cover"
        src={picture}
        alt={displayName}
        referrerPolicy="no-referrer"
      />
    );
  }

  return (
    <div className="flex h-16 w-16 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-xl font-semibold text-cyan-200">
      {displayName.slice(0, 1).toUpperCase()}
    </div>
  );
}

function PublishPage() {
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const [phase, setPhase] = useState<PublishPhase>("connect");
  const [statusMessage, setStatusMessage] = useState("Connecting signer...");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [publishProfile, setPublishProfile] = useState<PublishProfile | null>(
    null,
  );
  const [folderFiles, setFolderFiles] = useState<File[]>([]);
  const [folderName, setFolderName] = useState("site");

  useEffect(() => {
    const input = folderInputRef.current;
    if (!input) {
      return;
    }

    input.setAttribute("webkitdirectory", "");
    input.setAttribute("directory", "");
  }, []);

  async function handleConnectPublisher() {
    setPhase("loading");
    setStatusMessage("Connecting signer...");
    setErrorMessage(null);

    try {
      const profile = await loadPublishProfile();
      setPublishProfile(profile);
      setPhase("ready");
    } catch (error) {
      setPhase("connect");
      setErrorMessage(
        error instanceof Error ? error.message : "Failed to connect signer.",
      );
    }
  }

  function handleFolderChange(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    const nextFolderName = inferFolderName(event.target.files);

    setFolderFiles(files);
    setFolderName(nextFolderName);
  }

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-4xl items-center justify-center px-4 py-8 sm:px-6 lg:px-8">
      <section className="w-full max-w-xl rounded-[32px] border border-white/10 bg-[radial-gradient(circle_at_top,rgba(34,211,238,0.12),transparent_35%),linear-gradient(180deg,rgba(15,23,42,0.96),rgba(2,6,23,0.96))] p-8 shadow-[0_40px_120px_rgba(2,6,23,0.55)] sm:p-10">
        <div className="mb-10 text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.32em] text-cyan-300/85">
            passwd nsite
          </p>
        </div>

        {phase === "loading" ? (
          <LoadingView title="Preparing publish" message={statusMessage} />
        ) : null}

        {phase === "connect" ? (
          <div className="space-y-8 text-center">
            <div className="space-y-3">
              <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">
                Publish site
              </h1>
              <p className="text-sm leading-6 text-slate-400 sm:text-base">
                Connect a NIP-07 signer before creating and publishing a new
                locked site.
              </p>
            </div>

            <button
              className="inline-flex min-h-14 w-full items-center justify-center rounded-full bg-cyan-400 px-5 py-3 text-base font-semibold text-slate-950 transition hover:bg-cyan-300"
              type="button"
              onClick={handleConnectPublisher}
            >
              Connect NIP-07 signer
            </button>

            {errorMessage ? (
              <p className="rounded-2xl border border-rose-400/25 bg-rose-400/10 px-4 py-3 text-sm text-rose-200">
                {errorMessage}
              </p>
            ) : null}

            <div className="text-sm text-slate-400">
              <a className="transition hover:text-cyan-200" href="#/">
                Back to locked site
              </a>
            </div>
          </div>
        ) : null}

        {phase === "ready" ? (
          <div className="space-y-8">
            <div className="space-y-3 text-center">
              <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">
                Publish site
              </h1>
              <p className="text-sm leading-6 text-slate-400 sm:text-base">
                Your signer is ready. The archive upload and publishing steps
                come next.
              </p>
            </div>

            {publishProfile ? (
              <div className="rounded-[28px] border border-white/10 bg-white/[0.03] px-5 py-5">
                <div className="flex items-center gap-4">
                  <IdentityAvatar
                    picture={publishProfile.picture}
                    displayName={publishProfile.displayName}
                  />
                  <div className="min-w-0">
                    <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
                      Signed in as
                    </p>
                    <p className="mt-1 truncate text-lg font-semibold text-white">
                      {publishProfile.displayName}
                    </p>
                  </div>
                </div>

                <div className="mt-5 grid gap-3 sm:grid-cols-2">
                  <div className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-3 text-left">
                    <p className="text-xs uppercase tracking-[0.22em] text-slate-500">
                      Relays
                    </p>
                    <p className="mt-1 text-sm font-medium text-slate-100">
                      {publishProfile.outboxRelayCount} configured
                    </p>
                    {!publishProfile.hasConfiguredRelays ? (
                      <p className="mt-1 text-xs text-slate-400">
                        Defaults will be used next.
                      </p>
                    ) : null}
                  </div>

                  <div className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-3 text-left">
                    <p className="text-xs uppercase tracking-[0.22em] text-slate-500">
                      Blossom servers
                    </p>
                    <p className="mt-1 text-sm font-medium text-slate-100">
                      {publishProfile.blossomServerCount} configured
                    </p>
                    {!publishProfile.hasConfiguredBlossomServers ? (
                      <p className="mt-1 text-xs text-slate-400">
                        Defaults will be used next.
                      </p>
                    ) : null}
                  </div>
                </div>
              </div>
            ) : null}

            <div className="grid gap-4 text-left">
              <label className="grid gap-2">
                <span className="text-sm font-medium text-slate-200">
                  Site folder
                </span>
                <input
                  ref={folderInputRef}
                  className="min-h-12 rounded-2xl border border-white/10 bg-slate-950/70 px-4 text-sm text-slate-200 file:mr-4 file:rounded-full file:border-0 file:bg-cyan-400 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-slate-950"
                  type="file"
                  onChange={handleFolderChange}
                />
              </label>

              <div className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-3">
                <p className="text-xs uppercase tracking-[0.22em] text-slate-500">
                  Selected files
                </p>
                <p className="mt-1 text-sm font-medium text-slate-100">
                  {folderFiles.length > 0
                    ? `${folderFiles.length} file(s) from ${folderName}`
                    : "No folder selected yet"}
                </p>
              </div>

              <button
                className="inline-flex min-h-14 w-full items-center justify-center rounded-full border border-white/10 bg-white/6 px-5 py-3 text-base font-semibold text-white/80"
                type="button"
                disabled
              >
                Publish flow continues next
              </button>
            </div>

            <div className="text-center text-sm text-slate-400">
              <a className="transition hover:text-cyan-200" href="#/">
                Back to locked site
              </a>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}

export default PublishPage;
