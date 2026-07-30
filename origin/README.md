# meme-origin

Private Node.js image origin for the Meme Workers. It validates JPEG, PNG,
WebP, and GIF uploads with `sharp`, stores originals by SHA-256, and generates
autorotated, center-cropped 128×128 WebP thumbnails. Image processing is
serialized by default for the J1900.

## Synology Container Manager

The supported runtime is Node.js 24 on Debian Bookworm. Container use avoids
depending on the older libraries or Node packages installed on DSM itself.

Copy `origin/` to `/volume1/docker/meme-origin`, then:

```sh
cd /volume1/docker/meme-origin
cp .env.example .env
openssl rand -hex 32
vi .env
chmod 0600 .env
mkdir -p data logs
```

Replace the placeholder mutation token and set `PUID`/`PGID` to the DSM user
that owns `data` and `logs`. In Container Manager, select **Project → Create**,
choose `/volume1/docker/meme-origin/compose.yaml`, build, and start it.

The project provides:

- `node:24-bookworm-slim`
- host binding `127.0.0.1:8086`
- persistent `data/` and `logs/` bind mounts
- `restart: unless-stopped`
- application health check
- read-only container filesystem, dropped capabilities, and private `/tmp`

Cloudflare Tunnel on the NAS can reach `http://127.0.0.1:8086`. Do not expose
the mutation API directly through a router port-forward.

### Install or update from a public GitHub archive without Git

Download the installer once, then point it at the repository:

```sh
curl --fail --location --output /tmp/install-meme-origin.sh \
  https://raw.githubusercontent.com/octopus7/meme/main/origin/docker/install-from-github.sh
sh /tmp/install-meme-origin.sh
```

It extracts only `origin/` into `/volume1/docker/meme-origin`, creates a secure
`.env` on first install, and preserves `.env`, `data/`, and `logs/` on updates.
Previous application files are retained under `backups/`. After an update,
use Container Manager’s **Build** and **Recreate** actions for the project.
The script does not use Git, Wrangler, Workers, or D1.

For another volume path:

```sh
sh /tmp/install-meme-origin.sh --repo octopus7/meme \
  --target /volume1/docker/my-meme-origin
```

## API

Public reads, normally reachable only through Tunnel/VPC:

```text
GET|HEAD /i/{sha256}.{jpg|png|webp|gif}
GET|HEAD /t/{sha256}
GET      /healthz
```

Media supports ETag, If-None-Match, If-Modified-Since, and one byte range.
Mutations require `Authorization: Bearer <token>`:

```text
POST /internal/v1/blobs                    raw image body
POST /internal/v1/blobs/{sha256}/trash
POST /internal/v1/blobs/{sha256}/restore
POST /internal/v1/admin/purge
```

Upload responses are `{hash, extension, mimeType, size, deduplicated}`.
Duplicate content reuses its original. Trashed content returns 404, cannot be
restored by another upload, and is physically purged after 30 days unless an
administrator restores it.

Every request is one JSON object in
`logs/access-YYYY-MM-DD.log`. Authorization, query strings, bodies, and tokens
are never logged. Logs older than 30 days are atomically compressed to
`.log.gz`, which is retained.

## Local verification

Node.js `>=24 <25` is required outside Docker:

```sh
cd origin
npm ci
npm test
docker compose config
docker compose build
```

For a non-container systemd deployment, `deploy/install.sh` remains available
and now requires Node.js 24 plus glibc 2.28 for `sharp` 0.35.3. The Docker
deployment is preferred on Synology.

Configuration is environment-only; see `.env.example` for Container Manager
and `deploy/meme-origin.env.example` for systemd. Never commit `.env`, tokens,
`node_modules`, stored images, or logs.
