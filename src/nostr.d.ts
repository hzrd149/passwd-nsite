export {};

declare global {
  interface Window {
    nostr?: {
      getPublicKey(): Promise<string>;
    };
  }
}
