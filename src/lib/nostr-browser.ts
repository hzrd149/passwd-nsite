import type {
  EventTemplate as NostrEventTemplate,
  VerifiedEvent,
} from "nostr-tools";
import { BunkerSigner, createNostrConnectURI } from "nostr-tools/nip46";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";

import {
  createPublishSigner,
  type BrowserNostrApi,
  type PublishSigner,
  type RemotePublishSignerSession,
} from "./nostr";

const BLOSSOM_AUTH_KIND = 24242;
const NSITE_MANIFEST_KIND = 35128;
const REMOTE_SIGNER_NAME = "passwd-nsite";
export const DEFAULT_REMOTE_SIGNER_RELAY = "bucket.coracle.social";
const REMOTE_SIGNER_PERMS = [
  "get_public_key",
  `sign_event:${BLOSSOM_AUTH_KIND}`,
  `sign_event:${NSITE_MANIFEST_KIND}`,
] as const;

type BrowserWindowWithNostr = Window & {
  nostr?: BrowserNostrApi;
};

function getBrowserNostrApi(): BrowserNostrApi {
  const nostr = (window as BrowserWindowWithNostr).nostr;

  if (!nostr?.getPublicKey || !nostr.signEvent) {
    throw new Error("Install a NIP-07 extension to publish this site.");
  }

  return nostr;
}

function createRemoteSignerSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function signWithExtension(
  event: NostrEventTemplate,
): Promise<VerifiedEvent> {
  return getBrowserNostrApi().signEvent(event);
}

export function createExtensionPublishSigner(): PublishSigner {
  return createPublishSigner("nip07", getBrowserNostrApi());
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
