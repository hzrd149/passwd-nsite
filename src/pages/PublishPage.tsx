import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { nip19 } from "nostr-tools";

import {
  loadPublishProfile,
  publishEventToRelays,
  signNostrEvent,
  type PublishProfile,
} from "../lib/nostr";
import {
  buildArchiveInputs,
  buildSignedSiteManifest,
  createPublishBundle,
  getPublishTargetRelays,
  getPublishTargetServers,
  uploadPublishBundle,
} from "../lib/publish";

type PublishPhase = "connect" | "loading" | "ready" | "publishing" | "success";

type PublishResult = {
  eventId: string;
  aggregateHash: string;
  siteId: string;
  pubkey: string;
  pathCount: number;
  servers: string[];
  targetRelays: string[];
  successfulRelays: string[];
  failedRelays: Array<{ relay: string; error: string }>;
};

const SEVEN_ZIP_SIGNATURE = [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] as const;

function logPublishError(context: string, error: unknown) {
  console.error(context, error);
}

function isSevenZipArchive(bytes: Uint8Array): boolean {
  return SEVEN_ZIP_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

async function hasLockedSiteArchive(): Promise<boolean> {
  const response = await fetch("/site.7z", { cache: "no-store" });

  if (response.status === 404) {
    return false;
  }

  if (!response.ok) {
    throw new Error(`Archive check failed with status ${response.status}.`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const bytes = new Uint8Array(await response.arrayBuffer());

  return !contentType.includes("text/html") && isSevenZipArchive(bytes);
}

function hexPubkeyToBase36(pubkey: string): string {
  if (!/^[0-9a-f]{64}$/i.test(pubkey)) {
    throw new Error("The signer pubkey is not a valid 32-byte hex value.");
  }

  return BigInt(`0x${pubkey}`).toString(36).padStart(50, "0");
}

function getCurrentGatewaySuffix(hostname: string): string | null {
  const labels = hostname.toLowerCase().split(".").filter(Boolean);
  const leftMostLabel = labels[0];

  if (!leftMostLabel || labels.length < 2) {
    return null;
  }

  const isSnapshotLabel = /^h[0-9a-z]{50}$/.test(leftMostLabel);
  const isNamedSiteLabel =
    /^[0-9a-z]{50}[a-z0-9-]{1,13}$/.test(leftMostLabel) &&
    !leftMostLabel.endsWith("-");

  let isRootSiteLabel = false;
  try {
    const decoded = nip19.decode(leftMostLabel);
    isRootSiteLabel = decoded.type === "npub";
  } catch {
    isRootSiteLabel = false;
  }

  if (!isRootSiteLabel && !isSnapshotLabel && !isNamedSiteLabel) {
    return null;
  }

  return labels.slice(1).join(".");
}

function buildNamedSiteUrl(result: PublishResult, baseUrl: URL): string {
  const nextUrl = new URL(baseUrl.toString());
  nextUrl.pathname = "/";
  nextUrl.hash = "";
  nextUrl.search = "";
  nextUrl.hostname = `${hexPubkeyToBase36(result.pubkey)}${result.siteId}.${nextUrl.hostname}`;
  return nextUrl.toString();
}

function getCurrentGatewayUrl(result: PublishResult): string | null {
  const gatewaySuffix = getCurrentGatewaySuffix(window.location.hostname);
  if (!gatewaySuffix) {
    return null;
  }

  const currentGatewayBaseUrl = new URL(window.location.origin);
  currentGatewayBaseUrl.hostname = gatewaySuffix;

  return buildNamedSiteUrl(result, currentGatewayBaseUrl);
}

function getFallbackGatewayUrls(result: PublishResult): Array<{
  label: string;
  url: string;
}> {
  return [
    {
      label: "nsite.lol",
      url: buildNamedSiteUrl(result, new URL("https://nsite.lol")),
    },
    {
      label: "nsite.run",
      url: buildNamedSiteUrl(result, new URL("https://nsite.run")),
    },
  ];
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch (error) {
      logPublishError("Failed to copy publish value", error);
    }
  }

  return (
    <button
      className="inline-flex min-h-10 items-center justify-center rounded-full border border-white/10 bg-white/5 px-4 text-sm font-medium text-slate-200 transition hover:bg-white/10"
      type="button"
      onClick={handleCopy}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function PublishSuccessView({
  result,
  onReset,
  showLockedSiteLink,
}: {
  result: PublishResult;
  onReset: () => void;
  showLockedSiteLink: boolean;
}) {
  const currentGatewayUrl = getCurrentGatewayUrl(result);
  const fallbackGatewayUrls = getFallbackGatewayUrls(result);

  return (
    <div className="space-y-8">
      <div className="space-y-3 text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.32em] text-emerald-300/85">
          Locked nsite published
        </p>
        <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">
          Your new site is live
        </h1>
        <p className="text-sm leading-6 text-slate-400 sm:text-base">
          The manifest has been signed and published to your outbox relays.
        </p>
      </div>

      {currentGatewayUrl ? (
        <a
          className="inline-flex min-h-14 w-full items-center justify-center rounded-full bg-cyan-400 px-5 py-3 text-base font-semibold text-slate-950 transition hover:bg-cyan-300"
          href={currentGatewayUrl}
        >
          Open site
        </a>
      ) : null}

      <div className="rounded-[28px] border border-white/10 bg-white/[0.03] px-5 py-5">
        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
          Gateway links
        </p>
        <div className="mt-4 space-y-4">
          {currentGatewayUrl ? (
            <div className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-4">
              <p className="text-sm font-medium text-white">Current gateway</p>
              <p className="mt-2 break-all font-mono text-xs text-slate-300">
                {currentGatewayUrl}
              </p>
              <div className="mt-4 flex gap-3">
                <a
                  className="inline-flex min-h-10 items-center justify-center rounded-full bg-white/8 px-4 text-sm font-medium text-white transition hover:bg-white/14"
                  href={currentGatewayUrl}
                >
                  Open
                </a>
                <CopyButton value={currentGatewayUrl} />
              </div>
            </div>
          ) : (
            <>
              <div className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-4 text-sm text-slate-400">
                This publish view is not currently running on a compatible nsite
                gateway hostname, so use one of these public gateways instead.
              </div>

              {fallbackGatewayUrls.map((gateway) => (
                <div
                  key={gateway.label}
                  className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-4"
                >
                  <p className="text-sm font-medium text-white">
                    {gateway.label}
                  </p>
                  <p className="mt-2 break-all font-mono text-xs text-slate-300">
                    {gateway.url}
                  </p>
                  <div className="mt-4 flex gap-3">
                    <a
                      className="inline-flex min-h-10 items-center justify-center rounded-full bg-white/8 px-4 text-sm font-medium text-white transition hover:bg-white/14"
                      href={gateway.url}
                    >
                      Open
                    </a>
                    <CopyButton value={gateway.url} />
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-[28px] border border-white/10 bg-white/[0.03] px-5 py-5">
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
            Publish details
          </p>
          <div className="mt-4 space-y-4 text-sm text-slate-200">
            <div>
              <p className="text-slate-400">Named site id</p>
              <p className="mt-1 font-medium text-white">{result.siteId}</p>
            </div>
            <div>
              <p className="text-slate-400">Published paths</p>
              <p className="mt-1 font-medium text-white">{result.pathCount}</p>
            </div>
            <div>
              <p className="text-slate-400">Event id</p>
              <p className="mt-1 break-all font-mono text-xs text-slate-300">
                {result.eventId}
              </p>
              <div className="mt-2">
                <CopyButton value={result.eventId} />
              </div>
            </div>
            <div>
              <p className="text-slate-400">Aggregate hash</p>
              <p className="mt-1 break-all font-mono text-xs text-slate-300">
                {result.aggregateHash}
              </p>
              <div className="mt-2">
                <CopyButton value={result.aggregateHash} />
              </div>
            </div>
          </div>
        </div>

        <div className="rounded-[28px] border border-white/10 bg-white/[0.03] px-5 py-5">
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
            Delivery status
          </p>
          <div className="mt-4 space-y-4 text-sm text-slate-200">
            <div>
              <p className="text-slate-400">Blossom servers</p>
              <p className="mt-1 font-medium text-white">
                {result.servers.length}
              </p>
            </div>
            <div>
              <p className="text-slate-400">Outbox relays</p>
              <p className="mt-1 font-medium text-white">
                {result.successfulRelays.length}/{result.targetRelays.length}{" "}
                writes succeeded
              </p>
            </div>
            {result.failedRelays.length > 0 ? (
              <div>
                <p className="text-slate-400">Relay issues</p>
                <div className="mt-2 space-y-2 text-xs text-amber-100">
                  {result.failedRelays.map((failure) => (
                    <p key={failure.relay} className="break-all">
                      {failure.relay}: {failure.error}
                    </p>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row">
        <button
          className="inline-flex min-h-12 flex-1 items-center justify-center rounded-full border border-white/10 bg-white/6 px-5 py-3 text-sm font-semibold text-white transition hover:bg-white/10"
          type="button"
          onClick={onReset}
        >
          Publish another site
        </button>
        {showLockedSiteLink ? (
          <a
            className="inline-flex min-h-12 flex-1 items-center justify-center rounded-full border border-white/10 bg-white/6 px-5 py-3 text-sm font-semibold text-white transition hover:bg-white/10"
            href="#/"
          >
            Back to locked site
          </a>
        ) : null}
      </div>
    </div>
  );
}

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

function DirectoryInput({
  onChange,
}: {
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) {
      return;
    }

    input.multiple = true;
    input.setAttribute("webkitdirectory", "");
    input.setAttribute("directory", "");
  }, []);

  return (
    <input
      ref={inputRef}
      className="min-h-12 rounded-2xl border border-white/10 bg-slate-950/70 px-4 text-sm text-slate-200 file:mr-4 file:rounded-full file:border-0 file:bg-cyan-400 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-slate-950"
      type="file"
      multiple
      onChange={onChange}
    />
  );
}

function PublishPage() {
  const [phase, setPhase] = useState<PublishPhase>("connect");
  const [statusMessage, setStatusMessage] = useState("Connecting signer...");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [publishProfile, setPublishProfile] = useState<PublishProfile | null>(
    null,
  );
  const [folderFiles, setFolderFiles] = useState<File[]>([]);
  const [folderName, setFolderName] = useState("site");
  const [password, setPassword] = useState("");
  const [siteId, setSiteId] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [publishResult, setPublishResult] = useState<PublishResult | null>(
    null,
  );
  const [hasLockedArchive, setHasLockedArchive] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function loadLockedArchiveStatus() {
      try {
        const nextHasLockedArchive = await hasLockedSiteArchive();
        if (!cancelled) {
          setHasLockedArchive(nextHasLockedArchive);
        }
      } catch (error) {
        logPublishError("Failed to check locked site archive", error);
      }
    }

    void loadLockedArchiveStatus();

    return () => {
      cancelled = true;
    };
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
      logPublishError("Failed to connect publish signer", error);
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

  async function handlePublish() {
    if (!publishProfile) {
      setErrorMessage("Connect a signer before publishing.");
      return;
    }

    setPhase("publishing");
    setStatusMessage("Preparing folder...");
    setErrorMessage(null);
    setPublishResult(null);

    try {
      const targetServers = getPublishTargetServers(
        publishProfile.blossomServers,
        publishProfile.defaultBlossomServers,
      );
      const targetRelays = getPublishTargetRelays(
        publishProfile.outboxRelays,
        publishProfile.defaultRelays,
      );

      setStatusMessage("Reading selected folder...");
      const archiveInputs = await buildArchiveInputs(folderFiles);
      const { createEncryptedArchive } = await import("../lib/7zip");

      setStatusMessage("Building encrypted site.7z...");
      const archiveBytes = await createEncryptedArchive(
        archiveInputs,
        password,
        "site.7z",
      );

      const bundle = await createPublishBundle(
        new Blob([archiveBytes.slice().buffer], {
          type: "application/x-7z-compressed",
        }),
        ({ message }) => setStatusMessage(message),
      );

      setStatusMessage("Uploading site blobs to blossom...");
      const uploadResult = await uploadPublishBundle(
        bundle.blobs,
        targetServers,
        signNostrEvent,
        ({ message }) => setStatusMessage(message),
      );

      setStatusMessage("Signing named site manifest...");
      const manifestResult = await buildSignedSiteManifest(
        bundle,
        {
          siteId,
          title,
          description,
          servers: uploadResult.successfulServers,
        },
        signNostrEvent,
      );

      setStatusMessage("Publishing manifest to outbox relays...");
      const relayResult = await publishEventToRelays(
        manifestResult.event,
        targetRelays,
      );

      if (relayResult.successfulRelays.length === 0) {
        throw new Error(
          relayResult.failedRelays[0]?.error ??
            "Failed to publish the site manifest to any outbox relay.",
        );
      }

      setPublishResult({
        eventId: manifestResult.event.id,
        aggregateHash: manifestResult.aggregateHash,
        siteId: siteId.trim().toLowerCase(),
        pubkey: publishProfile.pubkey,
        pathCount: manifestResult.pathCount,
        servers: uploadResult.successfulServers,
        targetRelays: relayResult.targetRelays,
        successfulRelays: relayResult.successfulRelays,
        failedRelays: relayResult.failedRelays,
      });
      setStatusMessage("Publish complete.");
      setPhase("success");
    } catch (error) {
      logPublishError("Failed to publish site", error);
      setPhase("ready");
      setErrorMessage(
        error instanceof Error ? error.message : "Failed to publish site.",
      );
    }
  }

  const canPublish =
    folderFiles.length > 0 &&
    password.trim().length > 0 &&
    siteId.trim().length > 0;

  if (publishResult) {
    return (
      <div className="mx-auto flex min-h-screen w-full max-w-4xl items-center justify-center px-4 py-8 sm:px-6 lg:px-8">
        <section className="w-full max-w-3xl rounded-[32px] border border-white/10 bg-[radial-gradient(circle_at_top,rgba(16,185,129,0.12),transparent_35%),linear-gradient(180deg,rgba(15,23,42,0.96),rgba(2,6,23,0.96))] p-8 shadow-[0_40px_120px_rgba(2,6,23,0.55)] sm:p-10">
          <PublishSuccessView
            result={publishResult}
            showLockedSiteLink={hasLockedArchive}
            onReset={() => {
              setPublishResult(null);
              setPhase("ready");
              setErrorMessage(null);
            }}
          />
        </section>
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-4xl items-center justify-center px-4 py-8 sm:px-6 lg:px-8">
      <section className="w-full max-w-xl rounded-[32px] border border-white/10 bg-[radial-gradient(circle_at_top,rgba(34,211,238,0.12),transparent_35%),linear-gradient(180deg,rgba(15,23,42,0.96),rgba(2,6,23,0.96))] p-8 shadow-[0_40px_120px_rgba(2,6,23,0.55)] sm:p-10">
        {phase === "loading" ? (
          <LoadingView title="Preparing publish" message={statusMessage} />
        ) : null}

        {phase === "publishing" ? (
          <LoadingView title="Publishing site" message={statusMessage} />
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

            {hasLockedArchive ? (
              <div className="text-sm text-slate-400">
                <a className="transition hover:text-cyan-200" href="#/">
                  Back to locked site
                </a>
              </div>
            ) : null}
          </div>
        ) : null}

        {phase === "ready" || phase === "success" ? (
          <div className="space-y-8">
            <div className="space-y-3 text-center">
              <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">
                Publish site
              </h1>
              <p className="text-sm leading-6 text-slate-400 sm:text-base">
                Build a locked `site.7z`, upload the site blobs to blossom, then
                sign and publish a named site manifest to your outbox relays.
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
                      Outbox relays
                    </p>
                    <p className="mt-1 text-sm font-medium text-slate-100">
                      {publishProfile.outboxRelayCount > 0
                        ? `${publishProfile.outboxRelayCount} configured`
                        : `${publishProfile.defaultRelays.length} default relay(s)`}
                    </p>
                  </div>

                  <div className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-3 text-left">
                    <p className="text-xs uppercase tracking-[0.22em] text-slate-500">
                      Blossom servers
                    </p>
                    <p className="mt-1 text-sm font-medium text-slate-100">
                      {publishProfile.blossomServerCount > 0
                        ? `${publishProfile.blossomServerCount} configured`
                        : `${publishProfile.defaultBlossomServers.length} default server(s)`}
                    </p>
                  </div>
                </div>
              </div>
            ) : null}

            {errorMessage ? (
              <p className="rounded-2xl border border-rose-400/25 bg-rose-400/10 px-4 py-3 text-sm text-rose-200">
                {errorMessage}
              </p>
            ) : null}

            <div className="grid gap-4 text-left">
              <label className="grid gap-2">
                <span className="text-sm font-medium text-slate-200">
                  Site folder
                </span>
                <DirectoryInput onChange={handleFolderChange} />
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

              <label className="grid gap-2">
                <span className="text-sm font-medium text-slate-200">
                  Site password
                </span>
                <input
                  className="min-h-12 rounded-2xl border border-white/10 bg-slate-950/70 px-4 text-sm text-white outline-none transition placeholder:text-slate-500 focus:border-cyan-400/60"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="Required for site.7z"
                />
              </label>

              <label className="grid gap-2">
                <span className="text-sm font-medium text-slate-200">
                  Named site id
                </span>
                <input
                  className="min-h-12 rounded-2xl border border-white/10 bg-slate-950/70 px-4 text-sm text-white outline-none transition placeholder:text-slate-500 focus:border-cyan-400/60"
                  type="text"
                  value={siteId}
                  onChange={(event) =>
                    setSiteId(event.target.value.toLowerCase())
                  }
                  placeholder="blog"
                  maxLength={13}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                />
              </label>

              <div className="overflow-hidden rounded-2xl border border-white/10 bg-slate-950/40">
                <button
                  className="flex min-h-12 w-full items-center justify-between px-4 text-left text-sm font-medium text-slate-200"
                  type="button"
                  onClick={() => setShowAdvanced((value) => !value)}
                  aria-expanded={showAdvanced}
                >
                  <span>Advanced metadata</span>
                  <span className="text-slate-500">
                    {showAdvanced ? "Hide" : "Show"}
                  </span>
                </button>

                {showAdvanced ? (
                  <div className="grid gap-4 border-t border-white/10 px-4 py-4">
                    <p className="text-sm text-slate-400">
                      Most locked sites do not need a title or description.
                    </p>

                    <label className="grid gap-2">
                      <span className="text-sm font-medium text-slate-200">
                        Site title
                      </span>
                      <input
                        className="min-h-12 rounded-2xl border border-white/10 bg-slate-950/70 px-4 text-sm text-white outline-none transition placeholder:text-slate-500 focus:border-cyan-400/60"
                        type="text"
                        value={title}
                        onChange={(event) => setTitle(event.target.value)}
                        placeholder="Optional title"
                      />
                    </label>

                    <label className="grid gap-2">
                      <span className="text-sm font-medium text-slate-200">
                        Site description
                      </span>
                      <textarea
                        className="min-h-28 rounded-2xl border border-white/10 bg-slate-950/70 px-4 py-3 text-sm text-white outline-none transition placeholder:text-slate-500 focus:border-cyan-400/60"
                        value={description}
                        onChange={(event) => setDescription(event.target.value)}
                        placeholder="Optional description"
                      />
                    </label>
                  </div>
                ) : null}
              </div>

              <button
                className="inline-flex min-h-14 w-full items-center justify-center rounded-full bg-cyan-400 px-5 py-3 text-base font-semibold text-slate-950 transition hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-60"
                type="button"
                onClick={handlePublish}
                disabled={!canPublish}
              >
                Publish site
              </button>
            </div>

            {hasLockedArchive ? (
              <div className="text-center text-sm text-slate-400">
                <a className="transition hover:text-cyan-200" href="#/">
                  Back to locked site
                </a>
              </div>
            ) : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}

export default PublishPage;
