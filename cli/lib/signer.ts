import { nip19 } from "nostr-tools";
import type { EventTemplate, VerifiedEvent } from "nostr-tools";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";

export type LocalPublishSigner = {
  getPublicKey(): Promise<string>;
  signEvent(event: EventTemplate): Promise<VerifiedEvent>;
};

function hexToBytes(value: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/i.test(value)) {
    throw new Error("Expected a 32-byte hex private key.");
  }

  const bytes = new Uint8Array(32);
  for (let index = 0; index < 32; index += 1) {
    const start = index * 2;
    bytes[index] = Number.parseInt(value.slice(start, start + 2), 16);
  }

  return bytes;
}

export function parseSecretKey(secret: string): Uint8Array {
  const normalizedSecret = secret.trim();

  if (!normalizedSecret) {
    throw new Error("Provide an nsec or 32-byte hex private key.");
  }

  if (/^[0-9a-f]{64}$/i.test(normalizedSecret)) {
    return hexToBytes(normalizedSecret);
  }

  const decoded = nip19.decode(normalizedSecret);
  if (decoded.type !== "nsec" || !(decoded.data instanceof Uint8Array)) {
    throw new Error("Expected an nsec or 32-byte hex private key.");
  }

  return decoded.data;
}

export function createLocalPublishSigner(secret: string): LocalPublishSigner {
  const secretKey = parseSecretKey(secret);
  const pubkey = getPublicKey(secretKey);

  return {
    async getPublicKey() {
      return pubkey;
    },
    async signEvent(event) {
      return finalizeEvent(event, secretKey);
    },
  };
}
