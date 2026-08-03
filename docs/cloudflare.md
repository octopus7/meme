# Cloudflare infrastructure

[한국어](cloudflare.KO.md) | **English**

Account-specific values are kept only in the Cloudflare dashboard and GitHub Environment. Actual domains, account/zone/database IDs, and API tokens are not recorded in the repository.

## D1

D1 stores physical blobs, collection items, and image URL exposure logs. The source of truth for migrations is `database/d1/migrations`, and production migrations are applied by a manual workflow separate from Worker deployment.

```text
blob: SHA-256, canonical extension, MIME, size, active/trashed status
item: owner identifier, blob hash, description, original filename, creation/deletion timestamps
image_url_exposure_logs: timestamp when URL was included in an HTML response, item, filename, byte size, screen, viewer sub
```

Exposure logs do not mean that an actual image request, download, or Cloudflare cache HIT occurred. The log records only when the web Worker includes an image URL in an `/all` or `/search` response.

Create the database only once.

```bash
npx wrangler@latest d1 create <D1_DATABASE_NAME>
```

Store the returned name and ID identically as `D1_DATABASE_NAME` and `D1_DATABASE_ID` in the `web-production` and `d1-production` Environments.

## Tunnel and public image hostnames

Workers VPC and VPC Service are not used. Place the Synology Node origin behind the private network of a Cloudflare Tunnel, and connect two published hostnames to the same origin port (default `8086`).

```text
img.example.com
  public GET/HEAD /i/*, /t/*
  Cloudflare CDN → Tunnel → Synology origin

origin-admin.example.com
  public administrative hostname, Bearer token required
  web Worker → Tunnel → Synology /internal/*
```

Do not create port forwarding on the NAS router. Run the Tunnel connector on Synology and keep its token only in Linux service credentials. Do not expose SSH, the DSM UI, or other administrative ports through the Tunnel public hostname.

`img.example.com` allows only the following requests:

- `GET` and `HEAD` for `/i/*` and `/t/*`
- Block other paths (`/internal/*`, `/healthz`) and write methods at the edge

`origin-admin.example.com` is a public published hostname. Administrative API mutations require the origin bearer token, and only the web Worker sends this token.

```http
Authorization: Bearer <origin mutation token>
```

The origin validates the bearer token and, when possible, also validates Host and the allowed path.

## Public image CDN cache

Public images are cached by the Cloudflare CDN without going through a storage Worker. In Cache Rules, explicitly mark `/i/*` and `/t/*` on `img.example.com` as cache eligible (the extensionless `/t/{hash}` path must be included explicitly).

Normal image responses send the following headers from the origin.

```http
Cache-Control: public, max-age=31536000, immutable
Cache-Tag: blob-<sha256>
```

Long-lived browser caching is allowed. Browser caches cannot be purged remotely on deletion, but the Cloudflare edge cache is cleared with the `blob-<sha256>` tag through the Zone Purge API. Return 404, 401, 4xx, and 5xx responses with `Cache-Control: no-store` and do not store them long-term. Either omit the query string from the cache key or reject it on public paths, and do not cache methods other than GET/HEAD.

The deletion order must be as follows.

```text
D1 trash_pending
→ origin-admin active → trash move
→ Cloudflare Zone purge_cache(tags=[blob-<hash>])
→ D1 trashed
```

If purge fails, keep `trash_pending` so the web Worker cron can retry it.

Official documentation:

- [Cloudflare Tunnel routing](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/routing-to-tunnel/)
- [Cache Rules](https://developers.cloudflare.com/cache/how-to/cache-rules/)
- [Purge by cache tag](https://developers.cloudflare.com/cache/how-to/purge-cache/purge-by-tags/)

## web Worker

Deploy the web Worker with `cache.enabled=false` and bind only D1.

```text
DB  D1 database
```

Build image URLs from `IMAGE_ORIGIN`; actual image GET requests do not enter the Worker. Fetch origin administration requests for upload, deletion, and restoration directly over HTTPS using `ORIGIN_ADMIN_BASE_URL`.

## Domains and secrets

Configure the Custom Domain, Tunnel hostnames, and Cache Rule in the dashboard. Do not put actual values in Wrangler files or source code.

GitHub `web-production` variables:

- `CF_ACCOUNT_ID`, `WEB_WORKER_NAME`
- `D1_DATABASE_NAME`, `D1_DATABASE_ID`
- `IMAGE_ORIGIN` (for example, `https://img.example.com`)
- `ORIGIN_ADMIN_BASE_URL` (for example, `https://origin-admin.example.com`)
- `CF_ZONE_ID`
- Google OAuth-related variables

web Worker encrypted secrets:

- `GOOGLE_CLIENT_SECRET`
- `AUTH_SESSION_SECRET`
- `ORIGIN_ADMIN_TOKEN` (the same as the origin mutation token)
- `CF_CACHE_PURGE_TOKEN` (only Cache Purge permission for the target Zone)

Manage `CLOUDFLARE_API_TOKEN` from GitHub Actions with minimum permissions in the web Worker deployment and D1 migration Environments respectively. Do not expose the origin token or purge token in GitHub logs or the repository.
