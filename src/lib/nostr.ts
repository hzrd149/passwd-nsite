import { SimplePool } from "nostr-tools";
import type {
  Event as NostrEvent,
  EventTemplate as NostrEventTemplate,
  VerifiedEvent,
} from "nostr-tools";
import {
  DEFAULT_BLOSSOM_SERVERS,
  DEFAULT_RELAYS,
  LOOKUP_RELAYS,
} from "../const";

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

async function getLatestReplaceableEvent(
  pool: SimplePool,
  relays: string[],
  pubkey: string,
  kind: number,
): Promise<NostrEvent | null> {
  const events = await pool.querySync(
    relays,
    {
      authors: [pubkey],
      kinds: [kind],
      limit: 1,
    },
    { maxWait: 2000 },
  );

  return pickLatestEvent(events);
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

export async function loadPublishProfile(): Promise<PublishProfile> {
  if (!window.nostr) {
    throw new Error("Install a NIP-07 extension to publish this site.");
  }

  const pubkey = await window.nostr.getPublicKey();
  const lookupRelays = [...LOOKUP_RELAYS];
  const pool = new SimplePool();

  try {
    const [profileEvent, relayListEvent, blossomListEvent] = await Promise.all([
      getLatestReplaceableEvent(pool, lookupRelays, pubkey, 0).catch(
        (error) => {
          logNostrError("Failed to load profile metadata", error);
          return null;
        },
      ),
      getLatestReplaceableEvent(pool, lookupRelays, pubkey, 10002).catch(
        (error) => {
          logNostrError("Failed to load outbox relay list", error);
          return null;
        },
      ),
      getLatestReplaceableEvent(pool, lookupRelays, pubkey, 10063).catch(
        (error) => {
          logNostrError("Failed to load blossom server list", error);
          return null;
        },
      ),
    ]);

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
