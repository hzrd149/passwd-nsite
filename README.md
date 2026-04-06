# passwd-nsite

`passwd-nsite` lets you publish a password-locked nsite.

## How It Works

A locked nsite ships with a small unlock app and an encrypted `site.7z`.

When someone visits the site:

1. The unlock page loads.
2. The browser downloads `site.7z`.
3. The visitor enters the password.
4. The archive is decrypted locally in the browser.
5. The unlocked files are stored locally and served by the site router.

The password-protected content is not visible until the archive is successfully decrypted in the browser.

Demo site:
https://0ygl461f4ecz5thkn8eksa36nepjpij86s83ti8yzokopd3ag5passwd.nsite.lol

## CLI From JSR

Install the CLI globally with Deno:

```bash
deno install --allow-read --allow-net -f -g -n nsyte jsr:@hzrd149/passwd-nsite
```

If you want to use `--out`, include `--allow-write` when installing:

```bash
deno install --allow-read --allow-write --allow-net -f -g -n nsyte jsr:@hzrd149/passwd-nsite
```

After installing, you can run the CLI as `nsyte`.

Publish a locked nsite directly from JSR with Deno:

```bash
deno run --allow-read --allow-net jsr:@hzrd149/passwd-nsite publish ./my-site \
  --site-id mysite \
  --password YOUR_PASSWORD \
  --nsec YOUR_NSEC \
  --relay wss://relay.example.com \
  --server https://blossom.example.com
```

You can also read the password from stdin:

```bash
printf '%s' YOUR_PASSWORD | deno run --allow-read --allow-net jsr:@hzrd149/passwd-nsite publish ./my-site \
  --site-id mysite \
  --password-stdin \
  --nsec YOUR_NSEC \
  --relay wss://relay.example.com \
  --server https://blossom.example.com
```

Required inputs:

- `<siteDir>`
- `--site-id`
- `--password` or `--password-stdin`
- `--nsec`
- one or more `--relay`
- one or more `--server`

Optional inputs:

- `--title`
- `--description`
- `--out`
- `--dry-run`

Permissions:

- `--allow-read` to read the site folder and packaged publish assets
- `--allow-net` to upload to Blossom servers and publish to relays
- `--allow-write` only if using `--out`

The CLI builds `site.7z`, uploads the required blobs, signs the named-site manifest, and publishes it to the relays you provide.
