export const LOOKUP_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://purplepag.es",
  "wss://relay.ditto.pub",
] as const;

/** Default relays to use for publishing */
export const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.ditto.pub",
  "wss://nsite.run",
] as const;

/** Default blossom servers to use for publishing */
export const DEFAULT_BLOSSOM_SERVERS = [
  "https://nsite.run",
  "https://blossom.primal.net",
  "https://nostr.download",
] as const;
