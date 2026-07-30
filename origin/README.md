# meme-origin

Private Node.js image origin for the Meme Workers. It accepts raw JPEG, PNG,
WebP, and GIF uploads, validates them with `sharp`, stores originals by their
SHA-256 content hash, and creates autorotated, center-cropped 128×128 WebP
thumbnails. Image work is serialized by default for the J1900.

## API

Public reads (network exposure is restricted by Tunnel/VPC):

```text
GET|HEAD /i/{sha256}.{jpg|png|webp|gif}
GET|HEAD /t/{sha256}
GET      /healthz
```

Media supports ETag/If-None-Match, If-Modified-Since, and one byte range.
Mutation requests require `Authorization: Bearer <token>`:

```text
POST /internal/v1/blobs                    raw image body
POST /internal/v1/blobs/{sha256}/trash
POST /internal/v1/blobs/{sha256}/restore   administrator only
POST /internal/v1/admin/purge              administrator only
```

Upload responses use `{hash, extension, mimeType, size, deduplicated}`.
Duplicate content reuses the original. A blob whose final reference was
removed enters administrator-only trash for 30 days; it returns 404 and cannot
be resurrected by upload. The scheduled purge removes expired originals,
thumbnails, and records.

Every request is one JSON object in
`/var/log/meme-origin/access-YYYY-MM-DD.log`. The logger records UTC timestamp,
method, path without query, status, response bytes, duration, remote IP, and
user agent. It never records Authorization, queries, bodies, or tokens. Logs
older than 30 days are atomically changed to `.log.gz`; gzip files are kept.

## Requirements

- x86-64 systemd Linux
- Node.js `>=20.9.0 <21`
- glibc 2.28 or newer for the pinned, security-fixed `sharp` 0.35.3 Linux x64 binary
- Git, npm, curl, OpenSSL, sudo, and standard Linux account tools

Node 20 itself is EOL. This compatibility build remains available for the
Synology constraint, but the installer refuses the older vulnerable sharp
0.33 line. If the NAS has glibc older than 2.28, use the managed
`origin-dotnet` implementation instead of weakening the image decoder.

Node 20 is intentionally pinned for the target Synology environment. The
installer prints the detected Node, architecture, and glibc versions and
performs a real `sharp` import before switching releases. Because Synology may
install Node outside `/usr/bin`, the installer resolves the active executable
and atomically maintains `/opt/meme-origin/node`; systemd uses that stable
symlink.

## First install

Run as the target login user, not root:

```sh
curl --fail --location --output /tmp/meme-origin-install.sh \
  https://raw.githubusercontent.com/YOUR_ORG/YOUR_REPO/main/origin/deploy/install.sh
bash /tmp/meme-origin-install.sh \
  --repo-url https://github.com/YOUR_ORG/YOUR_REPO.git
```

The script clones to `~/meme`, installs only `origin/` into an immutable
`/opt/meme-origin/releases/<timestamp>-<commit>/` release, and atomically
switches `/opt/meme-origin/current`. It never invokes Wrangler, deploys a
Worker, or changes D1. The generated 256-bit token exists only in the root-only
`/etc/meme-origin/meme-origin.env`. Data and logs remain in
`/var/lib/meme-origin` and `/var/log/meme-origin`.

## Update and development install

```sh
bash ~/meme/origin/deploy/install.sh
bash ~/meme/origin/deploy/install.sh --no-pull
```

Normal updates use `git pull --ff-only` and re-execute the newly pulled
installer. The environment, data, and logs are preserved. The new release is
activated only after `npm ci --omit=dev` and a real sharp load check. A failed
service health check restores the previous release symlink. Worker and D1
deployments remain separate.

## Local verification

```sh
cd origin
npm ci
npm test
MEME_ORIGIN_MUTATION_TOKEN="$(openssl rand -hex 32)" npm start
```

Configuration is provided only through the environment; see
`deploy/meme-origin.env.example`. Do not commit tokens, `.env` files,
`node_modules`, data, or access logs. The default private listener is
`127.0.0.1:8086`.

To use a non-default log directory, create it for `meme-origin` and add that
exact path to a systemd `ReadWritePaths` override. The supplied hardened unit
permits writes only to the default data and log directories.
