#!/usr/bin/env -S deno run -A

import { uploadPublishBundle } from "./src/lib/blossom.ts";
import { buildSignedSiteManifest } from "./src/lib/publish.ts";
import { publishEventToRelays } from "./src/lib/nostr.ts";
import {
  buildArchiveInputsFromDirectory,
  createPublishBundleFromDisk,
  writeArchiveOutput,
} from "./cli/lib/publish.ts";
import { createEncryptedArchive } from "./cli/lib/7zip.ts";
import { createLocalPublishSigner } from "./cli/lib/signer.ts";

type CliOptions = {
  distDir: string;
  siteId: string;
  password?: string;
  passwordStdin: boolean;
  title?: string;
  description?: string;
  relays: string[];
  servers: string[];
  nsec: string;
  outputPath?: string;
  dryRun: boolean;
};

type ParsedArgs = {
  command: string | null;
  siteDir: string | null;
  options: CliOptions;
};

export function printUsage(): void {
  console.log(`passwd-nsite Deno CLI

Usage:
  deno run -A cli.ts publish <siteDir> [options]

Examples:
  deno run -A mod.ts publish ./my-site --site-id mysite --password YOUR_PASSWORD --nsec YOUR_NSEC --relay wss://relay.example.com --server https://blossom.example.com
  deno task publish ./my-site --site-id mysite --password YOUR_PASSWORD --nsec YOUR_NSEC --relay wss://relay.example.com --server https://blossom.example.com
  deno run -A jsr:@your-scope/passwd-nsite publish ./my-site --site-id mysite --password YOUR_PASSWORD --nsec YOUR_NSEC --relay wss://relay.example.com --server https://blossom.example.com
  printf '%s' YOUR_PASSWORD | deno run -A mod.ts publish ./my-site --site-id mysite --password-stdin --nsec YOUR_NSEC --relay wss://relay.example.com --server https://blossom.example.com

Options:
  --dist <dir>            Build output directory (default: dist)
  --site-id <id>          Named-site id, required
  --password <value>      Site archive password
  --password-stdin        Read the site archive password from stdin
  --title <text>          Optional site title
  --description <text>    Optional site description
  --relay <url>           Target relay, repeatable, required
  --server <url>          Target blossom server, repeatable, required
  --nsec <value>          Nostr private key as nsec or 32-byte hex, required
  --out <path>            Write the generated site.7z to disk
  --dry-run               Build and sign without uploading or publishing
  --help                  Show this help
`);
}

function requireOptionValue(
  args: string[],
  index: number,
  flag: string,
): string {
  const value = args[index + 1];
  if (!value) {
    throw new Error(`Missing value for ${flag}.`);
  }

  return value;
}

function parseArgs(args: string[]): ParsedArgs {
  const options: CliOptions = {
    distDir: "dist",
    siteId: "",
    passwordStdin: false,
    relays: [],
    servers: [],
    nsec: "",
    dryRun: false,
  };
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    switch (arg) {
      case "--help":
        printUsage();
        Deno.exit(0);
        break;
      case "--dist":
        options.distDir = requireOptionValue(args, index, arg);
        index += 1;
        break;
      case "--site-id":
        options.siteId = requireOptionValue(args, index, arg);
        index += 1;
        break;
      case "--password":
        options.password = requireOptionValue(args, index, arg);
        index += 1;
        break;
      case "--password-stdin":
        options.passwordStdin = true;
        break;
      case "--title":
        options.title = requireOptionValue(args, index, arg);
        index += 1;
        break;
      case "--description":
        options.description = requireOptionValue(args, index, arg);
        index += 1;
        break;
      case "--relay":
        options.relays.push(requireOptionValue(args, index, arg));
        index += 1;
        break;
      case "--server":
        options.servers.push(requireOptionValue(args, index, arg));
        index += 1;
        break;
      case "--nsec":
        options.nsec = requireOptionValue(args, index, arg);
        index += 1;
        break;
      case "--out":
        options.outputPath = requireOptionValue(args, index, arg);
        index += 1;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      default:
        if (arg.startsWith("--")) {
          throw new Error(`Unknown option: ${arg}`);
        }

        positionals.push(arg);
        break;
    }
  }

  return {
    command: positionals[0] ?? null,
    siteDir: positionals[1] ?? null,
    options,
  };
}

async function readPassword(options: CliOptions): Promise<string> {
  if (options.passwordStdin) {
    const stdinText = await new Response(Deno.stdin.readable).text();
    return stdinText.trim();
  }

  return options.password?.trim() ?? "";
}

function logProgress(message: string): void {
  console.error(message);
}

async function handlePublish(
  siteDir: string,
  options: CliOptions,
): Promise<void> {
  const password = await readPassword(options);
  const siteId = options.siteId.trim();
  const title = options.title?.trim() ?? "";
  const description = options.description?.trim() ?? "";
  const secret = options.nsec.trim();

  if (!siteId) {
    throw new Error("Provide --site-id.");
  }

  if (!password) {
    throw new Error("Provide --password or --password-stdin.");
  }

  if (!secret) {
    throw new Error("Provide --nsec.");
  }

  if (options.relays.length === 0) {
    throw new Error("Provide at least one --relay.");
  }

  if (options.servers.length === 0) {
    throw new Error("Provide at least one --server.");
  }

  const signer = createLocalPublishSigner(secret);
  const targetRelays = [...options.relays];
  const targetServers = [...options.servers];

  logProgress("Reading site directory...");
  const archiveInputs = await buildArchiveInputsFromDirectory(siteDir);

  logProgress("Building encrypted site.7z...");
  const archiveBytes = await createEncryptedArchive(
    archiveInputs,
    password,
    "site.7z",
  );

  if (options.outputPath) {
    const writtenPath = await writeArchiveOutput(
      archiveBytes,
      options.outputPath,
    );
    logProgress(`Wrote archive to ${writtenPath}`);
  }

  const bundle = await createPublishBundleFromDisk(
    options.distDir,
    archiveBytes,
    ({ message }) => logProgress(message),
  );

  if (options.dryRun) {
    logProgress("Signing manifest (dry run)...");
    const manifestResult = await buildSignedSiteManifest(
      bundle,
      {
        siteId,
        title,
        description,
        servers: targetServers,
      },
      (draft) => signer.signEvent(draft),
    );

    console.log(
      JSON.stringify(
        {
          dryRun: true,
          pubkey: await signer.getPublicKey(),
          eventId: manifestResult.event.id,
          aggregateHash: manifestResult.aggregateHash,
          siteId,
          pathCount: manifestResult.pathCount,
          relays: targetRelays,
          servers: targetServers,
        },
        null,
        2,
      ),
    );
    return;
  }

  logProgress("Uploading site blobs to blossom...");
  const uploadResult = await uploadPublishBundle(
    bundle.blobs,
    targetServers,
    (draft) => signer.signEvent(draft),
    ({ message }) => logProgress(message),
  );

  logProgress("Signing named-site manifest...");
  const manifestResult = await buildSignedSiteManifest(
    bundle,
    {
      siteId,
      title,
      description,
      servers: uploadResult.successfulServers,
    },
    (draft) => signer.signEvent(draft),
  );

  logProgress("Publishing manifest to relays...");
  const relayResult = await publishEventToRelays(
    manifestResult.event,
    targetRelays,
  );

  if (relayResult.successfulRelays.length === 0) {
    throw new Error(
      relayResult.failedRelays[0]?.error ??
        "Failed to publish the site manifest to any relay.",
    );
  }

  console.log(
    JSON.stringify(
      {
        dryRun: false,
        pubkey: await signer.getPublicKey(),
        eventId: manifestResult.event.id,
        aggregateHash: manifestResult.aggregateHash,
        siteId,
        pathCount: manifestResult.pathCount,
        servers: uploadResult.successfulServers,
        relays: relayResult.targetRelays,
        successfulRelays: relayResult.successfulRelays,
        failedRelays: relayResult.failedRelays,
      },
      null,
      2,
    ),
  );
}

export async function runCli(args: string[] = Deno.args): Promise<void> {
  const { command, siteDir, options } = parseArgs(args);

  if (!command) {
    printUsage();
    Deno.exit(1);
  }

  switch (command) {
    case "publish":
      if (!siteDir) {
        throw new Error(
          "Usage: deno run -A cli.ts publish <siteDir> [options]",
        );
      }
      await handlePublish(siteDir, options);
      return;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

if (import.meta.main) {
  try {
    await runCli();
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "The CLI command failed.",
    );
    Deno.exit(1);
  }
}
