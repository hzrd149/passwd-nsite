import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

function sha256Hex(data: string | Uint8Array): string {
  const hash = createHash("sha256");
  if (typeof data === "string") {
    hash.update(data, "utf-8");
  } else {
    hash.update(data);
  }
  return hash.digest("hex");
}

function outputBytes(output: {
  type: string;
  fileName: string;
  code?: string;
  source?: string | Uint8Array;
}): string | Uint8Array {
  if (output.type === "chunk") {
    if (typeof output.code !== "string") {
      throw new Error(
        `assets-manifest: chunk "${output.fileName}" has no string code`,
      );
    }
    return output.code;
  }
  if (output.type === "asset") {
    const { source } = output;
    if (typeof source === "string" || source instanceof Uint8Array) {
      return source;
    }
    throw new Error(
      `assets-manifest: cannot hash "${output.fileName}" (unexpected source type)`,
    );
  }
  throw new Error(
    `assets-manifest: unknown output type for "${output.fileName}"`,
  );
}

type ManifestEntry = { path: string; sha256: string };

/** Same effective URL prefix as `import.meta.env.BASE_URL` + emitted file path (Vite-normalized `base` + trailing slash). */
function joinViteBase(base: string, relativeOutPath: string): string {
  const withSlash = base.endsWith("/") ? base : `${base}/`;
  const rel = relativeOutPath.replace(/^\/+/, "");
  return `${withSlash}${rel}`;
}

/** Writes dist/assets.json: a flat array of { path, sha256 } for every emitted file (manifest itself is not listed). */
function assetsManifestPlugin(): Plugin {
  let viteBase = "/";

  return {
    name: "assets-manifest",
    configResolved(config) {
      viteBase = config.base;
    },
    writeBundle(options, bundle) {
      const outDir = options.dir;
      if (!outDir) {
        return;
      }

      const byPath = new Map<string, ManifestEntry>();

      for (const output of Object.values(bundle)) {
        const path = joinViteBase(viteBase, output.fileName);
        const sha256 = sha256Hex(outputBytes(output));
        byPath.set(output.fileName, { path, sha256 });
      }

      const manifest: ManifestEntry[] = [...byPath.values()].sort((a, b) =>
        a.path.localeCompare(b.path),
      );

      writeFileSync(
        join(outDir, "assets.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
        "utf-8",
      );
    },
  };
}

/** Drops `public/site.7z` from the production output; the dev server still serves it from `public/`. */
function omitPublicSite7zFromBuild(): Plugin {
  let outDirAbs = "";
  return {
    name: "omit-public-site-7z-from-build",
    apply: "build",
    configResolved(config) {
      outDirAbs = resolve(config.root, config.build.outDir);
    },
    async closeBundle() {
      const { unlink } = await import("node:fs/promises");
      const target = join(outDirAbs, "site.7z");
      try {
        await unlink(target);
      } catch (err) {
        const code =
          err && typeof err === "object" && "code" in err
            ? (err as NodeJS.ErrnoException).code
            : undefined;
        if (code === "ENOENT") {
          return;
        }
        throw err;
      }
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  appType: "mpa",
  base: "/",
  plugins: [
    react(),
    tailwindcss(),
    assetsManifestPlugin(),
    omitPublicSite7zFromBuild(),
  ],
  worker: {
    format: "es",
    rollupOptions: {
      output: {
        entryFileNames: "router.js",
      },
    },
  },
  build: {
    emptyOutDir: true,
    // Dont minify, we want others to be able to inspect and modify
    minify: false,
  },
});
