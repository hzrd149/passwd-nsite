import { basename, join, relative, resolve } from "@std/path";

import { getContentTypeForPath } from "../../src/lib/mediaTypes.ts";
import {
  normalizeRelativePath,
  parseAssetsManifest,
  preparePublishBundle,
  sha256Hex,
  sha256HexBytes,
  type PreparedPublishBundle,
  type PublishBlob,
  type PublishProgress,
} from "../../src/lib/publish.ts";
import type { SevenZipInputFile } from "./7zip.ts";

type BuildAssetFile = {
  blob: PublishBlob;
  filePath: string;
};

async function collectFilePaths(rootDir: string): Promise<string[]> {
  const filePaths: string[] = [];

  async function walk(currentDir: string): Promise<void> {
    for await (const entry of Deno.readDir(currentDir)) {
      const entryPath = join(currentDir, entry.name);

      if (entry.isDirectory) {
        await walk(entryPath);
        continue;
      }

      if (entry.isFile) {
        filePaths.push(entryPath);
      }
    }
  }

  await walk(rootDir);
  filePaths.sort((left, right) => left.localeCompare(right));
  return filePaths;
}

export async function buildArchiveInputsFromDirectory(
  siteDir: string,
): Promise<SevenZipInputFile[]> {
  const resolvedSiteDir = resolve(siteDir);
  const filePaths = await collectFilePaths(resolvedSiteDir);

  if (filePaths.length === 0) {
    throw new Error("The site directory does not contain any files.");
  }

  return Promise.all(
    filePaths.map(async (filePath) => {
      const relativePath = normalizeRelativePath(
        relative(resolvedSiteDir, filePath),
      );

      if (!relativePath) {
        throw new Error(
          `Could not determine the publish path for ${filePath}.`,
        );
      }

      return {
        path: relativePath,
        data: await Deno.readFile(filePath),
      } satisfies SevenZipInputFile;
    }),
  );
}

async function readBuildAssetFiles(
  distDir: string,
  onProgress?: (progress: PublishProgress) => void,
): Promise<BuildAssetFile[]> {
  const resolvedDistDir = resolve(distDir);
  const assetsManifestPath = join(resolvedDistDir, "assets.json");

  onProgress?.({ message: `Reading ${assetsManifestPath}...` });

  const manifestText = await Deno.readTextFile(assetsManifestPath);
  const manifestHash = await sha256Hex(manifestText);
  const assets = parseAssetsManifest(manifestText);
  const buildFiles: BuildAssetFile[] = [
    {
      filePath: assetsManifestPath,
      blob: {
        path: "/assets.json",
        sha256: manifestHash,
        file: new File([manifestText], "assets.json", {
          type: "application/json",
        }),
      },
    },
  ];

  for (const asset of assets) {
    const relativeAssetPath = asset.path.replace(/^\//, "");
    const filePath = join(resolvedDistDir, relativeAssetPath);

    onProgress?.({ message: `Verifying ${asset.path}...` });

    const bytes = await Deno.readFile(filePath);
    const actualHash = await sha256HexBytes(bytes);

    if (actualHash !== asset.sha256) {
      throw new Error(
        `The build asset at ${asset.path} did not match ${basename(assetsManifestPath)}.`,
      );
    }

    buildFiles.push({
      filePath,
      blob: {
        path: asset.path,
        sha256: actualHash,
        file: new File([bytes], basename(filePath), {
          type: getContentTypeForPath(asset.path) || "application/octet-stream",
        }),
      },
    });
  }

  return buildFiles;
}

export async function createPublishBundleFromDisk(
  distDir: string,
  encryptedArchive: Uint8Array,
  onProgress?: (progress: PublishProgress) => void,
): Promise<PreparedPublishBundle> {
  const buildFiles = await readBuildAssetFiles(distDir, onProgress);

  onProgress?.({ message: "Hashing /site.7z..." });

  const archiveHash = await sha256HexBytes(encryptedArchive);
  const blobs: PublishBlob[] = buildFiles.map((entry) => entry.blob);
  blobs.push({
    path: "/site.7z",
    sha256: archiveHash,
    file: new File([encryptedArchive.slice().buffer], "site.7z", {
      type: "application/x-7z-compressed",
    }),
  });

  return preparePublishBundle(blobs);
}

export async function writeArchiveOutput(
  archiveBytes: Uint8Array,
  outputPath: string,
): Promise<string> {
  const resolvedOutputPath = resolve(outputPath);
  await Deno.writeFile(resolvedOutputPath, archiveBytes);
  return resolvedOutputPath;
}
