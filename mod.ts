import { runCli } from "./cli.ts";

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
