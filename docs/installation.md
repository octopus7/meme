# Installation steps

[한국어](installation.KO.md) | **English**

This document describes the steps to create the current direct image CDN + Tunnel configuration for the first time. Replace every `<PLACEHOLDER>` with a value created by the operator, but do not record those values in the repository.

If you arrived here from an earlier Reddit post looking for the VPC-based configuration, use the [v1-vpc-final release](https://github.com/octopus7/meme/releases/tag/v1-vpc-final). This document and `main` describe the current architecture.

## Prerequisites

- A domain and Zone connected to Cloudflare
- A repository with GitHub Actions enabled
- Container Manager (Docker) on an x86-64 Synology/XPEnology
- An outbound HTTPS connection from Synology to Cloudflare
- Sufficient disk space and a separate backup for the origin data directory

Recommended hostnames:

```text
app.example.com          Google-authenticated web Worker
img.example.com          public image CDN → Tunnel → origin
origin-admin.example.com Bearer-token administrative API → Tunnel → origin
```

Anyone who knows a URL can access `img.example.com`, so the address itself must not be treated as secret. Separate upload, deletion, and restoration APIs on `origin-admin.example.com` and protect them with the origin Bearer token.

## 1. Install the Linux origin

- [Install the Node.js 24 Docker origin](origin.md): Container Manager project, default `127.0.0.1:8086`

Make the service listen only on loopback or a private address reachable by the Tunnel, and do not create router port forwarding. Do not install Node directly on Synology DSM; use a Debian Bookworm-based Node.js 24 LTS container. The installation source is `https://github.com/octopus7/meme` under `origin/`; keep the actual `.env` and token only on the NAS.

Check that the service is healthy from the Linux server.

```bash
curl --fail http://127.0.0.1:8086/healthz
```

## 2. Create the Tunnel and hostnames

1. Create a Cloudflare Tunnel and install the `cloudflared` connector on Synology.
2. Connect the `img.example.com` published route to port `8086` of the internal Node origin.
3. Connect the `origin-admin.example.com` published route to the same origin.
4. Do not configure separate Access on the `origin-admin.example.com` published route; authenticate administrative requests with the origin mutation Bearer token.
5. Allow only GET/HEAD for `/i/*` and `/t/*` on `img.example.com`, and block `/internal/*`, `/healthz`, and all write methods with a WAF or hostname rule.

Use the Tunnel token only in Linux systemd credentials or the Cloudflare installation procedure; do not store it in GitHub. Do not create external port forwarding on the NAS router.

## 3. Cloudflare Cache Rule and purge token

Configure the following Cache Rule in the `img.example.com` Zone.

- Explicitly mark `/i/*` and `/t/*` as cache eligible
- Include extensionless paths such as `/t/{hash}`
- Set the edge TTL for 200/206 responses to one year
- Do not cache 404 or 5xx responses
- Remove query strings from the cache key or reject them on public paths
- Do not cache methods other than GET/HEAD

Create a Cache Purge API token restricted to the target Zone and register it as the Worker secret `CF_CACHE_PURGE_TOKEN`. On deletion, purge the `blob-<sha256>` cache tag globally. Purge does not clear browser-local caches; when a later network request is an edge MISS, the origin state is checked again.

## 4. Create D1

Create D1 once from the Cloudflare dashboard or authenticated Wrangler.

```bash
npx wrangler@latest d1 create <D1_DATABASE_NAME>
```

Register the database name and ID in the GitHub `web-production` and `d1-production` Environments, then manually run the [D1 migration workflow](github-actions.md#d1-migration). Apply the exposure-log table (`image_url_exposure_logs`) migration at this stage as well.

## 5. GitHub Environment and web Worker secrets

Register the following variables in `web-production`.

```text
CF_ACCOUNT_ID
WEB_WORKER_NAME
D1_DATABASE_NAME
D1_DATABASE_ID
IMAGE_ORIGIN=https://<IMAGE_DOMAIN>
ORIGIN_ADMIN_BASE_URL=https://<ORIGIN_ADMIN_DOMAIN>
CF_ZONE_ID
GOOGLE_CLIENT_ID
GOOGLE_REDIRECT_URI=https://<APP_DOMAIN>/auth/callback
GOOGLE_ALLOWED_EMAILS=<one administrator email>
```

Register the following as Cloudflare web Worker encrypted secrets.

```text
GOOGLE_CLIENT_SECRET
AUTH_SESSION_SECRET
ORIGIN_ADMIN_TOKEN
CF_CACHE_PURGE_TOKEN
```

`ORIGIN_ADMIN_TOKEN` must equal the origin's `MEME_ORIGIN_MUTATION_TOKEN`. Generate all secrets as random values of at least 32 characters, and do not put them in GitHub variables or logs.

## 6. First Worker deployment

Run the following in order from GitHub Actions.

1. `Migrate D1`
2. `Deploy web Worker`
3. In the Cloudflare dashboard, connect the `app.example.com` Custom Domain to the web Worker.
4. Verify the `img.example.com` and `origin-admin.example.com` Tunnel routes and Cache Rule.

There is no storage Worker deployment step. Image GET requests are handled by the Cloudflare CDN rather than the web Worker, and the web Worker records in D1 when it includes an `IMAGE_ORIGIN` URL in list and search HTML. This record does not represent an actual download or HIT.

## 7. Operational checks

- Open `app.example.com` in a private browser window and confirm that it redirects to Google authentication.
- Sign in with the administrator Google account and confirm that `/` redirects to `/all`.
- Confirm that uploads succeed and the original is stored on Synology through `origin-admin.example.com`.
- Confirm that image URLs in `/all` and `/search` point to `img.example.com` and that the exposure log records the timestamp, filename, size, screen, and viewer sub.
- Confirm that unauthenticated GET/HEAD works for `img.example.com/i/...` and `/t/...`, and check on the second request that Cloudflare `Cf-Cache-Status` is `HIT`.
- Confirm that `img.example.com/internal/*` is blocked and that mutation requests to `origin-admin.example.com` return 401 without a Bearer token.
- After deletion of the last reference completes both the origin trash move and cache-tag purge, confirm that a new network request returns 404 for both image URLs (browser-local caches may remain).
- Open the image URL exposure-log screen at `/admin` and confirm that ordinary members cannot see the administrator screen.

Before production service, separately test upload failures, D1 failures, Tunnel interruptions, insufficient disk space, and purge-failure retries with test data.
