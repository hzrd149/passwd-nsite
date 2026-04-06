---
name: passwd-nsite
description: Run the passwd-nsite Deno CLI from JSR to publish or update a password-locked nsite from a folder of static files. Use when an agent needs to publish a locked site, republish an existing site by site id, supply explicit CLI flags, handle Deno permissions, capture JSON publish results, or troubleshoot Blossom and relay publish failures.
---

# passwd-nsite

Use the published JSR CLI, not local repo entrypoints, unless the user explicitly asks to work from a local checkout.

## Core Command

Install the CLI globally with Deno when repeated use is expected:

```bash
deno install --allow-read --allow-net -f -g -n passwd-snite jsr:@hzrd149/passwd-nsite
```

If `--out` will be used, install it with write permission:

```bash
deno install --allow-read --allow-write --allow-net -f -g -n passwd-snite jsr:@hzrd149/passwd-nsite
```

After installation, the command can be run as `passwd-snite`.

Run:

```bash
deno run --allow-read --allow-net jsr:@hzrd149/passwd-nsite publish <siteDir> \
  --site-id <id> \
  --password <value> \
  --nsec <nsec-or-hex> \
  --relay <wss://relay.example.com> \
  --server <https://blossom.example.com>
```

Use `--password-stdin` instead of `--password` when secret handling matters:

```bash
printf '%s' "$SITE_PASSWORD" | deno run --allow-read --allow-net jsr:@hzrd149/passwd-nsite publish <siteDir> \
  --site-id <id> \
  --password-stdin \
  --nsec <nsec-or-hex> \
  --relay <wss://relay.example.com> \
  --server <https://blossom.example.com>
```

Add `--allow-write` only when using `--out` to save the generated `site.7z`.

## Required Inputs

Provide all publish inputs explicitly:

- `<siteDir>` positional argument
- `--site-id`
- `--password` or `--password-stdin`
- `--nsec`
- one or more `--relay`
- one or more `--server`

Optional flags:

- `--title <text>`
- `--description <text>`
- `--out <path>`
- `--dry-run`

## Procedure

1. Run the JSR CLI with explicit flags.
2. Capture stdout JSON. Treat stderr as progress logging.
3. Report `eventId`, `aggregateHash`, `siteId`, successful servers, successful relays, and any failed relays.
4. For an update, rerun the same `publish` command with the same `--site-id` and the new static site folder contents.

## Important Behavior

- The CLI reads every file in `<siteDir>` and builds an encrypted `site.7z`.
- At least one Blossom server must end up holding the full bundle.
- Publish success only requires at least one relay to accept the signed manifest event.

## First Checks For Failures

- Empty site directory
- Invalid `--site-id`
- Missing `--allow-read`, `--allow-net`, or `--allow-write` when `--out` is used
- No Blossom server accepted the full bundle
- All relay publishes failed

Read `references/cli-publish.md` for full command patterns, output fields, constraints, and troubleshooting details.
