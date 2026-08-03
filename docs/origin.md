# Node.js 24 Docker origin

[한국어](origin.KO.md) | **English**

The image origin processes uploads with Node.js 24 LTS and `sharp`. On
Synology/XPEnology, use Container Manager (Docker) instead of installing Node.js
and native libraries directly on DSM. The container is based on
`node:24-bookworm-slim` and exposes only loopback port `8086`.

## Recommended environment

- x86-64 Synology/XPEnology with Container Manager or Docker Compose
- Read/write access to `/volume1/docker/meme-origin`
- Separate backups for image data and logs
- Cloudflare Tunnel routes for `img.example.com` and `origin-admin.example.com`
  reaching `http://127.0.0.1:8086`

The supported runtime is Node.js 24 LTS inside the Docker image. Build, test, and
runtime behavior do not depend on the Node.js version installed on DSM.

## Install or update from GitHub

The deployment script downloads only `origin/` without requiring Git.

```bash
curl --fail --location --output /tmp/deploy-latest-from-github.sh \
  https://raw.githubusercontent.com/octopus7/meme/main/origin/docker/deploy-latest-from-github.sh
```

The default target is `/volume1/docker/meme-origin`. The script records the
latest `main` commit SHA, builds and recreates the Docker image, and waits for
`/healthz`. Run the standard deployment with:

```bash
sh /tmp/deploy-latest-from-github.sh \
  --repo octopus7/meme \
  --ref main \
  --target /volume1/docker/meme-origin
```

The script preserves `.env`, `data/`, and `logs/`, and keeps previous application
files under `backups/`. It does not deploy Workers or run D1 migrations.

## Container Manager project

For a manual first-time setup, prepare the environment and persistent folders:

```bash
cd /volume1/docker/meme-origin
cp .env.example .env
openssl rand -hex 32
vi .env
chmod 0600 .env
mkdir -p data logs
```

In `.env`:

- Replace the mutation token with a random value of at least 32 characters.
- Set `PUID` and `PGID` to the DSM user that owns `data/` and `logs/`.
- Set `MEME_HOST_ROOT=/volume1/docker/meme-origin`.

Register the same mutation token as the web Worker secret
`ORIGIN_ADMIN_TOKEN`. The `origin-admin.example.com` hostname is public, so keep
the mutation token long and random; the web Worker sends it as a Bearer token.
Never commit `.env`, tokens, images, or logs.

In Synology Container Manager:

1. Select **Project → Create**.
2. Set the project path to `/volume1/docker/meme-origin`.
3. Select `compose.yaml`, then build and start the project.
4. Check the container health and endpoint:

```bash
curl --fail http://127.0.0.1:8086/healthz
```

The response includes the deployed commit, for example:

```json
{"status":"ok","commit":"ddf849ab7026bcecf7b9ac5eb468a2b1fd086f03"}
```

The Compose configuration applies these safety boundaries:

- Host binding on `127.0.0.1:8086`
- Only `data/` and `logs/` as persistent bind mounts
- Read-only container filesystem and private `/tmp`
- Dropped Linux capabilities and `no-new-privileges`
- `restart: unless-stopped` and an application health check

Do not expose port 8086 or mutation APIs through router port forwarding. The
public image hostname may expose only GET/HEAD for `/i/*` and `/t/*`; block
`/internal/*` and `/healthz`. Management requests must use the
`origin-admin.example.com` hostname with the Bearer mutation token.

## Updates and rollback

Run `deploy-latest-from-github.sh` again for updates. It backs up the previous
application files before replacing them and preserves `.env`, `data/`, and
`logs/`. The `/healthz` response includes the deployed commit SHA. If the new
container fails its health check, restore the previous application files from
`backups/` and rebuild. Do not delete or roll back the data and environment files
without a separate backup decision.

## GitHub Actions artifact

The `Build origin` workflow validates Node.js 24 tests and the Docker build, then
creates `meme-origin-node24-linux-x64-<commit>`. The artifact contains the
Container Manager files and Linux x64 production dependencies, but no environment
file or token.

The workflow creates an artifact only; it does not connect to the NAS or modify
the server, Worker, or D1. For a non-container systemd installation, see the
[origin README](../origin/README.md), but prefer Container Manager on Synology.

## Operations checklist

- Monitor Container Manager health, restart counts, and image build failures.
- Check that `logs/access-YYYY-MM-DD.log` excludes authorization, query strings,
  request bodies, and tokens.
- Confirm the daily trash purge (`MEME_ORIGIN_PURGE_INTERVAL=1d`).
- Check gzip compression of access logs older than 30 days and trash cleanup.
- Back up active images, thumbnails, trash, and `.env` separately.
- Recheck `PUID`/`PGID` after changing `data/` or `logs/` ownership.
- Rebuild regularly for Docker image and Node.js 24 LTS security updates.
