import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import { nip19 } from "nostr-tools";
import { qrcode } from "@libs/qrcode";

import {
  loadPublishProfile,
  normalizePublishSignerRelayInput,
  publishEventToRelays,
  type PublishProfile,
  type PublishSigner,
} from "../lib/nostr";
import {
  createExtensionPublishSigner,
  createRemotePublishSignerSession,
  DEFAULT_REMOTE_SIGNER_RELAY,
} from "../lib/nostr-browser";
import {
  buildArchiveInputs,
  buildSignedSiteManifest,
  createPublishBundle,
  getPublishTargetRelays,
  getPublishTargetServers,
  uploadPublishBundle,
} from "../lib/publish";

type PublishPhase =
  | "connect"
  | "remote-connect"
  | "loading"
  | "ready"
  | "publishing"
  | "success";

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

type CurrentNamedSiteHost = {
  gatewaySuffix: string;
  pubkeyB36: string;
  siteId: string;
};

const SEVEN_ZIP_SIGNATURE = [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] as const;
const REMOTE_SESSION_DURATION_MS = 10 * 60 * 1000;

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

function parseCurrentNamedSiteHost(
  hostname: string,
): CurrentNamedSiteHost | null {
  const labels = hostname.toLowerCase().split(".").filter(Boolean);
  const leftMostLabel = labels[0];

  if (!leftMostLabel || labels.length < 2) {
    return null;
  }

  if (
    !/^[0-9a-z]{50}[a-z0-9-]{1,13}$/.test(leftMostLabel) ||
    leftMostLabel.endsWith("-")
  ) {
    return null;
  }

  return {
    gatewaySuffix: labels.slice(1).join("."),
    pubkeyB36: leftMostLabel.slice(0, 50),
    siteId: leftMostLabel.slice(50),
  };
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
      className="inline-flex min-h-9 items-center justify-center rounded-xl bg-white/6 px-3.5 text-sm font-medium text-slate-200 transition hover:bg-white/10"
      type="button"
      onClick={handleCopy}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function QrCodePanel({ value }: { value: string }) {
  const svg = qrcode(value, {
    output: "svg",
    border: 4,
  });

  return (
    <div className="rounded-2xl border border-white/10 bg-[radial-gradient(circle_at_top,rgba(34,211,238,0.08),transparent_55%),rgba(2,6,23,0.76)] p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
      <div
        className="overflow-hidden rounded-xl bg-slate-950 [&_svg]:h-auto [&_svg]:w-full"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </div>
  );
}

function RemoteSignerConnectView({
  connectionUri,
  errorMessage,
  relayValue,
  relayError,
  onRelayChange,
  onRelaySet,
  onBack,
}: {
  connectionUri: string | null;
  errorMessage: string | null;
  relayValue: string;
  relayError: string | null;
  onRelayChange: (value: string) => void;
  onRelaySet: () => void;
  onBack: () => void;
}) {
  return (
    <div className="space-y-6">
      <div className="space-y-3 text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.32em] text-cyan-300/85">
          Remote signer
        </p>
        <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">
          Connect publish signer
        </h1>
        <p className="text-sm leading-6 text-slate-400 sm:text-base">
          Open this request in your signer app and approve a temporary
          `passwd-nsite` session for publishing.
        </p>
      </div>

      <div className="grid gap-5 sm:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] sm:items-center">
        <div className="order-2 sm:order-1">
          {connectionUri ? (
            <QrCodePanel value={connectionUri} />
          ) : (
            <div className="flex min-h-[280px] items-center justify-center rounded-2xl bg-white/[0.04] p-5 text-center text-sm text-slate-400">
              Enter a valid relay to generate a nostrconnect QR code.
            </div>
          )}
        </div>

        <div className="order-1 space-y-4 sm:order-2">
          {connectionUri ? (
            <a
              className="inline-flex min-h-12 w-full items-center justify-center rounded-full bg-cyan-400 px-4 py-3 text-base font-semibold text-slate-950 transition hover:bg-cyan-300"
              href={connectionUri}
            >
              Open signer app
            </a>
          ) : (
            <button
              className="inline-flex min-h-12 w-full items-center justify-center rounded-full bg-slate-700 px-4 py-3 text-base font-semibold text-slate-300"
              type="button"
              disabled
            >
              Open signer app
            </button>
          )}

          <div className="rounded-2xl bg-white/[0.03] p-4 text-left">
            <label className="grid gap-2">
              <span className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
                Signer relay
              </span>
              <div className="flex flex-col gap-3 sm:flex-row">
                <input
                  className="min-h-11 min-w-0 flex-1 rounded-xl border border-white/10 bg-slate-950/80 px-4 text-sm text-white outline-none transition placeholder:text-slate-500 focus:border-cyan-400/60"
                  type="text"
                  value={relayValue}
                  onChange={(event) => onRelayChange(event.target.value)}
                  placeholder={DEFAULT_REMOTE_SIGNER_RELAY}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                />
                <button
                  className="inline-flex min-h-11 w-full items-center justify-center rounded-xl bg-white/6 px-4 text-sm font-semibold text-white transition hover:bg-white/10 sm:w-auto"
                  type="button"
                  onClick={onRelaySet}
                >
                  Set
                </button>
              </div>
            </label>
            <p className="mt-3 text-sm leading-6 text-slate-300">
              On desktop, scan the QR code with your signer app. On mobile, tap
              the button above to open the signer directly.
            </p>
            <p className="mt-3 text-sm leading-6 text-slate-400">
              If your signer keeps old approvals around, look for an existing
              `passwd-nsite` entry and remove duplicates there.
            </p>
            <div className="mt-4 flex flex-wrap gap-3">
              {connectionUri ? <CopyButton value={connectionUri} /> : null}
              <button
                className="inline-flex min-h-9 items-center justify-center rounded-xl bg-white/6 px-3.5 text-sm font-medium text-slate-200 transition hover:bg-white/10"
                type="button"
                onClick={onBack}
              >
                Back
              </button>
            </div>
          </div>
        </div>
      </div>

      {relayError ? (
        <p className="rounded-2xl border border-amber-400/25 bg-amber-400/10 px-4 py-3 text-sm text-amber-100">
          {relayError}
        </p>
      ) : null}

      {errorMessage ? (
        <p className="rounded-2xl border border-rose-400/25 bg-rose-400/10 px-4 py-3 text-sm text-rose-200">
          {errorMessage}
        </p>
      ) : null}
    </div>
  );
}

function PublishSuccessView({
  result,
  showLockedSiteLink,
}: {
  result: PublishResult;
  showLockedSiteLink: boolean;
}) {
  const currentGatewayUrl = getCurrentGatewayUrl(result);
  const fallbackGatewayUrls = getFallbackGatewayUrls(result);

  return (
    <div className="space-y-6">
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
          className="inline-flex min-h-12 w-full items-center justify-center rounded-full bg-cyan-400 px-4 py-3 text-base font-semibold text-slate-950 transition hover:bg-cyan-300"
          href={currentGatewayUrl}
        >
          Open site
        </a>
      ) : null}

      <div className="space-y-4 rounded-2xl bg-white/[0.03] p-4">
        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
          Gateway links
        </p>
        <div className="space-y-4">
          {currentGatewayUrl ? (
            <div className="rounded-xl bg-slate-950/50 px-4 py-3">
              <p className="text-sm font-medium text-white">Current gateway</p>
              <p className="mt-2 break-all font-mono text-xs text-slate-300">
                {currentGatewayUrl}
              </p>
              <div className="mt-4 flex gap-3">
                <a
                  className="inline-flex min-h-9 items-center justify-center rounded-xl bg-white/8 px-3.5 text-sm font-medium text-white transition hover:bg-white/14"
                  href={currentGatewayUrl}
                >
                  Open
                </a>
                <CopyButton value={currentGatewayUrl} />
              </div>
            </div>
          ) : (
            <>
              <div className="rounded-xl bg-slate-950/50 px-4 py-3 text-sm text-slate-400">
                This publish view is not currently running on a compatible nsite
                gateway hostname, so use one of these public gateways instead.
              </div>

              {fallbackGatewayUrls.map((gateway) => (
                <div
                  key={gateway.label}
                  className="rounded-xl bg-slate-950/50 px-4 py-3"
                >
                  <p className="text-sm font-medium text-white">
                    {gateway.label}
                  </p>
                  <p className="mt-2 break-all font-mono text-xs text-slate-300">
                    {gateway.url}
                  </p>
                  <div className="mt-4 flex gap-3">
                    <a
                      className="inline-flex min-h-9 items-center justify-center rounded-xl bg-white/8 px-3.5 text-sm font-medium text-white transition hover:bg-white/14"
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
        <div className="space-y-4 rounded-2xl bg-white/[0.03] p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
            Publish details
          </p>
          <div className="space-y-4 text-sm text-slate-200">
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

        <div className="space-y-4 rounded-2xl bg-white/[0.03] p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
            Delivery status
          </p>
          <div className="space-y-4 text-sm text-slate-200">
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
        {showLockedSiteLink ? (
          <a
            className="inline-flex min-h-11 flex-1 items-center justify-center rounded-full bg-white/6 px-4 py-3 text-sm font-semibold text-white transition hover:bg-white/10"
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
      className="min-h-11 rounded-xl border border-white/10 bg-slate-950/80 px-4 text-sm text-slate-200 file:mr-4 file:rounded-full file:border-0 file:bg-cyan-400 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-slate-950"
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
  const [publishSigner, setPublishSigner] = useState<PublishSigner | null>(
    null,
  );
  const [publishProfile, setPublishProfile] = useState<PublishProfile | null>(
    null,
  );
  const [folderFiles, setFolderFiles] = useState<File[]>([]);
  const [folderName, setFolderName] = useState("site");
  const [password, setPassword] = useState("");
  const [siteId, setSiteId] = useState("");
  const [skipUpdateMode, setSkipUpdateMode] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [publishResult, setPublishResult] = useState<PublishResult | null>(
    null,
  );
  const [hasLockedArchive, setHasLockedArchive] = useState(false);
  const [remoteConnectionUri, setRemoteConnectionUri] = useState<string | null>(
    null,
  );
  const [remoteRelayInput, setRemoteRelayInput] = useState(
    DEFAULT_REMOTE_SIGNER_RELAY,
  );
  const [remoteRelayUrl, setRemoteRelayUrl] = useState(() => {
    return normalizePublishSignerRelayInput(DEFAULT_REMOTE_SIGNER_RELAY);
  });
  const [remoteRelayError, setRemoteRelayError] = useState<string | null>(null);
  const [remoteSessionExpiresAt, setRemoteSessionExpiresAt] = useState<
    number | null
  >(null);
  const publishSignerRef = useRef<PublishSigner | null>(null);
  const remoteConnectAbortRef = useRef<AbortController | null>(null);

  const currentNamedSiteHost = parseCurrentNamedSiteHost(
    window.location.hostname,
  );
  const isUpdateMode = Boolean(
    publishProfile &&
    currentNamedSiteHost &&
    currentNamedSiteHost.pubkeyB36 === hexPubkeyToBase36(publishProfile.pubkey),
  );
  const isUpdatingCurrentSite = isUpdateMode && !skipUpdateMode;
  const effectiveSiteId = isUpdatingCurrentSite
    ? (currentNamedSiteHost?.siteId ?? "")
    : siteId.trim().toLowerCase();

  useEffect(() => {
    if (!isUpdateMode) {
      setSkipUpdateMode(false);
    }
  }, [isUpdateMode]);

  const disconnectSigner = useCallback(async (signer: PublishSigner | null) => {
    if (!signer) {
      return;
    }

    try {
      await signer.disconnect();
    } catch (error) {
      logPublishError("Failed to disconnect publish signer", error);
    }
  }, []);

  function abortPendingRemoteConnect() {
    remoteConnectAbortRef.current?.abort("Cancelled remote signer connect.");
    remoteConnectAbortRef.current = null;
  }

  const activateSigner = useCallback(
    async (signer: PublishSigner, profile: PublishProfile) => {
      const previousSigner = publishSignerRef.current;
      publishSignerRef.current = signer;
      setPublishSigner(signer);
      setPublishProfile(profile);
      setRemoteConnectionUri(null);
      setRemoteRelayError(null);

      if (signer.kind === "remote") {
        const expiresAt = Date.now() + REMOTE_SESSION_DURATION_MS;
        setRemoteSessionExpiresAt(expiresAt);
      } else {
        setRemoteSessionExpiresAt(null);
      }

      if (previousSigner && previousSigner !== signer) {
        await disconnectSigner(previousSigner);
      }
    },
    [disconnectSigner],
  );

  async function clearActiveSigner() {
    const signer = publishSignerRef.current;
    publishSignerRef.current = null;
    setPublishSigner(null);
    setPublishProfile(null);
    setRemoteConnectionUri(null);
    setRemoteSessionExpiresAt(null);
    await disconnectSigner(signer);
  }

  async function expireRemoteSignerSession() {
    if (publishSignerRef.current?.kind !== "remote") {
      return;
    }

    await clearActiveSigner();
    setPhase("connect");
    setErrorMessage(
      "Remote signer session expired. Reconnect to publish again.",
    );
  }

  const handleRemoteSessionExpired = useEffectEvent(() => {
    void expireRemoteSignerSession();
  });

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

  useEffect(() => {
    publishSignerRef.current = publishSigner;
  }, [publishSigner]);

  useEffect(() => {
    return () => {
      abortPendingRemoteConnect();
      const signer = publishSignerRef.current;
      if (signer) {
        void disconnectSigner(signer);
      }
    };
  }, [disconnectSigner]);

  useEffect(() => {
    if (publishSigner?.kind !== "remote" || !remoteSessionExpiresAt) {
      return;
    }

    let timeoutId = 0;

    const tick = () => {
      const remaining = remoteSessionExpiresAt - Date.now();
      if (remaining <= 0) {
        handleRemoteSessionExpired();
        return;
      }

      timeoutId = window.setTimeout(tick, 1000);
    };

    tick();

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [publishSigner, remoteSessionExpiresAt]);

  useEffect(() => {
    if (phase !== "remote-connect") {
      return;
    }

    abortPendingRemoteConnect();

    if (!remoteRelayUrl) {
      setRemoteConnectionUri(null);
      return;
    }

    const session = createRemotePublishSignerSession(remoteRelayUrl);
    const abortController = new AbortController();
    let signer: PublishSigner | null = null;
    let ignore = false;

    remoteConnectAbortRef.current = abortController;
    setRemoteConnectionUri(session.connectionUri);

    void (async () => {
      try {
        signer = await session.connect(abortController.signal);
        if (ignore || remoteConnectAbortRef.current !== abortController) {
          await disconnectSigner(signer);
          return;
        }

        remoteConnectAbortRef.current = null;
        setPhase("loading");
        setStatusMessage("Loading signer profile...");

        const profile = await loadPublishProfile(signer);
        if (ignore) {
          await disconnectSigner(signer);
          return;
        }

        await activateSigner(signer, profile);
        setPhase("ready");
      } catch (error) {
        if (signer) {
          await disconnectSigner(signer);
        }

        if (ignore || abortController.signal.aborted) {
          return;
        }

        logPublishError("Failed to connect remote publish signer", error);
        remoteConnectAbortRef.current = null;
        setErrorMessage(
          error instanceof Error
            ? error.message
            : "Failed to connect remote signer.",
        );
      }
    })();

    return () => {
      ignore = true;
      abortController.abort("Cancelled remote signer connect.");
      if (remoteConnectAbortRef.current === abortController) {
        remoteConnectAbortRef.current = null;
      }
    };
  }, [activateSigner, disconnectSigner, phase, remoteRelayUrl]);

  async function handleConnectPublisher() {
    abortPendingRemoteConnect();
    setPhase("loading");
    setStatusMessage("Connecting signer...");
    setErrorMessage(null);

    try {
      const signer = createExtensionPublishSigner();
      const profile = await loadPublishProfile(signer);
      await activateSigner(signer, profile);
      setPhase("ready");
    } catch (error) {
      logPublishError("Failed to connect publish signer", error);
      setPhase("connect");
      setErrorMessage(
        error instanceof Error ? error.message : "Failed to connect signer.",
      );
    }
  }

  async function handleConnectRemoteSigner() {
    setPhase("remote-connect");
    setErrorMessage(null);
  }

  function handleSetRemoteRelay() {
    const normalizedRelay = normalizePublishSignerRelayInput(remoteRelayInput);
    if (!normalizedRelay) {
      setRemoteRelayError("Enter a valid relay hostname or websocket URL.");
      return;
    }

    setRemoteRelayInput(normalizedRelay);
    setRemoteRelayUrl(normalizedRelay);
    setRemoteRelayError(null);
    setErrorMessage(null);
  }

  function handleBackFromRemoteConnect() {
    abortPendingRemoteConnect();
    setRemoteConnectionUri(null);
    setRemoteRelayError(null);
    setPhase("connect");
    setErrorMessage(null);
  }

  function handleFolderChange(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    const nextFolderName = inferFolderName(event.target.files);

    setFolderFiles(files);
    setFolderName(nextFolderName);
  }

  async function handlePublish() {
    if (!publishProfile || !publishSigner) {
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
        publishSigner.signEvent,
        ({ message }) => setStatusMessage(message),
      );

      setStatusMessage("Signing named site manifest...");
      const manifestResult = await buildSignedSiteManifest(
        bundle,
        {
          siteId: effectiveSiteId,
          title,
          description,
          servers: uploadResult.successfulServers,
        },
        publishSigner.signEvent,
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
        siteId: effectiveSiteId,
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
    effectiveSiteId.length > 0;
  const publishSignerKind = publishSigner?.kind ?? null;
  const remoteSessionTimeRemaining = remoteSessionExpiresAt
    ? Math.max(0, remoteSessionExpiresAt - Date.now())
    : 0;

  function formatDuration(durationMs: number): string {
    const totalSeconds = Math.ceil(durationMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;

    if (minutes <= 0) {
      return `${seconds}s`;
    }

    return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
  }

  if (publishResult) {
    return (
      <div className="mx-auto flex min-h-screen w-full max-w-4xl items-center justify-center px-4 py-6 sm:px-6 sm:py-10">
        <section className="w-full max-w-3xl rounded-3xl border border-white/10 bg-[radial-gradient(circle_at_top,rgba(16,185,129,0.16),transparent_38%),linear-gradient(180deg,rgba(15,23,42,0.9),rgba(2,6,23,0.92))] p-6 shadow-[0_24px_80px_rgba(2,6,23,0.4)] backdrop-blur sm:p-8">
          <PublishSuccessView
            result={publishResult}
            showLockedSiteLink={hasLockedArchive}
          />
        </section>
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-4xl items-center justify-center px-4 py-6 sm:px-6 sm:py-10">
      <section
        className={`w-full ${phase === "remote-connect" ? "max-w-3xl" : "max-w-xl"} rounded-3xl border border-white/10 bg-[radial-gradient(circle_at_top,rgba(34,211,238,0.14),transparent_38%),linear-gradient(180deg,rgba(15,23,42,0.9),rgba(2,6,23,0.92))] p-6 shadow-[0_24px_80px_rgba(2,6,23,0.4)] backdrop-blur sm:p-8`}
      >
        {phase === "loading" ? (
          <LoadingView title="Preparing publish" message={statusMessage} />
        ) : null}

        {phase === "publishing" ? (
          <LoadingView title="Publishing site" message={statusMessage} />
        ) : null}

        {phase === "remote-connect" ? (
          <RemoteSignerConnectView
            connectionUri={remoteConnectionUri}
            errorMessage={errorMessage}
            relayValue={remoteRelayInput}
            relayError={remoteRelayError}
            onRelayChange={setRemoteRelayInput}
            onRelaySet={handleSetRemoteRelay}
            onBack={handleBackFromRemoteConnect}
          />
        ) : null}

        {phase === "connect" ? (
          <div className="space-y-6 text-center">
            <div className="space-y-3">
              <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">
                Publish site
              </h1>
              <p className="text-sm leading-6 text-slate-400 sm:text-base">
                Connect a signer before creating and publishing a new locked
                site.
              </p>
            </div>

            <div className="grid gap-4 text-left">
              <button
                className="inline-flex min-h-12 w-full items-center justify-center rounded-full bg-cyan-400 px-4 py-3 text-base font-semibold text-slate-950 transition hover:bg-cyan-300"
                type="button"
                onClick={handleConnectPublisher}
              >
                Connect NIP-07 signer
              </button>

              <div className="rounded-2xl bg-white/[0.03] p-4 text-left">
                <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
                  Remote signer
                </p>
                <p className="mt-3 text-sm leading-6 text-slate-300">
                  Pair a temporary `passwd-nsite` session by opening a
                  nostrconnect link or scanning a QR code in your signer app.
                </p>
                <button
                  className="mt-4 inline-flex min-h-11 w-full items-center justify-center rounded-full bg-white/6 px-4 py-3 text-sm font-semibold text-white transition hover:bg-white/10"
                  type="button"
                  onClick={handleConnectRemoteSigner}
                >
                  Connect remote signer
                </button>
              </div>
            </div>

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
          <div className="space-y-6">
            <div className="space-y-3 text-center">
              <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">
                {isUpdatingCurrentSite ? "Update site" : "Publish site"}
              </h1>
              <p className="text-sm leading-6 text-slate-400 sm:text-base">
                {isUpdatingCurrentSite
                  ? `Replace the locked site bundle for ${effectiveSiteId} on this gateway, then publish the updated named site manifest to your outbox relays.`
                  : "Build a locked `site.7z`, upload the site blobs to blossom, then sign and publish a named site manifest to your outbox relays."}
              </p>
            </div>

            {publishProfile ? (
              <div className="space-y-4 rounded-2xl bg-white/[0.03] p-4">
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

                <div className="grid gap-3 border-t border-white/10 pt-4 sm:grid-cols-2">
                  <div className="text-left">
                    <p className="text-xs uppercase tracking-[0.22em] text-slate-500">
                      Outbox relays
                    </p>
                    <p className="mt-1 text-sm font-medium text-slate-100">
                      {publishProfile.outboxRelayCount > 0
                        ? `${publishProfile.outboxRelayCount} configured`
                        : `${publishProfile.defaultRelays.length} default relay(s)`}
                    </p>
                  </div>

                  <div className="text-left">
                    <p className="text-xs uppercase tracking-[0.22em] text-slate-500">
                      Blossom servers
                    </p>
                    <p className="mt-1 text-sm font-medium text-slate-100">
                      {publishProfile.blossomServerCount > 0
                        ? `${publishProfile.blossomServerCount} configured`
                        : `${publishProfile.defaultBlossomServers.length} default server(s)`}
                    </p>
                  </div>

                  <div className="text-left sm:col-span-2">
                    <p className="text-xs uppercase tracking-[0.22em] text-slate-500">
                      Signer
                    </p>
                    <p className="mt-1 text-sm font-medium text-slate-100">
                      {publishSignerKind === "remote"
                        ? "Remote signer"
                        : "NIP-07 extension"}
                    </p>
                  </div>

                  {publishSignerKind === "remote" ? (
                    <div className="rounded-xl bg-cyan-400/10 px-4 py-3 text-left sm:col-span-2">
                      <p className="text-xs uppercase tracking-[0.22em] text-cyan-200/80">
                        Session
                      </p>
                      <p className="mt-1 text-sm font-medium text-white">
                        Expires in {formatDuration(remoteSessionTimeRemaining)}
                      </p>
                      <p className="mt-1 text-sm text-slate-300">
                        Remove old `passwd-nsite` approvals in your signer app
                        if you want to clean up duplicates there.
                      </p>
                    </div>
                  ) : null}
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

              {isUpdatingCurrentSite ? (
                <div className="rounded-xl bg-cyan-400/10 px-4 py-3 text-sm">
                  <p className="text-xs uppercase tracking-[0.22em] text-cyan-200/80">
                    Update mode
                  </p>
                  <p className="mt-1 font-medium text-white">
                    Current hostname matches{" "}
                    <span className="font-mono">
                      {currentNamedSiteHost?.siteId}
                    </span>
                  </p>
                  <p className="mt-1 text-slate-300">
                    This gateway hostname already identifies the nsite name for
                    the connected signer.
                  </p>
                  <button
                    className="mt-3 text-sm font-medium text-cyan-200 transition hover:text-cyan-100"
                    type="button"
                    onClick={() => {
                      setSkipUpdateMode(true);
                      setShowAdvanced(true);
                      setSiteId("");
                    }}
                  >
                    dont update
                  </button>
                </div>
              ) : null}

              <div className="overflow-hidden rounded-2xl bg-white/[0.03]">
                <button
                  className="flex min-h-11 w-full items-center justify-between px-4 text-left text-sm font-medium text-slate-200"
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
                      Most locked sites do not need extra metadata.
                    </p>

                    {!isUpdatingCurrentSite ? (
                      <label className="grid gap-2">
                        <span className="text-sm font-medium text-slate-200">
                          Nsite name
                        </span>
                        <input
                          className="min-h-11 rounded-xl border border-white/10 bg-slate-950/80 px-4 text-sm text-white outline-none transition placeholder:text-slate-500 focus:border-cyan-400/60"
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
                    ) : null}

                    <label className="grid gap-2">
                      <span className="text-sm font-medium text-slate-200">
                        Site title
                      </span>
                      <input
                        className="min-h-11 rounded-xl border border-white/10 bg-slate-950/80 px-4 text-sm text-white outline-none transition placeholder:text-slate-500 focus:border-cyan-400/60"
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
                        className="min-h-28 rounded-xl border border-white/10 bg-slate-950/80 px-4 py-3 text-sm text-white outline-none transition placeholder:text-slate-500 focus:border-cyan-400/60"
                        value={description}
                        onChange={(event) => setDescription(event.target.value)}
                        placeholder="Optional description"
                      />
                    </label>
                  </div>
                ) : null}
              </div>

              <button
                className="inline-flex min-h-12 w-full items-center justify-center rounded-full bg-cyan-400 px-4 py-3 text-base font-semibold text-slate-950 transition hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-60"
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
