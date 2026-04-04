import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const site = {
  id: "e9c4858c4e24b322841e0ff5916c584071a1584534bf1e9d866fc0d9d2e436b3",
  pubkey: "deab79dafa1c2be4b4a6d3aca1357b6caa0b744bf46ad529a5ae464288579e68",
  created_at: 1774564271,
  kind: 35128,
  tags: [
    ["d", "neongrid"],
    [
      "path",
      "/assets/index-BF63LMph.js",
      "fd3039af450240a811f3c9708de83b2a9d932156f8bb3bdf82bcc5678b87e06b",
    ],
    [
      "path",
      "/assets/index-CqBOSXDX.css",
      "f47b3dd2bc1d198bc3aadb04391e580d742a11a36436cb72ea966178b59e3126",
    ],
    [
      "path",
      "/assets/Orbitron-Bold-CQ39FtMf.ttf",
      "a24fe8031eefd8451d40e31882868d768ce6bed7c3659293281b3c5c7732a952",
    ],
    [
      "path",
      "/assets/Orbitron-Regular-CcmLPTI7.ttf",
      "59c2bc6487139f1b8c5754e0cc98ea431ab4c1c1ee142d9d2433ecabe444b59a",
    ],
    ["path", "/favicon.svg", "61bc9a161de58248288e6905425d7180f0624c2865007b97d763fdac12043a66"],
    ["path", "/hero.png", "72a860570eddf1dd9988f26c7106c67be286bc9f2fd3303c465ce87edb1ae6cd"],
    ["path", "/icons.svg", "b45fa506195cfcdef406ba9f0c77b36ddc1a7c224040926ec70abc2fdea7b93a"],
    [
      "path",
      "/index.html",
      "414e8bf7213c6e11a21a3ada471bed377d7903c8774c8dbabde991d8e816d188",
    ],
    ["server", "https://cdn.hzrd149.com"],
    ["server", "https://nostr.download"],
    ["server", "https://haven.downisontheup.ca"],
    ["relay", "wss://relay.primal.net"],
    ["relay", "wss://nos.lol"],
    ["relay", "wss://relay.damus.io"],
    ["relay", "wss://haven.downisontheup.ca"],
    ["title", "NEON GRID"],
    ["description", "A fast paced twin stick shooter."],
    ["client", "nsyte"],
  ],
  content: "",
  sig: "318f6a1a3cc1a99864dacbb62777453148431c6d1d170b94c960e38107c0a3c85456e3342b1e918c0b7f2ff9ebed98c3d83c389ff5670fb79869182c24929fd9",
};

type PathTag = { relPath: string; hash: string };

function parsePathTags(tags: string[][]): PathTag[] {
  const out: PathTag[] = [];
  for (const t of tags) {
    if (t[0] !== "path" || t.length < 3) continue;
    const relPath = t[1];
    const hash = t[2];
    if (!relPath?.startsWith("/") || !hash) continue;
    out.push({ relPath, hash });
  }
  return out;
}

function parseServerUrls(tags: string[][]): string[] {
  const out: string[] = [];
  for (const t of tags) {
    if (t[0] !== "server" || !t[1]) continue;
    const base = t[1].replace(/\/+$/, "");
    out.push(base);
  }
  return out;
}

async function fetchFromServers(
  servers: string[],
  hash: string,
): Promise<Response | null> {
  for (const base of servers) {
    const url = `${base}/${hash}`;
    try {
      const res = await fetch(url);
      if (res.ok) return res;
    } catch {
      // try next server
    }
  }
  return null;
}

const rootDir = join(process.cwd(), "public", "site");
const paths = parsePathTags(site.tags);
const servers = parseServerUrls(site.tags);

if (servers.length === 0) {
  console.error("No server tags found in site event.");
  process.exit(1);
}

for (const { relPath, hash } of paths) {
  const res = await fetchFromServers(servers, hash);
  if (!res) {
    console.error(`Failed to download ${relPath} (${hash}) from any server`);
    process.exit(1);
  }
  const dest = join(rootDir, relPath.slice(1));
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, new Uint8Array(await res.arrayBuffer()));
  console.log(`Wrote ${dest}`);
}

console.log(`Done: ${paths.length} file(s) under ${rootDir}`);
