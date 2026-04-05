import type { EventTemplate, VerifiedEvent } from "nostr-tools";

import type { SevenZipInputFile } from "./7zip";

export { uploadPublishBundle } from "./blossom";

export type BuildAssetEntry = {
  path: string;
  sha256: string;
};

export type PublishBlob = {
  path: string;
  sha256: string;
  file: File;
};

export type PublishProgress = {
  message: string;
};

export type PublishManifestInput = {
  siteId: string;
  title?: string;
  description?: string;
  servers: string[];
};

export type PreparedPublishBundle = {
  blobs: PublishBlob[];
  pathTags: string[][];
  aggregateHash: string;
};

export type UploadPublishBundleResult = {
  successfulServers: string[];
  uploadedBlobs: PublishBlob[];
};

export type PublishManifestResult = {
  event: VerifiedEvent;
  aggregateHash: string;
  servers: string[];
  pathCount: number;
};

function stripSharedRoot(paths: string[]): string[] {
  if (paths.length === 0) {
    return paths;
  }

  const splitPaths = paths.map((path) =>
    path
      .split("/")
      .map((segment) => segment.trim())
      .filter(Boolean),
  );
  const firstSegment = splitPaths[0]?.[0];

  if (!firstSegment) {
    return paths;
  }

  const shouldStrip = splitPaths.every(
    (segments) => segments.length > 1 && segments[0] === firstSegment,
  );

  if (!shouldStrip) {
    return paths;
  }

  return splitPaths.map((segments) => segments.slice(1).join("/"));
}

function normalizeRelativePath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join("/");
}

function normalizeAbsolutePath(path: string): string {
  const normalizedPath = normalizeRelativePath(path);
  return normalizedPath ? `/${normalizedPath}` : "/";
}

function getFileNameFromPath(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? "blob";
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(data: BufferSource | string): Promise<string> {
  const bytes =
    typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return hex(digest);
}

async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const copy = bytes.slice();
  return sha256Hex(copy.buffer);
}

async function blobToBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

function assertSiteId(siteId: string): string {
  const normalizedSiteId = siteId.trim().toLowerCase();

  if (
    !/^[a-z0-9-]{1,13}$/.test(normalizedSiteId) ||
    /-$/.test(normalizedSiteId)
  ) {
    throw new Error(
      "Use a site id with 1-13 lowercase letters, numbers, or hyphens, and no trailing hyphen.",
    );
  }

  return normalizedSiteId;
}

function parseAssetsManifest(content: string): BuildAssetEntry[] {
  const parsed = JSON.parse(content) as unknown;

  if (!Array.isArray(parsed)) {
    throw new Error("The assets manifest is not a valid array.");
  }

  return parsed.map((entry) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.path !== "string" ||
      typeof entry.sha256 !== "string"
    ) {
      throw new Error("The assets manifest contains an invalid entry.");
    }

    return {
      path: normalizeAbsolutePath(entry.path),
      sha256: entry.sha256.toLowerCase(),
    } satisfies BuildAssetEntry;
  });
}

export function getPublishTargetRelays(
  relays: string[],
  defaultRelays: string[],
): string[] {
  return (relays.length > 0 ? relays : defaultRelays).filter(Boolean);
}

export function getPublishTargetServers(
  servers: string[],
  defaultServers: string[],
): string[] {
  return (servers.length > 0 ? servers : defaultServers).filter(Boolean);
}

export async function buildArchiveInputs(
  files: File[],
): Promise<SevenZipInputFile[]> {
  if (files.length === 0) {
    throw new Error("Select a folder before publishing.");
  }

  const rawPaths = files.map((file) => {
    const relativePath = file.webkitRelativePath || file.name;
    return normalizeRelativePath(relativePath);
  });
  const strippedPaths = stripSharedRoot(rawPaths);

  const archiveInputs = await Promise.all(
    files.map(async (file, index) => {
      const path = strippedPaths[index];

      if (!path) {
        throw new Error("One of the selected files has an empty path.");
      }

      return {
        path,
        data: await file.arrayBuffer(),
      } satisfies SevenZipInputFile;
    }),
  );

  return archiveInputs;
}

export async function fetchBuildAssets(
  onProgress?: (progress: PublishProgress) => void,
): Promise<{ assets: BuildAssetEntry[]; assetsJsonFile: File }> {
  onProgress?.({ message: "Fetching /assets.json..." });

  const manifestResponse = await fetch("/assets.json", { cache: "no-store" });
  if (!manifestResponse.ok) {
    throw new Error(
      manifestResponse.status === 404
        ? "Publishing from this site is currently broken because the site asset list (/assets.json) could not be found."
        : `Failed to fetch /assets.json (${manifestResponse.status}).`,
    );
  }

  const manifestText = await manifestResponse.text();
  const manifestHash = await sha256Hex(manifestText);
  const assets = parseAssetsManifest(manifestText);
  const assetsJsonFile = new File([manifestText], "assets.json", {
    type: manifestResponse.headers.get("content-type") ?? "application/json",
  });

  return {
    assets: [...assets, { path: "/assets.json", sha256: manifestHash }],
    assetsJsonFile,
  };
}

export async function createPublishBundle(
  encryptedArchive: Blob,
  onProgress?: (progress: PublishProgress) => void,
): Promise<PreparedPublishBundle> {
  const { assets, assetsJsonFile } = await fetchBuildAssets(onProgress);
  const blobs: PublishBlob[] = [];

  for (const asset of assets) {
    if (asset.path === "/assets.json") {
      blobs.push({
        path: asset.path,
        sha256: asset.sha256,
        file: assetsJsonFile,
      });
      continue;
    }

    onProgress?.({ message: `Verifying ${asset.path}...` });

    const response = await fetch(asset.path, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Failed to fetch ${asset.path} (${response.status}).`);
    }

    const blob = await response.blob();
    const bytes = await blobToBytes(blob);
    const actualHash = await sha256HexBytes(bytes);

    if (actualHash !== asset.sha256) {
      throw new Error(
        `The build asset at ${asset.path} did not match /assets.json.`,
      );
    }

    blobs.push({
      path: asset.path,
      sha256: actualHash,
      file: new File([blob], getFileNameFromPath(asset.path), {
        type: blob.type || "application/octet-stream",
      }),
    });
  }

  onProgress?.({ message: "Hashing /site.7z..." });

  const archiveBytes = await blobToBytes(encryptedArchive);
  const archiveHash = await sha256HexBytes(archiveBytes);
  blobs.push({
    path: "/site.7z",
    sha256: archiveHash,
    file: new File([encryptedArchive], "site.7z", {
      type: "application/x-7z-compressed",
    }),
  });

  const pathTags = blobs
    .map((blob) => ["path", blob.path, blob.sha256])
    .sort((left, right) => left[1]!.localeCompare(right[1]!));

  const aggregateHash = await sha256Hex(
    pathTags
      .map(([, path, hash]) => `${hash} ${path}\n`)
      .sort()
      .join(""),
  );

  return {
    blobs,
    pathTags,
    aggregateHash,
  };
}

export async function buildSignedSiteManifest(
  bundle: PreparedPublishBundle,
  input: PublishManifestInput,
  signer: (draft: EventTemplate) => Promise<VerifiedEvent>,
): Promise<PublishManifestResult> {
  const siteId = assertSiteId(input.siteId);
  const tags = [
    ["d", siteId],
    ...bundle.pathTags,
    ["x", bundle.aggregateHash, "aggregate"],
    ...input.servers.map((server) => ["server", server]),
  ];

  if (input.title?.trim()) {
    tags.push(["title", input.title.trim()]);
  }

  if (input.description?.trim()) {
    tags.push(["description", input.description.trim()]);
  }

  const event = await signer({
    kind: 35128,
    created_at: Math.floor(Date.now() / 1000),
    content: "",
    tags,
  });

  return {
    event,
    aggregateHash: bundle.aggregateHash,
    servers: [...input.servers],
    pathCount: bundle.pathTags.length,
  };
}
