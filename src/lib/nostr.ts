import { SimplePool } from "nostr-tools";
import type {
  Event as NostrEvent,
  EventTemplate as NostrEventTemplate,
  VerifiedEvent,
} from "nostr-tools";
import { BunkerSigner, createNostrConnectURI } from "nostr-tools/nip46";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import {
  DEFAULT_BLOSSOM_SERVERS,
  DEFAULT_RELAYS,
  LOOKUP_RELAYS,
} from "../const";

const PROFILE_LOOKUP_GRACE_PERIOD_MS = 5000;
const PROFILE_LOOKUP_FALLBACK_TIMEOUT_MS = 10000;

export type PublishSigner = {
  kind: "nip07" | "remote";
  getPublicKey(): Promise<string>;
  signEvent(event: NostrEventTemplate): Promise<VerifiedEvent>;
  disconnect(): Promise<void>;
};

export type RemotePublishSignerSession = {
  connectionUri: string;
  connect(abortSignal?: AbortSignal): Promise<PublishSigner>;
};

const BLOSSOM_AUTH_KIND = 24242;
const NSITE_MANIFEST_KIND = 35128;
const REMOTE_SIGNER_NAME = "passwd-nsite";
export const DEFAULT_REMOTE_SIGNER_RELAY = "bucket.coracle.social";
const REMOTE_SIGNER_PERMS = [
  "get_public_key",
  `sign_event:${BLOSSOM_AUTH_KIND}`,
  `sign_event:${NSITE_MANIFEST_KIND}`,
] as const;

export type PublishProfile = {
  pubkey: string;
  picture: string | null;
  displayName: string;
  lookupRelays: string[];
  outboxRelays: string[];
  blossomServers: string[];
  outboxRelayCount: number;
  blossomServerCount: number;
  hasConfiguredRelays: boolean;
  hasConfiguredBlossomServers: boolean;
  defaultRelays: string[];
  defaultBlossomServers: string[];
};

type ProfileMetadata = {
  picture: string | null;
  displayName: string;
};

type PublishProfileSigner = Pick<PublishSigner, "getPublicKey">;

function logNostrError(context: string, error: unknown) {
  console.error(context, error);
}

function normalizeRelayUrl(url: string): string | null {
  try {
    const nextUrl = new URL(url);

    if (nextUrl.protocol !== "ws:" && nextUrl.protocol !== "wss:") {
      return null;
    }

    nextUrl.hash = "";
    nextUrl.pathname = nextUrl.pathname.replace(/\/+$/, "");
    nextUrl.search = "";

    if (
      (nextUrl.protocol === "ws:" && nextUrl.port === "80") ||
      (nextUrl.protocol === "wss:" && nextUrl.port === "443")
    ) {
      nextUrl.port = "";
    }

    return nextUrl.toString();
  } catch {
    return null;
  }
}

export function normalizePublishSignerRelayInput(input: string): string | null {
  const trimmedInput = input.trim();
  if (!trimmedInput) {
    return null;
  }

  const relayInput = /^[a-z]+:\/\//i.test(trimmedInput)
    ? trimmedInput
    : `wss://${trimmedInput}`;

  return normalizeRelayUrl(relayInput);
}

function normalizeHttpUrl(url: string): string | null {
  try {
    const nextUrl = new URL(url);

    if (nextUrl.protocol !== "http:" && nextUrl.protocol !== "https:") {
      return null;
    }

    nextUrl.hash = "";
    nextUrl.search = "";
    nextUrl.pathname = nextUrl.pathname.replace(/\/+$/, "");

    return nextUrl.toString();
  } catch {
    return null;
  }
}

function normalizeImageUrl(url: string | undefined): string | null {
  if (!url) {
    return null;
  }

  return normalizeHttpUrl(url);
}

function dedupe(values: Array<string | null>): string[] {
  return [
    ...new Set(values.filter((value): value is string => Boolean(value))),
  ];
}

function pickLatestEvent(events: NostrEvent[]): NostrEvent | null {
  if (events.length === 0) {
    return null;
  }

  return [...events].sort(
    (left, right) => right.created_at - left.created_at,
  )[0];
}

async function getLatestProfileEvents(
  pool: SimplePool,
  relays: string[],
  pubkey: string,
): Promise<{
  profileEvent: NostrEvent | null;
  relayListEvent: NostrEvent | null;
  blossomListEvent: NostrEvent | null;
}> {
  return new Promise((resolve) => {
    const eventsByKind = new Map<number, NostrEvent[]>();
    const seenEventIds = new Set<string>();
    const subscriptions = new Map<string, { close(reason?: string): void }>();
    const completedRelays = new Set<string>();
    let settled = false;
    let graceTimeoutId: ReturnType<typeof setTimeout> | null = null;
    let fallbackTimeoutId: ReturnType<typeof setTimeout> | null =
      window.setTimeout(() => {
        finalize();
      }, PROFILE_LOOKUP_FALLBACK_TIMEOUT_MS);

    function storeEvent(event: NostrEvent) {
      if (seenEventIds.has(event.id)) {
        return;
      }

      seenEventIds.add(event.id);
      const existingEvents = eventsByKind.get(event.kind) ?? [];
      existingEvents.push(event);
      eventsByKind.set(event.kind, existingEvents);
    }

    function clearTimers() {
      if (graceTimeoutId !== null) {
        window.clearTimeout(graceTimeoutId);
        graceTimeoutId = null;
      }

      if (fallbackTimeoutId !== null) {
        window.clearTimeout(fallbackTimeoutId);
        fallbackTimeoutId = null;
      }
    }

    function closeSubscriptions(reason: string) {
      subscriptions.forEach((subscription) => {
        try {
          subscription.close(reason);
        } catch {
          // Ignore close errors while shutting down lookup subscriptions.
        }
      });
      subscriptions.clear();
    }

    function finalize() {
      if (settled) {
        return;
      }

      settled = true;
      clearTimers();
      closeSubscriptions("profile lookup complete");

      resolve({
        profileEvent: pickLatestEvent(eventsByKind.get(0) ?? []),
        relayListEvent: pickLatestEvent(eventsByKind.get(10002) ?? []),
        blossomListEvent: pickLatestEvent(eventsByKind.get(10063) ?? []),
      });
    }

    function markRelayComplete(relay: string) {
      if (settled || completedRelays.has(relay)) {
        return;
      }

      completedRelays.add(relay);

      if (graceTimeoutId === null) {
        graceTimeoutId = window.setTimeout(() => {
          finalize();
        }, PROFILE_LOOKUP_GRACE_PERIOD_MS);
      }

      if (completedRelays.size === relays.length) {
        finalize();
      }
    }

    relays.forEach((relayUrl) => {
      void pool
        .ensureRelay(relayUrl, {
          connectionTimeout: PROFILE_LOOKUP_FALLBACK_TIMEOUT_MS,
        })
        .then((relay) => {
          if (settled) {
            return;
          }

          const subscription = relay.subscribe(
            [
              {
                authors: [pubkey],
                kinds: [0, 10002, 10063],
              },
            ],
            {
              onevent(event) {
                storeEvent(event);
              },
              oneose() {
                subscriptions.delete(relayUrl);
                markRelayComplete(relayUrl);
              },
              onclose() {
                subscriptions.delete(relayUrl);
                markRelayComplete(relayUrl);
              },
              alreadyHaveEvent(eventId) {
                return seenEventIds.has(eventId);
              },
              eoseTimeout: PROFILE_LOOKUP_FALLBACK_TIMEOUT_MS,
            },
          );

          subscriptions.set(relayUrl, subscription);
        })
        .catch((error) => {
          logNostrError(`Failed to connect lookup relay ${relayUrl}`, error);
          markRelayComplete(relayUrl);
        });
    });
  });
}

function getOutboxRelays(event: NostrEvent | null): string[] {
  if (!event) {
    return [];
  }

  return dedupe(
    event.tags
      .filter((tag) => tag[0] === "r")
      .map((tag) => {
        const marker = tag[2];

        if (marker && marker !== "write") {
          return null;
        }

        return normalizeRelayUrl(tag[1] ?? "");
      }),
  );
}

function getBlossomServers(event: NostrEvent | null): string[] {
  if (!event) {
    return [];
  }

  return dedupe(
    event.tags
      .filter((tag) => tag[0] === "server")
      .map((tag) => normalizeHttpUrl(tag[1] ?? "")),
  );
}

function getProfileMetadata(event: NostrEvent | null): ProfileMetadata {
  if (!event) {
    return {
      picture: null,
      displayName: "Unnamed account",
    };
  }

  try {
    const content = JSON.parse(event.content) as {
      display_name?: unknown;
      name?: unknown;
      picture?: unknown;
    };

    const displayName =
      typeof content.display_name === "string" && content.display_name.trim()
        ? content.display_name.trim()
        : typeof content.name === "string" && content.name.trim()
          ? content.name.trim()
          : "Unnamed account";

    return {
      picture: normalizeImageUrl(
        typeof content.picture === "string" ? content.picture : undefined,
      ),
      displayName,
    };
  } catch {
    return {
      picture: null,
      displayName: "Unnamed account",
    };
  }
}

export async function loadPublishProfile(
  signer: PublishProfileSigner,
): Promise<PublishProfile> {
  const pubkey = await signer.getPublicKey();
  const lookupRelays = [...LOOKUP_RELAYS];
  const pool = new SimplePool();

  try {
    const { profileEvent, relayListEvent, blossomListEvent } =
      await getLatestProfileEvents(pool, lookupRelays, pubkey).catch(
        (error) => {
          logNostrError("Failed to load publish profile", error);
          return {
            profileEvent: null,
            relayListEvent: null,
            blossomListEvent: null,
          };
        },
      );

    const profileMetadata = getProfileMetadata(profileEvent);
    const outboxRelays = getOutboxRelays(relayListEvent);
    const blossomServers = getBlossomServers(blossomListEvent);

    return {
      pubkey,
      picture: profileMetadata.picture,
      displayName: profileMetadata.displayName,
      lookupRelays,
      outboxRelays,
      blossomServers,
      outboxRelayCount: outboxRelays.length,
      blossomServerCount: blossomServers.length,
      hasConfiguredRelays: outboxRelays.length > 0,
      hasConfiguredBlossomServers: blossomServers.length > 0,
      defaultRelays: [...DEFAULT_RELAYS],
      defaultBlossomServers: [...DEFAULT_BLOSSOM_SERVERS],
    };
  } finally {
    pool.destroy();
  }
}

export async function signNostrEvent(
  event: NostrEventTemplate,
): Promise<VerifiedEvent> {
  if (!window.nostr?.signEvent) {
    throw new Error("This signer does not support event signing.");
  }

  return window.nostr.signEvent(event);
}

export function createExtensionPublishSigner(): PublishSigner {
  if (!window.nostr?.getPublicKey || !window.nostr.signEvent) {
    throw new Error("Install a NIP-07 extension to publish this site.");
  }

  return {
    kind: "nip07",
    getPublicKey() {
      return window.nostr!.getPublicKey();
    },
    signEvent(event) {
      return window.nostr!.signEvent(event);
    },
    async disconnect() {},
  };
}

function createRemoteSignerSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createRemotePublishSignerSession(
  relayUrl: string,
): RemotePublishSignerSession {
  const clientSecretKey = generateSecretKey();
  const connectionUri = createNostrConnectURI({
    clientPubkey: getPublicKey(clientSecretKey),
    relays: [relayUrl],
    secret: createRemoteSignerSecret(),
    perms: [...REMOTE_SIGNER_PERMS],
    name: REMOTE_SIGNER_NAME,
    url: new URL("#/publish", window.location.origin).toString(),
  });

  return {
    connectionUri,
    async connect(abortSignal) {
      const signer = await BunkerSigner.fromURI(
        clientSecretKey,
        connectionUri,
        {},
        abortSignal,
      );

      return {
        kind: "remote",
        getPublicKey() {
          return signer.getPublicKey();
        },
        signEvent(event) {
          return signer.signEvent(event);
        },
        disconnect() {
          return signer.close();
        },
      };
    },
  };
}

export type PublishRelayResult = {
  targetRelays: string[];
  successfulRelays: string[];
  failedRelays: Array<{ relay: string; error: string }>;
};

export async function publishEventToRelays(
  event: NostrEvent,
  relays: string[],
): Promise<PublishRelayResult> {
  const targetRelays = dedupe(relays.map((relay) => normalizeRelayUrl(relay)));

  if (targetRelays.length === 0) {
    throw new Error("Add at least one relay before publishing.");
  }

  const pool = new SimplePool();

  try {
    const relayResults = await Promise.allSettled(
      pool.publish(targetRelays, event),
    );
    const successfulRelays: string[] = [];
    const failedRelays: Array<{ relay: string; error: string }> = [];

    relayResults.forEach((result, index) => {
      const relay = targetRelays[index];

      if (!relay) {
        return;
      }

      if (result.status === "fulfilled") {
        successfulRelays.push(relay);
        return;
      }

      failedRelays.push({
        relay,
        error:
          result.reason instanceof Error
            ? result.reason.message
            : "Relay publish failed.",
      });
    });

    return {
      targetRelays,
      successfulRelays,
      failedRelays,
    };
  } finally {
    pool.destroy();
  }
}
