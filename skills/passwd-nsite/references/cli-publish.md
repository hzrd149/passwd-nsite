# passwd-nsite CLI Publish Reference

## Command Templates

Standard publish:

```bash
deno run --allow-read --allow-net jsr:@hzrd149/passwd-nsite publish ./my-site \
  --site-id mysite \
  --password YOUR_PASSWORD \
  --nsec YOUR_NSEC \
  --relay wss://relay.example.com \
  --server https://blossom.example.com
```

Read the password from stdin:

```bash
printf '%s' YOUR_PASSWORD | deno run --allow-read --allow-net jsr:@hzrd149/passwd-nsite publish ./my-site \
  --site-id mysite \
  --password-stdin \
  --nsec YOUR_NSEC \
  --relay wss://relay.example.com \
  --server https://blossom.example.com
```

Dry run without upload or relay publish:

```bash
deno run --allow-read --allow-net jsr:@hzrd149/passwd-nsite publish ./my-site \
  --site-id mysite \
  --password YOUR_PASSWORD \
  --nsec YOUR_NSEC \
  --relay wss://relay.example.com \
  --server https://blossom.example.com \
  --dry-run
```

## Required Inputs

- `<siteDir>`: static site folder to archive into `site.7z`
- `--site-id`: named-site id
- `--password` or `--password-stdin`: site archive password
- `--nsec`: Nostr private key as `nsec` or 64-character hex
- `--relay`: one or more target relays
- `--server`: one or more target Blossom servers

Optional inputs:

- `--title <text>`
- `--description <text>`
- `--dry-run`

## Permissions

- `--allow-read` is required to read the site directory and the packaged build output directory.
- `--allow-net` is required to upload blobs to Blossom and publish the manifest to relays.

## What The CLI Does

1. Read every file from `<siteDir>`.
2. Fail if the site directory is empty.
3. Build an encrypted `site.7z` from that folder.
4. Upload the locked site bundle to the requested Blossom servers.
5. Sign a named-site manifest event of kind `35128`.
6. Publish that signed manifest to the requested relays.

## Update Semantics

There is no separate `update` command.

To update an existing locked site, rerun `publish` with:

- the same `--site-id`
- the new static site folder contents
- the intended password for the new archive
- the target relays and Blossom servers

Republishing the same site id creates and publishes a new manifest for that named site.

## Site Id Rules

The CLI validates the site id after trimming and lowercasing it.

It must:

- match `^[a-z0-9-]{1,13}$`
- be lowercase after normalization
- not end with `-`

If invalid, expect an error like:

```text
Use a site id with 1-13 lowercase letters, numbers, or hyphens, and no trailing hyphen.
```

## Output Contract

Progress messages are written to stderr. Examples:

- `Reading site directory...`
- `Building encrypted site.7z...`
- `Verifying /index.html...`
- `Uploading site blobs to blossom...`
- `Signing named-site manifest...`
- `Publishing manifest to relays...`

Treat stdout as the machine-readable result.

Dry-run output fields:

- `dryRun`
- `pubkey`
- `eventId`
- `aggregateHash`
- `siteId`
- `pathCount`
- `relays`
- `servers`

Full publish output fields:

- `dryRun`
- `pubkey`
- `eventId`
- `aggregateHash`
- `siteId`
- `pathCount`
- `servers`
- `relays`
- `successfulRelays`
- `failedRelays`

When reporting success, surface at least:

- `eventId`
- `aggregateHash`
- `siteId`
- `servers`
- `successfulRelays`
- `failedRelays`

## Manifest Semantics

The signed event is kind `35128` with:

- one `d` tag for the site id
- one `path` tag per published path
- one aggregate `x` tag
- one `server` tag per usable Blossom server
- optional `title`
- optional `description`

The aggregate hash identifies the exact site version and is computed from sorted lines of the form:

```text
<sha256> <absolute-path>
```

Agents usually do not need to compute this manually because the CLI returns it.

## Troubleshooting

Missing required input:

- `Provide --site-id.`
- `Provide --password or --password-stdin.`
- `Provide --nsec.`
- `Provide at least one --relay.`
- `Provide at least one --server.`

Site/build problems:

- `The site directory does not contain any files.`

Permission problems:

- missing `--allow-read`
- missing `--allow-net`

Key/signing problems:

- invalid `--nsec` format
- invalid site id

Network/publish problems:

- Blossom `HEAD` or `PUT` requests fail
- no single Blossom server ends up with the full bundle
- all relays reject or fail to publish the signed manifest

## Agent Guidance

- Prefer the JSR package entrypoint over local repo entrypoints.
- Pass every input explicitly on the command line.
- Use `--password-stdin` when the environment already exposes the password as a secret.
- Capture stdout JSON exactly.
- Do not claim success unless at least one relay publish succeeded.
