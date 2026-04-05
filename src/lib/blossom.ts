import type { EventTemplate, VerifiedEvent } from "nostr-tools";

import type {
  PublishBlob,
  PublishProgress,
  UploadPublishBundleResult,
} from "./publish";

type SignEvent = (draft: EventTemplate) => Promise<VerifiedEvent>;

type UploadAttemptResult = {
  server: string;
  path: string;
  sha256: string;
  success: boolean;
  skipped: boolean;
  error?: string;
};

const UPLOAD_AUTH_BATCH_SIZE = 20;
const BLOSSOM_AUTH_KIND = 24242;
const UPLOAD_AUTH_TTL_SECONDS = 3600;

function getUploadMessage(path: string): string {
  return `Upload ${path}`;
}

function base64EncodeJson(value: unknown): string {
  const json = JSON.stringify(value);
  const bytes = new TextEncoder().encode(json);
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

function normalizeServerUrl(server: string): string {
  return server.endsWith("/") ? server : `${server}/`;
}

function describeUploadCounts(results: UploadAttemptResult[]): string {
  const skipped = results.filter((result) => result.skipped).length;
  const uploaded = results.filter(
    (result) => result.success && !result.skipped,
  ).length;
  const failed = results.length - skipped - uploaded;

  return `${uploaded} uploaded, ${skipped} already present, ${failed} failed`;
}

async function createBatchUploadAuth(
  signer: SignEvent,
  blobSha256s: string[],
): Promise<string> {
  const currentTime = Math.floor(Date.now() / 1000);
  const authEvent = await signer({
    kind: BLOSSOM_AUTH_KIND,
    created_at: currentTime,
    tags: [
      ["t", "upload"],
      ...blobSha256s.map((hash) => ["x", hash]),
      ["expiration", String(currentTime + UPLOAD_AUTH_TTL_SECONDS)],
      ["client", "passwd-nsite"],
    ],
    content: "Upload blobs via passwd-nsite",
  });

  return `Nostr ${base64EncodeJson(authEvent)}`;
}

async function buildUploadAuthMap(
  blobs: PublishBlob[],
  signer: SignEvent,
  onProgress?: (progress: PublishProgress) => void,
): Promise<Map<string, string>> {
  const hashes = [...new Set(blobs.map((blob) => blob.sha256))];
  const authMap = new Map<string, string>();
  const batchCount = Math.ceil(hashes.length / UPLOAD_AUTH_BATCH_SIZE);

  for (let index = 0; index < hashes.length; index += UPLOAD_AUTH_BATCH_SIZE) {
    const batch = hashes.slice(index, index + UPLOAD_AUTH_BATCH_SIZE);
    const batchNumber = Math.floor(index / UPLOAD_AUTH_BATCH_SIZE) + 1;
    onProgress?.({
      message: `Signing upload auth ${batchNumber}/${batchCount}...`,
    });

    const authHeader = await createBatchUploadAuth(signer, batch);
    for (const hash of batch) {
      authMap.set(hash, authHeader);
    }
  }

  return authMap;
}

async function headBlob(
  server: string,
  sha256: string,
): Promise<{ exists: boolean; error?: string }> {
  try {
    const response = await fetch(`${normalizeServerUrl(server)}${sha256}`, {
      method: "HEAD",
    });

    if (response.ok) {
      return { exists: true };
    }

    if (response.status === 404) {
      return { exists: false };
    }

    return {
      exists: false,
      error: `HEAD ${response.status}`,
    };
  } catch (error) {
    return {
      exists: false,
      error: error instanceof Error ? error.message : "HEAD request failed.",
    };
  }
}

async function uploadBlobToServer(
  server: string,
  blob: PublishBlob,
  authHeader: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await fetch(`${normalizeServerUrl(server)}upload`, {
      method: "PUT",
      headers: {
        Authorization: authHeader,
      },
      body: blob.file,
    });

    if (response.ok) {
      return { success: true };
    }

    const errorText = await response.text().catch(() => "");
    return {
      success: false,
      error: `PUT ${response.status}${errorText ? `: ${errorText}` : ""}`,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Upload failed.",
    };
  }
}

async function uploadBlobPair(
  server: string,
  blob: PublishBlob,
  authHeader: string,
): Promise<UploadAttemptResult> {
  const headResult = await headBlob(server, blob.sha256);
  if (headResult.exists) {
    return {
      server,
      path: blob.path,
      sha256: blob.sha256,
      success: true,
      skipped: true,
    };
  }

  const uploadResult = await uploadBlobToServer(server, blob, authHeader);
  return {
    server,
    path: blob.path,
    sha256: blob.sha256,
    success: uploadResult.success,
    skipped: false,
    error: uploadResult.success
      ? undefined
      : headResult.error
        ? `${headResult.error}; ${uploadResult.error ?? "Upload failed."}`
        : uploadResult.error,
  };
}

export async function uploadPublishBundle(
  blobs: PublishBlob[],
  servers: string[],
  signer: SignEvent,
  onProgress?: (progress: PublishProgress) => void,
): Promise<UploadPublishBundleResult> {
  if (servers.length === 0) {
    throw new Error("Add at least one blossom server before publishing.");
  }

  onProgress?.({ message: "Signing blossom upload auth..." });
  const authMap = await buildUploadAuthMap(blobs, signer, onProgress);

  onProgress?.({ message: "Checking existing blobs on blossom servers..." });

  const uploadTasks = blobs.flatMap((blob) =>
    servers.map(async (server) => {
      const authHeader = authMap.get(blob.sha256);
      if (!authHeader) {
        return {
          server,
          path: blob.path,
          sha256: blob.sha256,
          success: false,
          skipped: false,
          error: `Missing upload auth for ${getUploadMessage(blob.path)}.`,
        } satisfies UploadAttemptResult;
      }

      return uploadBlobPair(server, blob, authHeader);
    }),
  );

  const uploadResults = await Promise.all(uploadTasks);
  onProgress?.({
    message: `Processed blossom uploads: ${describeUploadCounts(uploadResults)}.`,
  });

  const successfulServers = servers.filter((server) =>
    blobs.every((blob) =>
      uploadResults.some(
        (result) =>
          result.server === server &&
          result.sha256 === blob.sha256 &&
          result.success,
      ),
    ),
  );

  if (successfulServers.length === 0) {
    const failedAttempt = uploadResults.find((result) => !result.success);
    if (failedAttempt) {
      throw new Error(
        `No blossom server accepted the full site bundle. ${failedAttempt.server} failed ${failedAttempt.path}: ${failedAttempt.error ?? "Upload failed."}`,
      );
    }

    throw new Error(
      "No single blossom server accepted the full site bundle. Try again with another server list.",
    );
  }

  return {
    successfulServers,
    uploadedBlobs: blobs,
  };
}
