import SevenZip from "7z-wasm";
import sevenZipWasmUrl from "7z-wasm/7zz.wasm?url";

export type SevenZipArchiveEntry = {
  path: string;
  isDirectory: boolean;
};

export type SevenZipInputFile = {
  path: string;
  data: ArrayBuffer | Uint8Array;
};

export type SevenZipExtractedFile = SevenZipArchiveEntry & {
  data?: Uint8Array;
};

type SevenZipRunResult = {
  args: string[];
  stdout: string;
  stderr: string;
  combinedOutput: string;
  thrownError?: unknown;
};

const wasmBinaryPromise = fetch(sevenZipWasmUrl).then(async (response) => {
  if (!response.ok) {
    throw new Error("Failed to load the 7-Zip runtime.");
  }

  return response.arrayBuffer();
});

function normalizeArchiveName(fileName: string): string {
  return fileName || "archive.7z";
}

function normalizeFileData(data: ArrayBuffer | Uint8Array): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

function sanitizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "");
}

function getArchiveTargets(files: SevenZipInputFile[]): string[] {
  return [
    ...new Set(
      files
        .map((file) => sanitizePath(file.path).split("/")[0])
        .filter(Boolean),
    ),
  ];
}

function createDirectoryTree(
  fs: Awaited<ReturnType<typeof SevenZip>>["FS"],
  path: string,
) {
  const segments = sanitizePath(path).split("/").filter(Boolean);

  let currentPath = "";
  for (const segment of segments) {
    currentPath += `/${segment}`;

    try {
      const existingNode = fs.lookupPath(currentPath, { follow: true }).node;
      if (!fs.isDir(existingNode.mode)) {
        throw new Error(`${currentPath} exists but is not a directory.`);
      }
    } catch (error) {
      if (
        error instanceof Error &&
        /exists but is not a directory\.$/.test(error.message)
      ) {
        throw error;
      }

      fs.mkdir(currentPath);
    }
  }
}

function parseArchiveEntries(
  output: string,
  archiveName: string,
): SevenZipArchiveEntry[] {
  return output
    .split(/\r?\n\r?\n+/)
    .map((block) => {
      const pathMatch = block.match(/^Path = (.+)$/m);

      if (!pathMatch) {
        return null;
      }

      const path = pathMatch[1].trim();
      if (!path || path === archiveName) {
        return null;
      }

      return {
        path,
        isDirectory: /^Folder = \+$/m.test(block),
      };
    })
    .filter((entry): entry is SevenZipArchiveEntry => entry !== null);
}

function formatThrownError(thrownError: unknown): string | null {
  if (!thrownError) {
    return null;
  }

  if (thrownError instanceof Error) {
    return thrownError.message;
  }

  return String(thrownError);
}

function getSevenZipError(result: SevenZipRunResult, context?: string): Error {
  const details = result.combinedOutput.trim();
  const thrownMessage = formatThrownError(result.thrownError);

  if (/Wrong password\?/i.test(details)) {
    return new Error("Wrong password for this archive.");
  }

  if (/Enter password:/i.test(details)) {
    return new Error("This archive is encrypted. Enter its password first.");
  }

  const summary =
    details.match(/ERROR:[^\n]*/)?.[0] ??
    thrownMessage ??
    context ??
    "7-Zip could not process that archive.";

  const sections = [summary, `Command: 7z ${result.args.join(" ")}`];

  if (details) {
    sections.push(`Output:\n${details}`);
  }

  if (thrownMessage && !details.includes(thrownMessage)) {
    sections.push(`Exception: ${thrownMessage}`);
  }

  return new Error(sections.join("\n\n"));
}

function walkExtractedFiles(
  fs: Awaited<ReturnType<typeof SevenZip>>["FS"],
  rootPath: string,
  currentPath = rootPath,
): SevenZipExtractedFile[] {
  const names = fs
    .readdir(currentPath)
    .filter((name) => name !== "." && name !== "..");

  return names.flatMap((name) => {
    const fullPath = `${currentPath}/${name}`;
    const relativePath = fullPath.slice(rootPath.length + 1);
    const stats = fs.stat(fullPath);

    if (fs.isDir(stats.mode)) {
      return [
        { path: relativePath, isDirectory: true },
        ...walkExtractedFiles(fs, rootPath, fullPath),
      ];
    }

    return [
      {
        path: relativePath,
        isDirectory: false,
        data: fs.readFile(fullPath),
      },
    ];
  });
}

async function withSevenZip<T>(
  work: (
    sevenZip: Awaited<ReturnType<typeof SevenZip>>,
    output: { stdout: string[]; stderr: string[] },
  ) => T | Promise<T>,
): Promise<T> {
  const output = {
    stdout: [] as string[],
    stderr: [] as string[],
  };

  const sevenZip = await SevenZip({
    wasmBinary: await wasmBinaryPromise,
    print: (line) => output.stdout.push(line),
    printErr: (line) => output.stderr.push(line),
  });

  return work(sevenZip, output);
}

function runSevenZip(
  sevenZip: Awaited<ReturnType<typeof SevenZip>>,
  output: { stdout: string[]; stderr: string[] },
  args: string[],
): SevenZipRunResult {
  output.stdout.length = 0;
  output.stderr.length = 0;

  let thrownError: unknown;

  try {
    sevenZip.callMain(args);
  } catch (error) {
    thrownError = error;
  }

  const stdoutText = output.stdout.join("\n");
  const stderrText = output.stderr.join("\n");

  return {
    args,
    stdout: stdoutText,
    stderr: stderrText,
    combinedOutput: `${stdoutText}\n${stderrText}`,
    thrownError,
  };
}

export async function listArchiveEntries(
  archive: File | SevenZipInputFile,
  password = "",
): Promise<SevenZipArchiveEntry[]> {
  const archiveName = normalizeArchiveName(
    archive instanceof File ? archive.name : archive.path,
  );
  const archiveData = normalizeFileData(
    archive instanceof File ? await archive.arrayBuffer() : archive.data,
  );

  return withSevenZip((sevenZip, output) => {
    sevenZip.FS.writeFile(archiveName, archiveData);

    const args = ["l", "-slt", archiveName];
    if (password) {
      args.push(`-p${password}`);
    }

    const result = runSevenZip(sevenZip, output, args);
    const entries = parseArchiveEntries(result.stdout, archiveName);

    if (entries.length > 0) {
      return entries;
    }

    throw getSevenZipError(result, "7-Zip could not read that archive.");
  });
}

export async function extractArchive(
  archive: File | SevenZipInputFile,
  password = "",
): Promise<SevenZipExtractedFile[]> {
  const archiveName = normalizeArchiveName(
    archive instanceof File ? archive.name : archive.path,
  );
  const archiveData = normalizeFileData(
    archive instanceof File ? await archive.arrayBuffer() : archive.data,
  );

  return withSevenZip((sevenZip, output) => {
    const outputDir = "/extracted";

    sevenZip.FS.mkdir(outputDir);
    sevenZip.FS.writeFile(archiveName, archiveData);

    const args = ["x", archiveName, `-o${outputDir}`, "-y"];
    if (password) {
      args.push(`-p${password}`);
    }

    const result = runSevenZip(sevenZip, output, args);
    const extractedFiles = walkExtractedFiles(sevenZip.FS, outputDir);

    if (extractedFiles.length > 0) {
      return extractedFiles;
    }

    throw getSevenZipError(result, "7-Zip could not extract that archive.");
  });
}

export async function createArchive(
  files: SevenZipInputFile[],
  options: { password?: string; archiveName?: string } = {},
): Promise<Uint8Array> {
  if (files.length === 0) {
    throw new Error("Provide at least one file to archive.");
  }

  const archiveName = normalizeArchiveName(options.archiveName ?? "archive.7z");
  const archiveTargets = getArchiveTargets(files);

  return withSevenZip((sevenZip, output) => {
    const inputRoot = "/input";
    const internalArchivePath = "/__result__.7z";

    sevenZip.FS.mkdir(inputRoot);

    for (const file of files) {
      const normalizedPath = sanitizePath(file.path);

      if (!normalizedPath) {
        throw new Error("Archive file paths cannot be empty.");
      }

      const lastSlash = normalizedPath.lastIndexOf("/");
      if (lastSlash >= 0) {
        createDirectoryTree(
          sevenZip.FS,
          `${inputRoot}/${normalizedPath.slice(0, lastSlash)}`,
        );
      }

      sevenZip.FS.writeFile(
        `${inputRoot}/${normalizedPath}`,
        normalizeFileData(file.data),
      );
    }

    sevenZip.FS.chdir(inputRoot);

    const args = ["a", internalArchivePath, ...archiveTargets];

    if (options.password) {
      args.push(`-p${options.password}`, "-mhe=on");
    }

    const result = runSevenZip(sevenZip, output, args);

    try {
      return sevenZip.FS.readFile(internalArchivePath);
    } catch (error) {
      const readFileMessage =
        formatThrownError(error) ?? "Unknown read failure";

      throw getSevenZipError(
        {
          ...result,
          thrownError: result.thrownError ?? error,
          combinedOutput: `${result.combinedOutput}\nreadFile(${internalArchivePath}) failed: ${readFileMessage}`,
        },
        `7-Zip did not produce the expected archive for ${archiveName}.`,
      );
    }
  });
}

export async function createEncryptedArchive(
  files: SevenZipInputFile[],
  password: string,
  archiveName?: string,
): Promise<Uint8Array> {
  if (!password) {
    throw new Error("A password is required to create an encrypted archive.");
  }

  return createArchive(files, { password, archiveName });
}
